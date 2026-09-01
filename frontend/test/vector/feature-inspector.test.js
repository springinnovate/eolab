import assert from "node:assert/strict";
import test from "node:test";

import {
  formatVectorFeatureAttribute,
  vectorFeatureAttributes,
  VectorFeatureInspectorController,
} from "../../src/vector/feature-inspector.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

function createFixture(fetchImplementation) {
  const documentContext = new FakeRasterControlDocument();
  const documentEvents = new EventTarget();
  documentContext.addEventListener = documentEvents.addEventListener.bind(documentEvents);
  documentContext.removeEventListener = documentEvents.removeEventListener.bind(documentEvents);
  documentContext.dispatchEvent = documentEvents.dispatchEvent.bind(documentEvents);
  documentContext.querySelector("#vector-feature-inspector").hidden = true;
  documentContext.querySelector("#vector-feature-result").hidden = true;
  const targets = [
    {
      label: "Parcels",
      publication: { layerName: "eolab:parcels", styleName: "vector-polygon" },
      primaryGeometry: "geometry",
    },
  ];
  const handlers = new Map();
  const removedLayers = [];
  const mapContainer = documentContext.createElement();
  const leafletMap = {
    options: { crs: { project: ({ lat, lng }) => ({ x: lng, y: lat }) } },
    getSize: () => ({ x: 800, y: 600 }),
    getBounds: () => ({
      getSouthWest: () => ({ lat: 0, lng: 0 }),
      getNorthEast: () => ({ lat: 10, lng: 10 }),
    }),
    getContainer: () => mapContainer,
    on(type, handler) { handlers.set(type, handler); },
    off(type, handler) {
      if (handlers.get(type) === handler) handlers.delete(type);
    },
    removeLayer(layer) { removedLayers.push(layer); },
    latLngToContainerPoint: () => ({ x: 10, y: 20 }),
  };
  const highlights = [];
  const leaflet = {
    geoJSON(feature, options) {
      const layer = {
        feature,
        options,
        addTo(map) { this.map = map; highlights.push(this); return this; },
      };
      return layer;
    },
    circleMarker(latlng, options) { return { latlng, options }; },
  };
  const inspectionChanges = [];
  const controller = new VectorFeatureInspectorController({
    leaflet,
    leafletMap,
    getVisibleTargets: () => targets,
    wmsUrl: "/geoserver/eolab/wms",
    onInspectionChange: (visible) => {
      inspectionChanges.push(visible);
      documentContext.querySelector("#vector-feature-inspector").hidden = !visible;
    },
    documentContext,
    fetchImplementation,
  });
  return {
    controller,
    documentContext,
    targets,
    handlers,
    highlights,
    removedLayers,
    inspectionChanges,
    mapContainer,
  };
}

test("attribute formatting is bounded and excludes the geometry field", () => {
  assert.equal(formatVectorFeatureAttribute(null), "No value");
  assert.equal(formatVectorFeatureAttribute(true), "True");
  assert.equal(formatVectorFeatureAttribute({ rank: 2 }), '{"rank":2}');
  assert.equal(formatVectorFeatureAttribute("x".repeat(1200)).length, 1000);
  assert.deepEqual(vectorFeatureAttributes({ id: "parcels.1", properties: {
    geometry: "not displayed",
    bbox: [0, 0, 1, 1],
    habitat: "wetland",
    rank: 2,
  } }, "geometry"), [
    { name: "Feature ID", value: "parcels.1" },
    { name: "habitat", value: "wetland" },
    { name: "rank", value: "2" },
  ]);
});

test("inspector queries composed visible targets and navigates overlapping features", async () => {
  const requestedLayers = [];
  const features = [
    {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [] },
      properties: { name: "First", geometry: "hidden" },
    },
    {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [] },
      properties: { name: "Second" },
    },
  ];
  const h = createFixture(async (url) => {
    requestedLayers.push(new URL(url, "https://viewer.test").searchParams.get("layers"));
    return {
      ok: true,
      json: async () => ({ type: "FeatureCollection", features }),
    };
  });
  await h.controller.inspect({ containerPoint: { x: 12, y: 24 } });
  assert.deepEqual(h.inspectionChanges, [true]);
  assert.equal(h.handlers.has("click"), false);
  assert.deepEqual(requestedLayers, ["eolab:parcels"]);
  assert.equal(h.documentContext.querySelector("#vector-feature-status").textContent,
    "2 features found.");
  assert.equal(h.documentContext.querySelector("#vector-feature-layer").textContent,
    "Parcels");
  assert.equal(h.documentContext.querySelector("#vector-feature-position").textContent,
    "1 of 2");
  assert.equal(h.highlights.length, 1);
  h.documentContext.querySelector("#next-vector-feature")
    .dispatchEvent(new Event("click"));
  assert.equal(h.documentContext.querySelector("#vector-feature-position").textContent,
    "2 of 2");
  assert.equal(h.highlights.length, 2);
  assert.equal(h.removedLayers.length, 1);
});

test("inspector validates the composition target contract at its boundary", () => {
  const h = createFixture(async () => {
    throw new Error("No request expected.");
  });
  h.targets[0].publication.layerName = null;
  assert.throws(
    () => h.controller.syncVisibleLayers(),
    /Invalid vector feature inspection target/,
  );
});

test("a newer click owns presentation and closing does not disable later inspection", async () => {
  const resolvers = [];
  const h = createFixture((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
    resolvers.push(resolve);
  }));
  const first = h.controller.inspect({ containerPoint: { x: 1, y: 1 } });
  const second = h.controller.inspect({ containerPoint: { x: 2, y: 2 } });
  resolvers[1]({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [{
      type: "Feature", geometry: null, properties: { name: "Newest" },
    }] }),
  });
  await Promise.all([first, second]);
  assert.equal(h.documentContext.querySelector("#vector-feature-status").textContent,
    "1 feature found.");

  h.documentContext.querySelector("#close-vector-inspector")
    .dispatchEvent(new Event("click"));
  assert.equal(
    h.documentContext.querySelector("#vector-feature-inspector").hidden,
    true,
  );
  assert.equal(h.documentContext.activeElement, h.mapContainer);

  const reopened = h.controller.inspect({ containerPoint: { x: 3, y: 3 } });
  resolvers[2]({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [] }),
  });
  await reopened;
  assert.equal(
    h.documentContext.querySelector("#vector-feature-inspector").hidden,
    false,
  );

  h.targets.length = 0;
  h.controller.syncVisibleLayers();
  assert.equal(h.handlers.has("click"), false);
  assert.deepEqual(h.inspectionChanges, [true, true, false, true, false]);
});
