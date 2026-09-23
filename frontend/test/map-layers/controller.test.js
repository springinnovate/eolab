import assert from "node:assert/strict";
import test from "node:test";

import { getCatalogItemKey } from "../../src/catalog-item-identity.js";
import { MapLayerController } from "../../src/map-layers/controller.js";

test("custom names change presentation and sorting without changing source or renderer identity", async () => {
    const view = createView();
    let publications = 0;
    const adapter = createAdapter("Raster", async item => { publications++; return { id: item.id }; });
    const controller = new MapLayerController({ leafletMap: createMap(), view });
    const item = catalogItem("first");
    await controller.show(item, adapter);
    await controller.show(catalogItem("second"), adapter);
    const key = getCatalogItemKey(item), record = controller.getRecord(key);
    const source = structuredClone(item), renderer = controller.getLeafletLayer(key), state = record.state;
    controller.renameLayer(key, "  <b>Protected areas</b>  ");
    assert.equal(record.entry.label, "<b>Protected areas</b>");
    assert.equal(record.entry.customName, "<b>Protected areas</b>");
    assert.equal(controller.snapshots().find(layer => layer.key === key).sourceName, "Raster first");
    controller.sortLayers("name-ascending");
    assert.equal(controller.snapshots()[0].key, key);
    assert.deepEqual(item, source);
    assert.equal(record.state, state);
    assert.equal(controller.getLeafletLayer(key), renderer);
    assert.equal(publications, 2);
    for (const invalid of [" ", "x".repeat(161), 12]) assert.throws(() => controller.renameLayer(key, invalid), /1 to 160/);
    assert.equal(record.entry.label, "<b>Protected areas</b>");
    controller.renameLayer(key, null);
    assert.equal(record.entry.label, "Raster first");
    assert.equal(record.entry.customName, null);
    controller.destroy();
});

test("staged custom names survive attachment and removal Undo snapshots", async () => {
    const view = createView(), adapter = createAdapter("Vector");
    adapter.exportSavedState = () => ({ kind: "vector", definition: {} });
    const controller = new MapLayerController({ leafletMap: createMap(), view });
    const staged = await controller.stage(catalogItem("boundaries"), adapter, { customName: "Countries" });
    controller.commitStaged([staged]);
    const key = staged.key;
    assert.equal(controller.getRecord(key).entry.customName, "Countries");
    controller.removeWithUndo(key);
    assert.equal(controller.removedLayer.customName, "Countries");
    const restored = await controller.stage(catalogItem("boundaries"), adapter, controller.removedLayer);
    controller.restoreStagedLayer(restored, 0);
    assert.equal(controller.snapshots()[0].label, "Countries");
    assert.equal(controller.snapshots()[0].customName, "Countries");
    controller.renameLayer(key, null);
    assert.equal(controller.snapshots()[0].label, "Vector boundaries");
    controller.destroy();
});

/** Create a Catalog Item with the identity required by the layer boundary. */
function catalogItem(id) {
    return { collection: "observations", id };
}

/** Create an inspectable semantic view adapter. */
function createView() {
    return {
        handlers: null,
        layers: [],
        activeKey: null,
        status: "",
        announcement: "",
        bind(handlers) {
            this.handlers = handlers;
        },
        unbind() {
            this.handlers = null;
        },
        render(layers, activeKey) {
            this.layers = layers;
            this.activeKey = activeKey;
        },
        setStatus(status) {
            this.status = status;
            this.announcement = status;
        },
        announceStatus(status) {
            this.status = "";
            this.announcement = status;
        },
    };
}

/** Create an inspectable Leaflet-compatible map. */
function createMap() {
    return {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
}

/** Create an independently owned map-layer adapter. */
function createAdapter(owner, publish = async (item) => ({ id: item.id })) {
    const events = [];
    return {
        events,
        label: (item) => `${owner} ${item.id}`,
        publish,
        createState: ({ item }) => ({ owner, item }),
        renderDescriptor: (record) => ({
            layerName: `eolab:${record.entry.item.id}`,
            styleName: `${owner}-style`,
            styleDefinition: { owner },
        }),
        createLayer: (record, onTileError) => ({
            record,
            onTileError,
            addTo(targetMap) {
                targetMap.attached.add(this);
                return this;
            },
            setOpacity(opacity) {
                this.opacity = opacity;
            },
            setZIndex(zIndex) {
                this.zIndex = zIndex;
            },
        }),
        snapshot: (record) => ({
            legend: {
                kind: "gradient",
                gradient: "linear-gradient(#000000, #ffffff)",
                description: `${record.state.owner} test gradient`,
                labels: [0, 0.5, 1],
            },
        }),
        deactivate: (record, next) =>
            events.push(["deactivate", record.entry.key, next.entry.key]),
        activate: (record) => events.push(["activate", record.entry.key]),
        visibilityChanged: (record, visible) =>
            events.push(["visibility", record.entry.key, visible]),
        orderChanged: (record) =>
            events.push(["order", record.entry.key]),
        tileErrorMessage: `${owner} tiles unavailable`,
    };
}

test("controller owns cross-adapter visibility, ordering, and removal", async () => {
    const map = createMap();
    const view = createView();
    const controller = new MapLayerController({ leafletMap: map, view });
    const firstOwner = createAdapter("first");
    const secondOwner = createAdapter("second");
    const first = catalogItem("one");
    const second = catalogItem("two");
    const third = catalogItem("three");

    await controller.show(first, firstOwner);
    await controller.show(second, secondOwner);
    await controller.show(third, firstOwner);

    assert.equal(view.status, "");
    assert.equal(view.announcement, "first three was added and is visible.");

    assert.equal(controller.retainedRecords.length, 3);
    assert.deepEqual(secondOwner.events, [
        ["activate", getCatalogItemKey(second)],
        [
            "deactivate",
            getCatalogItemKey(second),
            getCatalogItemKey(third),
        ],
    ]);
    assert.equal(controller.visibleCount, 3);
    assert.equal(controller.isAttached(getCatalogItemKey(third)), true);

    view.handlers.onVisibility(getCatalogItemKey(first), false);
    assert.equal(controller.visibleCount, 2);
    view.handlers.onVisibility(getCatalogItemKey(first), true);
    assert.equal(controller.visibleCount, 3);
    controller.setOpacity(getCatalogItemKey(third), 0.35);
    view.handlers.onReorder(getCatalogItemKey(first), 1);

    assert.equal(controller.getLeafletLayer(getCatalogItemKey(third)).opacity, 0.35);
    assert.deepEqual(firstOwner.events.at(-1), [
        "order",
        getCatalogItemKey(first),
    ]);
    assert.deepEqual(
        controller.snapshots().map(({ item }) => item.id),
        ["three", "one", "two"],
    );
    assert.equal(
        view.status,
        "first one moved to position 2 of 3 in the map drawing order.",
    );

    controller.removeOwned(firstOwner);

    assert.deepEqual(
        controller.snapshots().map(({ item }) => item.id),
        ["two"],
    );
    assert.equal(controller.contains(second), true);
    assert.equal(controller.contains(first), false);
});

test("removal preserves a replacement presentation activated by its adapter", async () => {
    const view = createView();
    const controller = new MapLayerController({
        leafletMap: createMap(),
        view,
    });
    const fallback = catalogItem("fallback");
    const removed = catalogItem("removed");
    const fallbackKey = getCatalogItemKey(fallback);
    const fallbackAdapter = createAdapter("fallback");
    const removedAdapter = createAdapter("removed");
    removedAdapter.beforeRemove = () => ({ activateFallback: false });
    removedAdapter.removed = () => controller.activate(fallbackKey);

    await controller.show(fallback, fallbackAdapter);
    await controller.show(removed, removedAdapter);
    controller.remove(removed);

    assert.equal(controller.activeKey, fallbackKey);
    assert.equal(view.activeKey, fallbackKey);
    assert.deepEqual(fallbackAdapter.events.at(-1), ["activate", fallbackKey]);
});

test("controller forwards authoritative Items to composition callbacks", async () => {
    const view = createView();
    const received = [];
    const controller = new MapLayerController({
        leafletMap: createMap(),
        view,
        onItemZoom: (item) => received.push(["zoom", item]),
        onItemInfo: (item) => received.push(["info", item]),
    });
    const item = catalogItem("navigation");
    const key = getCatalogItemKey(item);
    await controller.show(item, createAdapter("test"));

    view.handlers.onZoom(key);
    view.handlers.onInfo(key);

    assert.deepEqual(received, [
        ["zoom", item],
        ["info", item],
    ]);
});

test("controller rejects invalid Item navigation boundaries", () => {
    assert.throws(
        () => new MapLayerController({
            leafletMap: createMap(),
            view: createView(),
            onItemZoom: null,
        }),
        /navigation callbacks must be callable/,
    );
    assert.throws(
        () => new MapLayerController({
            leafletMap: createMap(),
            view: createView(),
            onItemInfo: "details",
        }),
        /navigation callbacks must be callable/,
    );
});

test("on-map membership survives hiding a layer until it is removed", async () => {
    const map = createMap();
    const controller = new MapLayerController({ leafletMap: map, view: createView() });
    const item = catalogItem("membership");
    const key = getCatalogItemKey(item);

    await controller.show(item, createAdapter("test"));
    assert.equal(controller.contains(item), true);
    assert.equal(controller.isAttached(key), true);

    controller.setVisible(key, false);
    assert.equal(controller.contains(item), true);
    assert.equal(controller.isAttached(key), false);

    controller.remove(item);
    assert.equal(controller.contains(item), false);
});

test("controller coalesces publication and invalidates removed pending work", async () => {
    const map = createMap();
    const view = createView();
    let resolvePublication;
    let calls = 0;
    const publication = new Promise((resolve) => {
        resolvePublication = resolve;
    });
    const adapter = createAdapter("delayed", async () => {
        calls += 1;
        return publication;
    });
    const item = catalogItem("pending");
    const controller = new MapLayerController({ leafletMap: map, view });
    const firstRequest = controller.show(item, adapter);
    const repeatedRequest = controller.show({ ...item }, adapter);
    controller.remove(item);
    resolvePublication({ id: item.id });

    assert.equal(await firstRequest, null);
    assert.equal(await repeatedRequest, null);
    assert.equal(calls, 1);
    assert.equal(controller.contains(item), false);
    assert.equal(map.attached.size, 0);
});

test("controller stages layers detached and commits one ordered snapshot", async () => {
    const map = createMap();
    const view = createView();
    let renderCount = 0;
    const render = view.render.bind(view);
    view.render = (...arguments_) => {
        renderCount += 1;
        render(...arguments_);
    };
    const layerChanges = [];
    const controller = new MapLayerController({
        leafletMap: map,
        view,
        onLayersChange: (layers) => layerChanges.push(
            layers.map(({ item }) => item.id)
        ),
    });
    const adapter = createAdapter("batch");
    adapter.added = (record, context) =>
        adapter.events.push(["added", record.entry.key, context.fitToBounds]);
    const top = await controller.stage(
        catalogItem("top"),
        adapter,
        { visible: true, opacity: 0.4 }
    );
    const bottom = await controller.stage(
        catalogItem("bottom"),
        adapter,
        { visible: false, opacity: 0.7 }
    );

    assert.equal(map.attached.size, 0);
    assert.deepEqual(controller.retainedRecords, []);
    assert.equal(renderCount, 1);
    assert.deepEqual(layerChanges, [[]]);

    const committed = controller.commitStaged(
        [top, bottom],
        { fitToBounds: false }
    );

    assert.deepEqual(committed.map(({ entry }) => entry.item.id), [
        "top",
        "bottom",
    ]);
    assert.deepEqual(view.layers.map(({ item }) => item.id), ["top", "bottom"]);
    assert.equal(map.attached.size, 1);
    assert.equal(controller.isAttached(top.key), true);
    assert.equal(controller.isAttached(bottom.key), false);
    assert.equal(controller.getLeafletLayer(top.key).opacity, 0.4);
    assert.equal(controller.getLeafletLayer(bottom.key).opacity, 0.7);
    assert.ok(
        controller.getLeafletLayer(top.key).zIndex >
        controller.getLeafletLayer(bottom.key).zIndex
    );
    assert.equal(renderCount, 2);
    assert.deepEqual(layerChanges, [[], ["top", "bottom"]]);
    assert.deepEqual(
        adapter.events.filter(([event]) => event === "added"),
        [
            ["added", top.key, false],
            ["added", bottom.key, false],
        ]
    );
});

test("controller copies portable style and layer opacity onto a compatible target", async () => {
    const map = createMap();
    const view = createView();
    const adapter = createAdapter("raster");
    adapter.createState = ({ item }) => ({
        owner: "raster",
        item,
        style: { color: item.id === "source" ? "red" : "blue" },
    });
    adapter.exportSavedState = (record) => ({
        kind: "raster",
        definition: record.state.style,
    });
    adapter.checkSavedStateCompatibility = (_record, savedState) =>
        savedState.kind === "raster" ? null : "Raster style required.";
    adapter.applySavedState = async (record, savedState) => {
        record.state.style = structuredClone(savedState.definition);
    };
    const controller = new MapLayerController({ leafletMap: map, view });
    const source = catalogItem("source");
    const target = catalogItem("target");
    await controller.show(source, adapter);
    await controller.show(target, adapter);
    const sourceKey = getCatalogItemKey(source);
    const targetKey = getCatalogItemKey(target);
    controller.setOpacity(sourceKey, 0.37);
    controller.setOpacity(targetKey, 0.82);

    assert.equal(
        controller.snapshots().find(({ key }) => key === targetKey)
            .styleClipboard.canPaste,
        false,
    );
    assert.equal(controller.copyStyle(sourceKey), true);
    controller.getRecord(sourceKey).state.style.color = "green";
    const targetClipboard = controller.snapshots().find(
        ({ key }) => key === targetKey,
    ).styleClipboard;
    assert.equal(targetClipboard.canPaste, true);
    assert.equal(targetClipboard.sourceLabel, "raster source");

    assert.equal(await controller.pasteStyle(targetKey), true);
    assert.deepEqual(controller.getRecord(targetKey).state.style, { color: "red" });
    assert.equal(controller.getRecord(targetKey).entry.opacity, 0.37);
    assert.equal(controller.getLeafletLayer(targetKey).opacity, 0.37);
    assert.equal(
        view.status,
        "Style and opacity from raster source pasted onto raster target.",
    );
});

test("controller rejects incompatible and failed pastes without changing opacity", async () => {
    const map = createMap();
    const view = createView();
    const raster = createAdapter("raster");
    raster.createState = ({ item }) => ({ owner: "raster", item, style: "source" });
    raster.exportSavedState = (record) => ({
        kind: "raster",
        definition: record.state.style,
    });
    raster.checkSavedStateCompatibility = () => null;
    raster.applySavedState = async () => {};
    const vector = createAdapter("vector");
    vector.createState = ({ item }) => ({ owner: "vector", item, style: "target" });
    vector.exportSavedState = (record) => ({
        kind: "vector",
        definition: record.state.style,
    });
    vector.checkSavedStateCompatibility = (_record, savedState) =>
        savedState.kind === "vector" ? null : "Only vector styles are compatible.";
    vector.applySavedState = async () => {
        throw new Error("The target fields changed.");
    };
    const controller = new MapLayerController({ leafletMap: map, view });
    const source = catalogItem("source");
    const target = catalogItem("target");
    await controller.show(source, raster);
    await controller.show(target, vector);
    const sourceKey = getCatalogItemKey(source);
    const targetKey = getCatalogItemKey(target);
    controller.setOpacity(sourceKey, 0.25);
    controller.setOpacity(targetKey, 0.75);
    controller.copyStyle(sourceKey);

    const incompatible = controller.snapshots().find(
        ({ key }) => key === targetKey,
    ).styleClipboard;
    assert.equal(incompatible.canPaste, false);
    assert.equal(incompatible.pasteReason, "Only vector styles are compatible.");
    assert.equal(await controller.pasteStyle(targetKey), false);
    assert.equal(controller.getRecord(targetKey).state.style, "target");
    assert.equal(controller.getRecord(targetKey).entry.opacity, 0.75);

    vector.checkSavedStateCompatibility = () => null;
    assert.equal(await controller.pasteStyle(targetKey), false);
    assert.equal(controller.getRecord(targetKey).state.style, "target");
    assert.equal(controller.getRecord(targetKey).entry.opacity, 0.75);
    assert.match(view.status, /The target fields changed/);
});

test("bulk visibility preserves layers and notifies owners and composition once", async () => {
    const map = createMap();
    const basemap = {};
    map.attached.add(basemap);
    map.fitBounds = () => assert.fail("Visibility must not change the viewport");
    const view = createView();
    const changes = [];
    const controller = new MapLayerController({
        leafletMap: map, view, onLayersChange: layers => changes.push(layers),
    });
    const raster = createAdapter("raster");
    const vector = createAdapter("vector");
    for (const adapter of [raster, vector]) {
        const originalSnapshot = adapter.snapshot;
        adapter.snapshot = record => ({
            ...originalSnapshot(record), datasetKind: record.state.owner,
        });
    }
    await controller.show(catalogItem("raster"), raster);
    await controller.show(catalogItem("vector"), vector);
    const [vectorRecord, rasterRecord] = controller.retainedRecords;
    vectorRecord.state.filter = { field: "year", value: 2020 };
    rasterRecord.state.style = { minimum: 0, maximum: 100 };
    controller.setOpacity(rasterRecord.entry.key, 0.35);
    controller.setVisible(vectorRecord.entry.key, false);
    const before = controller.snapshots();
    const state = controller.retainedRecords.map(record => structuredClone(record.state));
    const activeKey = controller.activeKey;
    const layers = controller.retainedRecords.map(record => controller.getLeafletLayer(record.entry.key));
    changes.length = 0;
    raster.events.length = 0;
    vector.events.length = 0;

    view.handlers.onAllVisibility(false);
    assert.equal(changes.length, 1);
    assert.deepEqual(raster.events, [["visibility", rasterRecord.entry.key, false]]);
    assert.deepEqual(vector.events, [], "Already hidden layers are untouched");
    assert.deepEqual([...map.attached], [basemap]);
    assert.equal(view.announcement, "1 map layer hidden.");
    view.handlers.onAllVisibility(false);
    assert.equal(changes.length, 1, "A no-op does not refresh consumers");

    view.handlers.onAllVisibility(true);
    assert.equal(changes.length, 2);
    assert.ok(changes[1].every(layer => layer.visible));
    assert.deepEqual(controller.snapshots(), before.map(layer => ({ ...layer, visible: true })));
    assert.deepEqual(controller.retainedRecords.map(record => record.state), state);
    assert.equal(controller.activeKey, activeKey);
    assert.deepEqual(
        controller.retainedRecords.map(record => controller.getLeafletLayer(record.entry.key)), layers,
    );
    assert.equal(map.attached.size, 3);
    assert.deepEqual(vector.events, [["visibility", vectorRecord.entry.key, true]]);
    view.handlers.onAllVisibility(true);
    assert.equal(changes.length, 2);
    view.handlers.onVisibility(vectorRecord.entry.key, false);
    assert.equal(controller.visibleCount, 1, "Individual toggles still work");
    assert.equal(changes.length, 3);
});

test("bulk visibility does not change empty stacks or pending additions", async () => {
    const view = createView();
    const changes = [];
    const controller = new MapLayerController({
        leafletMap: createMap(), view, onLayersChange: layers => changes.push(layers),
    });
    changes.length = 0;
    view.handlers.onAllVisibility(false);
    view.handlers.onAllVisibility(true);
    assert.equal(changes.length, 0);
    assert.throws(() => controller.setAllVisible(null), /visibility must be boolean/);
    let finish;
    const pending = controller.show(catalogItem("pending"), createAdapter("raster",
        () => new Promise(resolve => { finish = resolve; })));
    view.handlers.onAllVisibility(false);
    finish({ id: "pending" });
    await pending;
    assert.equal(controller.visibleCount, 1);
});

test("local layers keep their identity and survive Catalog clearing and restoration", async () => {
    const view = createView(), map = createMap();
    const controller = new MapLayerController({ leafletMap: map, view });
    const local = createAdapter("local");
    local.snapshot = () => ({ datasetKind: "annotation" });
    let zoomed = 0, inspected = 0;
    local.zoom = () => zoomed++;
    local.info = () => inspected++;
    const record = controller.addLocal({key: "local:annotation:one", label: "Workshop"}, local);
    assert.equal(record.entry.item, null);
    view.handlers.onZoom(record.entry.key);
    view.handlers.onInfo(record.entry.key);
    assert.equal(zoomed, 1);
    assert.equal(inspected, 1);
    const catalog = createAdapter("raster");
    await controller.show(catalogItem("raster"), catalog);
    controller.clear({preserveLocal: true});
    assert.deepEqual(controller.retainedRecords, [record]);
    const staged = await controller.stage(catalogItem("restored"), catalog);
    controller.commitStaged([staged]);
    assert.equal(controller.retainedRecords.length, 2);
    assert.equal(controller.getRecord(record.entry.key), record);
    controller.setVisible(record.entry.key, false);
    controller.setOpacity(record.entry.key, 0.4);
    assert.equal(record.entry.visible, false);
    assert.equal(record.entry.opacity, 0.4);
    assert.throws(() => controller.addLocal({key: record.entry.key, label: "duplicate"}, local));
});


test("name sorts use displayed numeric names, retain ties and preserve layer state", async () => {
    const map = createMap(), view = createView(), changes = [];
    const controller = new MapLayerController({ leafletMap: map, view,
        onOrderChange: layers => changes.push(layers.map(layer => layer.key)) });
    const adapter = createAdapter("raster");
    adapter.snapshot = record => ({ datasetKind: "raster", label: record.state.title });
    const records = [];
    for (const [id, title] of [["one", "Layer 10"], ["two", "Layer 2"], ["three", "layer 2"], ["four", "Alpha"]]) {
        await controller.show(catalogItem(id), adapter);
        const record = controller.getRecord(getCatalogItemKey(catalogItem(id)));
        record.state.title = title;
        records.push(record);
    }
    const keys = records.map(record => record.entry.key);
    controller.restoreOrder(keys);
    controller.setVisible(keys[1], false);
    controller.setOpacity(keys[0], 0.3);
    const originalState = records.map(record => ({ ...record.entry }));
    const activeKey = controller.presentationActiveKey;
    adapter.events.length = 0;
    view.handlers.onSort("name-ascending");
    assert.deepEqual(changes, [[keys[3], keys[1], keys[2], keys[0]]]);
    assert.deepEqual(controller.leafletLayers.order, changes[0]);
    assert.ok(controller.leafletLayers.get(keys[3]).zIndex > controller.leafletLayers.get(keys[0]).zIndex);
    assert.deepEqual(records.map(record => ({ ...record.entry })), originalState);
    assert.equal(controller.presentationActiveKey, activeKey);
    assert.equal(controller.leafletLayers.isAttached(keys[1]), false);
    assert.deepEqual(adapter.events, [["order", keys[3]], ["order", keys[0]]]);
    assert.match(view.status, /Layers at the top draw above/);
    view.handlers.onSort("name-ascending");
    assert.equal(changes.length, 1, "already sorted layers do not notify or refresh renderers");
    view.handlers.onSort("name-descending");
    assert.deepEqual(changes.at(-1), [keys[0], keys[1], keys[2], keys[3]], "descending preserves equal-name order too");
    controller.reorder(keys[3], 0);
    assert.deepEqual(changes.at(-1), [keys[3], keys[0], keys[1], keys[2]], "manual ordering still works");
    records[0].state.title = "A changed name";
    controller.render();
    assert.deepEqual(controller.snapshots().map(layer => layer.key), changes.at(-1), "name edits do not automatically resort");
    assert.throws(() => controller.sortLayers("reverse-stack"), TypeError);
});

test("visibility and type grouping keep each group's current order without changing visibility", () => {
    const view = createView();
    const controller = new MapLayerController({ leafletMap: createMap(), view });
    for (const [key, kind, visible] of [
        ["r1", "raster", true], ["v1", "vector", false], ["a1", "annotation", false],
        ["r2", "raster", false], ["a2", "annotation", true], ["v2", "vector", true],
    ]) {
        const adapter = createAdapter(kind);
        adapter.snapshot = () => ({ datasetKind: kind });
        controller.addLocal({ key: `local:${key}`, label: key, visible }, adapter);
    }
    controller.restoreOrder(["r1", "v1", "a1", "r2", "a2", "v2"].map(key => `local:${key}`));
    view.handlers.onSort("visible-first");
    assert.deepEqual(controller.snapshots().map(layer => layer.label), ["r1", "a2", "v2", "v1", "a1", "r2"]);
    view.handlers.onSort("layer-type");
    assert.deepEqual(controller.snapshots().map(layer => layer.label), ["a2", "a1", "v2", "v1", "r1", "r2"]);
    assert.deepEqual(controller.snapshots().map(layer => layer.visible), [true, false, true, false, true, false]);
    controller.setVisible("local:r2", true);
    assert.equal(controller.snapshots().at(-1).label, "r2", "visibility changes do not automatically regroup");
});

test("saved ordering applies atomically without user-reorder callbacks or focus requests", async () => {
    const view = createView(), renders = [], reorders = [];
    view.render = (...args) => renders.push(args);
    const controller = new MapLayerController({ leafletMap: createMap(), view,
        onOrderChange: layers => reorders.push(layers.map(layer => layer.key)) });
    const adapter = createAdapter("raster");
    await controller.show(catalogItem("one"), adapter);
    await controller.show(catalogItem("two"), adapter);
    const original = controller.snapshots().map(layer => layer.key);
    assert.equal(reorders.length, 0);
    const renderCount = renders.length;
    const status = view.status;
    controller.restoreOrder([...original].reverse());
    assert.equal(renders.length, renderCount + 1);
    assert.equal(reorders.length, 0);
    assert.equal(view.status, status);
    assert.equal(renders.at(-1)[2], null);
    controller.reorder(original[0], 0);
    assert.deepEqual(reorders, [original]);
});

/**
 * Wire the real removal lifecycle to a detached, controllable Catalog adapter.
 * @return {Object} Controller, presentation, source owner and delayed-restore hooks.
 */
function undoFixture() {
    const view = createView();
    view.showRemoval = (removal, busy, error) => { view.removal = { label: removal?.label ?? null, index: removal?.index, busy, error }; };
    const adapter = createAdapter("undo");
    adapter.exportSavedState = record => ({ color: record.state.color ?? "red" });
    const fixture = { beforeRestore: async () => {} };
    const controller = new MapLayerController({ leafletMap: createMap(), view,
        restoreRemovedLayer: async (snapshot, isCurrent) => {
            await fixture.beforeRestore();
            if (!isCurrent()) throw new Error("Superseded");
            const staged = await controller.stage(snapshot.item, adapter, snapshot);
            if (!isCurrent()) throw new Error("Superseded");
            staged.record.state.color = snapshot.style.color;
            controller.restoreStagedLayer(staged, snapshot.index);
        },
    });
    return Object.assign(fixture, { controller, view, adapter });
}

test("Undo restores the last removed layer's order, visibility, opacity and appearance without activating it", async () => {
    const { controller, view, adapter } = undoFixture();
    for (const id of ["a", "b", "c"]) await controller.show(catalogItem(id), adapter);
    const key = getCatalogItemKey(catalogItem("b"));
    controller.setVisible(key, false);
    controller.setOpacity(key, 0.25);
    controller.getRecord(key).state.color = "blue";
    const active = controller.activeKey;
    const priorLayer = controller.getLeafletLayer(key);
    view.handlers.onRemove(key);
    assert.equal(controller.getLeafletLayer(key), null);
    assert.equal(view.removal.label, "undo b");
    await controller.undoLayerRemoval();
    assert.deepEqual(controller.snapshots().map(layer => layer.item.id), ["c", "b", "a"]);
    assert.equal(controller.activeKey, active);
    assert.equal(controller.getRecord(key).state.color, "blue");
    assert.equal(controller.getRecord(key).entry.opacity, 0.25);
    assert.equal(controller.getRecord(key).entry.visible, false);
    assert.notEqual(controller.getLeafletLayer(key), priorLayer);
    assert.equal(view.removal.label, null);
});

test("only the latest explicit removal is undoable, including the final layer; internal removals do not replace it", async () => {
    const { controller, view, adapter } = undoFixture();
    for (const id of ["a", "b", "c"]) await controller.show(catalogItem(id), adapter);
    controller.removeWithUndo(getCatalogItemKey(catalogItem("b")));
    controller.removeWithUndo(getCatalogItemKey(catalogItem("a")));
    controller.clear();
    assert.equal(controller.snapshots().length, 0);
    assert.equal(view.removal.label, "undo a");
    await controller.undoLayerRemoval();
    assert.deepEqual(controller.snapshots().map(layer => layer.item.id), ["a"]);
    controller.removeWithUndo(getCatalogItemKey(catalogItem("a")));
    assert.equal(controller.snapshots().length, 0);
    assert.equal(view.removal.label, "undo a");
    await controller.undoLayerRemoval();
    await controller.undoLayerRemoval();
    assert.equal(controller.snapshots().length, 1);
});

test("failed restoration keeps Undo for retry and never overwrites a re-added layer", async () => {
    const fixture = undoFixture();
    const { controller, view, adapter } = fixture;
    const item = catalogItem("a");
    const key = getCatalogItemKey(item);
    await controller.show(item, adapter);
    controller.removeWithUndo(key);
    fixture.beforeRestore = async () => { throw new Error("Source unavailable"); };
    await controller.undoLayerRemoval();
    assert.match(view.removal.error, /Source unavailable/);
    assert.equal(view.removal.busy, false);
    fixture.beforeRestore = async () => {};
    await controller.show(item, adapter);
    const readded = controller.getRecord(key);
    await controller.undoLayerRemoval();
    assert.equal(controller.getRecord(key), readded);
    assert.ok(view.removal.error);
    controller.remove(item);
    await controller.undoLayerRemoval();
    assert.equal(controller.snapshots().length, 1);
    assert.equal(view.removal.label, null);
});

test("a delayed Undo cannot resurrect a layer after reset or replace a newer removal", async () => {
    for (const reset of [true, false]) {
        const fixture = undoFixture();
        const { controller, view, adapter } = fixture;
        for (const id of ["a", "b"]) await controller.show(catalogItem(id), adapter);
        controller.removeWithUndo(getCatalogItemKey(catalogItem("a")));
        let release;
        fixture.beforeRestore = () => new Promise(resolve => { release = resolve; });
        const undo = controller.undoLayerRemoval();
        if (reset) controller.clear();
        else controller.removeWithUndo(getCatalogItemKey(catalogItem("b")));
        release();
        await undo;
        assert.equal(controller.snapshots().length, 0);
        assert.equal(view.removal.label, reset ? "undo a" : "undo b");
        fixture.beforeRestore = async () => {};
        await controller.undoLayerRemoval();
        assert.deepEqual(controller.snapshots().map(layer => layer.item.id), [reset ? "a" : "b"]);
    }
});

test("a source re-added while Undo is preparing is never overwritten at attachment", async () => {
    const { controller, adapter } = undoFixture();
    const item = catalogItem("race");
    const staged = await controller.stage(item, adapter);
    await controller.show(item, adapter);
    const existing = controller.getRecord(staged.key);
    assert.throws(() => controller.restoreStagedLayer(staged, 0), /already on the map/);
    assert.equal(controller.getRecord(staged.key), existing);
    assert.equal(controller.snapshots().length, 1);
});

test("owner cleanup invalidates in-flight Undo without replacing its saved data", async () => {
    const fixture = undoFixture();
    const { controller, adapter, view } = fixture;
    const item = catalogItem("a");
    await controller.show(item, adapter);
    controller.removeWithUndo(getCatalogItemKey(item));
    let release;
    fixture.beforeRestore = () => new Promise(resolve => { release = resolve; });
    const undo = controller.undoLayerRemoval();
    controller.removeOwned(adapter);
    release();
    await undo;
    assert.equal(controller.snapshots().length, 0);
    assert.equal(view.removal.label, "undo a");
});

test("dismissal forgets Undo and a newer removal supplies its own row position", async () => {
    const { controller, view, adapter } = undoFixture();
    for (const id of ["a", "b", "c"]) await controller.show(catalogItem(id), adapter);
    controller.removeWithUndo(getCatalogItemKey(catalogItem("b")));
    assert.equal(view.removal.index, 1);
    controller.removeWithUndo(getCatalogItemKey(catalogItem("a")));
    assert.equal(view.removal.label, "undo a");
    assert.equal(view.removal.index, 1);
    view.handlers.onDismissRemoval();
    assert.equal(view.removal.label, null);
    await controller.undoLayerRemoval();
    assert.deepEqual(controller.snapshots().map(layer => layer.item.id), ["c"]);
    controller.removeWithUndo(getCatalogItemKey(catalogItem("c")));
    assert.equal(view.removal.index, 0);
    await controller.undoLayerRemoval();
    assert.deepEqual(controller.snapshots().map(layer => layer.item.id), ["c"]);
});

test("dismissing an in-flight Undo prevents its delayed response from restoring the layer", async () => {
    const fixture = undoFixture();
    const { controller, view, adapter } = fixture;
    await controller.show(catalogItem("a"), adapter);
    controller.removeWithUndo(getCatalogItemKey(catalogItem("a")));
    let release;
    fixture.beforeRestore = () => new Promise(resolve => { release = resolve; });
    const undo = controller.undoLayerRemoval();
    controller.dismissLayerRemoval();
    assert.equal(view.removal.label, null);
    release();
    await undo;
    assert.equal(controller.snapshots().length, 0);
    assert.equal(view.removal.label, null);
});
