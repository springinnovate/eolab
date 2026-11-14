"""Allow described nonspatial Items through the pinned STAC API's existing writer.

Run only while building Dockerfile.stac-api. The upstream transaction client
already validates identities and extensions; this patch changes its geometry
predicate alone, without copying the client or changing its request lifecycle.
"""

from importlib import metadata, util
from pathlib import Path

UPSTREAM_VERSION: str = "6.3.1"
ORIGINAL_GEOMETRY_CHECK: str = """        if item.get("geometry", None) is None:
            raise HTTPException(
                status_code=400,
                detail=f"Missing or null `geometry` for Item ({body_item_id}). Geometry is required in pgstac.",
            )
"""
NONSPATIAL_GEOMETRY_CHECK: str = """        if item.get("geometry", None) is None and not (
            collection_id == "eolab-described-nonspatial"
            and "geometry" in item
            and "bbox" not in item
        ):
            raise HTTPException(
                status_code=400,
                detail=f"Missing or null `geometry` for Item ({body_item_id}). Geometry is required in pgstac.",
            )
"""


def patch_transactions_source(source: str) -> str:
    """Replace the reviewed geometry rejection while preserving other validation.

    Args:
        source: Unmodified transactions.py from the digest-pinned upstream image.

    Returns:
        Source accepting an explicit null geometry, with no bbox, only in the
        described nonspatial Collection. All other source text is unchanged.

    Raises:
        RuntimeError: If the reviewed upstream block is absent or ambiguous.
    """
    if source.count(ORIGINAL_GEOMETRY_CHECK) != 1:
        raise RuntimeError("The pinned STAC API geometry validation block changed")
    return source.replace(ORIGINAL_GEOMETRY_CHECK, NONSPATIAL_GEOMETRY_CHECK, 1)


def patch_installed_transactions() -> None:
    """Patch the installed upstream provider during the image build.

    Raises:
        RuntimeError: If the upstream version, module location or validation
            block differs from the reviewed provider.
        metadata.PackageNotFoundError: If the upstream distribution is absent.
        OSError: If its installed source cannot be read or written.
    """
    if metadata.version("stac-fastapi-pgstac") != UPSTREAM_VERSION:
        raise RuntimeError("The nonspatial patch requires STAC FastAPI pgSTAC 6.3.1")
    module = util.find_spec("stac_fastapi.pgstac.transactions")
    if module is None or module.origin is None:
        raise RuntimeError("The installed STAC API transaction module is missing")
    path = Path(module.origin)
    source = path.read_text(encoding="utf-8")
    path.write_text(patch_transactions_source(source), encoding="utf-8")


if __name__ == "__main__":
    patch_installed_transactions()
