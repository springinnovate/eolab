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
    view.bind({
        onStyleInput: (isColor) => received.push(["input", isColor]),
        onStyleChange: () => received.push(["change"]),
        onPaletteChange: () => received.push(["palette"]),
        onResetStyle: () => received.push(["reset"]),
    });
    const launcher = documentContext.querySelector(
        "#open-raster-appearance-widget"
    );
    documentContext.querySelector("#raster-appearance-controls").hidden = true;
    launcher.hidden = true;
    view.setActiveRasterAvailable(true);
    launcher.dispatchEvent(new Event("click"));
    assert.equal(
        documentContext.querySelector("#raster-appearance-controls").hidden,
        false
    );
    assert.equal(launcher.getAttribute("aria-expanded"), "true");
    assert.equal(
        documentContext.activeElement,
        documentContext.querySelector("#close-raster-appearance-widget")
    );

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
    assert.deepEqual(received, [
        ["input", true],
        ["change"],
        ["palette"],
        ["reset"],
    ]);

    const escapeEvent = new Event("keydown", { cancelable: true });
    Object.defineProperty(escapeEvent, "key", { value: "Escape" });
    documentContext.querySelector("#raster-appearance-controls")
        .dispatchEvent(escapeEvent);
    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(
        documentContext.querySelector("#raster-appearance-controls").hidden,
        true
    );
    assert.equal(documentContext.activeElement, launcher);

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

test("appearance adapter requires its semantic subgroup root", () => {
    assert.throws(
        () => new RasterAppearanceControlsView({ querySelector: () => null }),
        /Required raster control is missing: #raster-appearance-controls/
    );
});
