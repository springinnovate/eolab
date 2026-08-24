import assert from "node:assert/strict";
import test from "node:test";

import {
  intersectRasterViewport,
  isRasterDetailZoom,
  rasterViewportKey,
} from "../../src/raster/detail-preview-viewport.js";

/**
 * Create Leaflet-shaped bounds from canonical coordinates.
 *
 * @param {number[]} bounds West, south, east, north.
 * @return {Object} Leaflet bounds accessors.
 */
function mapBounds(bounds) {
  return {
    getWest: () => bounds[0],
    getSouth: () => bounds[1],
    getEast: () => bounds[2],
    getNorth: () => bounds[3],
  };
}

test("viewport refinement clips canonical map bounds to raster extent", () => {
  const intersection = intersectRasterViewport(
    mapBounds([-125, 49, -122, 52]),
    [-123, 48, -121, 50],
  );
  assert.deepEqual(intersection, {
    west: -123,
    south: 49,
    east: -122,
    north: 50,
  });
  assert.equal(
    intersectRasterViewport(
      mapBounds([10, 10, 20, 20]),
      [-123, 48, -121, 50],
    ),
    null,
  );
});

test("viewport identities are exact and refinement starts one zoom closer", () => {
  const bounds = { west: -123, south: 48, east: -121, north: 50 };
  assert.equal(rasterViewportKey(bounds), "[-123,48,-121,50]");
  assert.equal(isRasterDetailZoom(5, 4), true);
  assert.equal(isRasterDetailZoom(4.999, 4), false);
  assert.equal(isRasterDetailZoom(Number.NaN, 4), false);
});

test("viewport refinement canonicalizes wrapped worlds but not dateline splits", () => {
  assert.deepEqual(
    intersectRasterViewport(
      mapBounds([237, 48, 239, 50]),
      [-123, 48, -121, 50],
    ),
    { west: -123, south: 48, east: -121, north: 50 },
  );
  assert.equal(
    intersectRasterViewport(
      mapBounds([170, -10, 190, 10]),
      [-180, -90, 180, 90],
    ),
    null,
  );
});
