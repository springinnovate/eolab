"""Verify authoring boundaries and shared public catalog metadata fixtures."""

import json
from pathlib import Path
import subprocess
import sys
from typing import Any
from urllib.parse import parse_qs, urlsplit

from pydantic import ValidationError
import pytest
import yaml

from eolab_app.catalog.descriptor_contract import (
    ASSET_ACCESS_KEY,
    CURATED_METADATA_KEY,
    CatalogDescriptor,
    LocalAsset,
    NONSPATIAL_COLLECTION_ID,
    assets_for_item,
    catalog_asset_href,
    descriptor_json_schema,
    metadata_for_item,
    parse_catalog_descriptor,
    public_asset_fields,
    public_metadata_fields,
    public_temporal_fields,
)

FIXTURES = Path(__file__).parent / "fixtures/catalog_descriptors"


def descriptor_document(name: str = "raster") -> dict[str, Any]:
    """Read a representative authoring document for external-input tests.

    Args:
        name: Fixture basename without its descriptor suffix.

    Returns:
        Mutable YAML-decoded descriptor data.
    """
    return yaml.safe_load((FIXTURES / f"{name}.eolab.yaml").read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "record", json.loads((FIXTURES / "public-items.json").read_text(encoding="utf-8"))
)
def test_descriptor_produces_shared_public_fixture(record: dict[str, Any]) -> None:
    """Keep authoring, public Asset identity and consumer fixtures synchronized.

    Args:
        record: A descriptor/selector and its expected public STAC Item.
    """
    descriptor = parse_catalog_descriptor(
        (FIXTURES / record["descriptor"]).read_text(encoding="utf-8")
    )
    item = record["item"]
    metadata = metadata_for_item(descriptor, record["selector"])
    projected = public_metadata_fields(metadata)
    assert {key: item["properties"][key] for key in projected} == projected
    assert item["assets"] == {
        key: public_asset_fields(asset, item["collection"], item["id"], key)
        for key, asset in assets_for_item(descriptor, record["selector"]).items()
    }
    if descriptor.temporal is not None:
        times = public_temporal_fields(
            descriptor.temporal, modified_at="2026-11-13T12:00:00Z"
        )
        assert {key: item["properties"][key] for key in times} == times
    if descriptor.kind == "nonspatial":
        assert item["collection"] == NONSPATIAL_COLLECTION_ID
        assert item["geometry"] is None
        assert "bbox" not in item
        assert item["properties"]["eolab:time_basis"] == "source-modified"
        assert (
            item["properties"][CURATED_METADATA_KEY]["study_time"]
            == "May to September 2023"
        )
        assert (
            item["properties"][CURATED_METADATA_KEY]["publications"][0]["year"] == 2024
        )


def test_container_overrides_preserve_scopes_and_explicit_clears() -> None:
    """Inherit omitted fields while replacing only supplied layer metadata."""
    descriptor = CatalogDescriptor.model_validate(descriptor_document("container"))
    sites = metadata_for_item(descriptor, "sites")
    assert sites.title == "Survey sites"
    assert sites.description is None
    assert sites.keywords == []
    assert sites.publications == descriptor.metadata.publications
    assert sites.annotations == {
        "relationship": "described_asset",
        "sample_count": 0,
        "reviewed": False,
    }
    assert descriptor.metadata.description == "Common study description."
    assert descriptor.metadata.annotations == {"objective": "Shared study objective."}
    assert metadata_for_item(descriptor, "other").title == "Survey layers"
    assert set(assets_for_item(descriptor, "sites")) == {
        "data",
        "methods",
        "field_notes",
    }
    assert set(assets_for_item(descriptor, "regions")) == {"data", "methods"}
    assert (
        assets_for_item(descriptor, "sites")["methods"]
        == assets_for_item(descriptor, "regions")["methods"]
    )


def test_json_annotations_keep_values_and_asset_scope() -> None:
    """Retain null, zero, false and nested annotations without flattening Assets."""
    descriptor = CatalogDescriptor.model_validate(descriptor_document())
    public = public_metadata_fields(descriptor.metadata)
    annotations = public[CURATED_METADATA_KEY]["annotations"]
    assert public[CURATED_METADATA_KEY]["doi"] == "10.1234/example-flood-dataset"
    assert (
        public[CURATED_METADATA_KEY]["publications"][0]["doi"]
        == "10.1234/example-flood"
    )
    assert annotations["observed_minimum"] == 0
    assert annotations["reviewed"] is False
    assert annotations["missing_note"] is None
    assert annotations["evidence"]["limitations"] == [
        "Missing southern sites",
        "Different temporal aggregation",
    ]
    support = public_asset_fields(
        descriptor.assets["observations"], "collection", "item", "observations"
    )
    assert support[CURATED_METADATA_KEY]["annotations"]["zero_is_valid"] is True
    assert "zero_is_valid" not in annotations
    public["keywords"].append("changed by caller")
    assert descriptor.metadata.keywords == ["flood", "depth"]


def test_public_local_assets_use_self_contained_catalog_identity() -> None:
    """Expose a usable catalog route without local paths or source selectors."""
    descriptor = CatalogDescriptor.model_validate(descriptor_document("vector-sites"))
    asset = descriptor.assets["methods"]
    assert isinstance(asset, LocalAsset)
    public = public_asset_fields(asset, "collection a", "item/b", "methods & notes")
    assert public[ASSET_ACCESS_KEY] == {"kind": "catalog"}
    url = urlsplit(public["href"])
    assert url.path == "/api/catalog/asset"
    assert parse_qs(url.query) == {
        "collection": ["collection a"],
        "item": ["item/b"],
        "asset": ["methods & notes"],
    }
    assert asset.path not in json.dumps(public)
    assert "path" not in public and "source" not in public and "layer" not in public
    assert public["href"] == catalog_asset_href(
        "collection a", "item/b", "methods & notes"
    )


@pytest.mark.parametrize(
    "href",
    [
        "javascript:alert(1)",
        "file:///private/data",
        "//example.org/path",
        "https://user:password@example.org/a",
        "https://example.org/a b",
        "https:///missing-host",
        "https://example.org:bad/data",
        "https://example.org/\x00data",
        "https://example.org\\data",
    ],
)
def test_external_links_reject_unsafe_schemes_and_credentials(href: str) -> None:
    """Reject links that cannot be exposed as HTTP(S) publication/Asset URLs.

    Args:
        href: Invalid external URL supplied by an author.
    """
    document = descriptor_document()
    document["assets"]["publication"]["href"] = href
    with pytest.raises(ValidationError):
        CatalogDescriptor.model_validate(document)
    document = descriptor_document()
    document["metadata"]["publications"][0]["url"] = href
    with pytest.raises(ValidationError):
        CatalogDescriptor.model_validate(document)


@pytest.mark.parametrize(
    "path",
    [
        "/root/file",
        "C:/private/file",
        "C:relative",
        "\\\\server/share",
        "https://example.org/file",
        "folder\\file",
        "",
        ".",
        "nul\x00file",
    ],
)
def test_local_assets_reject_nonportable_locations(path: str) -> None:
    """Keep absolute locations and URI inputs out of descriptor-relative paths.

    Args:
        path: Invalid local Asset path.
    """
    document = descriptor_document()
    document["assets"]["data"]["path"] = path
    with pytest.raises(ValidationError):
        CatalogDescriptor.model_validate(document)


@pytest.mark.parametrize(
    "change",
    [
        {"schema": "eolab/item/v2"},
        {"id": "contains spaces"},
        {"primary_asset": "missing"},
        {"kind": "vector"},
        {"source": {"format": "new-reader"}},
        {"source": {"format": "geotiff", "layer": "unexpected"}},
        {"metadata": {"title": None}},
        {"unrecognized": "typo"},
    ],
)
def test_descriptor_rejects_unsupported_or_inconsistent_shapes(
    change: dict[str, Any],
) -> None:
    """Reject external authoring mistakes before source admission.

    Args:
        change: Top-level replacement fields applied to a valid raster fixture.
    """
    document = {**descriptor_document(), **change}
    with pytest.raises(ValidationError):
        CatalogDescriptor.model_validate(document)


def test_nonspatial_time_is_explicit_and_modified_requires_local_source() -> None:
    """Never infer an observation date from an absent nonspatial time policy."""
    document = descriptor_document("nonspatial")
    document.pop("temporal")
    with pytest.raises(ValidationError, match="temporal"):
        CatalogDescriptor.model_validate(document)
    document = descriptor_document("nonspatial")
    document["assets"]["data"] = {
        "location": "external",
        "href": "https://example.org/data.csv",
        "media_type": "text/csv",
    }
    with pytest.raises(ValidationError, match="local primary"):
        CatalogDescriptor.model_validate(document)
    document["temporal"] = {"mode": "instant", "datetime": "2020-01-01T00:00:00Z"}
    assert CatalogDescriptor.model_validate(document).kind == "nonspatial"


@pytest.mark.parametrize(
    "temporal",
    [
        {"mode": "instant", "datetime": "2020"},
        {"mode": "instant", "datetime": "2020-01-01T00:00:00"},
        {"mode": "instant", "datetime": "2020-02-30T00:00:00Z"},
        {
            "mode": "interval",
            "start_datetime": "2020-01-02T00:00:00Z",
            "end_datetime": "2020-01-01T23:00:00Z",
        },
    ],
)
def test_observation_dates_reject_ambiguous_or_reversed_values(
    temporal: dict[str, str],
) -> None:
    """Require complete observation times and order intervals in absolute time.

    Args:
        temporal: Invalid external temporal metadata.
    """
    document = descriptor_document()
    document["temporal"] = temporal
    with pytest.raises(ValidationError):
        CatalogDescriptor.model_validate(document)


def test_interval_order_accounts_for_offsets() -> None:
    """Accept equivalent interval endpoints written with different offsets."""
    document = descriptor_document()
    document["temporal"] = {
        "mode": "interval",
        "start_datetime": "2020-01-02T01:00:00+01:00",
        "end_datetime": "2020-01-02T00:00:00Z",
    }
    assert CatalogDescriptor.model_validate(document).temporal is not None


@pytest.mark.parametrize(
    "override",
    [
        {"metadata": {"title": None}},
        {
            "assets": {
                "data": {
                    "location": "local",
                    "path": "another.gpkg",
                    "media_type": "application/geopackage+sqlite3",
                }
            }
        },
    ],
)
def test_container_override_cannot_clear_title_or_replace_primary(
    override: dict[str, Any],
) -> None:
    """Keep primary source identity and required Item titles outside overrides.

    Args:
        override: Invalid per-layer replacement.
    """
    document = descriptor_document("container")
    document["item_overrides"] = {"sites": override}
    with pytest.raises(ValidationError):
        CatalogDescriptor.model_validate(document)


def test_exact_selection_rejects_other_layer_overrides() -> None:
    """Reject an override for a layer the descriptor explicitly excludes."""
    document = descriptor_document("container")
    document["source"]["layer"] = "sites"
    with pytest.raises(ValidationError, match="explicitly selected"):
        CatalogDescriptor.model_validate(document)


def test_paper_doi_is_not_an_external_url() -> None:
    """Separate the paper's DOI name from its independently validated URL."""
    document = descriptor_document()
    document["metadata"]["publications"][0]["doi"] = "https://doi.org/10.1234/example"
    with pytest.raises(ValidationError, match="DOI name"):
        CatalogDescriptor.model_validate(document)


def test_exported_schema_matches_typed_authoring_contract() -> None:
    """Make schema drift visible to external descriptor authors."""
    schema_path = Path("catalog/schemas/eolab-item-v1.schema.json")
    assert (
        json.loads(schema_path.read_text(encoding="utf-8")) == descriptor_json_schema()
    )


def test_contract_import_is_independent_of_native_and_application_modules() -> None:
    """Load authoring validation without GIS readers, application services or UI."""
    source = str(Path("src").resolve())
    code = f"import sys; sys.path.insert(0, {source!r}); import eolab_app.catalog.descriptor_contract; assert not any(name.startswith(('rasterio', 'fiona', 'osgeo', 'eolab_app.main', 'eolab_app.raster', 'eolab_app.vector', 'fastapi')) for name in sys.modules)"
    subprocess.run(
        [sys.executable, "-B", "-c", code], check=True, capture_output=True, text=True
    )


@pytest.mark.parametrize(
    ("kind", "source", "expected"),
    [
        ("raster", {"format": "geotiff"}, "data"),
        ("vector", {"format": "geopackage"}, "data"),
        ("vector", {"format": "shapefile"}, "shp"),
        ("vector", {"format": "zipped-shapefile"}, "archive"),
    ],
)
def test_spatial_primary_asset_keeps_existing_reader_identity(
    kind: str, source: dict[str, str], expected: str
) -> None:
    """Reject authoring keys that would change existing spatial source identity.

    Args:
        kind: Spatial dataset kind.
        source: Existing reader selection.
        expected: Canonical primary Asset key required by that reader.
    """
    document = descriptor_document()
    primary = document["assets"].pop("data")
    document.update(kind=kind, source=source, primary_asset="custom")
    document["assets"]["custom"] = primary
    with pytest.raises(ValidationError, match="requires primary_asset"):
        CatalogDescriptor.model_validate(document)
    document["assets"][expected] = document["assets"].pop("custom")
    document["primary_asset"] = expected
    assert CatalogDescriptor.model_validate(document).primary_asset == expected
