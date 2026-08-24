/** Keyed Leaflet attachment, opacity, and drawing-order adapter. */

/** Manage independent keyed Leaflet layers without publication logic. */
export class LeafletLayerSet {
    /**
     * Create an empty keyed layer set.
     *
     * @param {{removeLayer:(layer:Object)=>void}} leafletMap Leaflet map.
     */
    constructor(leafletMap) {
        this.leafletMap = leafletMap;
        this.layers = new Map();
    }

    /**
     * Retain one layer and optionally attach it to the map.
     *
     * @param {string} key Stable map-layer key.
     * @param {Object} layer Leaflet-compatible layer.
     * @param {{visible:boolean,opacity:number}} presentation Initial state.
     * @return {Object} Retained Leaflet layer.
     * @throws {Error} If the key is already retained.
     */
    add(key, layer, { visible, opacity }) {
        if (this.layers.has(key)) {
            throw new Error(`Leaflet layer already exists: ${key}`);
        }
        layer.setOpacity(opacity);
        const record = { layer, attached: false };
        this.layers.set(key, record);
        if (visible) {
            layer.addTo(this.leafletMap);
            record.attached = true;
        }
        return layer;
    }

    /**
     * Attach or detach one retained layer without recreating it.
     *
     * @param {string} key Stable map-layer key.
     * @param {boolean} visible Requested map visibility.
     * @return {void}
     */
    setVisible(key, visible) {
        const record = this.#require(key);
        if (record.attached === visible) {
            return;
        }
        if (visible) {
            record.layer.addTo(this.leafletMap);
        } else {
            this.leafletMap.removeLayer(record.layer);
        }
        record.attached = visible;
    }

    /**
     * Apply ordinary-overlay opacity locally.
     *
     * @param {string} key Stable map-layer key.
     * @param {number} opacity Opacity from zero through one.
     * @return {void}
     */
    setOpacity(key, opacity) {
        this.#require(key).layer.setOpacity(opacity);
    }

    /**
     * Apply deterministic top-first drawing order to all retained layers.
     *
     * @param {string[]} orderedKeys Complete keys from topmost to bottommost.
     * @return {void}
     * @throws {Error} If the order is incomplete or contains duplicates.
     */
    setOrder(orderedKeys) {
        if (
            orderedKeys.length !== this.layers.size ||
            orderedKeys.some((key) => !this.layers.has(key))
        ) {
            throw new Error(
                "Leaflet order must contain every retained layer once."
            );
        }
        if (new Set(orderedKeys).size !== orderedKeys.length) {
            throw new Error("Leaflet order cannot contain duplicate keys.");
        }
        const baseZIndex = 200;
        orderedKeys.forEach((key, index) => {
            this.#require(key).layer.setZIndex(
                baseZIndex + orderedKeys.length - index
            );
        });
    }

    /**
     * Return one retained Leaflet layer.
     *
     * @param {string} key Stable map-layer key.
     * @return {Object|null} Matching layer or null.
     */
    get(key) {
        return this.layers.get(key)?.layer ?? null;
    }

    /**
     * Return whether one retained layer is attached to the map.
     *
     * @param {string} key Stable map-layer key.
     * @return {boolean} Whether the layer currently issues map requests.
     */
    isAttached(key) {
        return this.layers.get(key)?.attached ?? false;
    }

    /**
     * Remove one retained layer from the map and keyed set.
     *
     * @param {string} key Stable map-layer key.
     * @return {Object|null} Removed layer or null when unknown.
     */
    remove(key) {
        const record = this.layers.get(key);
        if (record === undefined) {
            return null;
        }
        if (record.attached) {
            this.leafletMap.removeLayer(record.layer);
        }
        this.layers.delete(key);
        return record.layer;
    }

    /**
     * Remove every retained layer, preserving no map attachments.
     *
     * @return {void}
     */
    clear() {
        for (const key of [...this.layers.keys()]) {
            this.remove(key);
        }
    }

    /**
     * Require one retained record.
     *
     * @param {string} key Stable map-layer key.
     * @return {{layer:Object,attached:boolean}} Retained record.
     * @throws {RangeError} If the key is unknown.
     */
    #require(key) {
        const record = this.layers.get(key);
        if (record === undefined) {
            throw new RangeError(`Unknown Leaflet layer: ${key}`);
        }
        return record;
    }
}
