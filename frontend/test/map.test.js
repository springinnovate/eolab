import assert from "node:assert/strict";
import test from "node:test";
import { createLeafletDouble } from "../test-support/fake-basemap-leaflet.js";

import {
  createSingleWorldMap,
  formatSingleWorldPosition,
  getCatalogItemMapBounds,
  SINGLE_WORLD_BOUNDS,
} from "../src/map.js";

test("catalog bounds convert 2D and 3D axis order without mutating the Item", () => {
  for (const bbox of [[-123, 48, -122, 49], [-123, 48, -100, -122, 49, 500]]) {
    const item = { bbox }, before = structuredClone(item);
    assert.deepEqual(getCatalogItemMapBounds(item), [[48, -123], [49, -122]]);
    assert.deepEqual(item, before);
  }
});

test("catalog bounds retain points and global extents and fit crossing bounds in one world", () => {
  assert.deepEqual(getCatalogItemMapBounds({ bbox: [10, 20, 10, 20] }), [[20, 10], [20, 10]]);
  assert.deepEqual(getCatalogItemMapBounds({ bbox: [-180, -90, 180, 90] }), SINGLE_WORLD_BOUNDS);
  assert.deepEqual(getCatalogItemMapBounds({ bbox: [177, -20, -178, -16] }), [[-20, -180], [-16, 180]]);
});

test("missing and malformed catalog bounds never reach Leaflet", () => {
  assert.equal(getCatalogItemMapBounds(null), null);
  for (const bbox of [undefined, null, "0,0,1,1", [], [0, 0, 1], [0, 0, 1, 1, 2],
    [0, 0, 1, NaN], [0, 0, Infinity, 1], ["0", 0, 1, 1], [null, 0, 1, 1],
    [0, 10, 1, 5], [-181, 0, 1, 1], [0, 0, 181, 1], [0, -91, 1, 1],
    [0, 0, 1, 91], [0, 0, 100, 1, 1, 50]]) {
    assert.equal(getCatalogItemMapBounds({ bbox }), null, JSON.stringify(bbox));
  }
});

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
  assert.equal(calls.attributionPrefix, false);
  assert.deepEqual([...leafletMap.attributions.keys()], ["Example tiles"]);
  assert.deepEqual(calls.map, {
    container: "map",
    options: {
      zoomControl: false,
      minZoom: 0,
      maxZoom: 22,
      maxBounds: SINGLE_WORLD_BOUNDS,
      maxBoundsViscosity: 1,
      worldCopyJump: false,
      updateWhenIdle: true,
      updateWhenZooming: false,
      wheelDebounceTime: 120,
    },
  });
  assert.deepEqual(calls.setView, {
    center: [20, -25],
    zoom: 2,
  });
  assert.deepEqual(calls.zoomControl, {
    options: {
      position: "bottomleft",
      zoomInTitle: "Zoom in (hold Shift for smaller steps)",
      zoomOutTitle: "Zoom out (hold Shift for smaller steps)",
    },
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
      className: "eolab-basemap",
      pane: "eolab-basemap-pane",
      errorTileUrl:
        "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 " +
        "width=%221%22 height=%221%22/%3E",
      maxZoom: 22,
      maxNativeZoom: 17,
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

/** Build the application map through its public initialization boundary.
 * @return {Object} Leaflet test double with fine handlers installed.
 */
function fineZoomMap() {
  const result = createLeafletDouble();
  createSingleWorldMap(result.leaflet, {
    basemap: {url: "https://tiles.example/{z}/{x}/{y}.png", attribution: "Example"},
    initialView: {latitude: 20, longitude: -25, zoom: 2},
  });
  return result;
}

test("wheel modifiers use separate native batches and restore ordinary sensitivity", () => {
  const {leafletMap: map, calls} = fineZoomMap();
  const normal = {shiftKey: false}, fine = {shiftKey: true};
  map.scrollWheelZoom._onWheelScroll(normal);
  map._animatingZoom = true;
  map.scrollWheelZoom._onWheelScroll(fine);
  assert.equal(calls.zoomTransitionsFinished, 1);
  assert.equal(map._animatingZoom, false);
  assert.deepEqual(calls.wheelBatches.map(({zoomSnap, wheelPxPerZoomLevel}) =>
    [zoomSnap, wheelPxPerZoomLevel]), [[1, 60]]);
  map.scrollWheelZoom._onWheelScroll(normal);
  assert.deepEqual(calls.wheelBatches.map(({zoomSnap, wheelPxPerZoomLevel}) =>
    [zoomSnap, wheelPxPerZoomLevel]), [[1, 60], [0.1, 600]]);
  map.scrollWheelZoom._performZoom();
  assert.equal(calls.wheelBatches[2].zoomSnap, 1);
  assert.equal(calls.wheelEvent, normal);
  assert.equal(map.options.zoomSnap, 0.1);
  assert.equal(map.options.wheelPxPerZoomLevel, 60);
});

test("fine controls and focused-map keys use tenths without replacing ordinary actions", () => {
  const {leafletMap: map, calls} = fineZoomMap();
  const fine = {shiftKey: true}, normal = {shiftKey: false};
  map._animatingZoom = true;
  map.zoomControl._zoomIn(fine);
  map.zoomControl._zoomOut(fine);
  assert.equal(calls.zoomTransitionsFinished, 1);
  assert.deepEqual(calls.zoomIn, {delta: 0.1, options: {animate: false}});
  assert.deepEqual(calls.zoomOut, {delta: 0.1, options: {animate: false}});
  map.zoomControl._zoomIn(normal);
  map.zoomControl._zoomOut(normal);
  assert.equal(calls.nativeZoomIn, normal);
  assert.equal(calls.nativeZoomOut, normal);
  map.zoomControl._disabled = true;
  calls.zoomIn = null;
  map.zoomControl._zoomIn(fine);
  assert.equal(calls.zoomIn, null);

  const key = {shiftKey: true, keyCode: 187};
  map._animatingZoom = true;
  map.keyboard._onKeyDown(key);
  assert.equal(calls.zoomTransitionsFinished, 2);
  assert.deepEqual(calls.setZoom, {zoom: 2.1, options: {animate: false}});
  assert.equal(calls.stoppedEvent, key);
  for (const event of [{shiftKey: false, keyCode: 187},
    {shiftKey: true, keyCode: 37}, {shiftKey: true, ctrlKey: true, keyCode: 187}]) {
    map.keyboard._onKeyDown(event);
    assert.equal(calls.nativeKey, event);
  }
});

test("fit bounds retain whole-level snapping and disabling wheel discards queued work", context => {
  const {leafletMap: map, calls} = fineZoomMap();
  const bounds = [[10, 20], [30, 40]], padding = [12, 24];
  assert.equal(map.getBoundsZoom(bounds, true, padding), 3);
  assert.deepEqual(calls.fit, {bounds, inside: true, padding, snap: 1});
  assert.equal(map.options.zoomSnap, 0.1);
  context.mock.timers.enable({apis: ["setTimeout"]});
  map.scrollWheelZoom._timer = setTimeout(() => assert.fail("removed map zoomed"), 120);
  map.scrollWheelZoom._delta = 40;
  map.scrollWheelZoom._startTime = 1;
  map.scrollWheelZoom.disable();
  context.mock.timers.runAll();
  assert.equal(map.scrollWheelZoom._delta, 0);
  assert.equal(map.scrollWheelZoom._startTime, null);
  assert.equal(calls.wheelDetached, true);
});
