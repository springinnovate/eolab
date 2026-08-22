import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleWorldMap,
  formatSingleWorldPosition,
  SINGLE_WORLD_BOUNDS,
} from "../src/map.js";

function createLeafletDouble() {
  const calls = {
    map: null,
    setView: null,
    zoomControl: null,
    basemap: null,
  };
  const leafletMap = {
    setView(center, zoom) {
      calls.setView = { center, zoom };
      return this;
    },
  };
  const zoomControl = {
    addTo(map) {
      calls.zoomControl.map = map;
      return this;
    },
  };
  const basemapLayer = {
    addTo(map) {
      calls.basemap.map = map;
      return this;
    },
  };
  const leaflet = {
    map(container, options) {
      calls.map = { container, options };
      return leafletMap;
    },
    control: {
      zoom(options) {
        calls.zoomControl = { options };
        return zoomControl;
      },
    },
    tileLayer(url, options) {
      calls.basemap = { url, options };
      return basemapLayer;
    },
  };
  return { calls, leaflet, leafletMap };
}

test("application map is bounded to one strict WGS 84 world", () => {
  const { calls, leaflet, leafletMap } = createLeafletDouble();
  const configuration = {
    basemap: {
      url: "https://tiles.example/{z}/{x}/{y}.png",
      attribution: "Example tiles",
    },
    initialView: { latitude: 20, longitude: -25, zoom: 2 },
  };

  assert.equal(createSingleWorldMap(leaflet, configuration), leafletMap);
  assert.deepEqual(calls.map, {
    container: "map",
    options: {
      zoomControl: false,
      minZoom: 0,
      maxZoom: 22,
      maxBounds: SINGLE_WORLD_BOUNDS,
      maxBoundsViscosity: 1,
      worldCopyJump: false,
    },
  });
  assert.deepEqual(calls.setView, {
    center: [20, -25],
    zoom: 2,
  });
  assert.deepEqual(calls.zoomControl, {
    options: { position: "bottomleft" },
    map: leafletMap,
  });
});

test("basemap tile requests do not wrap into another world", () => {
  const { calls, leaflet, leafletMap } = createLeafletDouble();

  createSingleWorldMap(leaflet, {
    basemap: {
      url: "https://tiles.example/{z}/{x}/{y}.png",
      attribution: "Example tiles",
    },
    initialView: { latitude: 0, longitude: 0, zoom: 1 },
  });

  assert.deepEqual(calls.basemap, {
    url: "https://tiles.example/{z}/{x}/{y}.png",
    options: {
      attribution: "Example tiles",
      maxZoom: 22,
      noWrap: true,
      bounds: SINGLE_WORLD_BOUNDS,
    },
    map: leafletMap,
  });
});

test("map position text never presents coordinates outside one world", () => {
  assert.equal(
    formatSingleWorldPosition({ lat: 48.12345, lng: -122.98765 }),
    "48.123, -122.988",
  );
  assert.equal(
    formatSingleWorldPosition({ lat: 20, lng: -180 }),
    "20.000, -180.000",
  );
  assert.equal(
    formatSingleWorldPosition({ lat: 20, lng: 180 }),
    "20.000, 180.000",
  );
  assert.equal(
    formatSingleWorldPosition({ lat: 20, lng: -180.001 }),
    "Outside map bounds",
  );
  assert.equal(
    formatSingleWorldPosition({ lat: 20, lng: 180.001 }),
    "Outside map bounds",
  );
});
