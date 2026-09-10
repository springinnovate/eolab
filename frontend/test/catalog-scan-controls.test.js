import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CatalogScanControls } from "../src/catalog-scan-controls.js";

/** @return {{promise: Promise<*>, resolve: Function, reject: Function}} Controllable transport result. */
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/** @return {Promise<void>} Flush asynchronous fetch/render/timer continuations. */
async function settle() {
    for (let index = 0; index < 20; ++index) await Promise.resolve();
}

/** @param {string} [state] Server state. @param {string} [id] Scan identity. @return {Object} HTTP response. */
function response(state = "scanning", id = "scan-1") {
    return { ok: true, status: 200, json: async () => ({ state, id }) };
}

/**
 * Strict current-markup controls plus controllable browser transport and time.
 * @param {Array<*>} replies Responses, errors or functions accepting request options.
 * @param {() => Promise<void>} [refresh] Optional completion callback.
 * @return {Object} Controller and externally observable test capabilities.
 */
function fixture(replies, refresh = async () => {}) {
    const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const elements = new Map();
    const document = { body: {}, activeElement: null, querySelector(selector) {
        assert.match(markup, new RegExp(`id="${selector.slice(1)}"`), `Missing real control ${selector}`);
        if (!elements.has(selector)) {
            const node = new EventTarget();
            Object.assign(node, { hidden: selector === "#scan-status-recovery",
                textContent: "", open: false, focus() { document.activeElement = this; } });
            let disabled = false;
            Object.defineProperty(node, "disabled", { get: () => disabled, set(value) {
                disabled = value;
                if (value && document.activeElement === node) document.activeElement = document.body;
            } });
            elements.set(selector, node);
        }
        return elements.get(selector);
    } };
    document.activeElement = document.body;
    const timers = new Map();
    let serial = 0;
    const window = new EventTarget();
    window.setTimeout = (callback, delay) => { timers.set(++serial, { callback, delay }); return serial; };
    window.clearTimeout = id => timers.delete(id);
    const requests = [], rendered = [], refreshes = [];
    const controls = new CatalogScanControls({ documentContext: document, windowContext: window,
        fetchImpl: async (url, options) => {
            requests.push({ url, ...options });
            assert.ok(replies.length, `Unexpected request to ${url}`);
            const reply = replies.shift();
            if (reply instanceof Error) throw reply;
            return typeof reply === "function" ? reply(options) : reply;
        },
        renderStatus: status => {
            rendered.push(status);
            const start = document.querySelector("#start-scan");
            start.disabled = ["discovering", "scanning"].includes(status.state);
            start.textContent = start.disabled ? "Scanning…" : "Scan directories";
        },
        refreshCatalog: async () => { refreshes.push(true); await refresh(); },
    });
    return { controls, document, window, requests, rendered, refreshes, timers,
        element: selector => document.querySelector(selector),
        tick: async delay => {
            const match = [...timers].find(([, timer]) => timer.delay === delay);
            assert.ok(match, `No ${delay}ms timer; pending: ${JSON.stringify([...timers.values()])}`);
            timers.delete(match[0]); match[1].callback(); await settle();
        },
    };
}

for (const [name, failure] of [
    ["HTTP 503", { ok: false, status: 503 }],
    ["network failure", new TypeError("Failed to fetch")],
    ["malformed JSON", { ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }],
    ["invalid snapshot", { ok: true, json: async () => ({ state: "complete" }) }],
]) {
    test(`a recurring ${name} recovers without another POST or duplicate refresh`, async () => {
        const f = fixture([response(), failure, response("completed"), response("completed")]);
        await f.controls.observe();
        await f.tick(750);
        assert.equal(f.rendered.length, 1);
        assert.equal(f.element("#scan-status-recovery").hidden, false);
        assert.match(f.element("#scan-status-warning").textContent, /status unavailable.*may still be running.*Retrying in 1 second/);
        assert.equal(f.element("#start-scan").disabled, true);
        await f.tick(1000);
        assert.equal(f.rendered.at(-1).state, "completed");
        assert.equal(f.element("#scan-status-recovery").hidden, true);
        assert.equal(f.refreshes.length, 1);
        assert.equal(f.timers.size, 0);
        await f.controls.observe();
        assert.equal(f.refreshes.length, 1);
        assert.ok(f.requests.every(request => request.url === "/api/scans/current"));
        f.controls.close();
    });
}

test("automatic retries stop after four delays; the manual button reads status only", async () => {
    const failures = Array.from({ length: 5 }, () => new Error("offline"));
    const f = fixture([response(), ...failures, response("failed")]);
    await f.controls.observe();
    await f.tick(750);
    for (const delay of [1000, 2000, 4000, 8000]) await f.tick(delay);
    assert.equal(f.timers.size, 0);
    assert.equal(f.requests.length, 6);
    assert.match(f.element("#scan-status-warning").textContent, /Retry the status check to reconnect/);
    const retry = f.element("#retry-scan-status");
    retry.focus();
    retry.dispatchEvent(new Event("click"));
    await settle();
    assert.equal(f.rendered.at(-1).state, "failed");
    assert.equal(f.refreshes.length, 0);
    assert.equal(f.element("#start-scan").disabled, false);
    assert.equal(f.document.activeElement, f.element("#scan-status-summary"));
    assert.ok(f.requests.every(request => request.method !== "POST"));
    f.controls.close();
});

test("a successful active status resets backoff after an initial error", async () => {
    const f = fixture([new Error("offline"), response(), new Error("offline"), response("completed")]);
    await f.controls.observe();
    assert.equal(f.rendered.length, 0);
    await f.tick(1000);
    await f.tick(750);
    await f.tick(1000);
    assert.equal(f.refreshes.length, 1);
    f.controls.close();
});

test("an initial failure can recover directly to a missed completion", async () => {
    const f = fixture([new Error("offline"), response("completed")]);
    await f.controls.observe();
    await f.tick(1000);
    assert.equal(f.refreshes.length, 1);
    f.controls.close();
});

test("an initial completed snapshot does not need a duplicate Catalog refresh", async () => {
    const f = fixture([response("completed")]);
    await f.controls.observe();
    assert.equal(f.refreshes.length, 0);
    assert.equal(f.timers.size, 0);
    f.controls.close();
});

for (const status of [202, 409]) {
    test(`an explicit start handles ${status} and fences repeated clicks`, async () => {
        const post = deferred();
        const f = fixture([response("not_started"), () => post.promise, response(), response("completed")]);
        await f.controls.observe();
        const start = f.controls.startScan();
        await f.controls.startScan();
        assert.equal(f.requests.filter(request => request.method === "POST").length, 1);
        post.resolve({ ok: status === 202, status });
        await start;
        await f.tick(750);
        assert.equal(f.refreshes.length, 1);
        assert.equal(f.element("#scan-status-disclosure").open, true);
        assert.equal(f.element("#scan-errors-disclosure").open, false);
        f.controls.close();
    });
}

test("an uncertain start offers status recovery without automatically resubmitting", async () => {
    const f = fixture([response("not_started"), new Error("connection lost"), response("completed")]);
    await f.controls.observe();
    await f.controls.startScan();
    assert.match(f.element("#scan-status-warning").textContent, /Could not confirm scan startup/);
    assert.equal(f.timers.size, 0);
    await f.controls.observe();
    assert.equal(f.refreshes.length, 1);
    assert.equal(f.requests.filter(request => request.method === "POST").length, 1);
    f.controls.close();
});

for (const outcome of ["success", "failure"]) {
    test(`a replaced response's late ${outcome} cannot render or schedule retries`, async () => {
        const old = deferred();
        const f = fixture([() => old.promise, response("completed", "new-scan")]);
        const first = f.controls.observe();
        await f.controls.observe();
        assert.equal(f.requests[0].signal.aborted, true);
        if (outcome === "success") old.resolve(response("scanning", "old-scan"));
        else old.reject(new Error("old failure"));
        await first;
        assert.deepEqual(f.rendered, [{ state: "completed", id: "new-scan" }]);
        assert.equal(f.element("#scan-status-recovery").hidden, true);
        assert.equal(f.timers.size, 0);
        f.controls.close();
    });
}

test("status timeout aborts the read and enters bounded retry", async () => {
    const f = fixture([({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }), response("failed")]);
    const reading = f.controls.observe();
    await f.tick(10000);
    await reading;
    assert.match(f.element("#scan-status-warning").textContent, /request timed out/);
    assert.equal(f.requests[0].signal.aborted, true);
    await f.tick(1000);
    assert.equal(f.timers.size, 0);
    f.controls.close();
});

test("pagehide aborts and clears timers; bfcache restore resumes status rather than POST", async () => {
    const old = deferred();
    const f = fixture([() => old.promise, response("failed")]);
    const reading = f.controls.observe();
    f.window.dispatchEvent(new Event("pagehide"));
    assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(f.timers.size, 0);
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    f.window.dispatchEvent(restored);
    await settle();
    old.resolve(response());
    await reading;
    assert.deepEqual(f.rendered.map(value => value.state), ["failed"]);
    assert.ok(f.requests.every(request => request.method !== "POST"));
    f.controls.close();
    f.element("#retry-scan-status").dispatchEvent(new Event("click"));
    assert.equal(f.requests.length, 2);
    assert.equal(f.timers.size, 0);
});

test("refresh failures have distinct feedback and retry to one successful refresh", async () => {
    let attempts = 0;
    const f = fixture([response(), response("completed"), response("completed"), response("completed")], async () => {
        if (++attempts === 1) throw new Error("Catalog unavailable");
    });
    await f.controls.observe();
    await f.tick(750);
    assert.match(f.element("#scan-status-warning").textContent, /Scan completed, but the Catalog could not refresh/);
    await f.tick(1000);
    await f.controls.observe();
    assert.equal(attempts, 2);
    assert.equal(f.timers.size, 0);
    f.controls.close();
});

test("rechecking the same completed scan shares an outstanding refresh", async () => {
    const refreshing = deferred();
    const f = fixture([response(), response("completed"), response("completed")], () => refreshing.promise);
    await f.controls.observe();
    await f.tick(750);
    const next = f.controls.observe();
    await settle();
    assert.equal(f.refreshes.length, 1);
    refreshing.resolve();
    await next;
    assert.equal(f.timers.size, 0);
    f.controls.close();
});

test("a paused POST cannot prevent restoration or replace a newer observation", async () => {
    const oldPost = deferred();
    const f = fixture([response("not_started"), () => oldPost.promise, response("scanning", "resumed")]);
    await f.controls.observe();
    const starting = f.controls.startScan();
    f.controls.pause();
    assert.equal(f.timers.size, 0);
    await f.controls.resume();
    oldPost.resolve({ ok: true, status: 202 });
    await starting;
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[1].signal.aborted, true);
    assert.equal(f.rendered.at(-1).id, "resumed");
    assert.equal(f.element("#start-scan").disabled, true);
    f.controls.close();
    assert.equal(f.timers.size, 0);
});

test("manual recovery clears the scheduled retry and preserves disclosure choices", async () => {
    const f = fixture([response(), new Error("offline"), response()]);
    await f.controls.observe();
    f.element("#scan-status-disclosure").open = false;
    f.element("#scan-errors-disclosure").open = true;
    await f.tick(750);
    await f.controls.observe();
    assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [750]);
    assert.equal(f.element("#scan-status-disclosure").open, false);
    assert.equal(f.element("#scan-errors-disclosure").open, true);
    f.controls.close();
});

test("finishing recovery does not steal focus after the user selects another control", async () => {
    const refresh = deferred();
    const f = fixture([new Error("offline"), response("completed")], () => refresh.promise);
    await f.controls.observe();
    f.element("#retry-scan-status").focus();
    const recovery = f.controls.observe();
    await settle();
    const start = f.element("#start-scan");
    assert.equal(start.disabled, false);
    start.focus();
    refresh.resolve();
    await recovery;
    assert.equal(f.document.activeElement, start);
    f.controls.close();
});
