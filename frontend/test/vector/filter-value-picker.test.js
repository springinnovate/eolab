import assert from "node:assert/strict";
import test from "node:test";
import { VectorFilterControls } from "../../src/vector/filter-controls.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

/** Drain pending request continuations. @return {Promise<void>} Next event-loop turn. */
const flush = () => new Promise(resolve => setImmediate(resolve));
/** Click a rendered control. @param {EventTarget} element Control. @return {boolean} Whether uncancelled. */
const click = element => element.dispatchEvent(new Event("click"));
/** Edit a rendered input. @param {HTMLInputElement} element Input. @param {string} value Exact text. @return {void} */
const type = (element, value) => { element.value = value; element.dispatchEvent(new Event("input")); };
/** Press a key on a focused control. @param {EventTarget} element Control. @param {string} value Key name. @return {Event} Dispatched key. */
const key = (element, value) => {
    const event = new Event("keydown", {cancelable: true}); Object.defineProperty(event, "key", {value});
    element.dispatchEvent(event); return event;
};

/** Build the shared editor at its DOM/API boundary, with controllable HTTP and timers.
 * @param {{inline?:boolean,source?:Object|null}} options Editor composition options.
 * @return {Object} Editor DOM, queued requests, applied predicates and deterministic timers.
 */
function fixture({inline = false, source = {collectionId: "vectors", itemId: "countries"}} = {}) {
    const document = new FakeRasterControlDocument(), requests = [], applied = [], timers = new Map();
    const fields = [{name: "name", type: "str"}, {name: "other", type: "string"},
        {name: "nullable", type: "string | null"}, {name: "year", type: "int"}, {name: "date", type: "date"}, {name: "flag", type: "bool"}];
    const target = {label: "Countries", source, fields,
        filter: {enabled: true, match: "all", rules: [{field: "name", operator: "ne", value: "original"}]},
        cancelPending() {}, apply: async candidate => { applied.push(candidate); return candidate; }};
    let host = null, sequence = 0;
    if (inline) {
        host = document.createElement("div"); host.id = "model-filter-host";
        document.querySelector("#vector-filter-panel").cloneNode = () => {
            const root = document.createElement("div"); root.querySelector = selector => document.querySelector(selector); return root;
        };
    }
    const controls = new VectorFilterControls({documentContext: document, host, getTarget: () => target,
        inspection: {showFilter() {}, hideFilter() {}, updateLayerEditorName() {}},
        setTimer: (handler, delay) => { const id = ++sequence; timers.set(id, {handler, delay}); return id; },
        clearTimer: id => timers.delete(id),
        loadValues: (source, query, signal) => new Promise((resolve, reject) => requests.push({source, query, signal, resolve, reject})),
    });
    const action = inline ? {apply: target.apply, complete() {}, cancel() {}} : null;
    controls.open("countries", action);
    return {document, controls, target, requests, applied, action, timers,
        runTimers(delay) { for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.handler(); } }};
}

/** Read the actual controls rendered inside one rule's optional picker.
 * @param {VectorFilterControls} controls Shared rule editor.
 * @return {Object} Scalar input and suggestion DOM nodes.
 */
function picker(controls) {
    const row = controls.rules.children[0], root = row.children[3];
    const [toggle, panel] = root.children, [search, list, status, previous, next, retry] = panel.children;
    return {row, input: row.children[2], root, toggle, panel, search, list, status, previous, next, retry};
}

for (const inline of [false, true]) test(`${inline ? "inline model/analysis" : "map"} picker separates search from scalar and reaches rare values by page`, async () => {
    const h = fixture({inline, source: inline ? {uploadId: "owned-upload"} : undefined}), p = picker(h.controls);
    assert.equal(h.requests.length, 0); click(p.toggle);
    assert.equal(p.search.getAttribute("role"), "combobox"); assert.equal(p.list.getAttribute("role"), "listbox");
    assert.equal(p.search.getAttribute("aria-controls"), p.list.id); assert.equal(h.document.activeElement, p.search);
    assert.deepEqual(h.requests[0].source, h.target.source);
    h.requests[0].resolve({values: Array.from({length: 50}, (_, index) => `common ${index}`), nextOffset: 50}); await flush();
    p.next.focus(); click(p.next); assert.equal(h.requests[1].query.offset, 50);
    assert.equal(h.document.activeElement, p.search, "Keep focus inside the picker before disabling the page button");
    h.requests[1].resolve({values: ["rare exact value"], nextOffset: null}); await flush();
    assert.equal(p.next.disabled, true); assert.equal(p.previous.disabled, false);
    p.previous.focus(); click(p.previous); assert.equal(h.requests[2].query.offset, 0);
    assert.equal(h.document.activeElement, p.search);
    h.requests[2].resolve({values: ["first"], nextOffset: 1}); await flush();
    type(p.search, "rare"); assert.equal(p.list.children.length, 0); assert.equal(h.requests.length, 3);
    assert.equal(h.controls.draft.rules[0].value, "original"); assert.equal(h.applied.length, 0);
    h.runTimers(200); assert.deepEqual(h.requests[3].query, {field: "name", search: "rare", offset: 0});
    h.requests[3].resolve({values: [" rare exact value "], nextOffset: null}); await flush();
    key(p.search, "ArrowDown"); assert.equal(p.search.getAttribute("aria-activedescendant"), p.list.children[0].id);
    assert.equal(p.list.children[0].getAttribute("aria-selected"), "true");
    key(p.search, "Enter"); assert.equal(p.panel.hidden, true); assert.equal(h.document.activeElement, p.input);
    assert.deepEqual(h.controls.draft.rules[0], {field: "name", operator: "ne", value: " rare exact value "});
    assert.equal(h.applied.length, 0);
    if (inline) click(h.controls.applyButton); else h.runTimers(450);
    await flush(); assert.equal(h.applied[0].rules[0].value, " rare exact value ");
    h.controls.destroy();
});

test("exact empty, null-like and Unicode strings remain scalar values; unsupported literals stay unavailable", async () => {
    const h = fixture(), p = picker(h.controls); click(p.toggle);
    h.requests[0].resolve({values: ["x".repeat(257), "a\nb", "", "NULL", "  é 😃  "], nextOffset: null}); await flush();
    assert.equal(p.list.children[0].getAttribute("aria-disabled"), "true"); assert.match(p.status.textContent, /character limits/);
    click(p.list.children[1]); assert.equal(h.controls.draft.rules[0].value, "original");
    key(p.search, "ArrowDown"); assert.equal(p.search.getAttribute("aria-activedescendant"), p.list.children[2].id);
    key(p.search, "Enter"); assert.equal(h.controls.draft.rules[0].value, "");
    click(p.toggle); h.requests[1].resolve({values: ["NULL", "  é 😃  "], nextOffset: null}); await flush();
    click(p.list.children[0]); assert.equal(h.controls.draft.rules[0].value, "NULL");
    click(p.toggle); h.requests[2].resolve({values: ["  é 😃  "], nextOffset: null}); await flush();
    click(p.list.children[0]); assert.equal(h.controls.draft.rules[0].value, "  é 😃  ");
    type(p.input, "direct entry"); assert.equal(h.controls.draft.rules[0].value, "direct entry");
    h.controls.destroy();
});

test("new searches, field/source changes, close and teardown abort work and ignore late responses", async () => {
    const h = fixture(); let p = picker(h.controls); click(p.toggle);
    type(p.search, "a"); assert.equal(h.requests[0].signal.aborted, true);
    type(p.search, "ab"); p.toggle.focus(); h.runTimers(200); assert.equal(h.requests.length, 2);
    assert.equal(h.document.activeElement, p.toggle, "A debounced search must not steal focus from another enabled control");
    h.requests[0].resolve({values: ["stale"], nextOffset: null}); await flush(); assert.equal(p.list.children.length, 0);
    h.requests[1].resolve({values: ["current"], nextOffset: null}); await flush(); assert.equal(p.list.children[0].textContent, '"current"');
    type(p.search, "next"); h.runTimers(200);
    p.row.children[0].value = "other"; p.row.children[0].dispatchEvent(new Event("change"));
    assert.equal(h.requests[2].signal.aborted, true); h.requests[2].resolve({values: ["old field"], nextOffset: null}); await flush();
    p = picker(h.controls); click(p.toggle); assert.equal(h.requests[3].query.field, "other");
    h.controls.open("different-source"); assert.equal(h.requests[3].signal.aborted, true);
    h.requests[3].reject(Error("old source")); await flush();
    p = picker(h.controls); click(p.toggle); h.controls.close(); assert.equal(h.requests[4].signal.aborted, true);
    h.requests[4].resolve({values: ["closed"], nextOffset: null}); await flush(); assert.equal(p.list.children.length, 0);
    h.controls.open("countries"); p = picker(h.controls); click(p.toggle); type(p.search, "scheduled"); h.controls.destroy();
    assert.equal(h.requests[5].signal.aborted, true); assert.equal(h.timers.size, 0);
});

test("empty/error/retry states retain direct entry; Escape and focusout dismiss only suggestions", async () => {
    const h = fixture(), p = picker(h.controls); click(p.toggle);
    h.requests[0].resolve({values: [], nextOffset: null}); await flush(); assert.match(p.status.textContent, /No available values match/);
    type(p.search, "failure"); h.runTimers(200); h.requests[1].reject(Error("Values unavailable.")); await flush();
    assert.match(p.status.textContent, /Values unavailable/); assert.equal(p.retry.hidden, false);
    p.retry.focus(); click(p.retry); assert.equal(h.requests[2].query.search, "failure");
    assert.equal(h.document.activeElement, p.search, "Keep focus inside the picker before hiding Retry");
    h.requests[2].resolve({values: ["working"], nextOffset: null}); await flush();
    assert.equal(p.retry.hidden, true); assert.equal(key(p.root, "Escape").defaultPrevented, true);
    assert.equal(p.panel.hidden, true); assert.equal(h.document.activeElement, p.toggle); assert.equal(h.controls.key, "countries");
    click(p.toggle); const event = new Event("focusout"); Object.defineProperty(event, "relatedTarget", {value: p.input}); p.root.dispatchEvent(event);
    assert.equal(p.panel.hidden, true); assert.equal(h.requests[3].signal.aborted, true);
    type(p.input, "typed after error"); assert.equal(h.controls.draft.rules[0].value, "typed after error"); h.controls.destroy();
});

test("annotation sources and numeric/date/boolean/null-only rules retain their existing controls", () => {
    const annotation = fixture({source: null}); assert.equal(annotation.controls.rules.children[0].children.length, 4); annotation.controls.destroy();
    const h = fixture();
    for (const [field, type] of [["year", "number"], ["date", "date"], ["flag", null], ["nullable", null]]) {
        const select = h.controls.rules.children[0].children[0]; select.value = field; select.dispatchEvent(new Event("change"));
        const row = h.controls.rules.children[0]; assert.equal(row.children.length, field === "nullable" ? 3 : 4);
        if (type) assert.equal(row.children[2].type, type);
        if (field === "nullable") assert.deepEqual(row.children[1].children.map(option => option.value), ["missing", "present"]);
    }
    assert.equal(h.requests.length, 0); h.controls.destroy();
});
