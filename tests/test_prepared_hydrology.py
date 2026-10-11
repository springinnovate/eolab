"""Prepared hydrology uses real bounded source reads and path-free, versioned reports."""

import asyncio
from dataclasses import replace
from datetime import timedelta
from itertools import count
from pathlib import Path
from typing import Any

import fiona
import numpy as np
import pytest
import rasterio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from rasterio.transform import from_origin
from shapely.geometry import box, mapping

from catalog_selection_support import FixtureCatalog
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.hydrology_validation import (
    HydrologyValidationLimits,
    validate_hydrology_sources,
    validate_hydrology_process,
    require_network_id,
)
from eolab_app.processing.prepared_hydrology import (
    HydrologyReference,
    PreparedHydrologyDefinition,
    PreparedHydrologyRegistry,
    PreparedHydrologySnapshot,
)
from eolab_app.processing.model_yaml import (
    encode_canonical_json,
    export_yaml,
    parse_yaml,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.service import ProcessingService
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.errors import RasterNotFoundError
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.routes.processing import create_processing_router
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.selection_source import resolve_selection


def prepare_sources(
    directory: Path,
    *,
    records: list[dict[str, Any]] | None = None,
    dem_values: np.ndarray | None = None,
    crs: str | None = "EPSG:4326",
    definition_changes: dict[str, Any] | None = None,
) -> tuple[
    PreparedHydrologyDefinition,
    AuthorizedRaster,
    ResolvedCatalogSelection,
    VectorSamplingService,
]:
    """Write a three-partition eastward network and DEM through real source contracts.

    Args:
        directory: Isolated source directory.
        records: Optional replacement watershed IDs, links, sink IDs and geometries.
        dem_values: Optional raster data; negative 9999 is NoData.
        crs: DEM coordinate system, or None to exercise missing metadata.
        definition_changes: Optional configuration fields to replace.

    Returns:
        Definition, authorized DEM, resolved vector and production reauthorization service.
    """
    directory.mkdir(parents=True, exist_ok=True)
    dem_path = directory / "elevation.tif"
    with rasterio.open(
        dem_path,
        "w",
        driver="GTiff",
        width=6,
        height=4,
        count=1,
        dtype="float32",
        crs=crs,
        nodata=-9999,
        transform=from_origin(0, 4, 1, 1),
    ) as dataset:
        dataset.write(
            np.asarray(
                (
                    dem_values
                    if dem_values is not None
                    else np.tile([6, 5, 4, 3, 2, 1], (4, 1))
                ),
                dtype="float32",
            ),
            1,
        )
    vector_path = directory / "watersheds.gpkg"
    if records is None:
        records = [
            {
                "id": i,
                "next": i + 1 if i < 3 else 0,
                "sink": 3,
                "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
            }
            for i in range(1, 4)
        ]
    with fiona.open(
        vector_path,
        "w",
        driver="GPKG",
        layer="watersheds",
        crs="EPSG:4326",
        schema={
            "geometry": "Polygon",
            "properties": {"id": "int64", "next": "int64", "sink": "int64"},
        },
    ) as dataset:
        for record in records:
            dataset.write(
                {
                    "geometry": record["geometry"],
                    "properties": {key: record[key] for key in ("id", "next", "sink")},
                }
            )
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", vector_path, "data", "watersheds")
    )
    resolved = asyncio.run(
        resolve_selection(
            catalog,
            catalog,
            CatalogVectorFilterRequest(
                collectionId="eolab-mounted-vectors",
                itemId="watersheds",
                filter=VectorFilter(),
            ),
        )
    )
    document = parse_yaml(
        Path("docs/model-examples/prepared-hydrology.yaml").read_bytes()
    )
    definition = PreparedHydrologyDefinition.model_validate(
        {**document, **(definition_changes or {})}
    )
    return (
        definition,
        AuthorizedRaster(dem_path, RasterSourceIdentity.read(dem_path)),
        resolved,
        VectorSamplingService(catalog, catalog),
    )


def test_registration_does_not_read_features_or_claim_network_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Register duplicate IDs without opening a feature stream or inventing counts.

    Args:
        tmp_path: Isolated catalog sources and installed report.
        monkeypatch: Forbid feature iteration through the native driver.
    """
    records = [
        {"id": 1, "next": 0, "sink": 1, "geometry": mapping(box(0, 0, 2, 4))}
    ] * 2
    definition, dem, watersheds, _ = prepare_sources(tmp_path, records=records)
    with pytest.raises(ValueError, match="Duplicate watershed ID"):
        validate_hydrology_sources(
            definition, dem, watersheds, HydrologyValidationLimits()
        )

    def reject_feature_read(*args: Any, **kwargs: Any) -> None:
        """Fail if registration attempts any feature read.

        Args:
            args: Native driver positional arguments.
            kwargs: Native driver keyword arguments.

        Raises:
            AssertionError: On every attempted feature read.
        """
        raise AssertionError("Registration must not iterate watershed features")

    monkeypatch.setattr(fiona.Collection, "filter", reject_feature_read)
    report = validate_hydrology_sources(
        definition,
        dem,
        watersheds,
        HydrologyValidationLimits(features=1, coordinates=1),
        register_only=True,
    )
    document = report.model_dump(mode="json", by_alias=True)
    assert report.validation.validator == "eolab.hydrology-registration/v1"
    assert set(document["validation"]) == {
        "validator",
        "validatedAt",
        "grid",
        "demCellsChecked",
    }
    assert str(tmp_path) not in str(document)
    assert (
        PreparedHydrologySnapshot.model_validate(
            parse_yaml(export_yaml(document, run=True), run=True)
        )
        == report
    )
    (tmp_path / "registered.hydrology.json").write_bytes(
        encode_canonical_json(document)
    )
    assert PreparedHydrologyRegistry.load(tmp_path).get(report.reference) == report
    document["validation"]["watershedCount"] = 2
    with pytest.raises(ValidationError):
        PreparedHydrologySnapshot.model_validate(document)
    with watersheds.path.open("ab") as source:
        source.write(b"changed")
    with pytest.raises(SelectionUnavailableError):
        validate_hydrology_sources(
            definition, dem, watersheds, HydrologyValidationLimits(), register_only=True
        )


def test_connected_network_report_round_trips_without_paths_or_geometries(
    tmp_path: Path,
) -> None:
    """Capture network validation and stable effective identity in a compact report.

    Args:
        tmp_path: Isolated native sources and installed reports.
    """
    definition, dem, watersheds, _ = prepare_sources(tmp_path)
    report = validate_hydrology_sources(
        definition, dem, watersheds, HydrologyValidationLimits()
    )
    assert report.validation.watershedCount == 3
    assert report.validation.terminalCount == 1
    assert report.validation.demCellsChecked == 0
    assert report.validation.validator == "eolab.hydrology-validation/v2"
    assert report.validation.grid.width == 6
    document = report.model_dump(mode="json", by_alias=True)
    assert str(tmp_path) not in str(document)
    assert "coordinates" not in str(document)
    assert (
        PreparedHydrologySnapshot.model_validate(
            parse_yaml(export_yaml(document, run=True), run=True)
        )
        == report
    )
    later = {
        **document,
        "validation": {
            **document["validation"],
            "validatedAt": report.validation.validatedAt + timedelta(seconds=1),
        },
    }
    assert (
        PreparedHydrologySnapshot.model_validate(later).effectiveSha256
        == report.effectiveSha256
    )
    (tmp_path / "example.hydrology.json").write_bytes(encode_canonical_json(document))
    assert PreparedHydrologyRegistry.load(tmp_path).get(report.reference) == report
    assert PreparedHydrologyRegistry.load(None).list_configurations() == ()
    with pytest.raises(ValueError, match="Duplicate"):
        PreparedHydrologyRegistry((report, report))
    with pytest.raises(ProcessingError, match="changed"):
        PreparedHydrologyRegistry((report,)).get(
            report.reference.model_copy(update={"effectiveSha256": "0" * 64})
        )
    changed = {
        **document,
        "definition": {**document["definition"], "title": "Edited after validation"},
    }
    with pytest.raises(ValidationError, match="checksum"):
        PreparedHydrologySnapshot.model_validate(changed)


@pytest.mark.parametrize(
    "change,match",
    [
        ({"id": 1}, "Duplicate watershed"),
        ({"next": 99}, "outside the configured network"),
        ({"next": 1}, "cycle"),
        ({"sink": 2}, "terminal drainage"),
        ({"next": None}, "non-null integer"),
    ],
)
def test_bad_networks_fail_before_any_model_runs(
    tmp_path: Path, change: dict[str, Any], match: str
) -> None:
    """Reject malformed links and identifiers independently of terrain coverage.

    Args:
        tmp_path: Isolated native sources.
        change: Invalid fields for the second partition.
        match: Expected actionable failure.
    """
    records = [
        {
            "id": i,
            "next": i + 1 if i < 3 else 0,
            "sink": 3,
            "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
        }
        for i in range(1, 4)
    ]
    records[1].update(change)
    definition, dem, watersheds, _ = prepare_sources(tmp_path, records=records)
    with pytest.raises(ValueError, match=match):
        validate_hydrology_sources(
            definition, dem, watersheds, HydrologyValidationLimits()
        )


@pytest.mark.parametrize("value", [-9999, float("nan"), float("inf")])
def test_installation_defers_elevation_validity_to_runs(
    tmp_path: Path, value: float
) -> None:
    """Allow installation without reading NoData or nonfinite elevation cells.

    Args:
        tmp_path: Isolated sources.
        value: Invalid value in the last watershed, beyond the starting partition.
    """
    values = np.ones((4, 6))
    values[2, 5] = value
    definition, dem, watersheds, _ = prepare_sources(tmp_path, dem_values=values)
    report = validate_hydrology_sources(
        definition, dem, watersheds, HydrologyValidationLimits()
    )
    assert report.validation.demCellsChecked == 0


@pytest.mark.parametrize(
    "limits,match",
    [
        (HydrologyValidationLimits(features=1), "feature budget"),
        (HydrologyValidationLimits(coordinates=4), "retained-coordinate budget"),
    ],
)
def test_native_validation_obeys_work_budgets(
    tmp_path: Path, limits: HydrologyValidationLimits, match: str
) -> None:
    """Stop bounded work with an explicit diagnostic rather than partially validating data.

    Args:
        tmp_path: Isolated sources.
        limits: One deliberately exhausted work budget.
        match: Expected budget diagnostic.
    """
    definition, dem, watersheds, _ = prepare_sources(tmp_path)
    with pytest.raises(ValueError, match=match):
        validate_hydrology_sources(definition, dem, watersheds, limits)


@pytest.mark.parametrize("register_only", [False, True])
def test_missing_fields_and_changed_sources_are_rejected(
    tmp_path: Path, register_only: bool
) -> None:
    """Catalog signatures and exact field names remain required independently of rendering.

    Args:
        tmp_path: Isolated native sources.
        register_only: Whether to omit the full-network scan.
    """
    definition, dem, watersheds, _ = prepare_sources(tmp_path)
    missing = definition.model_copy(
        update={
            "topology": definition.topology.model_copy(update={"idField": "absent"})
        }
    )
    with pytest.raises(ValueError, match="attribute field is missing"):
        validate_hydrology_sources(
            missing,
            dem,
            watersheds,
            HydrologyValidationLimits(),
            register_only=register_only,
        )
    with dem.source_path.open("ab") as source:
        source.write(b"changed")
    with pytest.raises(SelectionUnavailableError, match="DEM changed"):
        validate_hydrology_sources(
            definition,
            dem,
            watersheds,
            HydrologyValidationLimits(),
            register_only=register_only,
        )


@pytest.mark.parametrize("register_only", [False, True])
def test_metadata_routes_reauthorize_sources_without_viewer_or_geoserver(
    tmp_path: Path,
    register_only: bool,
) -> None:
    """Discover reports and reject stale selection through real Processing HTTP routes.

    Args:
        tmp_path: Isolated source datasets.
        register_only: Whether installation only registered metadata.
    """
    definition, dem, watersheds, reader = prepare_sources(tmp_path)
    report = validate_hydrology_sources(
        definition,
        dem,
        watersheds,
        HydrologyValidationLimits(),
        register_only=register_only,
    )

    class DemAuthority:
        """Supply the catalog-authorized fixture DEM without a rendering service."""

        available: bool = True

        async def authorize(self, request: Any) -> AuthorizedRaster:
            """Resolve only the fixture catalog identity.

            Args:
                request: DEM catalog identity.

            Returns:
                The originally authorized immutable source.

            Raises:
                RasterNotFoundError: When the catalog no longer authorizes this source.
            """
            assert request == definition.dem
            if not self.available:
                raise RasterNotFoundError(
                    "The prepared DEM is no longer in the catalog."
                )
            return dem

    authority = DemAuthority()
    service = ProcessingService(
        object(),
        object(),
        model_authorizer=authority,
        hydrology_registry=PreparedHydrologyRegistry((report,)),
        hydrology_selections=reader,
    )
    app = FastAPI()
    app.include_router(create_processing_router(service))
    with TestClient(app) as client:
        response = client.get("/api/processing/prepared-hydrology")
        assert response.status_code == 200
        assert (
            response.json()["configurations"][0]["effectiveSha256"]
            == report.effectiveSha256
        )
        reference = report.reference.model_dump()
        response = client.post(
            "/api/processing/prepared-hydrology/resolve", json=reference
        )
        assert response.status_code == 403
        response = client.post(
            "/api/processing/prepared-hydrology/resolve",
            json=reference,
            headers={"X-EOLab-Processing": "1"},
        )
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store"
        assert str(tmp_path) not in response.text
        authority.available = False
        response = client.post(
            "/api/processing/prepared-hydrology/resolve",
            json=reference,
            headers={"X-EOLab-Processing": "1"},
        )
        assert response.status_code == 404
        authority.available = True
        with dem.source_path.open("ab") as source:
            source.write(b"changed")
        response = client.post(
            "/api/processing/prepared-hydrology/resolve",
            json=reference,
            headers={"X-EOLab-Processing": "1"},
        )
        assert response.status_code == 409, response.text
        assert response.json()["detail"]["code"] == "hydrology_changed"


def test_native_process_returns_the_same_report(tmp_path: Path) -> None:
    """Use the existing native supervisor for successful administrator validation.

    Args:
        tmp_path: Isolated native sources.
    """
    from eolab_app.execution.reusable_process import ReusableProcess

    definition, dem, watersheds, _ = prepare_sources(tmp_path)

    async def run() -> dict[str, Any]:
        """Validate and reclaim the native process before returning its report.

        Returns:
            Successful native validation response.
        """
        process = ReusableProcess(
            (validate_hydrology_process,), address_space_bytes=2 * 1024**3
        )
        try:
            success, result = await process.run(
                validate_hydrology_process,
                (definition, dem, watersheds, HydrologyValidationLimits()),
                30,
            )
            assert success, result
            return result
        finally:
            await process.close()

    report = PreparedHydrologySnapshot.model_validate(asyncio.run(run()))
    assert report.validation.demCellsChecked == 0
    assert report.validation.validator == "eolab.hydrology-validation/v2"


@pytest.mark.parametrize("register_only", [False, True])
def test_installation_never_reads_dem_pixels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, register_only: bool
) -> None:
    """Inspect real DEM metadata while rejecting any attempt to read pixel data.

    Args:
        tmp_path: Isolated source datasets.
        monkeypatch: Replace the Rasterio reader with a metadata-only reader.
        register_only: Whether installation omits watershed features as well.
    """
    definition, dem, watersheds, _ = prepare_sources(tmp_path)

    class MetadataOnlyReader(rasterio.io.DatasetReader):
        """Expose the real raster metadata while forbidding elevation and mask reads."""

        def read(self, *args: Any, **kwargs: Any) -> None:
            """Reject a pixel read during installation.

            Args:
                args: Rasterio positional read arguments.
                kwargs: Rasterio keyword read arguments.

            Raises:
                AssertionError: On every attempted pixel read.
            """
            raise AssertionError("Installation must not read DEM pixels")

        def read_masks(self, *args: Any, **kwargs: Any) -> None:
            """Reject a validity-mask read during installation.

            Args:
                args: Rasterio positional read arguments.
                kwargs: Rasterio keyword read arguments.

            Raises:
                AssertionError: On every attempted mask read.
            """
            raise AssertionError("Installation must not read DEM validity masks")

    monkeypatch.setattr(rasterio, "open", MetadataOnlyReader)
    report = validate_hydrology_sources(
        definition,
        dem,
        watersheds,
        HydrologyValidationLimits(),
        register_only=register_only,
    )
    assert report.validation.demCellsChecked == 0


def test_legacy_coverage_reports_keep_their_checksum(tmp_path: Path) -> None:
    """Keep installed version 1 reports and saved Run YAML readable without migration.

    Args:
        tmp_path: Isolated original sources and legacy report file.
    """
    from eolab_app.processing.model_yaml import compute_document_checksum

    definition, dem, watersheds, _ = prepare_sources(tmp_path)
    report = validate_hydrology_sources(
        definition, dem, watersheds, HydrologyValidationLimits()
    )
    document = report.model_dump(mode="json", by_alias=True)
    document["validation"].update(
        validator="eolab.hydrology-validation/v1", demCellsChecked=24
    )
    # Compute the original wire checksum without using the updated model serializer.
    payload = {
        key: value for key, value in document.items() if key != "effectiveSha256"
    }
    payload["validation"] = {
        key: value
        for key, value in document["validation"].items()
        if key != "validatedAt"
    }
    document["effectiveSha256"] = compute_document_checksum(payload)
    (tmp_path / "legacy.hydrology.json").write_bytes(encode_canonical_json(document))
    restored = PreparedHydrologyRegistry.load(tmp_path).list_configurations()[0]
    assert restored.model_dump(mode="json", by_alias=True) == document
    for validator, cells in (("v1", 0), ("v2", 24)):
        document["validation"].update(
            validator=f"eolab.hydrology-validation/{validator}", demCellsChecked=cells
        )
        with pytest.raises(ValidationError, match="validator scope"):
            PreparedHydrologySnapshot.model_validate(document)


@pytest.mark.parametrize(
    "value,id_type",
    [
        (1.0, "integer"),
        (True, "integer"),
        ("1", "integer"),
        (1, "string"),
        ("", "string"),
        (None, "string"),
    ],
)
def test_identifiers_are_not_coerced(value: Any, id_type: str) -> None:
    """Reject mixed ID types instead of creating ambiguous or rounded graph links.

    Args:
        value: Source value that violates the declared convention.
        id_type: Configured ID convention.
    """
    with pytest.raises(ValueError, match="watershed IDs"):
        require_network_id(value, id_type, "watershed_id")
    assert require_network_id("0001", "string", "watershed_id") == "0001"
    assert require_network_id(0, "integer", "watershed_id") == 0


def test_installation_defers_spatial_gaps_to_selected_runs(tmp_path: Path) -> None:
    """Validate network links without claiming spatial coverage for any run.

    Args:
        tmp_path: Isolated source datasets.
    """
    records = [
        {"id": 1, "next": 2, "sink": 2, "geometry": mapping(box(0, 0, 0.6, 4))},
        {"id": 2, "next": 0, "sink": 2, "geometry": mapping(box(2.4, 0, 4, 4))},
    ]
    definition, dem, watersheds, _ = prepare_sources(tmp_path, records=records)
    report = validate_hydrology_sources(
        definition, dem, watersheds, HydrologyValidationLimits()
    )
    assert report.validation.watershedCount == 2


def test_zero_and_negative_elevations_and_multiple_drainages_are_valid(
    tmp_path: Path,
) -> None:
    """Accept multiple complete drainage graphs regardless of elevation values.

    Args:
        tmp_path: Isolated sources.
    """
    records = [
        {
            "id": i,
            "next": 0,
            "sink": i,
            "geometry": mapping(box((i - 1) * 2, 0, i * 2, 4)),
        }
        for i in range(1, 4)
    ]
    definition, dem, watersheds, _ = prepare_sources(
        tmp_path, records=records, dem_values=np.tile([-3, -2, -1, 0, 1, 2], (4, 1))
    )
    report = validate_hydrology_sources(
        definition, dem, watersheds, HydrologyValidationLimits()
    )
    assert report.validation.terminalCount == 3
    assert report.validation.demCellsChecked == 0
    assert report.validation.validator == "eolab.hydrology-validation/v2"


def test_missing_crs_and_wrong_terminal_mapping_fail(tmp_path: Path) -> None:
    """Explain unsupported source georeferencing and inconsistent stop rules.

    Args:
        tmp_path: Isolated sources.
    """
    definition, dem, watersheds, _ = prepare_sources(tmp_path / "missing-crs", crs=None)
    with pytest.raises(ValueError, match="valid source CRS"):
        validate_hydrology_sources(
            definition, dem, watersheds, HydrologyValidationLimits()
        )
    definition, dem, watersheds, _ = prepare_sources(tmp_path / "bad-stop")
    document = definition.model_dump(mode="json", by_alias=True)
    document["topology"]["terminal"] = {"field": "sink", "value": 3}
    with pytest.raises(ValueError, match="still links to another watershed"):
        validate_hydrology_sources(
            PreparedHydrologyDefinition.model_validate(document),
            dem,
            watersheds,
            HydrologyValidationLimits(),
        )


@pytest.mark.parametrize("register_only", [False, True])
def test_captured_model_run_retains_exact_hydrology_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, register_only: bool
) -> None:
    """A registered input capability captures reports in the existing Run YAML contract.

    Args:
        tmp_path: Isolated native sources.
        monkeypatch: Temporary trusted operation registration to exercise the input contract.
        register_only: Whether the captured evidence is registration or full validation.
    """
    from datetime import datetime, timezone
    from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
    from eolab_app.processing.model_run_contracts import (
        ModelRunRequest,
        ModelInvocation,
        RunDocument,
    )
    from eolab_app.processing.model_runs import (
        build_model_calculation_request,
        build_model_job_submission,
    )
    import eolab_app.processing.model_operations as operations
    import eolab_app.processing.model_definitions as definitions
    from unittest.mock import AsyncMock, Mock
    from eolab_app.processing.ports import JobStore, JobArtifactStore
    from eolab_app.raster.ports import RasterSourceAuthorizer

    definition, dem, watersheds, reader = prepare_sources(tmp_path)
    snapshot = validate_hydrology_sources(
        definition,
        dem,
        watersheds,
        HydrologyValidationLimits(),
        register_only=register_only,
    )
    operation = operations.get_model_operation("raster.aggregate.v1")
    recipe = ModelRegistry.load_installed().get("raster-summary", "1.1.0").to_document()
    registry = {
        **operations.OPERATIONS,
        operation.id: replace(
            operation, inputs=(*operation.inputs, ("hydrology", "prepared_hydrology"))
        ),
    }
    monkeypatch.setattr(operations, "OPERATIONS", registry)
    monkeypatch.setattr(definitions, "OPERATIONS", registry)
    recipe["inputs"]["terrain"] = {
        "type": "prepared_hydrology",
        "label": "Terrain and watersheds",
    }
    recipe["steps"][0]["inputs"]["hydrology"] = {"input": "terrain"}
    model = ModelDefinition.model_validate(recipe)
    request = ModelRunRequest(
        requestId="a" * 32,
        model={
            "id": model.id,
            "version": model.version,
            "definitionSha256": model.digest,
        },
        inputs={
            "raster": definition.dem.model_dump(by_alias=True),
            "area": {"kind": "wholeRaster"},
            "terrain": snapshot.reference.model_dump(),
        },
        label="Example hydrology capture",
    )
    installed = ModelRegistry((model,))
    with pytest.raises(ProcessingError, match="invalid"):
        build_model_calculation_request(request, installed)
    calculation, invocation = build_model_calculation_request(
        request, installed, hydrology={"terrain": snapshot}
    )
    plan = build_model_job_submission(
        operation.queue(calculation, None),
        invocation,
        tuple(dem.source_signature.to_catalog()),
    )
    jobs = Mock(spec=JobStore)
    jobs.find_request.return_value = None
    now = datetime.now(timezone.utc)
    row = {
        "id": "b" * 32,
        "operation": "model.run.v1",
        "status": "queued",
        "summary": plan.summary,
        "progress": {},
        "error": None,
        "created_at": now,
        "updated_at": now,
        "expires_at": now + timedelta(days=1),
    }
    jobs.submit.return_value = row
    authorizer = Mock(spec=RasterSourceAuthorizer)
    authorizer.authorize = AsyncMock(return_value=dem)
    service = ProcessingService(
        jobs,
        Mock(spec=JobArtifactStore),
        model_registry=installed,
        model_authorizer=authorizer,
        hydrology_registry=PreparedHydrologyRegistry((snapshot,)),
        hydrology_selections=reader,
    )
    submitted = asyncio.run(service.submit_model_run("owner", request))
    assert submitted["jobId"] == row["id"]
    _, _, admitted, request_hash = jobs.submit.call_args.args
    assert admitted.retained_metadata == plan.retained_metadata
    plan = admitted
    # An unchanged retry returns the accepted run even after this dataset is removed.
    row["request_hash"] = request_hash
    jobs.find_request.return_value = row
    service.hydrology_registry = PreparedHydrologyRegistry()
    assert asyncio.run(service.submit_model_run("owner", request)) == submitted
    jobs.submit.assert_called_once()
    jobs.find_request.return_value = None
    with pytest.raises(ProcessingError, match="not installed"):
        asyncio.run(service.submit_model_run("owner", request))
    jobs.submit.assert_called_once()
    document = RunDocument.model_validate(
        {
            "schema": "eolab.run/v1",
            "jobId": "a" * 32,
            "capturedAt": datetime.now(timezone.utc),
            **plan.retained_metadata,
        }
    )
    restored = RunDocument.model_validate(
        parse_yaml(
            export_yaml(document.model_dump(mode="json", by_alias=True), run=True),
            run=True,
        )
    )
    assert restored.invocation.hydrology["terrain"] == snapshot
    assert str(tmp_path) not in str(restored.model_dump())
    bad = invocation.model_dump(mode="json", by_alias=True)
    bad["inputs"]["terrain"]["effectiveSha256"] = "0" * 64
    with pytest.raises(ValidationError, match="does not match"):
        ModelInvocation.model_validate(bad)


def validate_hydrology_with_slow_reader_clock(
    writer: ProcessResultWriter,
    definition: PreparedHydrologyDefinition,
    dem: AuthorizedRaster,
    watersheds: ResolvedCatalogSelection,
    limits: HydrologyValidationLimits,
    register_only: bool = False,
) -> None:
    """Exercise real native validation with eight simulated seconds per watershed.

    Args:
        writer: Supervisor result channel from the real CLI process.
        definition: Administrator configuration resolved by the CLI.
        dem: Authorized original terrain source.
        watersheds: Authorized complete watershed network.
        limits: Administrator budgets passed across the native-process boundary.
        register_only: Whether to register metadata without advancing the slow reader.
    """
    import eolab_app.bounded_vector as reader

    original_clock = reader.monotonic
    ticks = count(step=8.0)
    reader.monotonic = lambda: next(ticks)
    try:
        validate_hydrology_process(
            writer, definition, dem, watersheds, limits, register_only
        )
    finally:
        reader.monotonic = original_clock


def test_administrator_command_uses_catalog_sources_and_atomic_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pass CLI time budgets into native reads and install only complete reports.

    Args:
        tmp_path: Isolated original sources, YAML and report.
        monkeypatch: Replace catalog HTTP and the native reader's elapsed-time clock.
    """
    import argparse
    import httpx2
    from eolab_app.catalog.geotiff import build_stac_item
    from eolab_app.catalog.geopackage import build_stac_items
    from eolab_app.hydrology_cli import validate_configuration

    monkeypatch.setattr(
        "eolab_app.processing.hydrology_validation.validate_hydrology_process",
        validate_hydrology_with_slow_reader_clock,
    )

    definition, dem, watersheds, _ = prepare_sources(tmp_path)
    raster_item = build_stac_item(tmp_path, dem.source_path)
    (vector_item,) = build_stac_items(tmp_path, watersheds.path)
    document = definition.model_dump(mode="json", by_alias=True)
    document["dem"]["itemId"] = raster_item["id"]
    document["watersheds"]["itemId"] = vector_item["id"]
    configuration = tmp_path / "configuration.yaml"
    configuration.write_bytes(export_yaml(document))
    items = {raster_item["id"]: raster_item, vector_item["id"]: vector_item}
    client_type = httpx2.AsyncClient

    def catalog(request: httpx2.Request) -> httpx2.Response:
        """Return scanner-owned metadata for the exact requested fixture Item.

        Args:
            request: STAC lookup from production catalog adapters.

        Returns:
            The real scanned fixture Item or a missing-item response.
        """
        item = items.get(request.url.path.rsplit("/", 1)[-1])
        return httpx2.Response(200, json=item) if item else httpx2.Response(404)

    monkeypatch.setattr(
        httpx2,
        "AsyncClient",
        lambda **kwargs: client_type(transport=httpx2.MockTransport(catalog), **kwargs),
    )
    output = tmp_path / "example.hydrology.json"
    args = argparse.Namespace(
        configuration=configuration,
        output=output,
        catalog_url="http://catalog",
        scan_mount=tmp_path,
        max_features=100,
        max_coordinates=10000,
        memory_mib=2048,
        timeout_seconds=30,
        register_only=False,
    )
    asyncio.run(validate_configuration(args))
    original = output.read_bytes()
    report = PreparedHydrologyRegistry.load(tmp_path).list_configurations()[0]
    assert report.validation.watershedCount == 3
    args.max_features = 1
    with pytest.raises(ValueError, match="feature budget"):
        asyncio.run(validate_configuration(args))
    assert output.read_bytes() == original
    assert str(tmp_path) not in original.decode()
    args.max_features = 100
    args.timeout_seconds = 15
    with pytest.raises(ValueError, match="15-second time budget"):
        asyncio.run(validate_configuration(args))
    assert output.read_bytes() == original
    args.register_only = True
    args.max_features = 1
    asyncio.run(validate_configuration(args))
    registration = output.read_bytes()
    report = PreparedHydrologyRegistry.load(tmp_path).list_configurations()[0]
    assert report.validation.validator == "eolab.hydrology-registration/v1"
    assert "watershedCount" not in report.validation.model_dump()
    document["topology"]["idField"] = "missing"
    configuration.write_bytes(export_yaml(document))
    with pytest.raises(ValueError, match="attribute field is missing"):
        asyncio.run(validate_configuration(args))
    assert output.read_bytes() == registration


def test_hydrology_configuration_settings_are_optional_and_reports_fail_closed(
    configured_environment: None,
    version_file_path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Load reports through real application composition and diagnose bad administrator settings.

    Args:
        configured_environment: Valid baseline application environment.
        version_file_path: Isolated build version fixture.
        tmp_path: Configuration directory and real native source fixtures.
        monkeypatch: Explicit optional deployment setting.
    """
    from eolab_app.main import create_app
    from eolab_app.settings import load_settings

    monkeypatch.delenv("PREPARED_HYDROLOGY_DIRECTORY", raising=False)
    assert load_settings(version_file_path).prepared_hydrology_directory is None
    monkeypatch.setenv("PREPARED_HYDROLOGY_DIRECTORY", "relative/directory")
    with pytest.raises(ValueError, match="absolute path"):
        load_settings(version_file_path)
    definition, dem, watersheds, _ = prepare_sources(tmp_path)
    snapshot = validate_hydrology_sources(
        definition, dem, watersheds, HydrologyValidationLimits()
    )
    report_path = tmp_path / "example.hydrology.json"
    report_path.write_bytes(
        encode_canonical_json(snapshot.model_dump(mode="json", by_alias=True))
    )
    monkeypatch.setenv("PREPARED_HYDROLOGY_DIRECTORY", str(tmp_path))
    application = create_app(version_file_path)
    # No lifespan or database is required to discover installed metadata.
    client = TestClient(application)
    assert (
        client.get("/api/processing/prepared-hydrology").json()["configurations"][0][
            "effectiveSha256"
        ]
        == snapshot.effectiveSha256
    )
    report_path.write_text('{"invalid": true}', encoding="utf-8")
    with pytest.raises(ValidationError):
        create_app(version_file_path)


def test_installation_accepts_internal_masks_but_rejects_source_replacement(
    tmp_path: Path,
) -> None:
    """Defer embedded elevation validity while preserving original vector identity.

    Args:
        tmp_path: Isolated native datasets.
    """
    definition, dem, watersheds, reader = prepare_sources(tmp_path)
    snapshot = validate_hydrology_sources(
        definition, dem, watersheds, HydrologyValidationLimits()
    )
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
        rasterio.open(dem.source_path, "r+") as dataset,
    ):
        validity = np.full((4, 6), 255, dtype="uint8")
        validity[1, 4] = 0
        dataset.write_mask(validity)
    dem = replace(dem, source_signature=RasterSourceIdentity.read(dem.source_path))
    report = validate_hydrology_sources(
        definition, dem, watersheds, HydrologyValidationLimits()
    )
    assert report.validation.demCellsChecked == 0
    with watersheds.path.open("ab") as dataset:
        dataset.write(b"changed")
    with pytest.raises(SelectionUnavailableError, match="identity changed"):
        asyncio.run(reader.resolve_for_sampling(snapshot.watershedSelection))
