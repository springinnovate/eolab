import assert from "node:assert/strict";
import test from "node:test";

import {
    CompositeLeafletRenderer,
} from "../../src/map-layers/composite-leaflet-renderer.js";

/** Flush promise callbacks queued by a plan publication. */
async function flushPromises() {
    await new Promise((resolve) => setImmediate(resolve));
}

/** Create a Leaflet-compatible evented WMS layer. */
function createLayer(url, options) {
    const handlers = new Map();
    return {
        url,
        options,
        once(event, handler) {
            handlers.set(event, handler);
            return this;
        },
        emit(event) {
            handlers.get(event)?.();
        },
        addTo(map) {
            map.attached.add(this);
            return this;
        },
        setOpacity(opacity) {
            this.opacity = opacity;
        },
    };
}

test("composite renderer swaps complete grids only after the replacement loads", async () => {
    const calls = [];
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const leaflet = {
        tileLayer: {
            wms(url, options) {
                return createLayer(url, options);
            },
        },
    };
    const client = {
        async create(layers) {
            calls.push(layers);
            const planId = String(calls.length).repeat(64);
            return {
                planId,
                wmsUrl: `/api/map-rendering/plans/${planId}/wms`,
            };
        },
    };
    const renderer = new CompositeLeafletRenderer({
        leaflet,
        leafletMap: map,
        client,
    });

    renderer.update([{ layerName: "eolab:first", opacity: 1 }]);
    await flushPromises();
    const first = [...map.attached][0];
    assert.equal(first.options.layers, "composite");
    first.emit("load");

    renderer.update([{ layerName: "eolab:second", opacity: 0.5 }]);
    await flushPromises();
    assert.equal(map.attached.size, 2, "old grid remains during replacement load");
    const second = [...map.attached].find((layer) => layer !== first);
    assert.equal(second.opacity, 0);
    second.emit("load");
    assert.deepEqual([...map.attached], [second]);
    assert.equal(second.opacity, 1);

    renderer.update([{ layerName: "eolab:second", opacity: 0.5 }]);
    await flushPromises();
    assert.equal(calls.length, 2, "identical presentation is not republished");
    renderer.clear();
    assert.equal(map.attached.size, 0);
});

test("composite renderer keeps the current grid after plan preparation fails", async () => {
    const messages = [];
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    let publication = 0;
    const renderer = new CompositeLeafletRenderer({
        leaflet: {
            tileLayer: { wms: (url, options) => createLayer(url, options) },
        },
        leafletMap: map,
        client: {
            async create() {
                publication += 1;
                if (publication === 2) throw new Error("plan rejected");
                const planId = "a".repeat(64);
                return {
                    planId,
                    wmsUrl: `/api/map-rendering/plans/${planId}/wms`,
                };
            },
        },
        onError: (message) => messages.push(message),
    });
    renderer.update([{ layerName: "eolab:first" }]);
    await flushPromises();
    const current = [...map.attached][0];
    current.emit("load");
    renderer.update([{ layerName: "eolab:second" }]);
    await flushPromises();

    assert.deepEqual([...map.attached], [current]);
    assert.deepEqual(messages, ["plan rejected"]);
});
