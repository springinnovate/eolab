import assert from "node:assert/strict";
import test from "node:test";

import {
  nearestRectangleConnector,
  RasterHistogramConnectorView,
} from "../../src/raster/histogram-connector-view.js";
import {
  FakeRasterControlDocument,
  FakeRasterControlElement,
} from "../../test-support/raster/fake-controls-document.js";

/** Build a projection-capable map with inspectable event ownership. */
function createMapFixture() {
  const handlers = new Map();
  const container = new FakeRasterControlElement();
  container.getBoundingClientRect = () => ({
    left: 100,
    top: 50,
    right: 900,
    bottom: 650,
    width: 800,
    height: 600,
  });
  let horizontalOffset = 0;
  const leafletMap = {
    getContainer: () => container,
    latLngToContainerPoint([latitude, longitude]) {
      return {
        x: (longitude + 180) / 360 * 800 + horizontalOffset,
        y: (90 - latitude) / 180 * 600,
      };
    },
    on(type, handler) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type).add(handler);
    },
    off(type, handler) {
      handlers.get(type)?.delete(handler);
    },
    emit(type) {
      for (const handler of handlers.get(type) ?? []) {
        handler();
      }
    },
  };
  return {
    handlers,
    leafletMap,
    moveProjection(offset) {
      horizontalOffset = offset;
    },
  };
}

test("nearest connector terminates on a visible target edge or corner", () => {
  const source = { left: 600, top: 500, right: 850, bottom: 620 };
  const target = { left: 300, top: 220, right: 520, bottom: 430 };

  const connector = nearestRectangleConnector(source, target);

  assert.notEqual(connector, null);
  assert.equal(
    connector.end.x === target.left ||
      connector.end.x === target.right ||
      connector.end.y === target.top ||
      connector.end.y === target.bottom,
    true
  );
  assert.equal(
    connector.start.x === source.left ||
      connector.start.x === source.right ||
      connector.start.y === source.top ||
      connector.start.y === source.bottom,
    true
  );
  assert.match(connector.arrowPoints, /^[-\d.]+,[-\d.]+ /);
});

test("connector follows projected sampled bounds and histogram visibility", () => {
  const documentContext = new FakeRasterControlDocument();
  const histogram = documentContext.querySelector("#raster-histogram");
  histogram.getBoundingClientRect = () => ({
    left: 610,
    top: 500,
    right: 850,
    bottom: 620,
    width: 240,
    height: 120,
  });
  const fixture = createMapFixture();
  const view = new RasterHistogramConnectorView(
    fixture.leafletMap,
    documentContext,
    {}
  );
  view.bind();
  view.setSamplingArea({ west: -60, south: -20, east: 20, north: 35 }, "selectedArea");

  const connector = documentContext.querySelector(
    "#raster-histogram-connector"
  );
  const line = documentContext.querySelector(
    "#raster-histogram-connector-line"
  );
  const firstTargetX = Number(line.getAttribute("x2"));
  assert.equal(connector.hidden, false);
  assert.equal(connector.getAttribute("data-sampling-area"), "selectedArea");
  assert.equal(Number.isFinite(firstTargetX), true);

  fixture.moveProjection(75);
  fixture.leafletMap.emit("move");
  assert.notEqual(Number(line.getAttribute("x2")), firstTargetX);

  view.setSamplingArea(
    { west: -60, south: -20, east: 20, north: 35 },
    "temporaryAoi"
  );
  assert.equal(connector.getAttribute("data-sampling-area"), "temporaryAoi");
  assert.equal(
    documentContext.querySelector("#raster-histogram-connector-target").hidden,
    false
  );

  histogram.hidden = true;
  view.refresh();
  assert.equal(connector.hidden, true);

  view.unbind();
  assert.equal(fixture.handlers.get("move").size, 0);
  assert.equal(fixture.handlers.get("zoom").size, 0);
  assert.equal(fixture.handlers.get("resize").size, 0);
});
