import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterAppearanceControlsView,
} from "../../src/raster/appearance-controls-view.js";
import { DEFAULT_RASTER_STYLE, validateRasterStyle } from "../../src/raster/style.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("appearance adapter owns style reads, direct presentation, and listeners", () => {
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
    documentContext.querySelector("#raster-appearance-controls").hidden = true;
    view.setActiveRasterAvailable(true);
    assert.equal(
        documentContext.querySelector("#raster-appearance-controls").hidden,
        false
    );
    assert.equal(
        documentContext.querySelector("#raster-appearance-controls")
            .getAttribute("aria-hidden"),
        "false"
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

    view.setActiveRasterAvailable(false);
    assert.equal(
        documentContext.querySelector("#raster-appearance-controls").hidden,
        true
    );
    view.setActiveRasterAvailable(true);
    view.showWidget(true);
    assert.equal(
        documentContext.activeElement,
        documentContext.querySelector("#raster-palette")
    );

    const error = Object.assign(new Error("Invalid colors"), {
        fieldGroup: "colors",
    });
    view.renderStyleError(error);
    assert.equal(
        documentContext.querySelector("#raster-minimum-color")
            .getAttribute("aria-invalid"),
        "true"
    );
    view.setStatus("Applied the Viridis palette.");
    assert.equal(
        documentContext.querySelector("#raster-appearance-status").textContent,
        "Applied the Viridis palette."
    );
    assert.throws(
        () => view.setStatus(null),
        /Raster appearance status must be a string/
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

test("opacity controls convert percent, validate blanks, and share the edit lifecycle", () => {
    const doc = new FakeRasterControlDocument();
    const view = new RasterAppearanceControlsView(doc);
    const events = [];
    view.bind({ onStyleInput: value => events.push(value), onStyleChange: () => events.push("commit") });
    view.setStyle({ ...DEFAULT_RASTER_STYLE, minimumOpacity: 0, midpointOpacity: 0.35 }, "viridis");
    const input = doc.querySelector("#raster-midpoint-opacity");
    assert.equal(input.value, 35);
    assert.equal(view.readStyle().minimumOpacity, 0);
    assert.equal(view.readStyle().midpointOpacity, 0.35);
    input.value = "75";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
    assert.deepEqual(events, [false, "commit"]);
    assert.equal(view.getPaletteName(), "viridis", "opacity does not change the RGB palette");
    assert.equal(view.readStyle().midpointOpacity, 0.75);
    input.value = "";
    let error;
    try { validateRasterStyle(view.readStyle()); } catch (caught) { error = caught; }
    view.renderStyleError(error);
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(doc.querySelector("#raster-midpoint").getAttribute("aria-invalid"), null);
    view.setStyle(DEFAULT_RASTER_STYLE, "blue-yellow-red");
    assert.equal(input.value, 100);
    assert.equal(input.getAttribute("aria-invalid"), null);
    view.setEnabled(false);
    assert.equal(input.disabled, true);
    view.unbind();
    input.dispatchEvent(new Event("input"));
    assert.equal(events.length, 2);
});
