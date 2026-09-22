import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationSessionsController } from "../../src/annotation-sessions/controller.js";
import { AnnotationSessionsApi } from "../../src/annotation-sessions/api.js";

const ID = "11111111-1111-4111-8111-111111111111";
/** @return {Object} One shared layer with two independent contributors. */
function snapshot() {
    return { id: ID, name: "Watersheds", contributorId: "me", joinCode: "ABCDEFGH",
        contributors: [{ id: "me", name: "Rich" }, { id: "other", name: "Maria" }], layers: [] };
}
/** @param {Function} request API boundary. @return {Object} Controller and observable layer state. */
function setup(request = async () => snapshot()) {
    const local = []; const events = []; const stored = new Map();
    const view = { busy() {}, connected() {}, open: (...args) => events.push(["open", ...args]), message: text => events.push(["error", text]) };
    const controller = new AnnotationSessionsController({ document: {}, api: { request }, getLayers: () => local,
        createLayer: async (name, collection) => { const id = `local-${local.length}`; local.push({ id, collection: structuredClone(collection) }); return id; },
        present: (id, data) => events.push(["display", id, data]), revealLayer: id => events.push(["reveal", id]),
        storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }, createView: () => view });
    return { controller, local, events, stored };
}
/** @param {Object} controller Controller under test. @return {void} Attach a known contributor binding. */
function bind(controller) {
    controller.bindings.set("local", { localId: "local", sessionId: ID, contributorId: "me", revision: 0, remote: new Map(), retryDelay: 0 });
}

test("creator and joiner both receive one layer and automatically see all shared contributions", async () => {
    for (const mode of ["create", "join"]) {
        const metadata = snapshot(); metadata.layers = [{ contributorId: "other", layerId: ID, revision: 1, polygonCount: 1 }];
        const writes = [];
        const { controller, local, events } = setup(async (path, method, body) => {
            if (method === "PUT") { writes.push(body); return { revision: 1 }; }
            if (path.includes("/contributors/")) return { revision: 1, collection: { type: "FeatureCollection", features: [{ id: "polygon", properties: { name: "River" } }] } };
            return structuredClone(metadata);
        });
        try {
            await controller.connect(mode, "ABCDEFGH", "Rich");
            assert.equal(local.length, 1);
            const data = events.filter(event => event[0] === "display").at(-1)[2];
            assert.equal(data.collections.length, 1); assert.equal(data.contributors[1].polygonCount, 1);
            assert.equal(writes[0].collection.features.length, 0, "other contributors are never uploaded as mine");
            await controller.connect("join", "ABCDEFGH", "Rich");
            assert.equal(local.length, 1, "rejoining does not duplicate the existing layer");
        } finally { controller.destroy(); }
    }
});

test("failed joins create no layer and preserve the server's duplicate-name message", async () => {
    const { controller, local, events } = setup(async () => { throw new Error("That name is already used"); });
    try { await controller.connect("join", "ABCDEFGH", "Rich"); assert.equal(local.length, 0); assert.deepEqual(events.at(-1), ["error", "That name is already used"]); }
    finally { controller.destroy(); }
});

test("changed contributor names refresh authorship without downloading unchanged geometry", async () => {
    const metadata = snapshot();
    metadata.layers = [{ contributorId: "other", layerId: ID, revision: 1, polygonCount: 1 }];
    let downloads = 0;
    const { controller, events } = setup(async (path, method) => {
        if (method === "PUT") return { revision: 1 };
        if (path.includes("/contributors/")) {
            downloads++;
            return { revision: 1, collection: { type: "FeatureCollection", features: [{ properties: { name: "River" } }] } };
        }
        return structuredClone(metadata);
    });
    try {
        await controller.connect("join", "ABCDEFGH", "Rich");
        metadata.contributors[1].name = "Maria Updated";
        await controller.refresh();
        assert.equal(downloads, 1);
        assert.equal(events.filter(event => event[0] === "display").at(-1)[2].collections[0].features[0].properties.contributor, "Maria Updated");
    } finally { controller.destroy(); }
});

test("lost replies retry the same revision; conflicts preserve edits and stop automatic writes", async () => {
    let count = 0; const writes = [];
    const { controller, local } = setup(async (_path, method, body) => {
        if (method !== "PUT") return snapshot();
        writes.push(structuredClone(body)); count++;
        if (count === 1) throw new Error("Network interrupted");
        if (count === 3) throw Object.assign(new Error("Changed in another tab"), { status: 409 });
        return { revision: 1 };
    });
    local.push({ id: "local", collection: { type: "FeatureCollection", name: "Watersheds", features: [] } }); bind(controller);
    try {
        await controller.refresh();
        local[0].collection.features.push({ id: "new" });
        await controller.refresh();
        assert.deepEqual(writes[0], writes[1]);
        await controller.refresh(); await controller.refresh();
        assert.equal(count, 3); assert.equal(local[0].collection.features.length, 1);
        assert.equal(controller.bindings.get("local").conflict, true);
    } finally { controller.destroy(); }
});

test("a removed map layer stops writes and polling without deleting its shared contents", async () => {
    const calls = [];
    const { controller, local } = setup(async (path, method) => { calls.push([path, method]); return method === "PUT" ? { revision: 1 } : snapshot(); });
    local.push({ id: "local", collection: { features: [] } }); bind(controller);
    try {
        await controller.refresh(); calls.length = 0; local.length = 0;
        await controller.refresh(); assert.deepEqual(calls, []);
    } finally { controller.destroy(); }
});

test("in-flight refresh cannot publish or upload a layer removed while waiting", async () => {
    let release; const writes = [];
    const { controller, local, events } = setup(async (_path, method) => {
        if (method === "PUT") { writes.push(method); return { revision: 1 }; }
        return new Promise(resolve => { release = resolve; });
    });
    local.push({ id: "local", collection: { features: [] } }); bind(controller);
    try {
        const pending = controller.refresh(); local.length = 0; release(snapshot()); await pending;
        assert.deepEqual(writes, []); assert.deepEqual(events, []);
    } finally { controller.destroy(); }
});

test("saved contributor identity cannot silently become a different contributor", async () => {
    const writes = []; const changed = { ...snapshot(), contributorId: "other" };
    const { controller, local, events } = setup(async (_path, method) => { if (method === "PUT") writes.push(method); return changed; });
    local.push({ id: "local", collection: { features: [] } }); bind(controller);
    try {
        await controller.refresh(); assert.deepEqual(writes, []);
        assert.match(events.at(-1)[2].status, /different contributor/);
        await controller.connect("join", "ABCDEFGH", "Maria"); assert.equal(local.length, 1);
        assert.match(events.at(-1)[1], /different contributor/);
    } finally { controller.destroy(); }
});

test("same-origin API retains private cookie handling and actionable validation errors", async () => {
    const api = new AnnotationSessionsApi(async (url, options) => {
        assert.equal(url, "/api/annotation-sessions/join");
        assert.equal(options.credentials, "same-origin"); assert.equal(options.headers["X-EOLab-Annotations"], "1");
        return { ok: false, status: 409, json: async () => ({ detail: "That name is already used" }) };
    });
    await assert.rejects(api.request("/join", "POST", {}), error => error.status === 409 && /already used/.test(error.message));
});
