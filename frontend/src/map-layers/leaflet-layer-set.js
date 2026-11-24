/** Keyed Leaflet attachment, opacity, and drawing-order adapter. */

import { TileRecovery } from "./tile-recovery.js";
import { revealLoadedRasterFrame } from "./raster-frame.js";

const INDIVIDUAL_RENDERING_TILE_RETRY_LIMIT = 1;

/** Manage keyed source layers and optional server-composed presentation. */
export class LeafletLayerSet {
    /**
     * Create an empty keyed layer set.
     *
     * @param {{removeLayer:(layer:Object)=>void}} leafletMap Leaflet map.
     * @param {{update:(layers:Object[],options?:{keepPreviousFrame:boolean})=>void,clear:()=>void,prepare:(layers:Object[],signal:AbortSignal)=>Promise<void>,previousFrameLayer:(index:number)=>Object|undefined}|null}
     * [compositeRenderer=null] Optional ordinary-map composite renderer.
     * @param {{onStatus:(status:import('./tile-recovery.js').MapTileStatus,displayed:Map<string,string>)=>void,onLayerStatus:(key:string,status:import('./tile-recovery.js').MapTileStatus)=>void}|null}
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
        this.keepCompositeFrameOnNextRender = false;
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
        const record = { layer, attached: false, visible, opacity, previousFrame: null, waitingDescriptor: null };
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
        if (!visible) this.#removePreviousFrame(record);
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
        record.previousFrame?.layer.setOpacity(opacity);
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
            const record = this.#require(key);
            const zIndex = baseZIndex + orderedKeys.length - index;
            record.layer.setZIndex(zIndex);
            record.previousFrame?.layer.setZIndex(zIndex);
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
     * Replace one source layer while preserving its visibility, opacity and order.
     * The controller supplies updated rendering descriptors immediately afterward.
     * @param {string} key Retained map-layer key.
     * @param {Object} layer Replacement Leaflet-compatible layer.
     * @param {{keepPreviousFrame?:boolean,awaitingPublication?:boolean}} [options] Keep the displayed date during publication and until replacement tiles draw.
     * @return {void}
     */
    replace(key, layer, {keepPreviousFrame = false, awaitingPublication = false} = {}) {
        const record = this.#require(key);
        const {visible, opacity} = record;
        const prior = this.rendering.find(candidate => candidate.key === key)?.descriptor;
        const replacingDrawnSource = keepPreviousFrame && visible && opacity > 0 && Boolean(prior);
        this.keepCompositeFrameOnNextRender = replacingDrawnSource;
        if (replacingDrawnSource && awaitingPublication) {
            if (record.previousFrame) {
                this.#cancelPendingIndividualRendering();
                this.#removeLocalTileRecovery(key);
                if (record.attached) this.leafletMap.removeLayer(record.layer);
                record.layer = record.previousFrame.layer;
                record.waitingDescriptor = record.previousFrame.descriptor;
                record.previousFrame = null;
                record.attached = true;
            } else {
                const index = this.#visibleCompositeEntries().findIndex(item => item.key === key);
                const drawn = this.compositeRenderer?.previousFrameLayer?.(index);
                record.waitingDescriptor = drawn ?? prior;
            }
            return;
        }
        const drawn = this.localTileRecovery.get(key)?.status.phase === "complete" ||
            this.activeIndividualRenderingSignature !== null;
        this.#removeLocalTileRecovery(key);
        if (this.pendingIndividualRendering?.keys.has(key)) this.#cancelPendingIndividualRendering();
        if (!replacingDrawnSource) this.#removePreviousFrame(record);
        if (record.attached) {
            if (replacingDrawnSource && drawn && !record.previousFrame) {
                record.previousFrame = {layer: record.layer, descriptor: prior};
            } else {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
            }
        }
        record.layer = layer;
        record.waitingDescriptor = null;
        layer.setOpacity(opacity);
        record.attached = visible && this.compositeRenderer === null;
        if (record.attached) layer.addTo(this.leafletMap);
        this.activeIndividualRenderingSignature = null;
        this.setOrder(this.order);
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
            descriptor: structuredClone(candidate.descriptor ?? this.#require(candidate.key).waitingDescriptor),
        }));
        for (const candidate of this.rendering) {
            const record = this.#require(candidate.key);
            record.visible = candidate.visible;
            record.opacity = candidate.opacity;
        }
        this.setOrder(keys);
        const keepPreviousFrame = this.keepCompositeFrameOnNextRender;
        this.keepCompositeFrameOnNextRender = false;
        this.#applyRenderingStrategy(keepPreviousFrame);
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
        this.#removePreviousFrame(record);
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
        this.keepCompositeFrameOnNextRender = false;
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

    /** Apply the selected map strategy and carry a date handoff into composite rendering.
     * @param {boolean} [keepPreviousFrame] Whether this update replaces one temporal observation.
     * @return {void}
     */
    #applyRenderingStrategy(keepPreviousFrame = false) {
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
            this.#removePreviousFrame(record);
            if (record.attached) {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
        }
        this.compositeRenderer.update(this.#compositeLayers(), {keepPreviousFrame});
    }

    /** Prepare an ordinary composite with one replacement while preserving its neighbors and their drawing order.
     * Independent grids begin loading when selected through their existing display strategy.
     * @param {string} key Retained layer being replaced.
     * @param {Object} descriptor Authorized replacement including its style.
     * @param {AbortSignal} signal Lifetime of the prepared tiles.
     * @return {Promise<void>} Completion when preparation finishes or independent rendering is in use.
     * @throws {Error} If the map plan cannot be prepared.
     */
    async prepareLayer(key, descriptor, signal) {
        if (this.compositeRenderer && !this.showingLocalLayers && this.individualRenderingKeys === null &&
            this.rendering.some(layer => layer.key === key && layer.visible && layer.opacity > 0 && layer.descriptor)) {
            await this.compositeRenderer.prepare(this.#compositeLayers(key, descriptor), signal);
        }
    }

    /** Build the same top-first plan for displayed and upcoming layers.
     * @param {string} [key] Optional key to replace for preloading.
     * @param {Object} [replacement] Authorized descriptor for that key.
     * @return {Object[]} Visible styled descriptors with their current opacity.
     */
    #compositeLayers(key, replacement) {
        return this.#visibleCompositeEntries()
            .map(layer => ({...structuredClone(layer.key === key ? replacement : layer.descriptor), opacity: layer.opacity}));
    }

    /** Match drawn composite publications to their views, including duplicate sources in different rows.
     * @param {string[]} names Drawn publication names in composite drawing order, or empty while no stack has drawn.
     * @return {Map<string,string>} Drawn publication name by retained map-layer key.
     */
    displayedCompositePublications(names) {
        const entries = this.#visibleCompositeEntries();
        return new Map(names.map((name, index) => [entries[index].key, name]));
    }

    /** Return visible, published entries in the order used to build the server composite.
     * @return {{key:string,descriptor:Object,opacity:number}[]} Ordered map entries.
     */
    #visibleCompositeEntries() {
        return this.rendering.filter(layer => layer.visible && layer.opacity > 0 && layer.descriptor !== null);
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
            if (!visible) this.#removePreviousFrame(record);
            if (visible && !record.attached) record.layer.addTo(this.leafletMap);
            if (!visible && record.attached) this.leafletMap.removeLayer(record.layer);
            this.#setLayerHidden(record.layer, Boolean(record.previousFrame));
            record.attached = visible;
        }
    }

    /** Retry failed visible independent tiles without reloading successful ones. @return {void} */
    retryFailedTiles() {
        for (const { recovery } of this.localTileRecovery.values()) recovery.retryFailedTiles();
        if (!this.showingLocalLayers && this.individualRenderingKeys !== null && this.activeIndividualRenderingSignature === null) {
            this.#prepareIndividualRendering();
        }
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
                if (record.attached && !record.waitingDescriptor) {
                    this.leafletMap.removeLayer(record.layer);
                    record.attached = false;
                }
                const status = { phase: "loading", total: 0, loaded: 0, failed: 0 };
                const recovery = new TileRecovery(this.leafletMap, this.#require(key).layer, snapshot => {
                    const current = this.localTileRecovery.get(key);
                    if (!current || current.recovery !== recovery) return;
                    current.status = snapshot;
                    if (snapshot.phase === "complete" && record.previousFrame) this.#revealFrame(record);
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
        const displayed = new Map();
        for (const layer of this.rendering) {
            const current = this.localTileRecovery.get(layer.key);
            if (!current) continue;
            const drawn = current.status.phase === "complete" ? layer.descriptor : this.#require(layer.key).previousFrame?.descriptor;
            if (drawn) displayed.set(layer.key, drawn.layerName);
        }
        this.tileStatus.onStatus({ phase, total, loaded, failed }, displayed);
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
     * Reveal selected source grids after their current tile requests finish.
     * An attached, complete grid needs no new load event when its partner changes.
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
            if (!selected.has(key)) this.#removePreviousFrame(record);
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
        const holdingFrame = keys.some(key => this.#require(key).previousFrame);
        this.tileStatus?.onStatus({phase: "loading", total: 0, loaded: 0, failed: 0},
            holdingFrame ? this.#drawnIndividualPublications(keys) : new Map());
        for (const key of keys) {
            const record = this.#require(key);
            const keepVisible = holdingFrame && record.attached && !record.previousFrame && !record.layer.isLoading();
            if (!record.attached) {
                record.layer.addTo(this.leafletMap);
                record.attached = true;
            }
            this.#setLayerHidden(record.layer, !keepVisible);
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
            if (!record.layer.isLoading()) onLoad();
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
                this.#revealFrame(record);
            }
        }
        this.activeIndividualRenderingSignature = pending.signature;
        const displayed = this.#drawnIndividualPublications(pending.keys);
        this.tileStatus?.onStatus({phase: "complete", total: 0, loaded: 0, failed: 0}, displayed);
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
        const holdingFrame = [...pending.keys].some(key => this.#require(key).previousFrame);
        for (const key of pending.keys) {
            const record = this.layers.get(key);
            if (record?.attached && (!holdingFrame || record.previousFrame)) {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
        }
        this.activeIndividualRenderingSignature = null;
        this.tileStatus?.onStatus({phase: "error", total: 0, loaded: 0, failed: 0,
            message: "The selected map layers could not be drawn."}, holdingFrame ? this.#drawnIndividualPublications(pending.keys) : new Map());
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
                this.#setLayerHidden(record.layer, Boolean(record.previousFrame));
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

    /** Return the publications still visible as a paired frame loads or fails.
     * @param {Iterable<string>} keys Selected independent grids.
     * @return {Map<string,string>} Drawn publication by selected layer key.
     */
    #drawnIndividualPublications(keys) {
        const displayed = new Map();
        for (const key of keys) {
            const record = this.#require(key);
            const drawn = record.previousFrame?.descriptor ??
                (record.attached && !record.layer.isLoading() ? this.rendering.find(item => item.key === key)?.descriptor : null);
            if (drawn) displayed.set(key, drawn.layerName);
        }
        return displayed;
    }

    /** Reveal a complete independent grid at its configured opacity and retire its previous date.
     * @param {Object} record Retained layer and optional previous frame.
     * @return {void}
     */
    #revealFrame(record) {
        if (record.previousFrame) revealLoadedRasterFrame(record.layer);
        else this.#setLayerHidden(record.layer, false);
        this.#removePreviousFrame(record);
    }

    /** Detach an observation held on screen during publication or tile loading.
     * @param {Object} record Retained layer whose previous date can be released.
     * @return {void}
     */
    #removePreviousFrame(record) {
        if (!record.previousFrame) return;
        this.leafletMap.removeLayer(record.previousFrame.layer);
        record.previousFrame = null;
    }

    /**
     * Require one retained record.
     *
     * @param {string} key Stable map-layer key.
     * @return {{layer:Object,attached:boolean,visible:boolean,opacity:number,previousFrame:{layer:Object,descriptor:Object}|null,waitingDescriptor:Object|null}} Retained record.
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
