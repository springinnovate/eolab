"""Preview or apply a one-map sourceRevision migration using PG connection settings.

Run with the new application image during a coordinated upgrade. Back up the
database first and stop old app writers before applying. The default is preview;
normal application startup and saved-map requests never invoke this command.
"""

import argparse
from collections.abc import Sequence
from dataclasses import asdict
import json
import sys

from pydantic import TypeAdapter, ValidationError

from eolab_app.saved_maps.models import SavedMapError, Slug
from eolab_app.saved_maps.store import SavedMapStore


def main(argv: Sequence[str] | None = None) -> int:
    """Run the operator migration and print its result without map data or secrets.

    Args:
        argv: Command arguments, or None to read the process arguments.

    Returns:
        Zero for a successful preview, application or no-op; one for storage or
        migration failure. Connection settings come from standard PG variables.

    Raises:
        SystemExit: With status two for invalid command arguments.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", required=True, help="Existing map URL name")
    parser.add_argument("--apply", action="store_true", help="Commit the migration")
    parser.add_argument(
        "--expected-revision", type=int, help="Revision returned by preview"
    )
    args = parser.parse_args(argv)
    try:
        slug = TypeAdapter(Slug).validate_python(args.slug)
    except ValidationError:
        parser.error("--slug must be an existing lowercase map URL name")
    if args.apply and args.expected_revision is None:
        parser.error("--apply requires --expected-revision from a successful preview")
    if args.expected_revision is not None and args.expected_revision < 1:
        parser.error("--expected-revision must be positive")
    try:
        result = SavedMapStore().migrate_source_revisions(
            slug, apply=args.apply, expected_revision=args.expected_revision
        )
    except SavedMapError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(asdict(result)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
