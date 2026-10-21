import test from "node:test";
import assert from "node:assert/strict";
import { UploadPolygonsDialog } from "../../src/vector-uploads/dialog.js";
import { deleteUpload, getUpload, listUploads, uploadPolygons } from "../../src/vector-uploads/api.js";

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
    /** @param {...Element} children Replacement children. @return {void} */
    replaceChildren(...children) { this.children = children; }
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
 * @param {Object} [options] Upload listing, deletion and map callbacks.
 * @return {Promise<{dialog:UploadPolygonsDialog,document:Object,file:File}>} Selected upload form.
 */
async function setup(fetcher, addToMap, options = {}) {
    const document = { createElement: tag => new Element(document, tag) };
    document.body = document.createElement("body");
    const trigger = document.createElement("button");
    document.querySelector = selector => { assert.equal(selector, "#upload-polygons"); return trigger; };
    const dialog = new UploadPolygonsDialog({ document, addToMap,
        isOnMap: () => false, onDeleted() {}, list: async () => [],
        upload: (file, name) => uploadPolygons(file, name, fetcher), ...options });
    await dialog.open();
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
    const { dialog, document, file } = await setup(async (url, options) => {
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
    const { dialog, file } = await setup(async () => new Response(JSON.stringify({ detail: "Upload a GeoPackage with exactly one layer." }), { status: 422 }),
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
    const { dialog } = await setup(async () => {
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
    await dialog.open();
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

test("existing uploads reopen from the server list without uploading again", async () => {
    const upload = { id: "stored-upload", name: "Wetlands" };
    const mapped = [];
    let lists = 0;
    const { dialog, document } = await setup(() => assert.fail("No file upload is needed"), async item => mapped.push(item), {
        list: () => listUploads(async (url, options) => {
            lists++;
            assert.equal(url, "/api/vector-uploads");
            assert.equal(options.credentials, "same-origin");
            assert.equal(options.cache, "no-store");
            return new Response(JSON.stringify([upload]));
        }),
        isOnMap: () => mapped.length > 0,
    });
    assert.equal(dialog.rows[0].add.textContent, "Add to map");
    assert.equal(dialog.rows[0].add.attributes.get("aria-label"), "Add to map: Wetlands");
    assert.equal(document.activeElement, dialog.rows[0].add);
    await dialog.addExistingUpload(upload);
    assert.deepEqual(mapped, [upload]);
    assert.equal(dialog.dialog.open, false);
    await dialog.open();
    assert.equal(lists, 2);
    assert.equal(dialog.rows[0].add.textContent, "On map");
    assert.equal(dialog.rows[0].add.disabled, true);
    assert.equal(dialog.rows[0].remove.disabled, false);
    assert.equal(document.activeElement, dialog.file);
});

test("listing failures can be retried without changing map layers or the file form", async () => {
    let fail = true;
    const { dialog, file } = await setup(() => assert.fail("No upload"), () => assert.fail("No map change"), {
        list: async () => {
            if (fail) throw new Error("Upload storage could not be read. Try again shortly.");
            return [{ id: "stored-upload", name: "Wetlands" }];
        },
    });
    assert.equal(dialog.retry.hidden, false);
    assert.match(dialog.status.textContent, /Upload storage/);
    fail = false;
    await dialog.loadUploads();
    assert.equal(dialog.rows.length, 1);
    assert.equal(dialog.retry.hidden, true);
    assert.equal(dialog.file.files[0], file);
    assert.equal(dialog.status.textContent, "");
});

test("deleting a file requires confirmation and preserves the map until server success", async () => {
    const upload = { id: "stored-upload", name: "Wetlands" };
    const deleted = [];
    let attempts = 0;
    let finish;
    const { dialog, document } = await setup(() => assert.fail("No upload"), () => assert.fail("No map addition"), {
        list: async () => [upload], isOnMap: () => true, onDeleted: id => deleted.push(id),
        deleteFile: id => deleteUpload(id, async (url, options) => {
            attempts++;
            assert.equal(url, "/api/vector-uploads/stored-upload");
            assert.equal(options.method, "DELETE");
            assert.equal(options.credentials, "same-origin");
            assert.equal(options.cache, "no-store");
            assert.deepEqual(options.headers, { "X-EOLab-Uploads": "1" });
            if (attempts === 1) return new Response(JSON.stringify({ detail: "Try deleting this file again." }), { status: 503 });
            return new Promise(resolve => { finish = () => resolve(new Response(null, { status: 204 })); });
        }),
    });
    dialog.rows[0].remove.dispatchEvent(new Event("click"));
    assert.equal(attempts, 0);
    assert.equal(dialog.confirmation.hidden, false);
    assert.match(dialog.confirmationText.textContent, /cannot be reopened from saved maps.*already submitted can finish.*cannot be undone/);
    assert.equal(document.activeElement, dialog.keep);
    dialog.keep.dispatchEvent(new Event("click"));
    assert.equal(dialog.confirmation.hidden, true);
    assert.equal(document.activeElement, dialog.rows[0].remove);
    dialog.rows[0].remove.dispatchEvent(new Event("click"));
    await dialog.deleteSelectedUpload();
    assert.deepEqual(deleted, []);
    assert.equal(dialog.rows.length, 1);
    assert.equal(dialog.confirmation.hidden, false);
    assert.equal(dialog.status.textContent, "Try deleting this file again.");
    const deleting = dialog.deleteSelectedUpload();
    assert.equal(dialog.confirmDelete.disabled, true);
    assert.equal(dialog.keep.disabled, true);
    assert.equal(dialog.cancel.disabled, true);
    assert.deepEqual(deleted, []);
    finish();
    await deleting;
    assert.deepEqual(deleted, [upload.id]);
    assert.equal(dialog.rows.length, 0);
    assert.equal(dialog.empty.hidden, false);
    assert.equal(dialog.confirmation.hidden, true);
    assert.equal(document.activeElement, dialog.file);
    assert.equal(dialog.status.textContent, "Wetlands was deleted from the server.");
});

test("reopening saved upload identifiers uses the current browser's credentials and reports unavailable files", async () => {
    const upload = { id: "stored-upload", name: "Wetlands" };
    assert.deepEqual(await getUpload(upload.id, async (url, options) => {
        assert.equal(url, "/api/vector-uploads/stored-upload");
        assert.equal(options.method, "GET");
        assert.equal(options.credentials, "same-origin");
        assert.equal(options.cache, "no-store");
        assert.equal(options.body, undefined);
        return new Response(JSON.stringify(upload));
    }), upload);
    for (const request of [getUpload, deleteUpload]) {
        await assert.rejects(request(upload.id, async () => new Response(JSON.stringify({
            detail: "This upload is not available to this browser.",
        }), { status: 404 })), /deleted or belong to another browser.*browser that uploaded the file.*upload it again/);
    }
});
