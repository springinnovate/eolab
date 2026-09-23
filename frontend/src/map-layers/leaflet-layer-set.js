/** Keyed Leaflet attachment, opacity, and drawing-order adapter. */

import { TileRecovery } from "./tile-recovery.js";

const INDIVIDUAL_RENDERING_TILE_RETRY_LIMIT = 1;

/** Manage keyed source layers and optional server-composed presentation. */
export class LeafletLayerSet {
    /**
     * Create an empty keyed layer set.
     *
     * @param {{removeLayer:(layer:Object)=>void}} leafletMap Leaflet map.
     * @param {{update:(layers:Object[])=>void,clear:()=>void}|null}
     * [compositeRenderer=null] Optional ordinary-map composite renderer.
     * @param {{onStatus:(status:import('./tile-recovery.js').MapTileStatus)=>void,onLayerStatus:(key:string,status:import('./tile-recovery.js').MapTileStatus)=>void}|null}
     * [tileStatus=null] Optional feedback for independent grids beside local layers.
     */
    constructor(leafletMap, compositeRenderer = null, tileStatus = null) {
        this.leafletMap = leafletMap;
        this.compositeRenderer = compositeRenderer;
        this.layers = new Map();
        this.order = [];
        this.rendering = [];
        this.individualRenderingKeys = null;
        this.individualRenderingGeneration = 0;
        this.pendingIndividualRendering = null;
        this.activeIndividualRenderingSignature = null;
        this.tileStatus = tileStatus;
        this.localTileRecovery = new Map();
        this.showingLocalLayers = false;
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
        if (
            this.compositeRenderer !== null &&
            this.individualRenderingKeys === null
        ) {
            return;
        }
        if (
            this.compositeRenderer !== null &&
            !this.individualRenderingKeys.has(key)
        ) {
            if (record.attached) {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
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
     * @param {Array<{key:string,visible:boolean,opacity:number,descriptor:Object|null}>}
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
     * Use only selected independent source grids for a special presentation.
     *
     * A null selection restores ordinary composite rendering. Selected source
     * grids load while hidden and replace the current composite together.
     *
     * @param {string[]|null} selectedKeys Retained keys to render independently,
     * or null to restore ordinary composite rendering.
     * @return {void}
     */
    setIndividualRendering(selectedKeys) {
        if (this.compositeRenderer === null) {
            return;
        }
        const nextKeys = selectedKeys === null
            ? null
            : this.#validateIndividualRenderingKeys(selectedKeys);
        if (this.#hasSameIndividualRenderingKeys(nextKeys)) {
            return;
        }
        this.individualRenderingKeys = nextKeys;
        this.individualRenderingGeneration += 1;
        this.#cancelPendingIndividualRendering();
        this.activeIndividualRenderingSignature = null;
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
        this.#removeLocalTileRecovery(key);
        if (this.pendingIndividualRendering?.keys.has(key)) {
            this.#cancelPendingIndividualRendering();
        }
        if (record.attached) {
            this.#setLayerHidden(record.layer, false);
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
        this.#clearLocalTileRecovery();
        this.individualRenderingGeneration += 1;
        this.#cancelPendingIndividualRendering();
        this.compositeRenderer?.clear();
        for (const key of [...this.layers.keys()]) {
            this.remove(key);
        }
        this.order = [];
        this.rendering = [];
        this.individualRenderingKeys = null;
        this.activeIndividualRenderingSignature = null;
    }

    /** Apply either one composite grid or the retained independent grids. */
    #applyRenderingStrategy() {
        if (this.compositeRenderer === null) return;
        if (this.rendering.some(candidate => candidate.descriptor === null && candidate.visible)) {
            this.#renderWithLocalLayers();
            return;
        }
        this.#clearLocalTileRecovery();
        if (this.individualRenderingKeys !== null) {
            this.#prepareIndividualRendering();
            return;
        }
        this.#cancelPendingIndividualRendering();
        for (const record of this.layers.values()) {
            if (record.attached) {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
        }
        this.compositeRenderer.update(
            this.rendering
                .filter(({ visible, opacity, descriptor }) => visible && opacity > 0 && descriptor !== null)
                .map(({ opacity, descriptor }) => ({
                    ...structuredClone(descriptor),
                    opacity,
                }))
        );
    }

    /**
     * Interleave local overlays with the existing individual source layers.
     * A null descriptor identifies local rendering, never a server source.
     * Paired-raster mode keeps its selected sources and visible local layers.
     * @return {void}
     */
    #renderWithLocalLayers() {
        this.#cancelPendingIndividualRendering();
        this.activeIndividualRenderingSignature = null;
        this.compositeRenderer.clear();
        this.showingLocalLayers = true;
        this.#watchLocalTiles();
        for (const candidate of this.rendering) {
            const record = this.#require(candidate.key);
            const visible = candidate.visible && (candidate.descriptor === null ||
                this.individualRenderingKeys === null || this.individualRenderingKeys.has(candidate.key));
            this.#setLayerHidden(record.layer, false);
            if (visible && !record.attached) record.layer.addTo(this.leafletMap);
            if (!visible && record.attached) this.leafletMap.removeLayer(record.layer);
            record.attached = visible;
        }
    }

    /** Retry failed visible independent tiles without reloading successful ones. @return {void} */
    retryFailedTiles() {
        for (const { recovery } of this.localTileRecovery.values()) recovery.retryFailedTiles();
    }

    /**
     * Report whether this layer's tile errors already have recovery and feedback.
     * @param {string} key Retained layer key.
     * @return {boolean} Whether independent tile recovery owns its errors.
     */
    hasTileRecovery(key) {
        return this.localTileRecovery.has(key);
    }

    /** Observe only visible catalog grids; annotations have no server tiles. @return {void} */
    #watchLocalTiles() {
        if (!this.tileStatus) return;
        const visible = new Set(this.rendering.filter(candidate => candidate.descriptor !== null &&
            candidate.visible &&
            (this.individualRenderingKeys === null || this.individualRenderingKeys.has(candidate.key)))
            .map(candidate => candidate.key));
        for (const key of this.localTileRecovery.keys()) {
            if (!visible.has(key)) this.#removeLocalTileRecovery(key);
        }
        for (const key of visible) {
            if (!this.localTileRecovery.has(key)) {
                const record = this.#require(key);
                // A previously staged paired grid must start a fresh observable tile cycle.
                if (record.attached) {
                    this.leafletMap.removeLayer(record.layer);
                    record.attached = false;
                }
                const status = { phase: "loading", total: 0, loaded: 0, failed: 0 };
                const recovery = new TileRecovery(this.leafletMap, this.#require(key).layer, snapshot => {
                    const current = this.localTileRecovery.get(key);
                    if (!current || current.recovery !== recovery) return;
                    current.status = snapshot;
                    this.tileStatus.onLayerStatus(key, snapshot);
                    this.#reportLocalTileStatus();
                });
                this.localTileRecovery.set(key, { recovery, status });
            }
            this.localTileRecovery.get(key).recovery.refresh();
        }
        this.#reportLocalTileStatus();
    }

    /** Combine independent grid counts into the existing on-map status. @return {void} */
    #reportLocalTileStatus() {
        if (!this.showingLocalLayers || !this.tileStatus) return;
        const statuses = [...this.localTileRecovery.values()].map(record => record.status);
        const total = statuses.reduce((sum, status) => sum + status.total, 0);
        const loaded = statuses.reduce((sum, status) => sum + status.loaded, 0);
        const failed = statuses.reduce((sum, status) => sum + status.failed, 0);
        const phase = statuses.length === 0 ? "idle"
            : statuses.some(status => status.phase === "retrying") ? "retrying"
            : statuses.some(status => status.phase === "loading") ? "loading"
            : failed ? "incomplete" : "complete";
        this.tileStatus.onStatus({ phase, total, loaded, failed });
    }

    /**
     * Release one grid's observers and reset its tile warning.
     * @param {string} key Retained layer key.
     * @return {void}
     */
    #removeLocalTileRecovery(key) {
        const record = this.localTileRecovery.get(key);
        if (!record) return;
        record.recovery.destroy();
        this.localTileRecovery.delete(key);
        this.tileStatus.onLayerStatus(key, { phase: "idle", total: 0, loaded: 0, failed: 0 });
    }

    /** Stop independent tile recovery when another presentation takes ownership. @return {void} */
    #clearLocalTileRecovery() {
        this.showingLocalLayers = false;
        for (const key of this.localTileRecovery.keys()) this.#removeLocalTileRecovery(key);
    }

    /**
     * Validate one requested independent-rendering key selection.
     *
     * @param {string[]} selectedKeys Candidate retained keys.
     * @return {Set<string>} Validated unique key selection.
     * @throws {TypeError|RangeError} If the selection is malformed or unknown.
     */
    #validateIndividualRenderingKeys(selectedKeys) {
        if (
            !Array.isArray(selectedKeys) ||
            selectedKeys.length === 0 ||
            selectedKeys.some((key) => typeof key !== "string") ||
            new Set(selectedKeys).size !== selectedKeys.length
        ) {
            throw new TypeError(
                "Individual rendering requires distinct retained layer keys."
            );
        }
        for (const key of selectedKeys) {
            if (!this.layers.has(key)) {
                throw new RangeError(`Unknown retained map layer: ${key}`);
            }
        }
        return new Set(selectedKeys);
    }

    /**
     * Compare a candidate key selection with the current rendering strategy.
     *
     * @param {Set<string>|null} candidate Candidate individual key selection.
     * @return {boolean} Whether the selected keys are unchanged.
     */
    #hasSameIndividualRenderingKeys(candidate) {
        if (candidate === null || this.individualRenderingKeys === null) {
            return candidate === this.individualRenderingKeys;
        }
        return candidate.size === this.individualRenderingKeys.size &&
            [...candidate].every(
                (key) => this.individualRenderingKeys.has(key)
            );
    }

    /**
     * Stage selected source grids and reveal them after every grid loads.
     *
     * @return {void}
     */
    #prepareIndividualRendering() {
        const keys = this.order.filter((key) => {
            const record = this.#require(key);
            return this.individualRenderingKeys.has(key) && record.visible;
        });
        const signature = JSON.stringify(keys);
        if (
            this.pendingIndividualRendering?.signature === signature ||
            this.activeIndividualRenderingSignature === signature
        ) {
            return;
        }
        this.individualRenderingGeneration += 1;
        this.#cancelPendingIndividualRendering();
        const selected = new Set(keys);
        for (const [key, record] of this.layers) {
            if (!selected.has(key) && record.attached) {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
        }
        if (keys.length === 0) {
            this.compositeRenderer.clear();
            this.activeIndividualRenderingSignature = signature;
            return;
        }
        const generation = this.individualRenderingGeneration;
        const pending = {
            failed: new Set(),
            generation,
            keys: selected,
            remaining: new Set(keys),
            retryCount: 0,
            signature,
            listeners: [],
        };
        this.pendingIndividualRendering = pending;
        for (const key of keys) {
            const record = this.#require(key);
            if (!record.attached) {
                record.layer.addTo(this.leafletMap);
                record.attached = true;
            }
            this.#setLayerHidden(record.layer, true);
            const onLoad = () => this.#recordIndividualLayerLoad(
                generation,
                key
            );
            const onError = () => this.#recordIndividualLayerError(
                generation,
                key
            );
            if (
                typeof record.layer.on === "function" &&
                typeof record.layer.off === "function"
            ) {
                record.layer.on("load", onLoad);
                record.layer.on("tileerror", onError);
                pending.listeners.push({ layer: record.layer, onLoad, onError });
            } else {
                record.layer.once?.("load", onLoad);
            }
        }
    }

    /**
     * Record one selected grid load and reveal the complete current selection.
     *
     * @param {number} generation Rendering transition generation.
     * @param {string} key Loaded retained key.
     * @return {void}
     */
    #recordIndividualLayerLoad(generation, key) {
        const pending = this.pendingIndividualRendering;
        if (pending === null || pending.generation !== generation) return;
        pending.remaining.delete(key);
        if (pending.remaining.size > 0) return;
        if (pending.failed.size > 0) {
            if (this.#retryFailedIndividualLayers(pending)) return;
            this.#failIndividualRendering(generation);
            return;
        }
        this.#removePendingIndividualListeners(pending);
        this.pendingIndividualRendering = null;
        this.compositeRenderer.clear();
        for (const selectedKey of pending.keys) {
            const record = this.layers.get(selectedKey);
            if (record?.attached) {
                this.#setLayerHidden(record.layer, false);
            }
        }
        this.activeIndividualRenderingSignature = pending.signature;
    }

    /**
     * Remember that one staged grid had at least one failed tile.
     *
     * The layer-level load event still marks the end of its current tile
     * cycle. Deferring recovery until then prevents one error from removing
     * the pair and canceling every other in-flight tile request.
     *
     * @param {number} generation Rendering transition generation.
     * @param {string} key Retained key whose tile failed.
     * @return {void}
     */
    #recordIndividualLayerError(generation, key) {
        const pending = this.pendingIndividualRendering;
        if (pending === null || pending.generation !== generation) return;
        pending.failed.add(key);
    }

    /**
     * Redraw only failed staged grids within one bounded retry budget.
     *
     * @param {Object} pending Current individual-rendering transition.
     * @return {boolean} Whether a retry was started.
     */
    #retryFailedIndividualLayers(pending) {
        if (
            pending.retryCount >= INDIVIDUAL_RENDERING_TILE_RETRY_LIMIT ||
            [...pending.failed].some((key) => {
                const record = this.layers.get(key);
                return !record?.attached ||
                    typeof record.layer.redraw !== "function";
            })
        ) {
            return false;
        }
        const retryKeys = [...pending.failed];
        pending.failed.clear();
        pending.remaining = new Set(retryKeys);
        pending.retryCount += 1;
        for (const key of retryKeys) {
            this.#require(key).layer.redraw();
        }
        return true;
    }

    /**
     * Keep the existing complete presentation after a selected grid fails.
     *
     * @param {number} generation Rendering transition generation.
     * @return {void}
     */
    #failIndividualRendering(generation) {
        const pending = this.pendingIndividualRendering;
        if (pending === null || pending.generation !== generation) return;
        this.#removePendingIndividualListeners(pending);
        this.pendingIndividualRendering = null;
        for (const key of pending.keys) {
            const record = this.layers.get(key);
            if (record?.attached) {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
        }
        this.activeIndividualRenderingSignature = null;
    }

    /**
     * Cancel an obsolete staged individual rendering without revealing it.
     *
     * @return {void}
     */
    #cancelPendingIndividualRendering() {
        const pending = this.pendingIndividualRendering;
        if (pending === null) return;
        this.#removePendingIndividualListeners(pending);
        for (const key of pending.keys) {
            const record = this.layers.get(key);
            if (record !== undefined) {
                this.#setLayerHidden(record.layer, false);
            }
        }
        this.pendingIndividualRendering = null;
    }

    /**
     * Remove event listeners registered for a staged selected grid set.
     *
     * @param {Object} pending Pending individual-rendering transition.
     * @return {void}
     */
    #removePendingIndividualListeners(pending) {
        for (const { layer, onLoad, onError } of pending.listeners) {
            layer.off("load", onLoad);
            layer.off("tileerror", onError);
        }
        pending.listeners = [];
    }

    /**
     * Hide or reveal one attached Leaflet layer container.
     *
     * @param {Object} layer Leaflet-compatible layer.
     * @param {boolean} hidden Whether the layer must remain visually hidden.
     * @return {void}
     */
    #setLayerHidden(layer, hidden) {
        const container = layer.getContainer?.();
        if (container?.style !== undefined) {
            container.style.visibility = hidden ? "hidden" : "";
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
