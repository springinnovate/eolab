/** Keyed Leaflet attachment, opacity, and drawing-order adapter. */

import { TileRecovery } from "./tile-recovery.js";
import { revealLoadedRasterFrame } from "./raster-frame.js";

/** @typedef {import("./raster-frame.js").MapFrame} MapFrame */

const INDIVIDUAL_RENDERING_TILE_RETRY_LIMIT = 1;

/** Manage keyed source layers and optional server-composed presentation. */
export class LeafletLayerSet {
    /**
     * Create an empty keyed layer set.
     *
     * @param {{removeLayer:(layer:Object)=>void}} leafletMap Leaflet map.
     * @param {{update:(layers:Object[],options?:{keepPreviousFrame:boolean,views:Map<string,MapFrame>})=>void,clear:()=>void,prepare:(layers:Object[],signal:AbortSignal)=>Promise<void>,drawnView:(key:string)=>MapFrame|undefined}|null}
     * [compositeRenderer=null] Optional ordinary-map composite renderer.
     * @param {{onStatus:(status:import('./tile-recovery.js').MapTileStatus,displayed:Map<string,MapFrame>)=>void,onLayerStatus:(key:string,status:import('./tile-recovery.js').MapTileStatus)=>void}|null}
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
        const record = { layer, attached: false, visible, opacity, frame: null, drawnFrame: null };
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
        if (!visible) this.#removeDrawnFrame(record);
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
        this.#heldFrame(record)?.layer.setOpacity(opacity);
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
            this.#heldFrame(record)?.layer.setZIndex(zIndex);
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
     * @return {boolean} Whether this change can retain a frame in the current map.
     */
    replace(key, layer, {keepPreviousFrame = false, awaitingPublication = false} = {}) {
        const record = this.#require(key);
        const retain = Boolean(keepPreviousFrame && record.visible && record.opacity > 0 && record.frame);
        if (retain && !record.drawnFrame && this.localTileRecovery.get(record.layer)?.status.loaded > 0) {
            record.drawnFrame = record.frame;
        }
        const drawn = record.drawnFrame ?? this.compositeRenderer?.drawnView?.(key) ?? record.frame;
        if (retain && awaitingPublication && record.layer === drawn.layer) return true;
        if (this.pendingIndividualRendering?.keys.has(key)) this.#cancelPendingIndividualRendering();
        const keepAttached = retain && record.drawnFrame?.layer === record.layer;
        if (record.attached && !keepAttached) {
            this.#removeLocalTileRecovery(record.layer);
            this.leafletMap.removeLayer(record.layer);
        }
        if (!retain) this.#removeDrawnFrame(record);
        if (retain && awaitingPublication) {
            record.frame = drawn;
            record.layer = drawn.layer;
            record.attached = record.drawnFrame?.layer === drawn.layer;
        } else {
            record.frame = null;
            record.layer = layer;
            layer.setOpacity(record.opacity);
            record.attached = record.visible && this.compositeRenderer === null;
            if (record.attached) layer.addTo(this.leafletMap);
        }
        this.activeIndividualRenderingSignature = null;
        this.setOrder(this.order);
        return retain;
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
     * @param {Array<{key:string,visible:boolean,opacity:number,descriptor:Object|null,observation?:{variable:string,time:string}|null}>}
     * rendering Complete retained-layer rendering state.
     * @param {{keepPreviousFrame?:boolean}} [options] Whether this render follows a same-variable date replacement.
     * @return {void}
     * @throws {Error} If keys do not match the retained layer set.
     */
    render(rendering, {keepPreviousFrame = false} = {}) {
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
        this.rendering = rendering.map(candidate => {
            const record = this.#require(candidate.key);
            record.visible = candidate.visible;
            record.opacity = candidate.opacity;
            if (candidate.descriptor !== null) {
                record.frame = {layer: record.layer, descriptor: structuredClone(candidate.descriptor),
                    observation: candidate.observation ?? null};
                if (record.drawnFrame?.layer === record.layer) record.drawnFrame = record.frame;
            }
            return {...candidate, descriptor: record.frame?.descriptor ?? null};
        });
        this.setOrder(keys);
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
        this.#removeDrawnFrame(record);
        this.#removeLocalTileRecovery(record.layer);
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
            this.#removeDrawnFrame(record);
            if (record.attached) {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
        }
        const views = new Map(this.#visibleCompositeEntries().map(({key}) => [key, this.#require(key).frame]));
        this.compositeRenderer.update(this.#compositeLayers(), {keepPreviousFrame, views});
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
        if (!this.showingLocalLayers) this.compositeRenderer.clear();
        this.showingLocalLayers = true;
        this.#watchLocalTiles();
        for (const candidate of this.rendering) {
            const record = this.#require(candidate.key);
            const visible = candidate.visible && (candidate.descriptor === null ||
                this.individualRenderingKeys === null || this.individualRenderingKeys.has(candidate.key));
            if (!visible) this.#removeDrawnFrame(record);
            if (visible && !record.attached) record.layer.addTo(this.leafletMap);
            if (!visible && record.attached) this.leafletMap.removeLayer(record.layer);
            this.#setLayerHidden(record.layer, Boolean(this.#heldFrame(record)));
            record.attached = visible;
        }
    }

    /** Retry failed visible independent tiles without reloading successful ones. @return {void} */
    retryFailedTiles() {
        for (const [layer, {key, recovery}] of this.localTileRecovery) {
            if (this.#require(key).layer === layer) recovery.retryFailedTiles();
        }
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
        return this.localTileRecovery.has(this.layers.get(key)?.layer);
    }

    /** Observe only visible catalog grids; annotations have no server tiles. @return {void} */
    #watchLocalTiles() {
        if (!this.tileStatus) return;
        const watched = new Set();
        for (const {key, descriptor, visible} of this.rendering) {
            if (!visible || !descriptor || (this.individualRenderingKeys && !this.individualRenderingKeys.has(key))) continue;
            const record = this.#require(key), layer = record.layer;
            watched.add(layer);
            if (record.drawnFrame) watched.add(record.drawnFrame.layer);
            if (!this.localTileRecovery.has(layer)) {
                // A grid arriving from paired mode needs an observable tile cycle.
                if (record.attached) {
                    this.leafletMap.removeLayer(layer);
                    record.attached = false;
                    if (record.drawnFrame?.layer === layer) record.drawnFrame = null;
                }
                const watch = {key, status: {phase: "loading", total: 0, loaded: 0, failed: 0}};
                watch.recovery = new TileRecovery(this.leafletMap, layer, status => {
                    watch.status = status;
                    if (record.layer === layer) {
                        if (status.phase === "complete" && (status.loaded || this.#heldFrame(record))) this.#revealFrame(record);
                        this.tileStatus.onLayerStatus(key, status);
                    }
                    this.#reportLocalTileStatus();
                });
                this.localTileRecovery.set(layer, watch);
            }
            this.localTileRecovery.get(layer).recovery.refresh();
        }
        for (const layer of this.localTileRecovery.keys()) {
            if (!watched.has(layer)) this.#removeLocalTileRecovery(layer);
        }
        this.#reportLocalTileStatus();
    }

    /** Combine independent grid counts into the existing on-map status. @return {void} */
    #reportLocalTileStatus() {
        if (!this.showingLocalLayers || !this.tileStatus) return;
        const statuses = [...this.localTileRecovery].filter(([layer, watch]) => this.layers.get(watch.key)?.layer === layer)
            .map(([, watch]) => watch.status);
        const total = statuses.reduce((sum, status) => sum + status.total, 0);
        const loaded = statuses.reduce((sum, status) => sum + status.loaded, 0);
        const failed = statuses.reduce((sum, status) => sum + status.failed, 0);
        const phase = statuses.length === 0 ? "idle"
            : statuses.some(status => status.phase === "retrying") ? "retrying"
            : statuses.some(status => status.phase === "loading") ? "loading"
            : failed ? "incomplete" : "complete";
        const displayed = new Map();
        for (const {key} of this.rendering) {
            const frame = this.#require(key).drawnFrame;
            if (frame && this.localTileRecovery.get(frame.layer)?.status.loaded > 0) displayed.set(key, frame);
        }
        this.tileStatus.onStatus({ phase, total, loaded, failed }, displayed);
    }

    /** Release tile observations when a grid leaves the map.
     * @param {Object} layer Source grid being detached.
     * @return {void}
     */
    #removeLocalTileRecovery(layer) {
        const watch = this.localTileRecovery.get(layer);
        if (!watch) return;
        watch.recovery.destroy();
        this.localTileRecovery.delete(layer);
        if (this.layers.get(watch.key)?.layer === layer) {
            this.tileStatus.onLayerStatus(watch.key, {phase: "idle", total: 0, loaded: 0, failed: 0});
        }
    }

    /** Stop independent tile recovery when another presentation takes ownership. @return {void} */
    #clearLocalTileRecovery() {
        this.showingLocalLayers = false;
        for (const layer of this.localTileRecovery.keys()) this.#removeLocalTileRecovery(layer);
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
            if (!selected.has(key)) this.#removeDrawnFrame(record);
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
        const holdingFrame = keys.some(key => this.#heldFrame(this.#require(key)));
        this.tileStatus?.onStatus({phase: "loading", total: 0, loaded: 0, failed: 0},
            holdingFrame ? this.#drawnIndividualFrames(keys) : new Map());
        for (const key of keys) {
            const record = this.#require(key);
            const keepVisible = holdingFrame && record.drawnFrame?.layer === record.layer;
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
        const displayed = this.#drawnIndividualFrames(pending.keys);
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
        const holdingFrame = [...pending.keys].some(key => this.#heldFrame(this.#require(key)));
        for (const key of pending.keys) {
            const record = this.layers.get(key);
            if (record?.attached && (!holdingFrame || this.#heldFrame(record))) {
                this.#setLayerHidden(record.layer, false);
                this.leafletMap.removeLayer(record.layer);
                record.attached = false;
            }
        }
        this.activeIndividualRenderingSignature = null;
        this.tileStatus?.onStatus({phase: "error", total: 0, loaded: 0, failed: 0,
            message: "The selected map layers could not be drawn."}, holdingFrame ? this.#drawnIndividualFrames(pending.keys) : new Map());
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
                this.#setLayerHidden(record.layer, Boolean(this.#heldFrame(record)));
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

    /** Return the source frames currently visible in a paired presentation.
     * @param {Iterable<string>} keys Selected independent grids.
     * @return {Map<string,MapFrame>} Drawn frame by view key.
     */
    #drawnIndividualFrames(keys) {
        const displayed = new Map();
        for (const key of keys) {
            const frame = this.#require(key).drawnFrame;
            if (frame) displayed.set(key, frame);
        }
        return displayed;
    }

    /** Identify an old independent grid kept visible behind its replacement.
     * @param {Object} record Retained layer record.
     * @return {MapFrame|null} The attached previous frame, if it differs from the selected source.
     */
    #heldFrame(record) {
        return record.drawnFrame?.layer === record.layer ? null : record.drawnFrame;
    }

    /** Reveal a ready independent grid and retire the previous observation.
     * @param {Object} record Retained layer record.
     * @return {void}
     */
    #revealFrame(record) {
        const previous = this.#heldFrame(record);
        if (previous) {
            revealLoadedRasterFrame(record.layer, previous.layer);
            this.#removeDrawnFrame(record);
        } else this.#setLayerHidden(record.layer, false);
        record.drawnFrame = record.frame;
    }

    /** Release the displayed frame, detaching it if the row also has an incoming grid.
     * @param {Object} record Retained layer record.
     * @return {void}
     */
    #removeDrawnFrame(record) {
        const held = this.#heldFrame(record);
        if (held) {
            this.#removeLocalTileRecovery(held.layer);
            this.leafletMap.removeLayer(held.layer);
        }
        record.drawnFrame = null;
    }

    /**
     * Require one retained record.
     *
     * @param {string} key Stable map-layer key.
     * @return {{layer:Object,attached:boolean,visible:boolean,opacity:number,frame:MapFrame|null,drawnFrame:MapFrame|null}} Retained record.
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
