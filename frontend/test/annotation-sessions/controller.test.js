import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationSessionsController } from "../../src/annotation-sessions/controller.js";
import { AnnotationSessionsApi } from "../../src/annotation-sessions/api.js";

const ID = "11111111-1111-4111-8111-111111111111";
/** @return {Object} One shared layer with two independent contributors. */
function snapshot() {
    return { id: ID, name: "Watersheds", contributorId: "me", joinCode: "ABCDEFGH",
        contributors: [{ id: "me", name: "Rich", color: "#FFBE0B" }, { id: "other", name: "Maria", color: "#FB5607" }], layers: [] };
}
/** @param {Function} request API boundary. @return {Object} Controller and observable layer state. */
function setup(request = async () => snapshot()) {
    const local = []; const events = []; const stored = new Map();
    const view = { busy() {}, connected() {}, open: (...args) => events.push(["open", ...args]), message: text => events.push(["error", text]) };
    const controller = new AnnotationSessionsController({ document: {}, api: { request }, getLayers: () => local,
        createLayer: async (name, collection, options = {}) => {
            const existing = local.find(layer => layer.id === options.localId);
            if (existing) { if (options.replacePolygons) existing.collection = structuredClone(collection); return existing.id; }
            const id = `local-${local.length}`; local.push({ id, collection: structuredClone(collection) }); return id;
        },
        drawAfterJoining: id => events.push(["draw", id]),
        present: (id, data) => events.push(["display", id, data]), revealLayer: id => events.push(["reveal", id]),
        storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }, createView: () => view });
    return { controller, local, events, stored };
}
/** @param {Object} controller Controller under test. @return {void} Attach a known contributor binding. */
function bind(controller) {
    controller.bindings.set("local", { localId: "local", sessionId: ID, contributorId: "me", revision: 0, remote: new Map(), retryDelay: 0 });
}

test("invited visitors see live polygons without joining; first drawing joins only that layer", async () => {
    const metadata = snapshot(); metadata.contributorId = null;
    metadata.layers = [{ contributorId: "other", layerId: ID, revision: 1, polygonCount: 1 }];
    const calls = []; let rejectName = true;
    const context = setup(async (path, method, body) => {
        calls.push([path, method, body]);
        if (path === "/join") {
            if (rejectName) throw Object.assign(new Error("That name is already used"), { status: 409 });
            metadata.contributorId = "me";
        }
        if (path.includes("/contributors/")) return { revision: metadata.layers[0].revision,
            collection: { type: "FeatureCollection", features: [{ properties: { name: "Remote" } }] } };
        if (method === "PUT") return { revision: 1 };
        return structuredClone(metadata);
    });
    const { controller, events, local } = context;
    try {
        await controller.start({ restoreBindings: false });
        const id = await controller.openMapReference({ id: ID, joinCode: "ABCDEFGH" });
        assert.equal(local.length, 1);
        assert.equal(local[0].collection.features.length, 0);
        assert.equal(calls.some(([, method]) => method === "POST" || method === "PUT"), false);
        assert.equal(events.filter(e => e[0] === "display").at(-1)[2].collections.length, 1);
        metadata.layers[0].revision = 2;
        await controller.refresh();
        assert.equal(calls.filter(([path]) => path.includes("/contributors/")).length, 2, "changed polygons are fetched live");
        assert.equal(controller.requestDrawing(id), false);
        assert.deepEqual(events.at(-1), ["open", "contribute", id, "ABCDEFGH"]);
        await controller.connect("contribute", "ABCDEFGH", "Taken", id);
        assert.match(events.at(-1)[1], /already used/);
        assert.equal(controller.getMapReference(id).joinCode, "ABCDEFGH");
        rejectName = false;
        await controller.connect("contribute", "ABCDEFGH", "New contributor", id);
        assert.equal(local.length, 1, "joining upgrades the same layer");
        assert.deepEqual(events.at(-1), ["draw", id]);
        assert.equal(controller.requestDrawing(id), true);
        const upload = calls.find(([, method]) => method === "PUT");
        assert.equal(upload[2].collection.features.length, 0, "remote polygons never become this contributor's work");
    } finally { controller.destroy(); }
});

test("saved-map restoration reuses own unsent edits and preserves unrelated bookmarks", async () => {
    const metadata = snapshot(); metadata.layers = [{ contributorId: "me", layerId: ID, revision: 3, polygonCount: 1 }];
    const calls = [];
    const { controller, local, stored } = setup(async (path, method, body) => {
        calls.push([path, method, body]);
        if (path.includes("/contributors/")) return { revision: 3, collection: { type: "FeatureCollection", name: "Watersheds", features: [{ properties: { name: "Server" } }] } };
        if (method === "PUT") return { revision: 4 };
        return structuredClone(metadata);
    });
    local.push({ id: "mine", collection: { type: "FeatureCollection", name: "Watersheds", features: [{ properties: { name: "Unsent edit" } }] } });
    local.push({ id: "unrelated", collection: { features: [] } });
    const privateBinding = { localId: "unrelated", sessionId: "22222222-2222-4222-8222-222222222222", contributorId: "private", revision: 9 };
    stored.set("eolab-shared-annotation-layers-v1", JSON.stringify([privateBinding, { localId: "mine", sessionId: ID, contributorId: "me", revision: 3 }]));
    try {
        await controller.start({ restoreBindings: false });
        assert.equal(calls.length, 0);
        assert.equal(await controller.openMapReference({ id: ID, joinCode: "ABCDEFGH" }), "mine");
        assert.equal(calls.some(([path]) => path.includes(privateBinding.sessionId)), false);
        assert.equal(local[0].collection.features[0].properties.name, "Unsent edit");
        assert.equal(calls.find(([, method]) => method === "PUT")[2].revision, 3);
        assert.deepEqual(JSON.parse([...stored.values()][0]).find(b => b.localId === "unrelated"), privateBinding);
        const before = structuredClone(local);
        assert.equal(await controller.openMapReference({ id: ID, joinCode: "ABCDEFGH" }), "mine");
        assert.deepEqual(local, before, "restore never replaces contributions");
        assert.equal(calls.some(([path]) => path === "/join"), false, "returning contributors need no prompt or new membership");
        assert.deepEqual(controller.getMapReference("mine"), { id: ID, joinCode: "ABCDEFGH" });
    } finally { controller.destroy(); }
});

test("multiple saved references stay independent and unavailable or obsolete invitations attach nothing", async () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    const context = setup(async path => {
        if (path.includes("MISSINGX")) throw new Error("This shared annotation layer is unavailable.");
        return { ...snapshot(), id: path.includes(secondId) ? secondId : ID, contributorId: null,
            joinCode: path.includes(secondId) ? "BCDEFGHJ" : "ABCDEFGH" };
    });
    try {
        await context.controller.start({ restoreBindings: false });
        await context.controller.openMapReference({ id: ID, joinCode: "ABCDEFGH" }, () => false);
        assert.equal(context.local.length, 0);
        await assert.rejects(context.controller.openMapReference({ id: ID, joinCode: "MISSINGX" }), /unavailable/);
        assert.equal(context.local.length, 0);
        const first = await context.controller.openMapReference({ id: ID, joinCode: "ABCDEFGH" });
        const second = await context.controller.openMapReference({ id: secondId, joinCode: "BCDEFGHJ" });
        assert.notEqual(first, second);
        context.controller.requestDrawing(first);
        assert.deepEqual(context.events.at(-1), ["open", "contribute", first, "ABCDEFGH"]);
        context.controller.requestDrawing(second);
        assert.deepEqual(context.events.at(-1), ["open", "contribute", second, "BCDEFGHJ"]);
    } finally { context.controller.destroy(); }
});

test("shared color changes update presentation without downloading or uploading unchanged polygons", async () => {
    const metadata = snapshot(); const calls = [];
    metadata.layers = [{ contributorId: "other", layerId: ID, revision: 1, polygonCount: 1 }];
    const { controller, events } = setup(async (path, method, body) => {
        calls.push([path, method]);
        if (method === "PATCH") { metadata.contributors[0].color = body.color; return { color: body.color }; }
        if (method === "PUT") return { revision: 1 };
        if (path.includes("/contributors/")) return { revision: 1, collection: { features: [{ properties: { name: "Other" } }] } };
        return structuredClone(metadata);
    });
    try {
        await controller.connect("join", "ABCDEFGH", "Rich"); calls.length = 0;
        await controller.setContributorColor("local-0", "#123456");
        metadata.contributors[1].color = "#987654";
        await controller.refresh();
        assert.equal(calls.filter(([, method]) => method === "PATCH").length, 1);
        assert.equal(calls.filter(([path, method]) => path.includes("/contributors/") || method === "PUT").length, 0);
        const display = events.filter(e => e[0] === "display").at(-1)[2];
        assert.deepEqual(display.contributors.map(p => p.color), ["#123456", "#987654"]);
        assert.equal(display.collections[0].features[0].properties.contributorId, "other");
    } finally { controller.destroy(); }
});

test("a new color chosen during a pending request survives the older reply and reload bookmarks", async () => {
    const metadata = snapshot(); let release; const sent = [];
    const { controller, stored, events } = setup(async (_path, method, body) => {
        if (method === "PUT") return { revision: 1 };
        if (method === "PATCH") {
            sent.push(body.color);
            if (sent.length === 1) await new Promise(resolve => { release = resolve; });
            metadata.contributors[0].color = body.color; return { color: body.color };
        }
        return structuredClone(metadata);
    });
    try {
        await controller.connect("join", "ABCDEFGH", "Rich");
        const first = controller.setContributorColor("local-0", "#111111");
        await new Promise(resolve => setImmediate(resolve));
        const second = controller.setContributorColor("local-0", "#222222");
        assert.equal(JSON.parse([...stored.values()][0])[0].pendingColor, "#222222");
        release(); await Promise.all([first, second]);
        assert.equal(events.filter(e => e[0] === "display").at(-1)[2].contributors[0].color, "#222222");
        await controller.refresh();
        assert.deepEqual(sent, ["#111111", "#222222"]);
        assert.equal(JSON.parse([...stored.values()][0])[0].pendingColor, undefined);
    } finally { controller.destroy(); }
});

test("an interrupted color update is retained for reload and retried without affecting other layers", async () => {
    const first = setup(async (_path, method) => {
        if (method === "PATCH") throw new Error("Offline");
        return method === "PUT" ? { revision: 1 } : snapshot();
    });
    try {
        await first.controller.connect("join", "ABCDEFGH", "Rich");
        await first.controller.setContributorColor("local-0", "#123abc");
        assert.match(first.events.at(-1)[2].status, /Offline/);
        const writes = [];
        const restored = setup(async (path, method, body) => {
            if (method === "PATCH") { writes.push([path, body]); return body; }
            return method === "PUT" ? { revision: 1 } : snapshot();
        });
        restored.local.push(...structuredClone(first.local));
        for (const [key, value] of first.stored) restored.stored.set(key, value);
        try {
            await restored.controller.start();
            assert.deepEqual(writes, [[`/${ID}/color`, { color: "#123abc" }]]);
            assert.equal(restored.events.filter(e => e[0] === "display").at(-1)[2].contributors[0].color, "#123abc");
        } finally { restored.controller.destroy(); }
    } finally { first.controller.destroy(); }
});

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
