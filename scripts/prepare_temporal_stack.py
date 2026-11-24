"""Draft a time manifest for aligned GeoTIFFs and publish its reviewed observation index."""

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import filecmp
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
from tempfile import TemporaryDirectory
from typing import Literal

import numpy
from pydantic import BaseModel, ConfigDict, Field, ValidationError
import rasterio
import yaml


class ManifestLoader(yaml.SafeLoader):
    """Read a reviewed stack without silently replacing repeated fields."""

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict:
        """Build one field mapping after checking the locations of its keys.

        Args:
            node: Mapping from the YAML document.
            deep: Whether to construct nested values immediately.

        Returns:
            SafeLoader's parsed field values.

        Raises:
            ValueError: A field was repeated in this mapping.
        """
        self.flatten_mapping(node)
        keys: set[str] = set()
        for key, _ in node.value:
            if isinstance(key, yaml.ScalarNode):
                if key.value in keys:
                    raise ValueError(
                        f"Duplicate key {key.value!r} on line {key.start_mark.line + 1}."
                    )
                keys.add(key.value)
        return super().construct_mapping(node, deep)


class StackFields(BaseModel):
    """Reject misspelled fields in an operator's reviewed manifest."""

    model_config = ConfigDict(extra="forbid", strict=True)


class TimeRange(StackFields):
    """Include observations from start up to the exclusive end, in UTC."""

    start: str
    end: str


class Observation(StackFields):
    """Associate one archive-relative GeoTIFF with a date label or coverage interval."""

    file: str = Field(min_length=1)
    time: str | TimeRange


class Variable(StackFields):
    """Describe the measured quantity and the time coverage shared by its observations."""

    id: str = Field(pattern=r"\S")
    title: str = Field(pattern=r"\S")
    units: str = Field(pattern=r"\S")
    time_support: Literal["snapshot", "mean", "total"]
    period: Literal[
        "year",
        "month",
        "day",
        "timestamp",
        "calendar_year",
        "calendar_month",
        "calendar_day",
        "explicit",
    ]


class Stack(StackFields):
    """Describe one Catalog item, its variable, and all files to index."""

    id: str = Field(pattern=r"\S")
    title: str = Field(pattern=r"\S")
    variable: Variable
    observations: list[Observation] = Field(min_length=1)


UTC = timezone.utc
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
PRECISIONS = ("year", "month", "day", "timestamp")
TIMESTAMP = (
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|[+-][0-9]{2}:[0-9]{2})"
)
# Match the entire date-shaped token so a bad month cannot become a plausible year.
FILE_DATE = re.compile(
    r"(?<![a-zA-Z0-9])([0-9]{4,}(?:[-_.][0-9]+)*(?:T[a-zA-Z0-9:.+-]+)?)"
    r"(?![a-zA-Z0-9]|[-_.][0-9])"
)


def parse_time(label: str) -> tuple[datetime, str]:
    """Parse an ISO calendar label or offset-aware whole-second timestamp.

    Args:
        label: Quoted year, year-month, date or timestamp from the manifest.

    Returns:
        UTC start of the label and its supplied precision.

    Raises:
        ValueError: The date is invalid or the timestamp lacks an explicit zone.
    """
    for precision, pattern, suffix in (
        ("year", r"[0-9]{4}", "-01-01"),
        ("month", r"[0-9]{4}-[0-9]{2}", "-01"),
        ("day", r"[0-9]{4}-[0-9]{2}-[0-9]{2}", ""),
    ):
        if re.fullmatch(pattern, label):
            return datetime.fromisoformat(label + suffix).replace(tzinfo=UTC), precision
    if re.fullmatch(TIMESTAMP, label):
        zone = re.search(r"([+-])(\d\d):(\d\d)$", label)
        if zone and (int(zone[2]) > 23 or int(zone[3]) > 59):
            raise ValueError(f"Invalid timezone offset in {label}")
        return (
            datetime.fromisoformat(label.replace("Z", "+00:00")).astimezone(UTC),
            "timestamp",
        )
    raise ValueError(
        f"Invalid date {label!r}. Use YYYY, YYYY-MM, YYYY-MM-DD or a whole-second timestamp with a timezone."
    )


def observation_interval(
    time: str | TimeRange, period: str
) -> tuple[datetime, datetime]:
    """Resolve one observation's physical coverage against the declared period.

    Args:
        time: Snapshot label, calendar shorthand, or explicit pair of boundaries.
        period: Variable-wide precision or interval convention.

    Returns:
        UTC boundaries, equal for snapshots and end-exclusive for intervals.

    Raises:
        ValueError: Boundaries or precision conflict with the declared period.
    """
    if isinstance(time, TimeRange):
        if period in PRECISIONS:
            raise ValueError("A snapshot needs one date label.")
        start, _ = parse_time(time.start)
        end, _ = parse_time(time.end)
        if end <= start:
            raise ValueError("The end must be later than the start.")
        if period == "explicit":
            return start, end
    else:
        start, precision = parse_time(time)
        if precision != period.removeprefix("calendar_"):
            raise ValueError(f"{time!r} does not match period {period!r}.")
        if period in PRECISIONS:
            return start, start
        end = None
    if period == "calendar_year":
        first = datetime(start.year, 1, 1, tzinfo=UTC)
        following = first.replace(year=first.year + 1)
    elif period == "calendar_month":
        first = datetime(start.year, start.month, 1, tzinfo=UTC)
        following = first.replace(
            year=first.year + first.month // 12, month=first.month % 12 + 1
        )
    else:
        first = datetime.combine(start.date(), datetime.min.time(), UTC)
        following = first + timedelta(days=1)
    if first != start or (end is not None and end != following):
        raise ValueError(f"Expected one complete {period.replace('_', ' ')}.")
    return first, following


def date_evidence(path: Path) -> dict[str, str]:
    """Find date candidates in a filename and acquisition metadata.

    Args:
        path: GeoTIFF to inspect without reading its pixels.

    Returns:
        Evidence labels and candidate values, including invalid or conflicting clues.

    Raises:
        OSError: The source cannot be opened.
    """
    evidence = {}
    for index, token in enumerate(FILE_DATE.findall(path.stem), 1):
        token = token.replace("_", "-").replace(".", "-")
        token = re.sub(
            r"^(\d{4})(\d{2})(\d{2})?(?=T|$)",
            lambda m: "-".join(filter(None, m.groups())),
            token,
        )
        token = re.sub(r"T(\d{2})(\d{2})(\d{2})(?=Z|[+-]|$)", r"T\1:\2:\3", token)
        evidence[f"filename {index}"] = token
    with rasterio.open(path, driver="GTiff") as src:
        for band in (0, 1):
            for tag, value in src.tags(band).items():
                if tag.lower() in {
                    "acquisition_date",
                    "acquisition_datetime",
                    "observation_date",
                    "observation_time",
                    "date_acquired",
                }:
                    evidence[f"{'band' if band else 'dataset'} {tag}"] = value
    return evidence


def draft_stack(root: Path) -> None:
    """Preview inferred dates and write an editable manifest without replacing edits.

    Args:
        root: Dedicated directory containing the GeoTIFFs and eventual archive.

    Raises:
        ValueError: No files match or the operator supplies an unknown choice.
        OSError: The directory or output cannot be accessed.
    """
    target = root / "stack.yaml"
    if target.exists():
        raise ValueError(f"Edit the existing {target.name} or use another directory.")
    files = sorted(
        p
        for p in root.rglob("*")
        if p.is_file() and p.suffix.lower() in {".tif", ".tiff"}
    )
    if not files:
        raise ValueError("No GeoTIFF files found.")
    rows = []
    precisions = set()
    for path in files:
        name = path.relative_to(root).as_posix()
        label = None
        reason = "no date found"
        try:
            evidence = date_evidence(path)
            if evidence:
                reason = ", ".join(
                    f"{source}: {value}" for source, value in evidence.items()
                )
                candidates = {parse_time(value) for value in evidence.values()}
                if len(candidates) == 1:
                    label = next(iter(evidence.values()))
                    precisions.add(candidates.pop()[1])
        except (ValueError, OverflowError, OSError) as error:
            reason += f" ({error})"
        print(f"{name}  |  {label or '?'}  |  {reason}")
        rows.append((name, label, reason))
    answer = input("Use the proposed dates in stack.yaml? [Y/n] ").strip().lower()
    if answer not in {"", "y", "yes", "n", "no"}:
        raise ValueError("Choose y or n.")
    use_dates = answer in {"", "y", "yes"}
    support = (
        input(
            "What does each raster represent? [snapshot/mean/total, Enter to decide later] "
        )
        .strip()
        .lower()
    )
    if support and support not in {"snapshot", "mean", "total"}:
        raise ValueError("Choose snapshot, mean or total.")
    precision = next(iter(precisions)) if len(precisions) == 1 and use_dates else None
    period = precision if support == "snapshot" else None
    if support in {"mean", "total"}:
        choices = ("calendar_year", "calendar_month", "calendar_day", "explicit")
        period = (
            input(
                f"Coverage of each raster [{'/'.join(choices)}, Enter to decide later] "
            ).strip()
            or None
        )
        if period and period not in choices:
            raise ValueError("Choose one of the listed coverage periods.")
    header = {
        "id": root.resolve().name,
        "title": root.resolve().name,
        "variable": {
            "id": None,
            "title": None,
            "units": None,
            "time_support": support or None,
            "period": period,
        },
    }
    with target.open("x", encoding="utf-8") as stream:
        stream.write(
            "# Review dates and fill in the variable details before building. Quote date labels.\n"
        )
        stream.write(yaml.safe_dump(header, sort_keys=False, allow_unicode=True))
        stream.write("observations:\n")
        for name, label, reason in rows:
            stream.write("# " + " ".join(reason.splitlines()) + "\n")
            stream.write(
                yaml.safe_dump(
                    [{"file": name, "time": label if use_dates else None}],
                    sort_keys=False,
                    allow_unicode=True,
                )
            )
    print(f"Review {target.name}, then run build.")


def index_rows(stack: Stack, root: Path) -> list[tuple[str | int | float | None, ...]]:
    """Validate original files, times and metadata before publishing any archive.

    Args:
        stack: Parsed operator manifest.
        root: Resolved directory enclosing every indexed file.

    Returns:
        SQLite observation records in manifest order.

    Raises:
        ValueError: Lists incompatible files, invalid times or overlapping intervals.
    """
    var = stack.variable
    if (var.time_support == "snapshot") != (var.period in PRECISIONS):
        raise ValueError(
            f"Time support {var.time_support} is incompatible with period {var.period}."
        )
    errors = []
    reference = None
    measurement_sources: dict[str, str] = {}
    rows = []
    intervals = []
    for obs in stack.observations:
        try:
            start, end = observation_interval(obs.time, var.period)
            intervals.append((start, end, obs.file))
            member = Path(obs.file)
            path = (root / member).resolve(strict=True)
            if member.is_absolute() or not path.is_relative_to(root):
                raise ValueError(
                    "The file must be relative and inside the stack directory."
                )
            with rasterio.open(path, driver="GTiff") as src:
                sidecars = [
                    Path(name).name
                    for name in src.files
                    if Path(name).resolve() != path
                ]
                if sidecars:
                    raise ValueError(
                        f"Embed the data from {', '.join(sidecars)} in the GeoTIFF before indexing."
                    )
                grid = src.transform
                if src.count != 1 or numpy.dtype(src.dtypes[0]).kind not in "iuf":
                    raise ValueError("Expected one numeric data band.")
                if (
                    not src.crs
                    or grid.a <= 0
                    or grid.e >= 0
                    or grid.b
                    or grid.d
                    or not all(map(math.isfinite, grid))
                ):
                    raise ValueError("Expected a georeferenced north-up grid.")
                if src.units[0] and src.units[0] != var.units:
                    raise ValueError(
                        f"Band units {src.units[0]!r} differ from {var.units!r}."
                    )
                for band in (0, 1):
                    standard_name = src.tags(band).get("standard_name", "").strip()
                    if standard_name:
                        measurement_sources.setdefault(standard_name, obs.file)
                if src.scales[0] != 1 or src.offsets[0] != 0:
                    raise ValueError(
                        "Convert packed values to their declared units before indexing."
                    )
                nodata = src.nodata
                if nodata is not None and not math.isfinite(nodata):
                    nodata = str(nodata)
                fields = {
                    "CRS": src.crs,
                    "transform": grid,
                    "height": src.height,
                    "width": src.width,
                    "dtype": src.dtypes[0],
                    "NoData": nodata,
                }
                if reference is None:
                    reference = fields
                differences = [key for key in fields if fields[key] != reference[key]]
                if differences:
                    raise ValueError(
                        "Different "
                        + ", ".join(differences)
                        + " from the first raster."
                    )
                first, last = (int((dt - EPOCH).total_seconds()) for dt in (start, end))
                rows.append(
                    (
                        var.id,
                        var.title,
                        var.units,
                        member.as_posix(),
                        1,
                        last,
                        None,
                        first,
                        last,
                        {
                            "snapshot": "instant",
                            "mean": "mean",
                            "total": "accumulation",
                        }[var.time_support],
                        src.dtypes[0],
                        nodata,
                        src.crs.to_wkt(),
                        json.dumps(grid.to_gdal()),
                        src.height,
                        src.width,
                    )
                )
        except (OSError, ValueError, OverflowError, RuntimeError) as error:
            errors.append(f"{obs.file}: {error}")
    if len(measurement_sources) > 1:
        errors.append(
            "Conflicting standard_name measurements: "
            + ", ".join(
                f"{name!r} in {file}" for name, file in measurement_sources.items()
            )
        )
    previous = None
    for start, end, name in sorted(intervals):
        if previous and (start < previous[0] or end == previous[0]):
            errors.append(f"{name}: duplicate time or overlap with {previous[1]}.")
        if previous is None or end > previous[0]:
            previous = end, name
    if errors:
        raise ValueError("\n".join(errors))
    return rows


def build_stack(manifest: Path, check: bool) -> None:
    """Index reviewed observations and publish the discovery descriptor last.

    Args:
        manifest: YAML file in the dedicated archive directory.
        check: Only validate the manifest and raster headers.

    Raises:
        ValueError: The manifest or sources are invalid.
        OSError: Publication fails, a descriptor exists or an existing index differs.
        sqlite3.Error: The complete observation index could not be written.
    """
    root = manifest.resolve(strict=True).parent
    content = yaml.load(manifest.read_text(encoding="utf-8"), Loader=ManifestLoader)
    try:
        stack = Stack.model_validate(content)
    except ValidationError as error:
        messages = []
        for problem in error.errors():
            location = problem["loc"]
            field = ".".join(map(str, location)) or "stack"
            if (
                len(location) >= 2
                and location[0] == "observations"
                and isinstance(location[1], int)
            ):
                row = content["observations"][location[1]]
                if isinstance(row, dict) and row.get("file"):
                    field = f"{row['file']} ({field})"
            messages.append(f"{field}: {problem['msg']}")
        raise ValueError("\n".join(messages)) from error
    rows = index_rows(stack, root)
    if check:
        print(f"Validated {len(rows)} observations.")
        return
    catalog = root / "catalog.sqlite"
    descriptor = root / "dataset.yaml"
    if descriptor.exists():
        raise FileExistsError(
            "Archive output already exists. Build in a new dedicated directory."
        )
    with TemporaryDirectory(dir=root) as temp:
        index = Path(temp) / catalog.name
        with closing(sqlite3.connect(index)) as db, db:
            db.executescript("""
                CREATE TABLE frames (variable TEXT, name TEXT, units TEXT, path TEXT,
                    band INTEGER, valid_time INTEGER, reference_time INTEGER,
                    interval_start INTEGER, interval_end INTEGER, temporal_type TEXT,
                    dtype TEXT, nodata, crs TEXT, transform TEXT, height INTEGER, width INTEGER,
                    PRIMARY KEY (variable, valid_time));
                CREATE VIEW observations AS SELECT * FROM frames;
            """)
            db.executemany(
                "INSERT INTO frames VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows
            )
        description = {
            "id": stack.id,
            "title": stack.title,
            "time_labels": stack.variable.period,
            "source": {"format": "temporal_cog", "catalog": catalog.name},
        }
        staged = Path(temp) / "descriptor.pending"
        staged.write_text(
            yaml.safe_dump(description, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
        try:
            catalog.hardlink_to(index)
        except FileExistsError:
            # A previous build may have stopped after installing this exact index.
            if (
                catalog.is_symlink()
                or not catalog.is_file()
                or not filecmp.cmp(index, catalog, shallow=False)
            ):
                raise FileExistsError(
                    "An existing catalog.sqlite differs from the reviewed stack."
                )
        descriptor.hardlink_to(staged)
    print(f"Prepared {len(rows)} observations. Scan the dataset directory in EOLab.")


def main() -> int:
    """Run the interactive draft or reviewed build command.

    Returns:
        Zero for success and one for input or publication failures.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    draft = commands.add_parser(
        "draft", help="Find date clues and write an editable stack.yaml"
    )
    draft.add_argument("directory", type=Path)
    build = commands.add_parser(
        "build", help="Validate stack.yaml and publish its observation index"
    )
    build.add_argument("manifest", type=Path)
    build.add_argument(
        "--check", action="store_true", help="Validate without writing archive files"
    )
    args = parser.parse_args()
    try:
        if args.command == "draft":
            draft_stack(args.directory)
        else:
            build_stack(args.manifest, args.check)
    except (
        ValueError,
        OSError,
        OverflowError,
        EOFError,
        sqlite3.Error,
        yaml.YAMLError,
    ) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
