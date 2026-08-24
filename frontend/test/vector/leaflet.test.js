import assert from "node:assert/strict";
import test from "node:test";

import {
    createVectorWmsLayer,
    VECTOR_DEFAULT_SYMBOLOGY,
} from "../../src/vector/leaflet.js";

test("vector WMS uses one bounded layer and no raster environment", () => {
    let capturedRequest;
    let tileErrorHandler;
    const wmsLayer = {
        once(type, handler) {
            assert.equal(type, "tileerror");
            tileErrorHandler = handler;
        },
    };
    const leaflet = {
        tileLayer: {
            wms(url, options) {
                capturedRequest = { url, options };
                return wmsLayer;
            },
        },
    };
    let failures = 0;

    assert.equal(createVectorWmsLayer(
        leaflet,
        "/geoserver/eolab/wms",
        {
            layerName: "eolab:roads",
            bbox: [-123, 48, -122, 49],
            geometryKind: "line",
            styleName: "vector-line",
        },
        () => { failures += 1; }
    ), wmsLayer);
    assert.deepEqual(capturedRequest, {
        url: "/geoserver/eolab/wms",
        options: {
            layers: "eolab:roads",
            styles: "vector-line",
            format: "image/png",
            transparent: true,
            version: "1.3.0",
            noWrap: true,
            bounds: [[48, -123], [49, -122]],
        },
    });
    assert.equal("env" in capturedRequest.options, false);
    tileErrorHandler();
    assert.equal(failures, 1);
});

test("default vector geometry families remain visually distinct", () => {
    assert.deepEqual(Object.keys(VECTOR_DEFAULT_SYMBOLOGY), [
        "point",
        "line",
        "polygon",
    ]);
    assert.equal(new Set(Object.values(VECTOR_DEFAULT_SYMBOLOGY).map(
        ({ stroke }) => stroke
    )).size, 3);
});
