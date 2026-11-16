import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationSessionsView } from "../../src/annotation-sessions/view.js";
import { AnnotationSessionsController } from "../../src/annotation-sessions/controller.js";

/** DOM test element supporting retained forms and movable status messages. */
class Element extends EventTarget {
    /** @param {Object} document Owner tracking focus. @param {string} tag HTML tag. */
    constructor(document, tag) {
        super(); this.ownerDocument = document; this.tagName = tag; this.children = [];
        this.attributes = new Map(); this.classes = new Set(); this.textContent = "";
        this.hidden = false; this.disabled = false; this.value = ""; this.open = false;
        this.classList = { toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name) };
    }
    /** @param {...Element} nodes Elements to move into this parent. @return {void} */
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    /** Remove this element from its current parent. @return {void} */
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    /** @param {...Element} nodes New child elements. @return {void} */
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    /** @return {Element|undefined} First child. */
    get firstChild() { return this.children[0]; }
    /** @param {string} name Attribute name. @param {string} value Attribute value. @return {void} */
    setAttribute(name, value) { this.attributes.set(name, value); }
    /** Show the modal. @return {void} */
    showModal() { this.open = true; }
    /** Close now and queue the native close event for a later task. @return {void} */
    close() { this.open = false; this.ownerDocument.closeEvents.push(() => this.dispatchEvent(new Event("close"))); }
    /** Apply the native Escape dismissal unless its cancel event is prevented. @return {void} */
    requestClose() {
        const event = new Event("cancel", { cancelable: true });
        this.oncancel?.(event); this.dispatchEvent(event);
        if (!event.defaultPrevented) this.close();
    }
    /** Focus this element. @return {void} */
    focus() { this.ownerDocument.activeElement = this; }
}

/** @return {Object} Minimal browser document with explicitly queued native close events. */
function createDocument() {
    const document = { createElement: tag => new Element(document, tag), closeEvents: [] };
    document.body = document.createElement("body");
    const buttons = new Map();
    document.querySelector = key => { if (!buttons.has(key)) buttons.set(key, document.createElement("button")); return buttons.get(key); };
    return document;
}

/** @return {Object} Dialog and connection calls through its public actions. */
function setup() {
    const document = createDocument();
    const calls = [];
    const view = new AnnotationSessionsView(document, { connect: (...args) => calls.push(args), rename: (...args) => calls.push(["rename", ...args]),
        listLayers: () => calls.push(["list"]), addLayer: layer => calls.push(["add", layer]) });
    return { view, document, calls };
}

/** Connect the real controller and view to held API requests and observable map callbacks.
 * @return {{controller:AnnotationSessionsController,view:AnnotationSessionsView,document:Object,requests:Object[],added:string[]}} Dialog boundary fixture.
 */
function setupController() {
    const document = createDocument(); const requests = []; const added = []; const stored = new Map();
    const controller = new AnnotationSessionsController({ document,
        api: { request: (path, method = "GET", body) => new Promise((resolve, reject) => requests.push({ path, method, body, resolve, reject })) },
        getLayers: () => [], saveLocalLayers: async () => {}, isLayerOnMap: id => added.includes(id),
        createLayer: async () => { added.push("local"); return "local"; }, present: () => {}, revealLayer: () => {},
        storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    });
    return { controller, view: controller.view, document, requests, added };
}

const MEMBERSHIP = { id: "11111111-1111-4111-8111-111111111111", name: "Watersheds", joinCode: "ABCDEFGH" };

/** Finish one held membership read with either layer metadata or a transport failure.
 * @param {{resolve:(value:Object[])=>void,reject:(error:Error)=>void}} request Held API request.
 * @param {"success"|"failure"} outcome Result to deliver.
 * @return {void}
 */
function finishList(request, outcome) {
    if (outcome === "success") request.resolve([MEMBERSHIP]);
    else request.reject(new Error("Old list unavailable"));
}

for (const dismissal of ["Close", "Escape"]) {
    for (const outcome of ["success", "failure"]) {
        test(`${dismissal} dismisses a held membership read and ignores its late ${outcome}`, async t => {
            const { controller, view, requests, added } = setupController(); t.after(() => controller.destroy());
            const pending = controller.showYourLayers();
            assert.equal(view.cancel.disabled, false);
            assert.equal(view.status.textContent, "Loading your layers…");
            if (dismissal === "Close") view.cancel.dispatchEvent(new Event("click"));
            else view.dialog.requestClose();
            assert.equal(view.dialog.open, false);
            finishList(requests[0], outcome); await pending;
            assert.equal(view.dialog.open, false);
            assert.equal(view.status.textContent, "Loading your layers…");
            assert.equal(view.library.children.length, 0);
            assert.deepEqual(requests.map(({ path, method }) => [path, method]), [["", "GET"]]);
            assert.deepEqual(added, []);
        });
    }
}

for (const outcome of ["success", "failure"]) {
    for (const oldFinishesFirst of [true, false]) {
        test(`reopening ignores old ${outcome} ${oldFinishesFirst ? "before" : "after"} the current list finishes`, async t => {
            const { controller, view, document, requests } = setupController(); t.after(() => controller.destroy());
            const old = controller.showYourLayers();
            view.cancel.dispatchEvent(new Event("click"));
            const current = controller.showYourLayers();
            for (const deliverClose of document.closeEvents.splice(0)) deliverClose();
            assert.equal(view.dialog.open, true, "the queued close event belongs to the previous opening");
            if (oldFinishesFirst) {
                finishList(requests[0], outcome); await old;
                assert.equal(view.status.textContent, "Loading your layers…");
                assert.equal(view.library.children.length, 0);
            }
            requests[1].resolve([{ ...MEMBERSHIP, name: "Current list" }]); await current;
            if (!oldFinishesFirst) { finishList(requests[0], outcome); await old; }
            assert.equal(view.library.children[0].children[0].textContent, "Current list");
            assert.match(view.status.textContent, /Add a layer without joining again/);
            assert.equal(view.layerButtons[0].button.disabled, false);
            assert.equal(view.cancel.disabled, false);
            assert.equal(view.dialog.open, true);
        });
    }
}

for (const mode of ["create", "join", "contribute", "rename"]) {
    for (const outcome of ["success", "failure"]) {
        test(`opening ${mode} ignores the old membership read's ${outcome}`, async t => {
            const { controller, view, document, requests } = setupController(); t.after(() => controller.destroy());
            const old = controller.showYourLayers();
            if (outcome === "failure") view.dialog.requestClose();
            view.open(mode, "local", mode === "rename" ? "Rich" : "ABCDEFGH");
            view.name.input.value = "Entered name";
            const heading = view.heading.textContent;
            for (const deliverClose of document.closeEvents.splice(0)) deliverClose();
            finishList(requests[0], outcome); await old;
            assert.equal(view.dialog.open, true);
            assert.equal(view.heading.textContent, heading);
            assert.equal(view.status.textContent, "");
            assert.equal(view.name.input.value, "Entered name");
            assert.equal(view.library.hidden, true);
            assert.equal(view.library.children.length, 0);
            assert.equal(view.cancel.disabled, false);
        });
    }
}

test("a current list failure stays dismissible and a reopened list can recover", async t => {
    const { controller, view, requests, added } = setupController(); t.after(() => controller.destroy());
    const failed = controller.showYourLayers(); requests[0].reject(new Error("Offline")); await failed;
    assert.equal(view.dialog.open, true);
    assert.match(view.status.textContent, /Could not load your layers: Offline/);
    assert.equal(view.cancel.disabled, false);
    view.dialog.requestClose(); assert.equal(view.dialog.open, false);
    const retry = controller.showYourLayers(); requests[1].resolve([]); await retry;
    assert.match(view.status.textContent, /not created or joined/);
    assert.equal(view.library.children.length, 0);
    assert.deepEqual(added, []);
});

for (const outcome of ["success", "failure"]) {
    test(`destroying the controller ignores a held list's ${outcome}`, async () => {
        const { controller, view, requests } = setupController();
        const pending = controller.showYourLayers(); controller.destroy();
        finishList(requests[0], outcome); await pending;
        assert.equal(view.status.textContent, "Loading your layers…");
        assert.equal(view.library.children.length, 0);
    });
}

for (const mutation of ["create", "join", "rename", "add"]) {
    for (const outcome of ["success", "failure"]) {
        test(`old membership ${outcome} preserves pending ${mutation} serialization and dismissal protection`, async t => {
            const { controller, view, document, requests, added } = setupController(); t.after(() => controller.destroy());
            if (mutation === "rename") {
                const attaching = controller.openMapReference(MEMBERSHIP);
                requests.shift().resolve({ ...MEMBERSHIP, contributorId: "me", contributors: [{ id: "me", name: "Rich" }], layers: [] });
                await attaching;
            }
            const old = controller.showYourLayers();
            view.cancel.dispatchEvent(new Event("click"));
            if (mutation === "add") {
                const current = controller.showYourLayers(); requests[1].resolve([MEMBERSHIP]); await current;
                view.layerButtons[0].button.dispatchEvent(new Event("click"));
            } else {
                if (mutation === "rename") controller.editContributorName("local");
                else document.querySelector(`#${mutation}-shared-annotation-layer`).dispatchEvent(new Event("click"));
                view.layerName.input.value = "New layer"; view.code.input.value = "ABCDEFGH"; view.name.input.value = "Richard";
                view.form.dispatchEvent(new Event("submit", { cancelable: true }));
            }
            await Promise.resolve();
            const heldMutation = requests.at(-1);
            assert.notEqual(heldMutation, requests[0]);
            assert.equal(heldMutation.method, mutation === "rename" ? "PATCH" : mutation === "add" ? "GET" : "POST");
            assert.equal(view.cancel.disabled, true);
            const status = view.status.textContent;
            for (const deliverClose of document.closeEvents.splice(0)) deliverClose();
            finishList(requests[0], outcome); await old;
            assert.equal(view.status.textContent, status);
            assert.equal(view.cancel.disabled, true);
            assert.equal(view.submit.disabled, true);
            if (mutation === "add") assert.equal(view.layerButtons[0].button.disabled, true);
            view.dialog.requestClose(); assert.equal(view.dialog.open, true);
            const count = requests.length;
            await Promise.all([controller.showYourLayers(), controller.connect("join", "ABCDEFGH", "Other"),
                controller.renameContributor("local", "Other"), controller.addJoinedLayer(MEMBERSHIP)]);
            assert.equal(requests.length, count, "the active mutation still excludes every other mutation and list opening");
            heldMutation.reject(new Error("Mutation unavailable"));
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(view.status.textContent, "Mutation unavailable");
            assert.equal(view.cancel.disabled, false);
            assert.equal(view.dialog.open, true);
            assert.equal(added.length, mutation === "rename" ? 1 : 0);
        });
    }
}

test("Your layers lists explicit Add actions with busy and already-on-map states", () => {
    const { view, document, calls } = setup();
    document.querySelector("#open-joined-annotation-layers").dispatchEvent(new Event("click"));
    assert.deepEqual(calls, [["list"]]);
    view.open("library");
    assert.equal(view.name.hidden, true);
    assert.equal(view.submit.hidden, true);
    assert.equal(view.code.input.disabled, true);
    assert.equal(view.cancel.textContent, "Close");
    view.showLayers([{ id: "one", name: "<Layer>", joinCode: "ABCDEFGH", onMap: false },
        { id: "two", name: "Already here", joinCode: "BCDEFGHJ", onMap: true }]);
    assert.equal(view.library.children[0].children[0].textContent, "<Layer>");
    view.busy(true);
    assert.equal(view.layerButtons.every(({ button }) => button.disabled), true);
    view.busy(false);
    assert.equal(view.layerButtons[0].button.disabled, false);
    assert.equal(view.layerButtons[1].button.disabled, true);
    view.layerButtons[0].button.dispatchEvent(new Event("click"));
    assert.deepEqual(calls.at(-1), ["add", { id: "one", joinCode: "ABCDEFGH" }]);
    view.open("join");
    assert.equal(view.library.hidden, true);
    assert.equal(view.name.input.disabled, false);
    assert.equal(view.submit.hidden, false);
});

test("first drawing asks only for a name and submits the map's fixed invitation", () => {
    const { view, document, calls } = setup();
    view.open("contribute", "included-layer", "ABCDEFGH");
    assert.equal(view.layerName.hidden, true);
    assert.equal(view.code.hidden, true);
    assert.equal(view.code.input.disabled, true);
    assert.equal(document.activeElement, view.name.input);
    assert.equal(view.submit.textContent, "Join and draw polygon");
    view.name.input.value = "Visitor";
    view.form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.deepEqual(calls[0], ["contribute", "ABCDEFGH", "Visitor", "included-layer"]);
});

test("create and join ask for a real display name and only the relevant connection field", () => {
    const { view, document, calls } = setup();
    document.querySelector("#create-shared-annotation-layer").dispatchEvent(new Event("click"));
    assert.equal(view.dialog.open, true);
    assert.equal(view.heading.textContent, "Create shared layer");
    assert.equal(view.submit.textContent, "Create shared layer");
    assert.equal(view.code.input.disabled, true);
    assert.equal(view.name.input.required, true);
    view.layerName.input.value = "Watersheds"; view.name.input.value = " Maria ";
    view.form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.deepEqual(calls[0], ["create", "Watersheds", "Maria", null]);
    view.connected(); assert.equal(view.dialog.open, false);
    view.open("join");
    assert.equal(view.heading.textContent, "Join shared layer");
    assert.equal(view.layerName.input.disabled, true);
    assert.equal(view.code.input.disabled, false);
    view.code.input.value = "ABCDEFGH";
    view.form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.deepEqual(calls[1], ["join", "ABCDEFGH", "Maria", null]);
});

test("failed joins retain values and pending connections cannot dismiss the dialog", () => {
    const { view } = setup(); view.open("join");
    view.name.input.value = "Rich"; view.busy(true);
    let prevented = false; view.dialog.oncancel({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(view.cancel.disabled, true);
    view.message("That name is already used"); view.busy(false);
    assert.equal(view.dialog.open, true); assert.equal(view.name.input.value, "Rich");
    assert.equal(view.status.textContent, "That name is already used");
    assert.equal(view.submit.disabled, false);
});

test("changing your name prefills only the name and saves to the chosen layer", () => {
    const { view, document, calls } = setup();
    view.open("rename", "layer-one", "Rich");
    assert.equal(view.name.input.value, "Rich");
    assert.equal(document.activeElement, view.name.input);
    assert.equal(view.layerName.input.disabled, true);
    assert.equal(view.code.input.disabled, true);
    assert.equal(view.heading.textContent, "Change your name");
    assert.equal(view.submit.textContent, "Save name");
    view.name.input.value = " Richard ";
    view.form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.deepEqual(calls, [["rename", "layer-one", "Richard"]]);
    view.message("That name is already used");
    assert.equal(view.name.input.value, " Richard ");
    assert.equal(view.dialog.open, true);
    view.cancel.dispatchEvent(new Event("click"));
    assert.equal(view.dialog.open, false);
    assert.equal(calls.length, 1, "cancel does not submit another change");
    view.open("join");
    assert.equal(view.submit.textContent, "Join shared layer");
    assert.match(view.help.textContent, /Everyone with the code/);
});
