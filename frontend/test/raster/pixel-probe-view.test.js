import assert from "node:assert/strict";
import test from "node:test";

import { RasterPixelProbeView } from "../../src/raster/pixel-probe-view.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("pixel-probe adapter owns floating readout presentation", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterPixelProbeView(documentContext);
    documentContext.querySelector("#raster-pixel-probe").hidden = true;

    assert.equal(view.isVisible(), false);
    view.setContent("temperature.tif", "1.5 at 45, -120");
    assert.deepEqual(view.show(), { width: 120, height: 48 });
    view.position({ x: 12, y: 24 });

    assert.equal(view.isVisible(), true);
    assert.equal(
        documentContext.querySelector("#raster-pixel-probe-name").textContent,
        "temperature.tif"
    );
    assert.equal(
        documentContext.querySelector("#raster-pixel-probe-name").title,
        "temperature.tif"
    );
    assert.equal(
        documentContext.querySelector("#raster-pixel-probe-reading").textContent,
        "1.5 at 45, -120"
    );
    assert.equal(
        documentContext.querySelector("#raster-pixel-probe").style.transform,
        "translate3d(12px, 24px, 0)"
    );

    view.hide();
    assert.equal(view.isVisible(), false);
});
