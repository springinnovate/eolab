import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationSessionsController } from "../../src/annotation-sessions/controller.js";
import { AnnotationSessionsApi } from "../../src/annotation-sessions/api.js";

/** @return {Object} Independent session metadata for lifecycle tests. */
function snapshot() {
    return { id: "session", contributorId: "me", isOwner: true, joinsOpen: true, name: "Session", joinCode: "ABCDEFGH",
        contributors: [{ id: "me", name: "Owner" }, { id: "other", name: "Maria" }], layers: [] };
}

/**
 * Compose the real session controller with an in-memory HTTP boundary and view.
 * @param {(path:string,method:string,body:Object)=>Promise<Object>} request Fake API response function.
 * @return {Object} Controller, committed local data, and observable view/presentation events.
 */
function setup(request = async () => snapshot()) {
    const local = [{ id: "local", collection: { name: "Priority areas", features: [] } }];
    const events = []; const storage = new Map();
    const view = { memberships() {}, busy() {}, render() {}, setJoiningBusy: busy => events.push(["joiningBusy", busy]), code: {}, message: (...args) => events.push(["message", ...args]) };
    const controller = new AnnotationSessionsController({ root: {}, getLayers: () => local,
        createLayer: () => {
            const id = `created-${local.length}`;
            local.push({ id, collection: { name: "New annotations", features: [] } });
            events.push(["created", id]); return id;
        },
        setShareLabel: (...args) => events.push(["label", ...args]),
        showLayer: (...args) => events.push(["show", ...args]), retainLayers: ids => events.push(["retain", [...ids]]),
        storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        createView: () => view, api: { request },
    });
    controller.snapshot = snapshot();
    return { controller, local, events, storage };
}

test("coalesces saved changes and does not send unchanged content", async () => {
    let release; const writes = [];
    const { controller, local } = setup(async (path, method, body) => {
        writes.push(structuredClone(body));
        if (writes.length === 1) await new Promise(resolve => { release = resolve; });
        return { revision: writes.length };
    });
    controller.shareLayer("local");
    local[0].collection.name = "Updated";
    await controller.sendChangedLayers(); assert.equal(writes.length, 1);
    release(); await controller.sharing.get("local").sending;
    assert.equal(writes.length, 2); assert.equal(writes[1].revision, 1);
    assert.equal(writes[1].collection.name, "Updated");
    await controller.sendChangedLayers(); assert.equal(writes.length, 2);
    controller.destroy();
});

test("lost replies retry the same revision; conflicts preserve local content and stop auto uploads", async () => {
    let count = 0; const writes = [];
    const { controller, local } = setup(async (path, method, body) => {
        writes.push(body); count++;
        if (count === 1) throw new Error("Network unavailable");
        if (count === 3) throw Object.assign(new Error("Changed in another tab"), { status: 409 });
        return { revision: 1 };
    });
    controller.shareLayer("local"); await controller.sharing.get("local").sending;
    await controller.sendChangedLayers(); assert.deepEqual(writes[0], writes[1]);
    local[0].collection.name = "My new name";
    await controller.sendChangedLayers(); await controller.sendChangedLayers();
    assert.equal(count, 3); assert.equal(local[0].collection.name, "My new name");
    assert.equal(controller.sharing.get("local").conflict, true);
    controller.destroy();
});

test("a failed status request keeps observation alive and expiry removes remote presentation", async () => {
    let fail = true;
    const { controller, events } = setup(async () => {
        if (fail) throw new Error("Temporary outage");
        throw Object.assign(new Error("Expired"), { status: 404 });
    });
    await controller.refreshSession(); assert.ok(controller.timer); assert.equal(controller.delay, 10000);
    fail = false; await controller.refreshSession(); assert.equal(controller.snapshot, null);
    assert.ok(events.some(event => event[0] === "retain" && event[1].length === 0));
    controller.destroy();
});

test("late contribution fetch cannot display data after leaving", async () => {
    let release; const remote = { contributorId: "other", layerId: "remote", revision: 1, name: "Other layer" };
    const { controller, events } = setup(async path => {
        if (path.includes("/contributors/")) return new Promise(resolve => { release = resolve; });
        if (path === "") return [];
        return { ...snapshot(), layers: [remote] };
    });
    controller.showContributions = true;
    const refreshing = controller.refreshSession(); await Promise.resolve();
    await controller.leave(); release({ collection: {}, revision: 1 }); await refreshing;
    assert.equal(events.some(event => event[0] === "show"), false);
    controller.destroy();
});

test("removing a local layer keeps its last contribution; no delete or empty replacement is sent", async () => {
    const writes = [];
    const { controller, local } = setup(async (path, method) => { writes.push(method); return { revision: 1 }; });
    controller.shareLayer("local"); await controller.sharing.get("local").sending;
    local.length = 0; await controller.sendChangedLayers();
    assert.deepEqual(writes, ["PUT"]); controller.destroy();
});

test("only changed contributions are fetched and stale metadata does not fetch local copies", async () => {
    const metadata = { ...snapshot(), layers: [{ contributorId: "other", layerId: "remote", revision: 2, name: "Shared" }] };
    let reads = 0;
    const { controller, events } = setup(async path => {
        if (path.includes("/contributors/")) { reads++; return { revision: 2, collection: {} }; }
        return metadata;
    });
    controller.showContributions = true;
    await controller.refreshSession(); await controller.refreshSession();
    assert.equal(reads, 1); assert.equal(events.filter(event => event[0] === "show").length, 1);
    controller.destroy();
});

test("API sends credentials/header and preserves conflict status for lifecycle decisions", async () => {
    const api = new AnnotationSessionsApi(async (url, options) => {
        assert.equal(url, "/api/annotation-sessions/join");
        assert.equal(options.credentials, "same-origin"); assert.equal(options.headers["X-EOLab-Annotations"], "1");
        return new Response(JSON.stringify({ detail: "Conflict" }), { status: 409 });
    });
    await assert.rejects(api.request("/join", "POST", {}), error => error.status === 409 && error.message === "Conflict");
});

test("a contribution withdrawn between metadata and content does not end the session", async () => {
    const { controller } = setup(async path => {
        if (path.includes("/contributors/")) throw Object.assign(new Error("Withdrawn"), { status: 404 });
        return { ...snapshot(), layers: [{ contributorId: "other", layerId: "removed", revision: 1 }] };
    });
    controller.showContributions = true;
    await controller.refreshSession();
    assert.equal(controller.snapshot.id, "session"); assert.ok(controller.timer);
    controller.destroy();
});

test("explicit re-sharing uses the observed revision while automatic reconnect retains its own revision", async () => {
    const writes = [];
    const { controller } = setup(async (path, method, body) => { writes.push(body); return { revision: 4 }; });
    controller.snapshot.layers = [{ contributorId: "me", layerId: "local", revision: 3 }];
    controller.shareLayer("local"); await controller.sharing.get("local").sending;
    assert.equal(writes[0].revision, 3);
    controller.destroy();
});

test("joining switch uses the requested setting and recovers after a failed save", async () => {
    let reject; const calls = [];
    const { controller, events } = setup((path, method) => {
        calls.push([path, method]); return new Promise((resolve, fail) => { reject = fail; });
    });
    const saving = controller.setAllowNewContributors(false);
    await controller.setAllowNewContributors(true);
    assert.deepEqual(calls, [["/session/actions/close-joining", "POST"]]);
    reject(new Error("Offline")); await saving;
    assert.equal(controller.snapshot.joinsOpen, true);
    assert.equal(controller.joiningBusy, false);
    assert.ok(events.some(event => event[0] === "message" && event[1] === "Offline"));
    controller.api.request = async path => { calls.push([path, "POST"]); };
    await controller.setAllowNewContributors(false);
    assert.equal(controller.snapshot.joinsOpen, false);
    await controller.setAllowNewContributors(true);
    assert.equal(controller.snapshot.joinsOpen, true);
    assert.deepEqual(calls.at(-1), ["/session/actions/open-joining", "POST"]);
    controller.destroy();
});

test("contributors cannot use the owner switch and late saves do not change a different session", async () => {
    let finish; let calls = 0;
    const { controller } = setup(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    controller.snapshot.isOwner = false;
    await controller.setAllowNewContributors(false); assert.equal(calls, 0);
    controller.snapshot.isOwner = true;
    const saving = controller.setAllowNewContributors(false);
    await controller.stopUploads(); controller.snapshot = { ...snapshot(), id: "other-session" };
    finish(); await saving;
    assert.equal(controller.snapshot.joinsOpen, true);
    controller.destroy();
});

for (const command of ["", "/join"]) test(`${command || "create"} starts a shared layer and reopening reuses it without sharing older layers`, async () => {
    const writes = [];
    const { controller, events } = setup(async (path, method, body) => {
        if (method === "PUT") { writes.push([path, body]); return { revision: 1 }; }
        return snapshot();
    });
    await controller.openSession(command, { contributorName: "Maria" });
    assert.equal(events.filter(event => event[0] === "created").length, 1);
    assert.equal(controller.sharing.has("local"), false, "older local layers require Share");
    assert.ok(controller.sharing.has("created-1"));
    await controller.sendChangedLayers();
    assert.equal(writes[0][0], "/session/layers/created-1");
    assert.equal(writes.length, 1);
    await controller.openSession("/session");
    assert.equal(events.filter(event => event[0] === "created").length, 1);
    assert.equal(controller.sharing.get("created-1").revision, 1);
    await controller.openSession(command, { contributorName: "Maria" });
    assert.equal(events.filter(event => event[0] === "created").length, 1, "repeated join does not add another layer");
    controller.destroy();
});

test("new layers wait for device persistence; withdrawn layers and layers created after leaving stay private", async () => {
    const writes = [];
    const { controller, local } = setup(async (path, method, body) => {
        if (method === "PUT") { writes.push(path); return { revision: 1 }; }
        return path === "" ? [] : snapshot();
    });
    controller.annotationLayerCreated("new");
    await controller.sendChangedLayers(); assert.equal(writes.length, 0);
    local.push({ id: "new", collection: { name: "Saved", features: [] } });
    controller.committedLayersChanged(); await controller.sendChangedLayers();
    assert.deepEqual(writes, ["/session/layers/new"]);
    await controller.withdrawLayer("new");
    local[1].collection.name = "Still private";
    controller.committedLayersChanged(); await controller.sendChangedLayers();
    assert.equal(writes.length, 1, "withdrawal is not undone by the next save");
    controller.annotationLayerCreated("another");
    assert.ok(controller.sharing.has("another"));
    await controller.leave();
    controller.annotationLayerCreated("after-leaving");
    assert.equal(controller.sharing.size, 0);
    controller.destroy();
});

test("failed joins do not create layers and local capacity errors leave the joined session usable", async () => {
    const { controller, events } = setup(async () => { throw new Error("Joining is closed"); });
    controller.snapshot = null;
    await controller.openSession("/join", { contributorName: "Maria" });
    assert.equal(events.some(event => event[0] === "created"), false);
    assert.equal(controller.snapshot, null);
    controller.api.request = async () => snapshot();
    controller.createLayer = () => { throw new Error("Layer limit reached"); };
    await controller.openSession("/join", { contributorName: "Maria" });
    assert.equal(controller.snapshot.id, "session");
    assert.equal(controller.transitioning, false);
    assert.ok(controller.timer, "membership observation survives a local layer error");
    assert.ok(events.some(event => event[0] === "message" && event[1] === "Layer limit reached"));
    controller.destroy();
});

test("rejoining with no revision bookmark never silently replaces an existing changed contribution", async () => {
    const metadata = { ...snapshot(), layers: [{ contributorId: "me", layerId: "local", revision: 5 }] };
    let requestedRevision;
    const { controller, events } = setup(async (path, method, body) => {
        if (method === "PUT") {
            requestedRevision = body.revision;
            throw Object.assign(new Error("Changed in another tab"), { status: 409 });
        }
        return metadata;
    });
    await controller.openSession("/join", { contributorName: "Owner" });
    await controller.sendChangedLayers();
    assert.equal(requestedRevision, 0);
    assert.equal(controller.sharing.get("local").conflict, true);
    assert.equal(events.some(event => event[0] === "created"), false);
    controller.destroy();
});
