import assert from "node:assert/strict";
import test from "node:test";

import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";

const PUBLICATION = Object.freeze({
  layerName: "eolab:geopackage-0123456789abcdef01234567",
  bbox: [-123, 48, -122, 49],
  geometryKind: "polygon",
  styleName: "vector-polygon",
  style: {
    geometryKind: "polygon",
    fillColor: "#a855f7",
    fillOpacity: 0.38,
    strokeColor: "#581c87",
    strokeOpacity: 1,
    strokeWidth: 2,
        pointSize: null,
        categorical: null,
        graduated: null,
        label: null,
  },
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
  const categoryCalls = [];
  const numericCalls = [];
  const leaflet = {
    tileLayer: {
      wms(url, options) {
        const layer = {
          styleRequests: [],
          once(type, handler) {
            this.errorHandler = { type, handler };
          },
          setParams(parameters) {
            this.styleRequests.push(parameters);
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
      style: async (_item, style) => ({
        styleName: style.fillColor === "#00ff00"
          ? "vector-style-0123456789abcdef01234567-aaaaaaaaaaaa"
          : "vector-style-0123456789abcdef01234567-bbbbbbbbbbbb",
        style,
      }),
      summarize: async (item, field) => {
        categoryCalls.push({ item, field });
        return { field, values: [] };
      },
      classify: async (item, field, method, classCount) => {
        numericCalls.push({ item, field, method, classCount });
        return { field, method, requestedClassCount: classCount };
      },
    }),
    wmsCalls,
    fitCalls,
    tileErrors,
    categoryCalls,
    numericCalls,
  };
}

test("vector map-layer adapter owns publication, WMS, legend, and optional fit", async () => {
  const fitted = createAdapterFixture(true);
  const item = {
    collection: "eolab-mounted-vectors",
    id: "geopackage-0123456789abcdef01234567",
    properties: {
      title: "Parcels",
      "table:primary_geometry": "geometry",
      "table:columns": [
        { name: "geometry", type: "Polygon" },
        { name: "name", type: "str" },
        { name: "area", type: "float" },
      ],
    },
  };

  assert.equal(await fitted.adapter.publish(item), PUBLICATION);
  assert.equal(fitted.adapter.label(item), "Parcels");
  const record = {
    publication: PUBLICATION,
    entry: { item },
    error: "Vector map tiles could not be rendered.",
  };
  record.state = fitted.adapter.createState({ item, publication: PUBLICATION });
  assert.deepEqual(record.state.labelFields, [
    { name: "name", type: "str" },
    { name: "area", type: "float" },
  ]);
  const layer = fitted.adapter.createLayer(record, () => {});
  assert.deepEqual(
    await fitted.adapter.summarizeCategories(record, "name"),
    { field: "name", values: [] },
  );
  assert.deepEqual(fitted.categoryCalls, [{ item, field: "name" }]);
  assert.deepEqual(
    await fitted.adapter.classifyNumbers(record, "area", "quantile", 5),
    { field: "area", method: "quantile", requestedClassCount: 5 },
  );
  assert.deepEqual(fitted.numericCalls, [{
    item,
    field: "area",
    method: "quantile",
    classCount: 5,
  }]);
  assert.equal(
    layer.errorHandler.type,
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
  const appliedStyle = {
    ...PUBLICATION.style,
    fillColor: "#00ff00",
    fillOpacity: 0.6,
  };
  assert.deepEqual(
    await fitted.adapter.applyStyle(record, appliedStyle),
    appliedStyle,
  );
  assert.deepEqual(layer.styleRequests, [{
    styles: "vector-style-0123456789abcdef01234567-aaaaaaaaaaaa",
  }]);
  assert.equal(fitted.adapter.snapshot(record).legend.fill, "#00ff00");
  const reappliedStyle = {
    ...appliedStyle,
    fillColor: "#ff0000",
  };
  assert.deepEqual(
    await fitted.adapter.applyStyle(record, reappliedStyle),
    reappliedStyle,
  );
  assert.deepEqual(layer.styleRequests, [
    {
      styles: "vector-style-0123456789abcdef01234567-aaaaaaaaaaaa",
    },
    {
      styles: "vector-style-0123456789abcdef01234567-bbbbbbbbbbbb",
    },
  ]);
  assert.equal(fitted.adapter.snapshot(record).legend.fill, "#ff0000");

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
