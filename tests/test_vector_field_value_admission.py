"""Read real vector formats once at admission and serve stored value pages."""

import json
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import fiona
import pytest

from eolab_app.catalog.metadata import build_dataset_metadata
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.catalog import geopackage
from eolab_app.vector_field_values import (
    VECTOR_FIELD_VALUES_KEY,
    VectorFieldValueQuery,
    page_field_values,
    read_field_value_inventory,
)
from eolab_app.vector_uploads import VectorUploadStore
from test_vector_uploads import BASE, HEADERS, client_for, write_layer


def write_text_layer(
    path: Path, driver: str, values: list[str | None], layer: str = "values"
) -> None:
    """Write actual source strings and a numeric field in a spatial test layer.

    Args:
        path: Output dataset or container path.
        driver: Installed Fiona vector writer.
        values: String values, including duplicates and missing values.
        layer: Exact native layer name.
    """
    with fiona.open(
        path,
        "w",
        driver=driver,
        layer=layer,
        crs="EPSG:4326",
        encoding="UTF-8",
        schema={
            "geometry": "Point",
            "properties": {"label": "str:100", "number": "int"},
        },
    ) as output:
        output.writerecords(
            {
                "geometry": {"type": "Point", "coordinates": [1, 2]},
                "properties": {"label": value, "number": index},
            }
            for index, value in enumerate(values)
        )


@pytest.mark.parametrize(
    "kind,driver,suffix",
    [
        ("geopackage", "GPKG", ".gpkg"),
        ("shapefile", "ESRI Shapefile", ".shp"),
        ("zipped-shapefile", "ESRI Shapefile", ".shp"),
        ("geojson", "GeoJSON", ".geojson"),
        ("file-geodatabase", "OpenFileGDB", ".gdb"),
    ],
)
def test_every_admitted_format_prepares_values_within_the_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str, driver: str, suffix: str
) -> None:
    """Exercise actual format admission, then page/search without opening features.

    Args:
        tmp_path: Disposable mounted source tree.
        monkeypatch: Block source reads after admission.
        kind: Existing handler registry name.
        driver: Native fixture writer.
        suffix: Required source suffix.
    """
    source = tmp_path / f"values{suffix}"
    exact = [f"value {index:04d}" for index in range(240)] + [
        "Straße",
        "STRASSE",
        "é",
        "e\u0301",
    ]
    write_text_layer(source, driver, [*exact, *(["value 0000"] * 15), None])
    components = tuple(tmp_path.glob("values.*")) if suffix == ".shp" else ()
    if kind == "zipped-shapefile":
        archive = tmp_path / "values.zip"
        with ZipFile(archive, "w") as output:
            for component in components:
                output.write(component, f"nested/{component.name}")
        source, components = archive, ()
    result = build_dataset_metadata(
        tmp_path, DatasetCandidate(source, kind, components)
    )
    assert result.error is None
    inventory = result.items[0]["properties"][VECTOR_FIELD_VALUES_KEY]
    assert set(inventory) == {"label"}
    assert [entry[0] for entry in inventory["label"]["values"]] == sorted(exact)
    assert not inventory["label"]["truncated"]

    def no_read(*args: Any, **kwargs: Any) -> None:
        """Reject an accidental native read during metadata-only lookup."""
        pytest.fail("Interactive lookup reopened source features")

    monkeypatch.setattr("eolab_app.vector_field_values.visit_vector_fields", no_read)
    assert page_field_values(
        inventory, VectorFieldValueQuery(field="label", search="strasse")
    ).values == ("STRASSE", "Straße")
    page = page_field_values(
        inventory, VectorFieldValueQuery(field="label", offset=220, limit=100)
    )
    assert page.values == tuple(sorted(exact)[220:]) and page.next_offset is None
    assert not page.truncated


@pytest.mark.parametrize("unique_count", [254, 255, 256, 1000])
def test_admission_caps_distinct_choices_and_reports_omitted_values(
    tmp_path: Path, unique_count: int
) -> None:
    """Keep the first 255 distinct values and disclose omissions on every search.

    Args:
        tmp_path: Disposable source directory.
        unique_count: Number of distinct strings around and beyond the cap.
    """
    source = tmp_path / "capped.gpkg"
    values = [f"value {index:04d}" for index in range(unique_count)]
    write_text_layer(source, "GPKG", [None, *values, *values[:10], None])
    result = build_dataset_metadata(tmp_path, DatasetCandidate(source, "geopackage"))
    assert result.error is None
    inventory = result.items[0]["properties"][VECTOR_FIELD_VALUES_KEY]
    assert inventory["label"] == {
        "values": [(value, value.casefold()) for value in values[:255]],
        "truncated": unique_count > 255,
    }
    collected = []
    offset = 0
    while True:
        page = page_field_values(
            inventory, VectorFieldValueQuery(field="label", offset=offset, limit=100)
        )
        assert page.truncated == (unique_count > 255)
        collected.extend(page.values)
        if page.next_offset is None:
            break
        offset = page.next_offset
    assert collected == values[:255]
    missing = page_field_values(
        inventory, VectorFieldValueQuery(field="label", search="value 0255")
    )
    assert missing.values == () and missing.next_offset is None
    assert missing.truncated == (unique_count > 255)


def test_geojson_null_empty_and_mixed_fields(tmp_path: Path) -> None:
    """Keep empty string distinct from null and exclude mixed JSON scalar types.

    Args:
        tmp_path: Disposable mounted source directory.
    """
    source = tmp_path / "strings.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [1, 2]},
                        "properties": {
                            "label": label,
                            "mixed": mixed,
                            "date_text": "2026-01-01T00:00:00Z",
                        },
                    }
                    for label, mixed in [("", "text"), (None, 5), ("Upper", None)]
                ],
            }
        ),
        encoding="utf-8",
    )
    result = build_dataset_metadata(tmp_path, DatasetCandidate(source, "geojson"))
    assert result.error is None
    assert result.items[0]["properties"][VECTOR_FIELD_VALUES_KEY] == {
        "label": {"values": [("", ""), ("Upper", "upper")], "truncated": False},
        "date_text": {
            "values": [("2026-01-01T00:00:00Z", "2026-01-01t00:00:00z")],
            "truncated": False,
        },
    }
    empty = tmp_path / "empty.gpkg"
    write_text_layer(empty, "GPKG", [])
    assert read_field_value_inventory(str(empty), "values", {"label": "str"}) == {
        "label": {"values": [], "truncated": False}
    }


def test_inventory_failure_preserves_sibling_layers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep the existing container's per-layer failure isolation for native reads.

    Args:
        tmp_path: Disposable GeoPackage source directory.
        monkeypatch: Fail one layer at its native attribute boundary.
    """
    source = tmp_path / "two.gpkg"
    write_text_layer(source, "GPKG", ["bad"], "bad")
    write_text_layer(source, "GPKG", ["good"], "good")
    original = geopackage.read_vector_table_properties

    def read(*args: Any, **kwargs: Any) -> dict[str, Any]:
        """Fail only the named bad layer, preserving the genuine good-layer read."""
        if args[1] == "bad":
            raise RuntimeError("Native read failed")
        return original(*args, **kwargs)

    monkeypatch.setattr(geopackage, "read_vector_table_properties", read)
    result = build_dataset_metadata(tmp_path, DatasetCandidate(source, "geopackage"))
    assert result.error is None and len(result.items) == 1
    assert result.items[0]["properties"][VECTOR_FIELD_VALUES_KEY] == {
        "label": {"values": [("good", "good")], "truncated": False}
    }


def test_upload_value_lookup_is_private_stored_and_deleted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Publish inventories atomically and retain ownership through read/delete.

    Args:
        tmp_path: Disposable source file and private upload storage.
        monkeypatch: Forbid native source reads after upload admission.
    """
    store = VectorUploadStore(tmp_path / "uploads", None)
    payload = write_layer(tmp_path / "source.gpkg")
    with client_for(store) as owner, client_for(store) as stranger:
        created = owner.post(
            BASE, params={"name": "areas"}, headers=HEADERS, content=payload
        )
        assert created.status_code == 201
        identifier = created.json()["id"]
        url = f"{BASE}/{identifier}/field-values"

        def no_read(*args: Any, **kwargs: Any) -> None:
            """Forbid a native feature read while returning prepared suggestions."""
            pytest.fail("Lookup reopened upload features")

        monkeypatch.setattr(
            "eolab_app.vector_field_values.visit_vector_fields", no_read
        )
        response = owner.get(url, params={"field": "label", "search": "CAFÉ"})
        assert response.status_code == 200
        assert response.json() == {
            "field": "label",
            "values": ["Café wetlands"],
            "nextOffset": None,
            "truncated": False,
        }
        assert response.headers["cache-control"] == "private, no-store"
        assert "Café wetlands" not in owner.get(BASE).text
        assert stranger.get(url, params={"field": "label"}).status_code == 404
        assert owner.get(url, params={"field": "count"}).status_code == 422
        assert (
            owner.get(url, params={"field": "label", "limit": 101}).status_code == 422
        )
        inventory_path = next(store.root.glob("*/*/values.json"))
        inventory_path.unlink()
        missing = owner.get(url, params={"field": "label"})
        assert missing.status_code == 409 and "again" in missing.text
        assert owner.delete(f"{BASE}/{identifier}", headers=HEADERS).status_code == 204
        assert owner.get(url, params={"field": "label"}).status_code == 404
        assert not inventory_path.parent.exists()
