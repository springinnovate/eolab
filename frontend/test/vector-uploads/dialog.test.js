import test from "node:test";
import assert from "node:assert/strict";
import { UploadPolygonsDialog } from "../../src/vector-uploads/dialog.js";
import { uploadPolygons } from "../../src/vector-uploads/api.js";

/** Minimal dialog elements that expose user actions and the component's rendered state. */
class Element extends EventTarget {
    /** @param {Object} document Document tracking focus. @param {string} tag Element tag. */
    constructor(document, tag) {
        super();
        Object.assign(this, { document, tagName: tag, children: [], value: "", files: [], textContent: "", hidden: false, disabled: false, open: false });
        this.attributes = new Map();
        this.classes = new Set();
        this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    /** @param {...Element} children Child elements. @return {void} */
    append(...children) { this.children.push(...children); }
    /** @param {string} name Attribute name. @param {string} value Attribute value. @return {void} */
    setAttribute(name, value) { this.attributes.set(name, value); }
    /** Open the dialog. @return {void} */
    showModal() { this.open = true; }
    /** Close the dialog and emit its browser event. @return {void} */
    close() { this.open = false; this.dispatchEvent(new Event("close")); }
    /** Record focus. @return {void} */
    focus() { this.document.activeElement = this; }
}

/**
 * Build a dialog connected to real upload transport with controlled HTTP and map completion.
 * @param {typeof fetch} fetcher Upload response provider.
 * @param {(upload:import('../../src/vector-uploads/api.js').VectorUpload)=>Promise<void>} addToMap Map composition callback.
 * @return {{dialog:UploadPolygonsDialog,document:Object,file:File}} Selected upload form.
 */
function setup(fetcher, addToMap) {
    const document = { createElement: tag => new Element(document, tag) };
    document.body = document.createElement("body");
    const trigger = document.createElement("button");
    document.querySelector = selector => { assert.equal(selector, "#upload-polygons"); return trigger; };
    const dialog = new UploadPolygonsDialog({ document, addToMap,
        upload: (file, name) => uploadPolygons(file, name, fetcher) });
    trigger.dispatchEvent(new Event("click"));
    const file = new File(["original GeoPackage bytes"], "Café wetlands.gpkg");
    dialog.file.files = [file];
    dialog.file.dispatchEvent(new Event("change"));
    return { dialog, document, file };
}

test("upload form sends the original file and chosen name, then adds the returned record to the map", async () => {
    const admitted = { id: "opaque-upload", name: "Floodplain & wetlands", fields: { label: "str" }, geometry_type: "Polygon" };
    let finishUpload;
    let finishMap;
    let request;
    let mapped;
    const { dialog, document, file } = setup(async (url, options) => {
        request = { url, options };
        return new Promise(resolve => { finishUpload = () => resolve(new Response(JSON.stringify(admitted), { status: 201 })); });
    }, async upload => {
        mapped = upload;
        return new Promise(resolve => { finishMap = resolve; });
    });
    assert.equal(dialog.name.value, "Café wetlands");
    assert.equal(document.activeElement, dialog.file);
    dialog.name.value = " Floodplain & wetlands ";
    const pending = dialog.uploadAndAdd();
    assert.equal(request.url, "/api/vector-uploads?name=Floodplain+%26+wetlands");
    assert.equal(request.options.body, file);
    assert.equal(request.options.credentials, "same-origin");
    assert.equal(request.options.cache, "no-store");
    assert.deepEqual(request.options.headers, { "Content-Type": "application/geopackage+sqlite3", "X-EOLab-Uploads": "1" });
    assert.equal(dialog.status.textContent, "Uploading polygons…");
    assert.equal(dialog.progress.hidden, false);
    assert.equal(dialog.cancel.disabled, true);
    assert.equal(dialog.dialog.dispatchEvent(new Event("cancel", { cancelable: true })), false);
    finishUpload();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(mapped, admitted);
    assert.equal(dialog.status.textContent, "Adding layer to map…");
    assert.equal(dialog.dialog.open, true);
    finishMap();
    await pending;
    assert.equal(dialog.dialog.open, false);
    assert.equal(document.activeElement, dialog.trigger);
    assert.equal(dialog.progress.hidden, true);
});

test("an admission failure keeps the file and name editable and displays the server explanation", async () => {
    let mapCalls = 0;
    const { dialog, file } = setup(async () => new Response(JSON.stringify({ detail: "Upload a GeoPackage with exactly one layer." }), { status: 422 }),
        async () => { mapCalls++; });
    dialog.name.value = "My polygons";
    await dialog.uploadAndAdd();
    assert.equal(mapCalls, 0);
    assert.equal(dialog.file.files[0], file);
    assert.equal(dialog.name.value, "My polygons");
    assert.equal(dialog.file.disabled, false);
    assert.equal(dialog.name.disabled, false);
    assert.equal(dialog.dialog.open, true);
    assert.equal(dialog.status.textContent, "Upload a GeoPackage with exactly one layer.");
    assert.equal(dialog.status.classes.has("is-error"), true);
    assert.equal(dialog.submit.textContent, "Upload and add to map");
    dialog.cancel.dispatchEvent(new Event("click"));
    assert.equal(dialog.dialog.open, false);
});

test("a rendering failure retries the admitted upload without sending its bytes again", async () => {
    let uploads = 0;
    const mapped = [];
    const { dialog } = setup(async () => {
        uploads++;
        return new Response(JSON.stringify({ id: "existing-upload", name: "Wetlands" }), { status: 201 });
    }, async upload => {
        mapped.push(upload);
        if (mapped.length === 1) throw new Error("Rendering is unavailable. Try again.");
    });
    await dialog.uploadAndAdd();
    assert.equal(dialog.file.disabled, true);
    assert.equal(dialog.name.disabled, true);
    assert.equal(dialog.cancel.disabled, false);
    assert.equal(dialog.cancel.textContent, "Close");
    assert.equal(dialog.submit.textContent, "Retry add to map");
    assert.match(dialog.status.textContent, /Your file was uploaded, but could not be added to the map.*Rendering is unavailable/);
    await dialog.uploadAndAdd();
    assert.equal(uploads, 1);
    assert.equal(mapped[0], mapped[1]);
    assert.equal(dialog.dialog.open, false);
    dialog.open();
    assert.equal(dialog.uploaded, null);
    assert.equal(dialog.name.disabled, false);
    assert.equal(dialog.name.value, "");
});

test("upload transport explains network and non-JSON server failures", async () => {
    const file = new File(["bytes"], "polygons.gpkg");
    await assert.rejects(uploadPolygons(file, "Polygons", async () => { throw new TypeError("Failed to fetch"); }),
        /Could not reach the server/);
    await assert.rejects(uploadPolygons(file, "Polygons", async () => new Response("proxy size limit", { status: 413 })),
        /Choose a smaller file or ask the administrator/);
});
