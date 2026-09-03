import assert from "node:assert/strict";
import test from "node:test";

import { LeafletLayerSet } from "../../src/map-layers/leaflet-layer-set.js";

/** Create a Leaflet-compatible layer with inspectable presentation state. */
function createLayer() {
    return {
        addTo(map) {
            map.attached.add(this);
            return this;
        },
        setOpacity(opacity) {
            this.opacity = opacity;
        },
        setZIndex(zIndex) {
            this.zIndex = zIndex;
        },
    };
}

test("Leaflet layer set owns attachment, opacity, order, and cleanup", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const layers = new LeafletLayerSet(map);
    const bottom = createLayer();
    const top = createLayer();

    layers.add("bottom", bottom, { visible: true, opacity: 0.8 });
    layers.add("top", top, { visible: false, opacity: 1 });
    layers.setOrder(["top", "bottom"]);
    layers.setVisible("top", true);
    layers.setVisible("bottom", false);
    layers.setOpacity("top", 0.4);

    assert.equal(layers.get("top"), top);
    assert.equal(layers.isAttached("top"), true);
    assert.equal(layers.isAttached("bottom"), false);
    assert.equal(top.opacity, 0.4);
    assert.ok(top.zIndex > bottom.zIndex);
    assert.throws(() => layers.setOrder(["top", "top"]), Error);

    layers.clear();

    assert.equal(map.attached.size, 0);
    assert.equal(layers.get("top"), null);
});

test("Leaflet layer set uses one composite grid except for explicit individual mode", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const updates = [];
    let clears = 0;
    const layers = new LeafletLayerSet(map, {
        update(rendering) {
            updates.push(rendering);
        },
        clear() {
            clears += 1;
        },
    });
    const top = createLayer();
    const bottom = createLayer();
    layers.add("top", top, { visible: true, opacity: 0.8 });
    layers.add("bottom", bottom, { visible: true, opacity: 0.4 });
    layers.render([
        {
            key: "top",
            visible: true,
            opacity: 0.8,
            descriptor: { layerName: "eolab:top" },
        },
        {
            key: "bottom",
            visible: true,
            opacity: 0.4,
            descriptor: { layerName: "eolab:bottom" },
        },
    ]);

    assert.equal(map.attached.size, 0);
    assert.deepEqual(updates.at(-1), [
        { layerName: "eolab:top", opacity: 0.8 },
        { layerName: "eolab:bottom", opacity: 0.4 },
    ]);
    layers.setIndividualRendering(true);
    assert.equal(clears, 1);
    assert.deepEqual(map.attached, new Set([bottom, top]));

    layers.setIndividualRendering(false);
    assert.equal(map.attached.size, 0);
    assert.equal(updates.length, 2);
});
