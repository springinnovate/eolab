import assert from "node:assert/strict";
import test from "node:test";

import { CategoricalRasterEditorView } from "../../src/raster/categorical-editor-view.js";
import { normalizeCategoricalRasterStyle } from "../../src/raster/categorical-style.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const style = normalizeCategoricalRasterStyle({
    mode: "categorical",
    categories: [
        { value: 0, label: "Water", color: "#0022ff", opacity: 0 },
        { value: -3, label: "Forest", color: "#00aa44", opacity: 0.35 },
        { value: 41, label: "Urban", color: "#ff2233", opacity: 1 },
    ],
    unmapped: { color: "#bbbbbb", opacity: 0.75 },
});

test("category editor starts with an invalid empty draft and reads canonical style semantics", () => {
    const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].inputs.value.value, "");
    assert.throws(() => view.readStyle(), /Category 1 value must be a safe integer/);
    view.setStyle(style);
    assert.deepEqual(view.readStyle(), style);
    assert.equal(view.rows[0].inputs.opacity.value, "0");
    assert.equal(view.rows[1].inputs.opacity.value, "35");
    assert.equal(view.unmappedOpacity.value, "75");
    view.rows[0].inputs.label.value = "  Water & ice  ";
    view.rows[0].inputs.color.value = "#ABCDEF";
    assert.equal(view.readStyle().categories[0].label, "Water & ice");
    assert.equal(view.readStyle().categories[0].color, "#abcdef");
    assert.ok(Object.isFrozen(view.readStyle().categories[0]));
    assert.equal(view.rows[0].inputs.label.value, "  Water & ice  ", "reading does not rewrite the draft");
});

test("category errors mark the relevant row or unmapped field and do not erase edits", () => {
    const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
    view.setStyle(style);
    view.rows[1].inputs.value.value = "0";
    let error;
    try { view.readStyle(); } catch (caught) { error = caught; }
    view.renderError(error);
    assert.match(view.error.textContent, /Category 2 value duplicates/);
    assert.equal(view.rows[1].inputs.value.getAttribute("aria-invalid"), "true");
    assert.equal(view.rows[0].inputs.value.getAttribute("aria-invalid"), null);
    assert.equal(view.rows[1].inputs.value.value, "0");
    view.rows[1].inputs.value.value = "-3";
    view.unmappedOpacity.value = "";
    try { view.readStyle(); } catch (caught) { error = caught; }
    view.renderError(error);
    assert.match(view.error.textContent, /Unmapped opacity/);
    assert.equal(view.unmappedOpacity.getAttribute("aria-invalid"), "true");
    assert.equal(view.rows[1].inputs.value.getAttribute("aria-invalid"), null);
    view.renderError();
    assert.equal(view.error.textContent, "");
    assert.equal(view.unmappedOpacity.getAttribute("aria-invalid"), null);
});

test("row actions preserve order, follow focus, and release removed listeners", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new CategoricalRasterEditorView(documentContext);
    const edits = [];
    view.setStyle(style);
    view.bind({
        onCategoricalStyleInput: () => edits.push("input"),
        onCategoricalStyleChange: () => edits.push("change"),
    });
    const middle = view.rows[1];
    middle.actions.up.dispatchEvent(new Event("click"));
    assert.deepEqual(view.readStyle().categories.map(row => row.value), [-3, 0, 41]);
    assert.equal(view.rowsRoot.children.length, 3);
    assert.equal(middle.legend.textContent, "Category 1");
    assert.equal(middle.inputs.value.getAttribute("aria-label"), "Category 1 value");
    assert.equal(middle.actions.up.disabled, true);
    assert.equal(documentContext.activeElement, middle.inputs.value);
    middle.actions.down.dispatchEvent(new Event("click"));
    assert.deepEqual(view.readStyle().categories.map(row => row.value), [0, -3, 41]);
    assert.equal(documentContext.activeElement, middle.actions.down);
    middle.actions.remove.dispatchEvent(new Event("click"));
    assert.deepEqual(view.readStyle().categories.map(row => row.value), [0, 41]);
    assert.equal(documentContext.activeElement, view.rows[1].inputs.value);
    middle.inputs.value.dispatchEvent(new Event("input"));
    assert.deepEqual(edits, ["change", "change", "change"]);
    view.addButton.dispatchEvent(new Event("click"));
    assert.equal(view.rows.length, 3);
    assert.equal(documentContext.activeElement, view.rows[2].inputs.value);
    assert.throws(() => view.readStyle(), /Category 3 value/);
    while (view.rows.length) view.rows[0].actions.remove.dispatchEvent(new Event("click"));
    assert.equal(documentContext.activeElement, view.addButton);
    assert.throws(() => view.readStyle(), /1 to 256 rows/);
});

test("hex and native color controls synchronize only valid colors and detach on unbind", () => {
    const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
    const edits = [];
    view.bind({
        onCategoricalStyleInput: () => edits.push("input"),
        onCategoricalStyleChange: () => edits.push("change"),
    });
    view.setStyle(style);
    const row = view.rows[0];
    row.inputs.color.value = "#12";
    row.inputs.color.dispatchEvent(new Event("input"));
    assert.equal(row.swatch.value, "#0022ff");
    assert.equal(row.inputs.color.value, "#12");
    row.inputs.color.value = "#123456";
    row.inputs.color.dispatchEvent(new Event("input"));
    assert.equal(row.swatch.value, "#123456");
    row.swatch.value = "#fedcba";
    row.swatch.dispatchEvent(new Event("input"));
    row.swatch.dispatchEvent(new Event("change"));
    assert.equal(row.inputs.color.value, "#fedcba");
    view.unmappedSwatch.value = "#654321";
    view.unmappedSwatch.dispatchEvent(new Event("input"));
    assert.equal(view.unmappedColor.value, "#654321");
    assert.deepEqual(edits, ["input", "input", "input", "change", "input"]);
    view.unbind();
    row.inputs.color.dispatchEvent(new Event("input"));
    view.unmappedSwatch.dispatchEvent(new Event("input"));
    view.addButton.dispatchEvent(new Event("click"));
    assert.equal(view.rows.length, 3);
    assert.equal(edits.length, 5);
});

test("category count bound and disabled state cover all editable fields and actions", () => {
    const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
    view.bind({ onCategoricalStyleInput() {}, onCategoricalStyleChange() {} });
    view.setStyle(normalizeCategoricalRasterStyle({
        mode: "categorical",
        categories: Array.from({ length: 256 }, (_, value) => ({ value, label: `Class ${value}`, color: "#808080" })),
    }));
    assert.equal(view.addButton.disabled, true);
    assert.equal(view.count.textContent, "256 / 256 categories");
    view.addButton.dispatchEvent(new Event("click"));
    assert.equal(view.rows.length, 256);
    view.setEnabled(false);
    assert.equal(view.rows[1].inputs.label.disabled, true);
    assert.equal(view.rows[1].swatch.disabled, true);
    assert.equal(view.rows[1].actions.up.disabled, true);
    assert.equal(view.rows[1].actions.remove.disabled, true);
    assert.equal(view.unmappedOpacity.disabled, true);
    view.rows[1].actions.remove.dispatchEvent(new Event("click"));
    assert.equal(view.rows.length, 256);
    view.setEnabled(true);
    assert.equal(view.rows[1].inputs.label.disabled, false);
    assert.equal(view.rows[1].actions.up.disabled, false);
    assert.equal(view.rows[0].actions.up.disabled, true);
    assert.equal(view.rows[255].actions.down.disabled, true);
    view.rows[0].actions.remove.dispatchEvent(new Event("click"));
    assert.equal(view.addButton.disabled, false);
});
