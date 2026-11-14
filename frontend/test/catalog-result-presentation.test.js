import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalogResultPresentation,
  formatCatalogResultCount,
} from "../src/catalog-result-presentation.js";

test("Catalog results lead with raster filenames and hazard context", () => {
  const presentation = buildCatalogResultPresentation(
    {
      id: "drought-item",
      properties: {
        title:
          "droughts-historic-speibase-v2-11/drought_frequency_2000.tif",
        description: "A long technical warning that belongs in the inspector.",
        datetime: "2026-08-27T00:00:00Z",
      },
      assets: {},
    },
    "Raster",
  );

  assert.deepEqual(presentation, {
    filename: "drought_frequency_2000.tif",
    context: "droughts · historic",
    datasetType: "Raster",
    fullTitle:
      "droughts-historic-speibase-v2-11/drought_frequency_2000.tif",
    accessibleLabel:
      "More details for drought_frequency_2000.tif, droughts · historic, " +
      "Raster, Source: droughts-historic-speibase-v2-11/" +
      "drought_frequency_2000.tif",
  });
});

test("Catalog results retain GeoPackage and geodatabase layer identity", () => {
  assert.deepEqual(
    buildCatalogResultPresentation(
      {
        id: "geopackage-item",
        properties: {
          title: "flooding-future/FLOPROS.gpkg — flood_protection",
          "eolab:geopackage_layer": "flood_protection",
          "eolab:vector_source": {
            kind: "mounted", format: "geopackage", asset_key: "data",
            layer_name: "flood_protection",
          },
        },
        assets: {
          data: { title: "flooding-future/FLOPROS.gpkg" },
        },
      },
      "Vector",
    ),
    {
      filename: "FLOPROS.gpkg",
      context: "Layer: flood_protection",
      datasetType: "Vector",
      fullTitle: "flooding-future/FLOPROS.gpkg — flood_protection",
      accessibleLabel:
        "More details for FLOPROS.gpkg, Layer: flood_protection, Vector, " +
        "Source: flooding-future/FLOPROS.gpkg — flood_protection",
    },
  );

  const geodatabase = buildCatalogResultPresentation(
    {
      id: "geodatabase-item",
      properties: {
        title: "Data/Habitat.gdb/habitat",
        "eolab:layer_name": "habitat",
      },
      assets: {},
    },
    "Vector",
  );
  assert.equal(geodatabase.filename, "Habitat.gdb");
  assert.equal(geodatabase.context, "Layer: habitat");
});

test("Catalog result identity safely falls back to titles and Item IDs", () => {
  assert.deepEqual(
    buildCatalogResultPresentation(
      {
        id: "remote-item",
        properties: { title: "Model Outputs\\grassland_2002.tif" },
      },
      undefined,
    ),
    {
      filename: "grassland_2002.tif",
      context: "Model Outputs",
      datasetType: null,
      fullTitle: "Model Outputs\\grassland_2002.tif",
      accessibleLabel:
        "More details for grassland_2002.tif, Model Outputs, " +
        "Source: Model Outputs\\grassland_2002.tif",
    },
  );
  assert.equal(
    buildCatalogResultPresentation(
      { id: "standalone-item", properties: {}, assets: {} },
      undefined,
    ).filename,
    "standalone-item",
  );
});

test("Catalog results preserve curated titles containing units and punctuation", () => {
  const titles = [
    "West Maui groundwater recharge - No units protected - model year 50 - mm/year",
    "West Maui groundwater recharge - No units protected - model year 50 - L/day",
    "West Maui groundwater recharge — Existing and proposed units protected — model year 35 — L/day",
    "Groundwater recharge / annual mean",
    "Recharge \\ runoff comparison",
  ];

  for (const title of titles) {
    assert.deepEqual(
      buildCatalogResultPresentation(
        {
          id: "curated-raster",
          properties: { title },
          assets: { data: { title } },
        },
        "Raster",
      ),
      {
        filename: title,
        context: null,
        datasetType: "Raster",
        fullTitle: title,
        accessibleLabel: `More details for ${title}, Raster`,
      },
      title,
    );
  }
});

test("Catalog results keep em dashes inside actual filenames", () => {
  const presentation = buildCatalogResultPresentation(
    {
      id: "raster-with-punctuation",
      properties: { title: "Model Outputs/recharge — model year 35.tif" },
    },
    "Raster",
  );
  assert.equal(presentation.filename, "recharge — model year 35.tif");
  assert.equal(presentation.context, "Model Outputs");
});

for (const [format, extension, legacyField] of [
  ["file-geodatabase", "gdb", "eolab:layer_name"],
  ["geopackage", "gpkg", "eolab:geopackage_layer"],
]) {
  test(`curated ${format} titles and layer names do not depend on asset order`, () => {
    for (const title of [
      "Central India habitat classes",
      "Recharge / annual mean — L/day",
      "Study notes/habitat.gpkg — comparison",
      "Study notes/habitat.tif",
    ]) {
      const primary = ["source", { title: `GIS/habitat.${extension}` }];
      const supporting = ["support", { title: "supporting-map.tif" }];
      for (const assets of [[primary, supporting], [supporting, primary]]) {
        const presentation = buildCatalogResultPresentation({
          id: "habitat-item",
          properties: {
            title,
            "eolab:metadata": { title },
            [legacyField]: "habitat",
            "eolab:vector_source": {
              kind: "mounted", format, asset_key: "source", layer_name: "habitat",
            },
          },
          assets: Object.fromEntries(assets),
        }, "Vector");
        assert.deepEqual(presentation, {
          filename: title, fullTitle: title, context: "Layer: habitat",
          datasetType: "Vector",
          accessibleLabel: `More details for ${title}, Layer: habitat, Vector`,
        });
      }
    }
  });
}

test("native source binding chooses layer and asset while preserving descriptive titles", () => {
  const item = {
    id: "vector-item",
    properties: {
      title: "GIS/old.gpkg — old_layer",
      "eolab:layer_name": "old_layer",
      "eolab:vector_source": {
        kind: "mounted", format: "geopackage", asset_key: "source", layer_name: "habitat",
      },
    },
    assets: {
      support: { title: "supporting-map.tif" },
      source: { title: "GIS/habitat.gpkg" },
    },
  };
  const presentation = buildCatalogResultPresentation(item, "Vector");
  assert.equal(presentation.filename, "habitat.gpkg");
  assert.equal(presentation.context, "Layer: habitat");
  item.properties.title = "Habitat classes";
  assert.equal(buildCatalogResultPresentation(item, "Vector").filename, "Habitat classes");
});

test("Catalog results infer legacy layer labels only from vector containers", () => {
  const presentation = buildCatalogResultPresentation(
    {
      id: "geopackage-layer",
      properties: { title: "Maui/Survey — 2020.gpkg — wetlands" },
      assets: { data: { title: "Maui/Survey — 2020.gpkg" } },
    },
    "Vector",
  );
  assert.equal(presentation.filename, "Survey — 2020.gpkg");
  assert.equal(presentation.context, "Layer: wetlands");
});

test("Catalog results retain compact paths for scanner-supported file formats", () => {
  for (const filename of ["rain.TIFF", "sites.shp", "sites.geojson", "sites.zip"]) {
    const presentation = buildCatalogResultPresentation(
      { id: filename, properties: { title: `Maui/${filename}` } },
      undefined,
    );
    assert.equal(presentation.filename, filename);
    assert.equal(presentation.context, "Maui");
  }
});

test("Catalog result counts use concise result language", () => {
  assert.equal(formatCatalogResultCount({ numberMatched: 0 }), "0 results");
  assert.equal(formatCatalogResultCount({ numberMatched: 1 }), "1 result");
  assert.equal(
    formatCatalogResultCount({
      numberMatched: 15234,
      numberMatchedEstimated: true,
    }),
    "15,234 (est.) results",
  );
});
