import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationDownloadDialog } from "../../src/annotations/download-dialog.js";

/**
 * @typedef {{body:Element,activeElement:Element|null,createElement:(tag:string)=>Element}} TestDocument
 */

/** Record dialog form state and dispatch events without simulating browser focus rules. */
class Element extends EventTarget {
    /**
     * Create a minimal element for the dialog's form and close-event contract.
     * @param {TestDocument} document Owner recording explicit focus requests.
     * @param {string} tag HTML tag name.
     */
    constructor(document, tag) {
        super();
        this.ownerDocument = document;
        this.tagName = tag;
        /** @type {Element[]} */
        this.children = [];
        /** @type {Map<string,string>} */
        this.attributes = new Map();
        this.textContent = "";
        this.value = "";
        this.hidden = false;
        this.open = false;
    }

    /** @param {...Element} nodes Children to retain. @return {void} */
    append(...nodes) { this.children.push(...nodes); }

    /** @param {string} name Attribute name. @param {string} value Attribute value. @return {void} */
    setAttribute(name, value) { this.attributes.set(name, value); }

    /** @param {string} name Attribute to clear. @return {void} */
    removeAttribute(name) { this.attributes.delete(name); }

    /** Record that the dialog was opened. @return {void} */
    showModal() { this.open = true; }

    /** Notify the component that a previously open dialog has closed. @return {void} */
    close() {
        if (!this.open) return;
        this.open = false;
        queueMicrotask(() => this.dispatchEvent(new Event("close")));
    }

    /** Record an explicit focus request; native restoration is covered in browser tests. @return {void} */
    focus() { this.ownerDocument.activeElement = this; }

    /** Accept the input-selection request without simulating browser selection. @return {void} */
    select() {}
}

/**
 * Connect the actual filename dialog to form elements that can receive user events.
 * @return {{view:AnnotationDownloadDialog,form:Element,cancel:Element}} Dialog and its submission/cancellation controls.
 */
function setup() {
    const document = { activeElement: null, createElement: tag => new Element(document, tag) };
    document.body = document.createElement("body");
    const view = new AnnotationDownloadDialog(document);
    const form = view.dialog.children.find(child => child.tagName === "form");
    const actions = form.children.find(child => child.tagName === "div");
    const cancel = actions.children.find(child => child.textContent === "Cancel");
    return { view, form, cancel };
}

const DEFAULT_FILENAME = "maui-restoration_Condition-layer_a1b2c3d4e5f6_2026-11-10T184512.123Z.geojson";

test("the download dialog offers the generated default and submits it unchanged", async () => {
    const { view, form } = setup();
    const choice = view.choose(DEFAULT_FILENAME, "<Condition layer>");
    assert.equal(view.dialog.open, true);
    assert.equal(view.input.value, DEFAULT_FILENAME);
    assert.equal(view.description.textContent, "Download all saved polygons from “<Condition layer>”.");
    assert.equal(view.error.hidden, true);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(await choice, DEFAULT_FILENAME);
    assert.equal(view.dialog.open, false);
});

test("edited filenames are normalized on submission and do not replace the next generated default", async () => {
    const { view, form } = setup();
    const first = view.choose(DEFAULT_FILENAME, "Condition layer");
    view.input.value = "  Workshop copy  ";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(await first, "Workshop copy.geojson");

    const nextDefault = DEFAULT_FILENAME.replace(".123Z", ".124Z");
    const second = view.choose(nextDefault, "Condition layer");
    assert.equal(view.input.value, nextDefault);
    view.input.value = "Second copy.GEOJSON";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(await second, "Second copy.geojson");

    const cancelled = view.choose(DEFAULT_FILENAME, "Condition layer");
    view.dialog.close();
    assert.equal(await cancelled, null, "a native cancellation cannot reuse the last submitted filename");
});

test("Cancel resolves without a filename and later native closure also cancels", async () => {
    const { view, cancel } = setup();
    const clickedCancel = view.choose(DEFAULT_FILENAME, "Condition layer");
    view.input.value = "Abandoned name";
    cancel.dispatchEvent(new Event("click"));
    assert.equal(await clickedCancel, null);

    const nativeClose = view.choose(DEFAULT_FILENAME, "Condition layer");
    assert.equal(view.input.value, DEFAULT_FILENAME);
    view.dialog.close();
    assert.equal(await nativeClose, null);
});

test("invalid names retain the open choice until corrected and validation state resets on reopening", async () => {
    const { view, form, cancel } = setup();
    let settled = false;
    const choice = view.choose(DEFAULT_FILENAME, "Condition layer");
    choice.then(() => { settled = true; });
    view.input.value = "invalid/name";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(view.dialog.open, true);
    assert.equal(view.input.value, "invalid/name");
    assert.equal(view.error.hidden, false);
    assert.match(view.error.textContent, /Remove these characters/);
    assert.equal(view.input.attributes.get("aria-invalid"), "true");

    view.input.value = "Corrected name";
    view.input.dispatchEvent(new Event("input"));
    assert.equal(view.error.hidden, true);
    assert.equal(view.error.textContent, "");
    assert.equal(view.input.attributes.has("aria-invalid"), false);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(await choice, "Corrected name.geojson");

    const rejectedThenCancelled = view.choose(DEFAULT_FILENAME, "Condition layer");
    view.input.value = ".geojson";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(view.error.hidden, false);
    cancel.dispatchEvent(new Event("click"));
    assert.equal(await rejectedThenCancelled, null);

    const freshChoice = view.choose(DEFAULT_FILENAME, "Another layer");
    assert.equal(view.input.value, DEFAULT_FILENAME);
    assert.equal(view.error.hidden, true);
    assert.equal(view.error.textContent, "");
    assert.equal(view.input.attributes.has("aria-invalid"), false);
    view.dialog.close();
    assert.equal(await freshChoice, null);
});
