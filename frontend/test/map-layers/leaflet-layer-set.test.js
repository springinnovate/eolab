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
