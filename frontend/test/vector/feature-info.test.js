import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVectorFeatureInfoUrl,
  fetchVectorFeatureInfo,
  VECTOR_FEATURE_INFO_BUFFER_PIXELS,
  VECTOR_FEATURE_INFO_LIMIT,
  VectorFeatureInfoError,
} from "../../src/vector/feature-info.js";

const PUBLICATION = Object.freeze({
  layerName: "eolab:parcels",
  styleName: "vector-polygon",
});

function mapFixture() {
  return {
    getSize: () => ({ x: 4096, y: 2048 }),
    getBounds: () => ({
      getSouthWest: () => ({ lat: 10, lng: 20 }),
      getNorthEast: () => ({ lat: 30, lng: 40 }),
    }),
  };
}

test("feature info scales a large viewport and click under the WMS limit", () => {
  const url = new URL(buildVectorFeatureInfoUrl({
    wmsUrl: "https://viewer.test/geoserver/eolab/wms",
    leafletMap: mapFixture(),
    publication: PUBLICATION,
    containerPoint: { x: 1024, y: 512 },
  }));
  assert.equal(url.searchParams.get("request"), "GetFeatureInfo");
  assert.equal(url.searchParams.get("layers"), PUBLICATION.layerName);
  assert.equal(url.searchParams.get("query_layers"), PUBLICATION.layerName);
  assert.equal(url.searchParams.get("styles"), PUBLICATION.styleName);
  assert.equal(url.searchParams.get("version"), "1.1.1");
  assert.equal(url.searchParams.get("srs"), "EPSG:4326");
  assert.equal(url.searchParams.get("bbox"), "20,10,40,30");
  assert.equal(url.searchParams.get("width"), "2048");
  assert.equal(url.searchParams.get("height"), "1024");
  assert.equal(url.searchParams.get("x"), "512");
  assert.equal(url.searchParams.get("y"), "256");
  assert.equal(url.searchParams.get("feature_count"), String(VECTOR_FEATURE_INFO_LIMIT));
  assert.equal(url.searchParams.get("buffer"), String(VECTOR_FEATURE_INFO_BUFFER_PIXELS));
  assert.equal(url.searchParams.get("info_format"), "application/json");
});

test("feature info accepts only a bounded GeoJSON FeatureCollection", async () => {
  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [20, 10] },
    properties: { name: "Wetland" },
  };
  const calls = [];
  const features = await fetchVectorFeatureInfo({
    wmsUrl: "/geoserver/eolab/wms",
    leafletMap: mapFixture(),
    publication: PUBLICATION,
    containerPoint: { x: 4, y: 8 },
    signal: new AbortController().signal,
  }, async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ type: "FeatureCollection", features: [feature] }),
    };
  });
  assert.deepEqual(features, [feature]);
  assert.equal(calls[0].options.headers.Accept, "application/json");

  await assert.rejects(
    () => fetchVectorFeatureInfo({
      wmsUrl: "/wms",
      leafletMap: mapFixture(),
      publication: PUBLICATION,
      containerPoint: { x: 4, y: 8 },
      signal: new AbortController().signal,
    }, async () => ({
      ok: true,
      json: async () => ({ type: "FeatureCollection", features: [
        ...Array.from({ length: VECTOR_FEATURE_INFO_LIMIT + 1 }, () => feature),
      ] }),
    })),
    VectorFeatureInfoError,
  );
});

test("feature info exposes safe proxy failures", async () => {
  await assert.rejects(
    () => fetchVectorFeatureInfo({
      wmsUrl: "/wms",
      leafletMap: mapFixture(),
      publication: PUBLICATION,
      containerPoint: { x: 4, y: 8 },
      signal: new AbortController().signal,
    }, async () => ({
      ok: false,
      status: 502,
      json: async () => ({ detail: "Feature response exceeded its limit" }),
    })),
    /exceeded its limit/,
  );
});
