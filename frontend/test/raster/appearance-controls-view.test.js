import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterAppearanceControlsView,
} from "../../src/raster/appearance-controls-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("appearance adapter owns style reads, presentation, and listeners", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterAppearanceControlsView(documentContext);
    const received = [];
    view.populatePalettes({ viridis: { label: "Viridis" } });
    view.setStyle(DEFAULT_RASTER_STYLE, "viridis");
    view.setActiveLayer("temperature.tif", false);
    view.setControlsVisible(true);
    view.bind({
        onStyleInput: (isColor) => received.push(["input", isColor]),
        onStyleChange: () => received.push(["change"]),
        onPaletteChange: () => received.push(["palette"]),
        onResetStyle: () => received.push(["reset"]),
    });

    documentContext.querySelector("#raster-minimum-color")
        .dispatchEvent(new Event("input"));
    documentContext.querySelector("#raster-minimum")
        .dispatchEvent(new Event("change"));
    documentContext.querySelector("#raster-palette")
        .dispatchEvent(new Event("change"));
    documentContext.querySelector("#reset-raster-style")
        .dispatchEvent(new Event("click"));

    assert.deepEqual(view.readStyle(), DEFAULT_RASTER_STYLE);
    assert.equal(view.getPaletteName(), "viridis");
    assert.equal(
        documentContext.querySelector("#raster-palette").children.length,
        2
    );
    assert.match(
        documentContext.querySelector("#raster-active-layer-label").textContent,
        /temperature\.tif; this layer is hidden/
    );
    assert.equal(documentContext.querySelector("#raster-style-controls").hidden, false);
    assert.deepEqual(received, [
        ["input", true],
        ["change"],
        ["palette"],
        ["reset"],
    ]);

    const error = Object.assign(new Error("Invalid colors"), {
        fieldGroup: "colors",
    });
    view.renderStyleError(error);
    assert.equal(
        documentContext.querySelector("#raster-minimum-color")
            .getAttribute("aria-invalid"),
        "true"
    );
    view.unbind();
    documentContext.querySelector("#reset-raster-style")
        .dispatchEvent(new Event("click"));
    assert.equal(received.length, 4);
});
