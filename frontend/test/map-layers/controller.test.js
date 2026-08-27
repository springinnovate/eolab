import assert from "node:assert/strict";
import test from "node:test";

import { getCatalogItemKey } from "../../src/catalog-item-identity.js";
import { MapLayerController } from "../../src/map-layers/controller.js";

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

    assert.equal(controller.retainedRecords.length, 3);
    assert.deepEqual(secondOwner.events, [
        ["activate", getCatalogItemKey(second)],
        [
            "deactivate",
            getCatalogItemKey(second),
            getCatalogItemKey(third),
        ],
    ]);
    assert.equal(controller.visibleCount, 2);
    assert.equal(controller.isAttached(getCatalogItemKey(third)), false);
    view.handlers.onVisibility(getCatalogItemKey(third), true);
    assert.match(view.status, /Only 2 map layers/);

    view.handlers.onVisibility(getCatalogItemKey(first), false);
    view.handlers.onVisibility(getCatalogItemKey(third), true);
    view.handlers.onOpacity(getCatalogItemKey(third), 0.35);
    view.handlers.onMove(getCatalogItemKey(first), "up");

    assert.equal(controller.getLeafletLayer(getCatalogItemKey(third)).opacity, 0.35);
    assert.deepEqual(firstOwner.events.at(-1), [
        "order",
        getCatalogItemKey(first),
    ]);
    assert.deepEqual(
        controller.snapshots().map(({ item }) => item.id),
        ["three", "one", "two"],
    );

    controller.removeOwned(firstOwner);

    assert.deepEqual(
        controller.snapshots().map(({ item }) => item.id),
        ["two"],
    );
    assert.equal(controller.contains(second), true);
    assert.equal(controller.contains(first), false);
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
