import assert from "node:assert/strict";
import test from "node:test";

import { CategoricalRasterEditorView } from "../../src/raster/categorical-editor-view.js";
import { normalizeCategoricalRasterStyle } from "../../src/raster/categorical-style.js";
import { MAX_CATEGORICAL_RASTER_CSV_BYTES } from "../../src/raster/categorical-csv.js";
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
    assert.equal(view.csvFile.disabled, true);
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

/**
 * Select a local CSV file and allow its asynchronous read to finish.
 * @param {CategoricalRasterEditorView} view Bound editor under test.
 * @param {string} text CSV file contents.
 * @param {string} [name="categories.csv"] File name shown in the preview.
 * @return {Promise<void>} Resolves after preview rendering.
 */
async function selectCsv(view, text, name = "categories.csv") {
    const bytes = new TextEncoder().encode(text);
    view.csvFile.files = [{ name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }];
    view.csvFile.dispatchEvent(new Event("change"));
    await new Promise(resolve => setImmediate(resolve));
}

/**
 * Start a file read whose completion is controlled by the caller.
 * @param {CategoricalRasterEditorView} view Bound editor under test.
 * @return {(text:string) => Promise<void>} Completes the read and drains reactions.
 */
function deferCsv(view) {
    let resolveRead;
    const read = new Promise(resolve => { resolveRead = resolve; });
    view.csvFile.files = [{ name: "pending.csv", size: 100, arrayBuffer: () => read }];
    view.csvFile.dispatchEvent(new Event("change"));
    return async text => {
        resolveRead(new TextEncoder().encode(text).buffer);
        await new Promise(resolve => setImmediate(resolve));
    };
}

/** Test document that reproduces native single-line and multiline value sanitation. */
class NativeTextValueDocument extends FakeRasterControlDocument {
    /**
     * Create a fake element with the native text-field newline behavior.
     * @param {string} tagName Requested HTML tag name.
     * @return {import("../../test-support/raster/fake-controls-document.js").FakeRasterControlElement} New element.
     */
    createElement(tagName) {
        const element = super.createElement(tagName);
        element.tagName = tagName.toUpperCase();
        if (tagName === "input" || tagName === "textarea") {
            let value = "";
            Object.defineProperty(element, "value", {
                get: () => value,
                set: next => {
                    value = String(next);
                    if (tagName === "textarea") value = value.replace(/\r\n?/g, "\n");
                    else if (element.type === "text") value = value.replace(/[\r\n]/g, "");
                },
            });
        }
        return element;
    }
}

test("quoted CSV multiline labels survive native field sanitation, editing, and style hydration", async () => {
    const view = new CategoricalRasterEditorView(new NativeTextValueDocument());
    view.setStyle(style);
    const commits = [];
    view.bind({ onCategoricalStyleChange: () => commits.push(view.readStyle()) });
    for (const row of view.rows) {
        assert.equal(row.inputs.label.tagName, "TEXTAREA");
        assert.equal(row.inputs.label.rows, 2);
    }
    await selectCsv(view, 'value,label,color\r\n4,"Forest\r\nwetland",#112233\r\n5,"Water\nice",#445566');
    assert.equal(view.csvRows.children[0].children[2].textContent, "Forest\nwetland");
    view.csvApply.dispatchEvent(new Event("click"));
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].categories.map(row => row.label), ["Forest\nwetland", "Water\nice"]);
    assert.equal(view.rows[0].inputs.label.getAttribute("aria-label"), "Category 1 label");
    assert.equal(view.rows[0].inputs.label.getAttribute("aria-describedby"), "raster-category-error");
    view.setStyle(commits[0]);
    assert.deepEqual(view.readStyle(), commits[0], "Restoring an imported style preserves line breaks");
    view.rows[0].inputs.label.value = "Forest\nwetland\nrestored";
    view.rows[0].inputs.label.dispatchEvent(new Event("change"));
    assert.equal(commits[1].categories[0].label, "Forest\nwetland\nrestored");
    view.setEnabled(false);
    assert.equal(view.rows[0].inputs.label.disabled, true);
});

test("CSV preview preserves manual drafts until one atomic replacement with current unmapped settings", async () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new CategoricalRasterEditorView(documentContext);
    const commits = [];
    view.setStyle(style);
    view.rows[0].inputs.label.value = "Incomplete manual draft";
    view.rows[1].inputs.value.value = "";
    view.unmappedColor.value = "#123456";
    view.unmappedOpacity.value = "0";
    const previousRows = [...view.rows];
    view.bind({
        onCategoricalStyleInput: () => assert.fail("Import must not emit draft input"),
        onCategoricalStyleChange: () => commits.push(view.readStyle()),
    });
    await selectCsv(view, '\uFEFFvalue,label,color,opacity\r\n0,"Water, ice",#AABBCC,0\r\n-2,"<b>Forest</b>",#001122,0.29\r\n41,"Trees ""mixed""",#445566,1\r\n');
    assert.deepEqual(view.rows, previousRows);
    assert.equal(view.rows[1].inputs.value.value, "");
    assert.equal(commits.length, 0);
    assert.equal(view.csvPreview.hidden, false);
    assert.equal(view.csvTable.hidden, false);
    assert.equal(view.csvApply.disabled, false);
    assert.equal(view.csvRoot.getAttribute("aria-busy"), "false");
    assert.equal(documentContext.activeElement, view.csvPreview);
    assert.deepEqual(view.csvRows.children.map(row => row.children.map(cell => cell.textContent)), [
        ["1", "0", "Water, ice", "#aabbcc", "0"],
        ["2", "-2", "<b>Forest</b>", "#001122", "0.29"],
        ["3", "41", 'Trees "mixed"', "#445566", "1"],
    ]);
    view.csvApply.dispatchEvent(new Event("click"));
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].categories.map(row => row.value), [0, -2, 41]);
    assert.equal(commits[0].categories[1].opacity, 0.29);
    assert.deepEqual(commits[0].unmapped, { color: "#123456", opacity: 0 });
    assert.equal(view.csvPreview.hidden, true);
    assert.equal(view.csvRows.children.length, 0);
    assert.equal(documentContext.activeElement, view.rows[0].inputs.value);
    previousRows[0].inputs.label.dispatchEvent(new Event("change"));
    assert.equal(commits.length, 1, "Replaced rows release listeners");
    view.csvApply.dispatchEvent(new Event("click"));
    assert.equal(commits.length, 1, "A consumed preview cannot apply twice");
});

test("Cancel import restores file focus without changing categories or unmapped drafts", async () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new CategoricalRasterEditorView(documentContext);
    view.setStyle(style);
    view.bind({ onCategoricalStyleChange: () => assert.fail("Cancel cannot commit") });
    await selectCsv(view, "value,label,color\n4,Imported,#112233");
    view.csvCancel.dispatchEvent(new Event("click"));
    assert.deepEqual(view.readStyle(), style);
    assert.equal(view.csvPreview.hidden, true);
    assert.equal(view.csvFile.value, "");
    assert.equal(documentContext.activeElement, view.csvFile);
    await selectCsv(view, "value,label,color\n4,Imported,#112233");
    assert.equal(view.csvApply.disabled, false, "The same file can be selected again");
});

test("CSV failures clear an earlier preview and never replace existing rows", async () => {
    const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
    view.setStyle(style);
    view.bind({ onCategoricalStyleChange: () => assert.fail("Invalid imports cannot commit") });
    await selectCsv(view, "value,label,color\n4,Valid,#112233");
    assert.equal(view.csvRows.children.length, 1);
    await selectCsv(view, "value,label,color\n4,Valid,#112233\n4,Duplicate,#445566");
    assert.match(view.csvStatus.textContent, /CSV row 3, column "value".*duplicates/);
    assert.equal(view.csvApply.disabled, true);
    assert.equal(view.csvTable.hidden, true);
    assert.equal(view.csvRows.children.length, 0);
    assert.equal(view.csvSummary.textContent, "");
    view.csvApply.dispatchEvent(new Event("click"));
    assert.deepEqual(view.readStyle(), style);
});

test("CSV replacement validates the current unmapped draft before changing any category", async () => {
    const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
    view.setStyle(style);
    view.bind({ onCategoricalStyleChange: () => assert.fail("Invalid fallback cannot commit") });
    view.unmappedColor.value = "#invalid";
    const previousRows = [...view.rows];
    await selectCsv(view, "value,label,color\n4,Imported,#112233");
    view.csvApply.dispatchEvent(new Event("click"));
    assert.deepEqual(view.rows, previousRows);
    assert.equal(view.unmappedColor.value, "#invalid");
    assert.equal(view.unmappedColor.getAttribute("aria-invalid"), "true");
    assert.match(view.csvStatus.textContent, /Cannot replace categories: Unmapped color/);
    assert.equal(view.csvApply.disabled, true);
    view.unmappedColor.value = "#123456";
    view.unmappedColor.dispatchEvent(new Event("input"));
    assert.equal(view.csvPreview.hidden, true, "Manual corrections invalidate the preview");
});

test("CSV size and UTF-8 failures are local and oversized files are rejected before reading", async () => {
    const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
    view.setStyle(style);
    view.bind({ onCategoricalStyleChange: () => assert.fail("File failures cannot commit") });
    view.csvFile.files = [{ name: "large.csv", size: MAX_CATEGORICAL_RASTER_CSV_BYTES + 1,
        arrayBuffer: () => assert.fail("Oversized file must not be read") }];
    view.csvFile.dispatchEvent(new Event("change"));
    assert.match(view.csvStatus.textContent, /128 KiB/);
    assert.equal(view.csvApply.disabled, true);
    view.csvFile.files = [{ name: "encoding.csv", size: 2,
        arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }];
    view.csvFile.dispatchEvent(new Event("change"));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(view.csvStatus.textContent, /valid UTF-8/);
    view.csvFile.files = [{ name: "unreadable.csv", size: 1,
        arrayBuffer: async () => { throw new Error("File is no longer available"); } }];
    view.csvFile.dispatchEvent(new Event("change"));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(view.csvStatus.textContent, /File is no longer available/);
    assert.equal(view.csvRoot.getAttribute("aria-busy"), "false");
    assert.deepEqual(view.readStyle(), style);
});

test("new file selection wins over an earlier pending CSV read", async () => {
    const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
    view.setStyle(style);
    view.bind({ onCategoricalStyleChange: () => assert.fail("Preview cannot commit") });
    const completeOld = deferCsv(view);
    assert.equal(view.csvRoot.getAttribute("aria-busy"), "true");
    assert.equal(view.csvApply.disabled, true);
    await selectCsv(view, "value,label,color\n9,Newest,#998877", "newest.csv");
    await completeOld("value,label,color\n4,Obsolete,#112233");
    assert.match(view.csvSummary.textContent, /^newest\.csv:/);
    assert.equal(view.csvRows.children[0].children[1].textContent, "9");
    assert.deepEqual(view.readStyle(), style);
});

test("manual edits and editor lifecycle transitions invalidate outstanding CSV reads", async t => {
    for (const [name, transition] of [
        ["category input", view => view.rows[0].inputs.label.dispatchEvent(new Event("input"))],
        ["category change", view => view.rows[0].inputs.label.dispatchEvent(new Event("change"))],
        ["unmapped input", view => view.unmappedOpacity.dispatchEvent(new Event("input"))],
        ["add row", view => view.addButton.dispatchEvent(new Event("click"))],
        ["hydrate", view => view.setStyle(style)],
        ["disable", view => view.setEnabled(false)],
        ["unbind", view => view.unbind()],
        ["explicit cancel", view => view.csvCancel.dispatchEvent(new Event("click"))],
    ]) {
        await t.test(name, async () => {
            const view = new CategoricalRasterEditorView(new FakeRasterControlDocument());
            view.setStyle(style);
            let commits = 0;
            view.bind({ onCategoricalStyleChange: () => { commits += 1; } });
            const complete = deferCsv(view);
            transition(view);
            const beforeCompletion = commits;
            await complete("value,label,color\n4,Obsolete,#112233");
            assert.equal(view.csvPreview.hidden, true);
            assert.equal(view.csvRows.children.length, 0);
            assert.equal(view.csvStatus.textContent, "");
            assert.equal(view.csvRoot.getAttribute("aria-busy"), "false");
            assert.equal(commits, beforeCompletion);
            assert.equal(view.rows[0].inputs.value.value, "0");
        });
    }
});
