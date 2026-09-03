/** Keyed Leaflet attachment, opacity, and drawing-order adapter. */

/** Manage keyed source layers and optional server-composed presentation. */
export class LeafletLayerSet {
    /**
     * Create an empty keyed layer set.
     *
     * @param {{removeLayer:(layer:Object)=>void}} leafletMap Leaflet map.
     * @param {{update:(layers:Object[])=>void,clear:()=>void}|null}
     * [compositeRenderer=null] Optional ordinary-map composite renderer.
     */
    constructor(leafletMap, compositeRenderer = null) {
        this.leafletMap = leafletMap;
        this.compositeRenderer = compositeRenderer;
        this.layers = new Map();
        this.order = [];
        this.rendering = [];
        this.individualRendering = false;
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
        const record = { layer, attached: false, visible, opacity };
        this.layers.set(key, record);
        this.order.push(key);
        if (visible && this.compositeRenderer === null) {
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
        record.visible = visible;
        if (this.compositeRenderer !== null && !this.individualRendering) {
            return;
        }
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
        const record = this.#require(key);
        record.opacity = opacity;
        record.layer.setOpacity(opacity);
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
        this.order = [...orderedKeys];
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
     * Synchronize complete top-first descriptors with the current strategy.
     *
     * @param {Array<{key:string,visible:boolean,opacity:number,descriptor:Object}>}
     * rendering Complete retained-layer rendering state.
     * @return {void}
     * @throws {Error} If keys do not match the retained layer set.
     */
    render(rendering) {
        const keys = rendering.map(({ key }) => key);
        if (
            keys.length !== this.layers.size ||
            keys.some((key) => !this.layers.has(key)) ||
            new Set(keys).size !== keys.length
        ) {
            throw new Error(
                "Leaflet rendering must contain every retained layer once."
            );
        }
        this.rendering = rendering.map((candidate) => ({
            ...candidate,
            descriptor: structuredClone(candidate.descriptor),
        }));
        for (const candidate of this.rendering) {
            const record = this.#require(candidate.key);
            record.visible = candidate.visible;
            record.opacity = candidate.opacity;
        }
        this.setOrder(keys);
        this.#applyRenderingStrategy();
    }

    /**
     * Use independent source grids only for presentation modes that require it.
     *
     * @param {boolean} enabled Whether to suspend ordinary composite rendering.
     * @return {void}
     */
    setIndividualRendering(enabled) {
        if (this.compositeRenderer === null || enabled === this.individualRendering) {
            return;
        }
        this.individualRendering = enabled;
        this.#applyRenderingStrategy();
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
        this.order = this.order.filter((candidate) => candidate !== key);
        this.rendering = this.rendering.filter(
            (candidate) => candidate.key !== key
        );
        return record.layer;
    }

    /**
     * Remove every retained layer, preserving no map attachments.
     *
     * @return {void}
     */
    clear() {
        this.compositeRenderer?.clear();
        for (const key of [...this.layers.keys()]) {
            this.remove(key);
        }
        this.order = [];
        this.rendering = [];
    }

    /** Apply either one composite grid or the retained independent grids. */
    #applyRenderingStrategy() {
        if (this.compositeRenderer === null) return;
        if (this.individualRendering) {
            this.compositeRenderer.clear();
            for (const key of [...this.order].reverse()) {
                const record = this.#require(key);
                if (record.visible && !record.attached) {
                    record.layer.addTo(this.leafletMap);
                    record.attached = true;
                } else if (!record.visible && record.attached) {
                    this.leafletMap.removeLayer(record.layer);
                    record.attached = false;
                }
            }
            return;
        }
        for (const record of this.layers.values()) {
            if (record.attached) {
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
        }
        this.compositeRenderer.update(
            this.rendering
                .filter(({ visible, opacity }) => visible && opacity > 0)
                .map(({ opacity, descriptor }) => ({
                    ...structuredClone(descriptor),
                    opacity,
                }))
        );
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
