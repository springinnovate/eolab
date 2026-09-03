import assert from "node:assert/strict";
import test from "node:test";

import {
  formatVectorFeatureAttribute,
  vectorFeatureAttributes,
  vectorInspectionObservation,
  VectorFeatureInspectorController,
} from "../../src/vector/feature-inspector.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

function createFixture(fetchImplementation, { now = () => 0 } = {}) {
  const documentContext = new FakeRasterControlDocument();
  const documentEvents = new EventTarget();
  documentContext.addEventListener = documentEvents.addEventListener.bind(documentEvents);
  documentContext.removeEventListener = documentEvents.removeEventListener.bind(documentEvents);
  documentContext.dispatchEvent = documentEvents.dispatchEvent.bind(documentEvents);
  documentContext.querySelector("#vector-feature-inspector").hidden = true;
  documentContext.querySelector("#vector-feature-result").hidden = true;
  documentContext.querySelector("#open-vector-time-series").disabled = true;
  documentContext.querySelector("#open-vector-feature-profile").disabled = true;
  const targets = [
    {
      sourceId: "catalog|parcels",
      label: "Parcels",
      bbox: [0, 0, 10, 10],
      publication: { layerName: "eolab:parcels", styleName: "vector-polygon" },
      propertyNames: ["name", "rank"],
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
  const sampleChanges = [];
  const currentObservationChanges = [];
  let featureProfileRequests = 0;
  let timeSeriesRequests = 0;
  const controller = new VectorFeatureInspectorController({
    leaflet,
    leafletMap,
    getVisibleTargets: () => targets,
    wmsUrl: "/geoserver/eolab/wms",
    onInspectionChange: (visible) => {
      inspectionChanges.push(visible);
      documentContext.querySelector("#vector-feature-inspector").hidden = !visible;
    },
    onSampleChange: (sample) => sampleChanges.push(sample),
    onCurrentObservationChange: (observation) =>
      currentObservationChanges.push(observation),
    onFeatureProfileRequested: () => { featureProfileRequests += 1; },
    onTimeSeriesRequested: () => { timeSeriesRequests += 1; },
    documentContext,
    fetchImplementation,
    now,
  });
  return {
    controller,
    documentContext,
    targets,
    handlers,
    highlights,
    removedLayers,
    inspectionChanges,
    sampleChanges,
    currentObservationChanges,
    get featureProfileRequests() { return featureProfileRequests; },
    get timeSeriesRequests() { return timeSeriesRequests; },
    mapContainer,
  };
}

function inspectionEvent(x, y, longitude = 5, latitude = 5) {
  return {
    latlng: { lng: longitude, lat: latitude },
    containerPoint: { x, y },
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

test("analysis observations are immutable and omit nested properties", () => {
  const observation = vectorInspectionObservation({
    feature: {
      id: "parcels.2",
      properties: { year: 2024, label: "Current", nested: { rank: 2 } },
    },
    target: { sourceId: "catalog|parcels-2024", label: "Parcels 2024" },
  });
  assert.deepEqual(observation, {
    sourceId: "catalog|parcels-2024",
    layerLabel: "Parcels 2024",
    featureId: "parcels.2",
    properties: { year: 2024, label: "Current" },
  });
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.properties), true);
});

test("inspector queries composed visible targets and navigates overlapping features", async () => {
  const requestedLayers = [];
  const requestedProperties = [];
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
    const parameters = new URL(url, "https://viewer.test").searchParams;
    requestedLayers.push(parameters.get("layers"));
    requestedProperties.push(parameters.get("propertyName"));
    return {
      ok: true,
      json: async () => ({ type: "FeatureCollection", features }),
    };
  });
  await h.controller.inspect(inspectionEvent(12, 24));
  assert.deepEqual(h.inspectionChanges, [true]);
  assert.equal(h.handlers.has("click"), false);
  assert.deepEqual(requestedLayers, ["eolab:parcels"]);
  assert.deepEqual(requestedProperties, ["name,rank"]);
  assert.equal(h.documentContext.querySelector("#vector-feature-status").textContent,
    "2 features found in under 0.1 s.");
  assert.equal(h.documentContext.querySelector("#vector-feature-layer").textContent,
    "Parcels");
  assert.equal(h.documentContext.querySelector("#vector-feature-position").textContent,
    "1 of 2");
  assert.equal(h.highlights.length, 1);
  assert.deepEqual(h.sampleChanges.map((sample) => sample.state), [
    "loading",
    "ready",
  ]);
  assert.equal(h.sampleChanges[1].observations.length, 2);
  assert.equal(Object.isFrozen(h.sampleChanges[1]), true);
  assert.equal(
    h.documentContext.querySelector("#open-vector-time-series").disabled,
    false,
  );
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-action-help").textContent,
    "Plot one numeric field across all features found at this location.",
  );
  h.documentContext.querySelector("#open-vector-time-series")
    .dispatchEvent(new Event("click"));
  assert.equal(h.timeSeriesRequests, 1);
  h.documentContext.querySelector("#next-vector-feature")
    .dispatchEvent(new Event("click"));
  assert.equal(h.documentContext.querySelector("#vector-feature-position").textContent,
    "2 of 2");
  assert.equal(h.highlights.length, 2);
  assert.equal(h.removedLayers.length, 1);
  assert.equal(h.currentObservationChanges.at(-1).properties.name, "Second");
});

test("inspector presents out-of-order layer results progressively in map order", async () => {
  const resolvers = new Map();
  let elapsedMilliseconds = 0;
  const h = createFixture((url) => new Promise((resolve) => {
    const layerName = new URL(url, "https://viewer.test")
      .searchParams.get("layers");
    resolvers.set(layerName, resolve);
  }), { now: () => elapsedMilliseconds });
  h.targets.push({
    sourceId: "catalog|habitats",
    label: "Habitats",
    bbox: [0, 0, 10, 10],
    publication: {
      layerName: "eolab:habitats",
      styleName: "vector-polygon",
    },
    propertyNames: ["name"],
    primaryGeometry: "geometry",
  });

  const inspection = h.controller.inspect(inspectionEvent(12, 24));
  assert.deepEqual(h.inspectionChanges, [true]);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-status").textContent,
    "Inspecting 2 visible vector layers…",
  );

  elapsedMilliseconds = 400;
  resolvers.get("eolab:habitats")({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [{
      type: "Feature",
      geometry: null,
      properties: { name: "Habitat result" },
    }] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.documentContext.querySelector("#vector-feature-layer").textContent,
    "Habitats",
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-position").textContent,
    "1 of 1",
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-status").textContent,
    "1 feature found; 1 of 2 vector layers inspected in 0.4 s; " +
      "waiting for 1 more…",
  );
  assert.deepEqual(
    h.sampleChanges.map((sample) => sample.state),
    ["loading", "loading"],
  );
  assert.equal(h.sampleChanges.at(-1).observations.length, 1);

  elapsedMilliseconds = 1200;
  resolvers.get("eolab:parcels")({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [{
      type: "Feature",
      geometry: null,
      properties: { name: "Parcel result" },
    }] }),
  });
  await inspection;
  assert.equal(
    h.documentContext.querySelector("#vector-feature-layer").textContent,
    "Habitats",
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-position").textContent,
    "2 of 2",
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-status").textContent,
    "2 features found in 1.2 s.",
  );
  assert.deepEqual(
    h.sampleChanges.at(-1).observations.map((observation) =>
      observation.layerLabel
    ),
    ["Parcels", "Habitats"],
  );
  h.documentContext.querySelector("#previous-vector-feature")
    .dispatchEvent(new Event("click"));
  assert.equal(
    h.documentContext.querySelector("#vector-feature-layer").textContent,
    "Parcels",
  );
});

test("current numeric feature actions publish separate plotting intents", async () => {
  const h = createFixture(async () => ({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [{
      type: "Feature",
      geometry: null,
      properties: { node_nm: "North", R2000: 2, R2001: 4 },
    }, {
      type: "Feature",
      geometry: null,
      properties: { node_nm: "South", R2000: 3, R2001: 5 },
    }] }),
  }));
  await h.controller.inspect(inspectionEvent(12, 24));
  const profileButton = h.documentContext.querySelector(
    "#open-vector-feature-profile",
  );
  const selectedButton = h.documentContext.querySelector(
    "#open-vector-time-series",
  );
  assert.equal(profileButton.disabled, false);
  assert.equal(selectedButton.disabled, false);
  profileButton.dispatchEvent(new Event("click"));
  selectedButton.dispatchEvent(new Event("click"));
  assert.equal(h.featureProfileRequests, 1);
  assert.equal(h.timeSeriesRequests, 1);
  assert.equal(h.currentObservationChanges.at(-1).properties.node_nm, "North");
  h.controller.clearResults();
  assert.equal(h.currentObservationChanges.at(-1), null);
  assert.equal(profileButton.disabled, true);
});

test("one feature explains why plotting across features is unavailable", async () => {
  const h = createFixture(async () => ({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [{
      type: "Feature",
      geometry: null,
      properties: { node_nm: "North", R2000: 2, R2001: 4 },
    }] }),
  }));
  await h.controller.inspect(inspectionEvent(12, 24));
  assert.equal(
    h.documentContext.querySelector("#open-vector-time-series").disabled,
    true,
  );
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-action-help").textContent,
    "Select at least two features at this location to plot one field across them.",
  );
});

test("an empty click closes the transient inspection progress", async () => {
  const h = createFixture(async () => ({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [] }),
  }));
  await h.controller.inspect(inspectionEvent(2, 3));
  assert.deepEqual(h.inspectionChanges, [true, false]);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-inspector").hidden,
    true,
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-status").textContent,
    "Click the map to inspect visible vector features.",
  );
  assert.deepEqual(
    h.sampleChanges.map((sample) => [sample.state, sample.message]),
    [
      ["loading", "Inspecting 1 visible vector layer…"],
      ["empty", "No vector feature was found at that location."],
    ],
  );
});

test("an empty click clears and closes a previous feature result", async () => {
  let features = [{
    type: "Feature",
    geometry: { type: "Point", coordinates: [1, 2] },
    properties: { name: "Previous" },
  }];
  const h = createFixture(async () => ({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features }),
  }));
  await h.controller.inspect(inspectionEvent(2, 3));
  features = [];
  await h.controller.inspect(inspectionEvent(4, 5));
  assert.deepEqual(h.inspectionChanges, [true, false]);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-inspector").hidden,
    true,
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-result").hidden,
    true,
  );
  assert.equal(h.removedLayers.length, 1);
  assert.equal(h.sampleChanges.at(-1).state, "empty");
});

test("an actionable inspection failure still opens the inspector", async () => {
  const h = createFixture(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ detail: "GeoServer is warming up." }),
  }));
  await h.controller.inspect(inspectionEvent(2, 3));
  assert.deepEqual(h.inspectionChanges, [true]);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-inspector").hidden,
    false,
  );
  assert.equal(
    h.documentContext.querySelector("#vector-feature-status").textContent,
    "GeoServer is warming up. Inspection finished in under 0.1 s.",
  );
  assert.equal(h.sampleChanges.at(-1).state, "empty");
});

test("inspector skips targets outside their authoritative Catalog bounds", async () => {
  const requestedLayers = [];
  const h = createFixture(async (url) => {
    requestedLayers.push(
      new URL(url, "https://viewer.test").searchParams.get("layers"),
    );
    return {
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: { type: "Point", coordinates: [5, 5] },
          properties: { name: "Inside" },
        }],
      }),
    };
  });
  h.targets.push({
    sourceId: "catalog|distant",
    label: "Distant points",
    bbox: [20, 20, 30, 30],
    publication: {
      layerName: "eolab:distant",
      styleName: "vector-point",
    },
    propertyNames: ["name"],
    primaryGeometry: "geometry",
  });

  await h.controller.inspect(inspectionEvent(2, 3));
  assert.deepEqual(requestedLayers, ["eolab:parcels"]);
  assert.deepEqual(h.inspectionChanges, [true]);

  await h.controller.inspect(inspectionEvent(4, 5, 50, 50));
  assert.deepEqual(requestedLayers, ["eolab:parcels"]);
  assert.deepEqual(h.inspectionChanges, [true, false]);
  assert.equal(
    h.documentContext.querySelector("#vector-feature-result").hidden,
    true,
  );
  assert.equal(h.removedLayers.length, 1);
  assert.equal(h.sampleChanges.at(-1).state, "empty");
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
  const first = h.controller.inspect(inspectionEvent(1, 1));
  const second = h.controller.inspect(inspectionEvent(2, 2));
  resolvers[1]({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [{
      type: "Feature", geometry: null, properties: { name: "Newest" },
    }] }),
  });
  await Promise.all([first, second]);
  assert.equal(h.documentContext.querySelector("#vector-feature-status").textContent,
    "1 feature found in under 0.1 s.");

  h.documentContext.querySelector("#close-vector-inspector")
    .dispatchEvent(new Event("click"));
  assert.equal(
    h.documentContext.querySelector("#vector-feature-inspector").hidden,
    true,
  );
  assert.equal(h.documentContext.activeElement, h.mapContainer);

  const reopened = h.controller.inspect(inspectionEvent(3, 3));
  resolvers[2]({
    ok: true,
    json: async () => ({ type: "FeatureCollection", features: [] }),
  });
  await reopened;
  assert.equal(
    h.documentContext.querySelector("#vector-feature-inspector").hidden,
    true,
  );

  h.targets.length = 0;
  h.controller.syncVisibleLayers();
  assert.equal(h.handlers.has("click"), false);
  assert.deepEqual(h.inspectionChanges, [true, false, true, false]);
  assert.equal(h.sampleChanges.at(-1).state, "invalidated");
});

test("changing the visible vector set invalidates results but retains inspection", async () => {
  const h = createFixture(async () => ({
    ok: true,
    json: async () => ({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: null,
        properties: { score: 3 },
      }],
    }),
  }));
  await h.controller.inspect(inspectionEvent(2, 3));
  h.targets.push({
    sourceId: "catalog|habitats",
    label: "Habitats",
    bbox: [0, 0, 10, 10],
    publication: {
      layerName: "eolab:habitats",
      styleName: "vector-polygon",
    },
    propertyNames: ["score"],
    primaryGeometry: "geometry",
  });
  h.controller.syncVisibleLayers();
  assert.equal(
    h.documentContext.querySelector("#vector-feature-status").textContent,
    "Visible vector layers changed. Click the map to sample again.",
  );
  assert.equal(h.sampleChanges.at(-1).state, "invalidated");
  assert.equal(
    h.documentContext.querySelector("#vector-feature-inspector").hidden,
    false,
  );
});
