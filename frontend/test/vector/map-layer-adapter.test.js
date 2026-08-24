import assert from "node:assert/strict";
import test from "node:test";

import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";

const PUBLICATION = Object.freeze({
  layerName: "eolab:geopackage-0123456789abcdef01234567",
  bbox: [-123, 48, -122, 49],
  geometryKind: "polygon",
  styleName: "vector-polygon",
});

/**
 * Create a focused adapter fixture with inspectable WMS and fit calls.
 *
 * @param {boolean} fitToBounds Whether new layers should fit the map.
 * @return {{adapter:Object,wmsCalls:Object[],fitCalls:Object[]}} Fixture state.
 */
function createAdapterFixture(fitToBounds) {
  const wmsCalls = [];
  const fitCalls = [];
  const tileErrors = [];
  const leaflet = {
    tileLayer: {
      wms(url, options) {
        const layer = {
          once(type, handler) {
            this.errorHandler = { type, handler };
          },
        };
        wmsCalls.push({ url, options, layer });
        return layer;
      },
    },
  };
  const leafletMap = {
    fitBounds(bounds, options) {
      fitCalls.push({ bounds, options });
    },
  };
  return {
    adapter: createVectorMapLayerAdapter({
      leaflet,
      leafletMap,
      wmsUrl: "/geoserver/eolab/wms",
      onTileError(message, item) {
        tileErrors.push({ message, item });
      },
      fitToBounds,
      publish: async () => PUBLICATION,
    }),
    wmsCalls,
    fitCalls,
    tileErrors,
  };
}

test("vector map-layer adapter owns publication, WMS, legend, and optional fit", async () => {
  const fitted = createAdapterFixture(true);
  const item = {
    collection: "eolab-mounted-vectors",
    id: "geopackage-0123456789abcdef01234567",
    properties: { title: "Parcels" },
  };

  assert.equal(await fitted.adapter.publish(item), PUBLICATION);
  assert.equal(fitted.adapter.label(item), "Parcels");
  const record = {
    publication: PUBLICATION,
    entry: { item },
    error: "Vector map tiles could not be rendered.",
  };
  record.state = fitted.adapter.createState({ item });
  assert.equal(
    fitted.adapter.createLayer(record, () => {}).errorHandler.type,
    "tileerror",
  );
  assert.deepEqual(fitted.adapter.snapshot(record), {
    legend: {
      kind: "fixed",
      label: "Polygon",
      fill: "#a855f7",
      stroke: "#581c87",
    },
  });
  fitted.adapter.added(record);
  assert.deepEqual(fitted.fitCalls[0].bounds, [[48, -123], [49, -122]]);
  fitted.adapter.tileError(record);
  assert.deepEqual(fitted.tileErrors, [{ message: record.error, item }]);

  const unfitted = createAdapterFixture(false);
  unfitted.adapter.added(record);
  assert.deepEqual(unfitted.fitCalls, []);
  assert.throws(
    () => createVectorMapLayerAdapter({
      leaflet: {},
      leafletMap: {},
      wmsUrl: "/wms",
      onTileError() {},
      fitToBounds: "yes",
    }),
    TypeError,
  );
});
