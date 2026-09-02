/** Neutral retained map-layer publication and presentation lifecycle. */

import { getCatalogItemKey } from "../catalog-item-identity.js";
import { LeafletLayerSet } from "./leaflet-layer-set.js";
import { MapLayerStack } from "./layer-stack.js";
import { MapLayerStackView } from "./layer-stack-view.js";

/**
 * @typedef {Object} MapLayerAdapter
 * @property {(item:Object)=>string} label Return a readable layer label.
 * @property {(item:Object)=>Promise<Object>} publish Publish one Catalog Item.
 * @property {(context:Object)=>Object} createState Create adapter-owned state.
 * @property {(record:Object,onTileError:()=>void)=>Object} createLayer Create a
 * Leaflet-compatible layer for one publication.
 * @property {(record:Object)=>Object} snapshot Return presentation-ready legend,
 * optional role badge, and other feature-owned snapshot fields.
 * @property {(record:Object)=>Object} [exportSavedState] Return validated,
 * portable owner-specific style state.
 * @property {(record:Object,savedState:Object)=>Promise<void>|void}
 * [applySavedState] Validate and apply portable owner-specific style state.
 * @property {(record:Object,savedState:Object)=>string|null}
 * [checkSavedStateCompatibility] Return null when a copied portable style can
 * be applied to the record, otherwise a user-facing incompatibility reason.
 * @property {(record:Object)=>void} [prepare] Prepare an existing record before
 * activation.
 * @property {(record:Object,next:Object)=>void} [deactivate] Release this
 * adapter's active session before a different owner becomes active.
 * @property {(record:Object)=>void} [activate] Load adapter-owned active state.
 * @property {(record:Object,removal:Object)=>Object|undefined} [beforeRemove]
 * Prepare adapter state before removal and optionally disable fallback
 * activation.
 * @property {(record:Object,removal:Object)=>void} [removed] Observe completed
 * removal.
 * @property {(record:Object,boolean)=>void} [visibilityChanged] Observe
 * visibility after the neutral transition.
 * @property {(record:Object,number)=>void} [opacityChanged] Observe opacity.
 * @property {(record:Object)=>void} [orderChanged] Observe completed stack
 * movement when feature-owned presentation depends on drawing order.
 * @property {(record:Object)=>void} [added] Observe successful layer creation.
 * @property {(record:Object)=>void} [tileError] Observe an owned tile failure.
 * @property {string} tileErrorMessage Browser-safe tile failure message.
 */

/** Own retained layers without knowing any dataset-specific controls. */
export class MapLayerController {
    /**
     * Create the neutral controller.
     *
     * @param {Object} configuration Controller collaborators.
     * @param {Object} configuration.leafletMap Leaflet-compatible map.
     * @param {MapLayerStackView} [configuration.view] Layer-list DOM adapter.
     * @param {(layers:Object[])=>void} [configuration.onLayersChange]
     * Presentation change observer.
     * @param {(item:Object)=>void} [configuration.onItemZoom] Requests that a
     * higher-level consumer fit the map to one authoritative Catalog Item.
     * @param {(item:Object)=>void} [configuration.onItemInfo] Requests that a
     * higher-level consumer present one authoritative Catalog Item's details.
     * @param {MapLayerStack} [configuration.stack] Pure retained-layer state.
     * @param {LeafletLayerSet} [configuration.leafletLayers] Keyed Leaflet set.
     */
    constructor({
        leafletMap,
        view = new MapLayerStackView(),
        onLayersChange = () => {},
        onItemZoom = () => {},
        onItemInfo = () => {},
        stack = new MapLayerStack(),
        leafletLayers = new LeafletLayerSet(leafletMap),
    }) {
        if (
            typeof onItemZoom !== "function" ||
            typeof onItemInfo !== "function"
        ) {
            throw new TypeError(
                "Map-layer Item navigation callbacks must be callable"
            );
        }
        this.view = view;
        this.onLayersChange = onLayersChange;
        this.onItemZoom = onItemZoom;
        this.onItemInfo = onItemInfo;
        this.stack = stack;
        this.leafletLayers = leafletLayers;
        this.records = new Map();
        this.publicationGenerations = new Map();
        this.pendingPublications = new Map();
        this.pendingAdapters = new Map();
        this.styleClipboard = null;
        this.pendingStylePastes = new Set();
        this.activationIntentSequence = 0;
        this.presentationActiveKey = null;
        this.destroyed = false;
        this.view.bind({
            onStyle: (key) => this.onStyle?.(key),
            onZoom: (key) =>
                this.onItemZoom(this.#requireRecord(key).entry.item),
            onInfo: (key) =>
                this.onItemInfo(this.#requireRecord(key).entry.item),
            onCopyStyle: (key) => this.copyStyle(key),
            onPasteStyle: (key) => void this.pasteStyle(key),
            onVisibility: (key, visible) => this.setVisible(key, visible),
            onReorder: (key, targetIndex) => this.reorder(key, targetIndex),
            onRemove: (key) => this.removeKey(key),
        });
        this.render();
    }

    /**
     * Publish, retain, and activate one Catalog layer through its owner.
     *
     * @param {Object} item Supported Catalog Item.
     * @param {MapLayerAdapter} adapter Feature-owned map-layer adapter.
     * @return {Promise<Object|null>} Publication or null after invalidation.
     * @throws {Error} If publication or Leaflet construction fails.
     */
    async show(item, adapter) {
        this.#requireAdapter(adapter);
        const key = getCatalogItemKey(item);
        const showRequestSequence = this.recordIntent();
        const retainedRecord = this.records.get(key);
        if (retainedRecord !== undefined) {
            retainedRecord.adapter.prepare?.(retainedRecord);
            this.activate(key);
            this.view.setStatus(`${retainedRecord.entry.label} selected.`);
            return retainedRecord.publication;
        }
        const pendingPublication = this.pendingPublications.get(key);
        if (pendingPublication !== undefined) {
            const publication = await pendingPublication;
            if (
                publication !== null &&
                showRequestSequence === this.activationIntentSequence &&
                this.records.has(key)
            ) {
                this.activate(key);
            }
            return publication;
        }
        const generation = (this.publicationGenerations.get(key) ?? 0) + 1;
        this.publicationGenerations.set(key, generation);
        const publicationRequest = this.#publish(
            item,
            adapter,
            key,
            generation,
            showRequestSequence
        );
        this.pendingPublications.set(key, publicationRequest);
        this.pendingAdapters.set(key, adapter);
        try {
            return await publicationRequest;
        } finally {
            if (this.pendingPublications.get(key) === publicationRequest) {
                this.pendingPublications.delete(key);
                this.pendingAdapters.delete(key);
            }
        }
    }

    /**
     * Record a user intent that outranks older asynchronous publications.
     *
     * @return {number} New monotonic activation-intent sequence.
     */
    recordIntent() {
        this.activationIntentSequence += 1;
        return this.activationIntentSequence;
    }

    /**
     * Activate one retained record and notify its owning adapter.
     *
     * @param {string} key Stable retained-layer key.
     * @param {{key:string,action:string}|null} [requestedFocus=null] Focus hint.
     * @return {Object} Activated record.
     */
    activate(key, requestedFocus = null) {
        this.recordIntent();
        return this.#activate(key, requestedFocus);
    }

    /**
     * Present no retained layer as active while preserving the stack.
     *
     * Feature-owned detached analysis may use this without transferring
     * retained lifecycle ownership back into a feature controller.
     *
     * @return {void}
     */
    deactivatePresentation() {
        this.presentationActiveKey = null;
        this.render();
    }

    /**
     * Return one retained feature record.
     *
     * @param {string} key Stable map-layer key.
     * @return {Object|null} Retained record or null.
     */
    getRecord(key) {
        return this.records.get(key) ?? null;
    }

    /**
     * Return one retained Leaflet layer.
     *
     * @param {string} key Stable map-layer key.
     * @return {Object|null} Retained layer or null.
     */
    getLeafletLayer(key) {
        return this.leafletLayers.get(key);
    }

    /**
     * Return whether one layer is attached to the map.
     *
     * @param {string} key Stable map-layer key.
     * @return {boolean} Whether the layer is visible on the map.
     */
    isAttached(key) {
        return this.leafletLayers.isAttached(key);
    }

    /**
     * Return whether one Catalog Item is retained.
     *
     * @param {Object} item Catalog Item.
     * @return {boolean} Whether its composite identity is retained.
     */
    contains(item) {
        return this.stack.hasItem(item);
    }

    /**
     * Set one retained layer's visibility.
     *
     * @param {string} key Stable map-layer key.
     * @param {boolean} visible Requested visibility.
     * @return {void}
     */
    setVisible(key, visible) {
        const entry = this.stack.setVisible(key, visible);
        this.leafletLayers.setVisible(key, visible);
        const record = this.#requireRecord(key);
        record.adapter.visibilityChanged?.(record, visible);
        this.view.setStatus(
            `${entry.label} is now ${visible ? "visible" : "hidden"}.`
        );
        this.render({ key, action: "visibility" });
    }

    /**
     * Set one retained layer's opacity.
     *
     * @param {string} key Stable map-layer key.
     * @param {number} opacity Finite opacity from zero through one.
     * @return {void}
     */
    setOpacity(key, opacity) {
        const entry = this.stack.setOpacity(key, opacity);
        this.leafletLayers.setOpacity(key, opacity);
        const record = this.#requireRecord(key);
        record.adapter.opacityChanged?.(record, opacity);
        this.onLayersChange(this.snapshots());
        this.view.setStatus(
            `${entry.label} opacity is ${Math.round(opacity * 100)} percent.`
        );
    }

    /**
     * Copy one adapter-owned portable style and neutral layer opacity.
     *
     * The clipboard is intentionally local to this controller instance. It
     * preserves a detached style value after its source layer is removed and
     * does not include visibility, order, or feature-owned interaction state.
     *
     * @param {string} key Stable retained-layer key.
     * @return {boolean} Whether a style was copied.
     */
    copyStyle(key) {
        const record = this.#requireRecord(key);
        if (typeof record.adapter.exportSavedState !== "function") {
            this.view.setStatus(
                `${record.entry.label} does not support copying styles.`
            );
            return false;
        }
        try {
            const savedState = structuredClone(
                record.adapter.exportSavedState(record)
            );
            if (
                savedState === null || typeof savedState !== "object" ||
                typeof savedState.kind !== "string" ||
                savedState.kind.length === 0
            ) {
                throw new TypeError("The layer returned an invalid style.");
            }
            this.styleClipboard = Object.freeze({
                sourceKey: key,
                sourceLabel: record.entry.label,
                opacity: record.entry.opacity,
                savedState,
            });
            this.view.setStatus(
                `Style and opacity copied from ${record.entry.label}.`
            );
            this.render({ key, action: "copy-style" });
            return true;
        } catch (error) {
            this.view.setStatus(
                `Could not copy the style from ${record.entry.label}: ` +
                `${asErrorMessage(error)}`
            );
            return false;
        }
    }

    /**
     * Apply the copied adapter-owned style and neutral opacity to one layer.
     *
     * Adapter validation occurs before neutral opacity changes, so rejected
     * portable styles leave the target opacity untouched. Rendering and
     * observer notification remain within the retained-layer lifecycle.
     *
     * @param {string} key Stable retained-layer key.
     * @return {Promise<boolean>} Whether the complete appearance was applied.
     */
    async pasteStyle(key) {
        const record = this.#requireRecord(key);
        const availability = this.#styleClipboardSnapshot(record);
        if (!availability.canPaste) {
            this.view.setStatus(availability.pasteReason);
            return false;
        }
        const clipboard = this.styleClipboard;
        this.pendingStylePastes.add(key);
        this.render({ key, action: "paste-style" });
        try {
            await record.adapter.applySavedState(
                record,
                structuredClone(clipboard.savedState)
            );
            if (this.records.get(key) !== record) {
                return false;
            }
            this.setOpacity(key, clipboard.opacity);
            this.view.setStatus(
                `Style and opacity from ${clipboard.sourceLabel} pasted onto ` +
                `${record.entry.label}.`
            );
            return true;
        } catch (error) {
            this.view.setStatus(
                `Could not paste the style from ${clipboard.sourceLabel} ` +
                `onto ${record.entry.label}: ${asErrorMessage(error)}`
            );
            return false;
        } finally {
            this.pendingStylePastes.delete(key);
            if (this.records.get(key) === record) {
                this.render({ key, action: "paste-style" });
            }
        }
    }

    /**
     * Move one retained layer atomically to a top-first drawing-order index.
     *
     * @param {string} key Stable retained-layer key.
     * @param {number} targetIndex Zero-based top-first destination.
     * @return {void}
     */
    reorder(key, targetIndex) {
        if (!this.stack.moveTo(key, targetIndex)) return;
        this.#applyLeafletOrder();
        const record = this.#requireRecord(key);
        record.adapter.orderChanged?.(record);
        this.view.setStatus(
            `${record.entry.label} moved to position ${targetIndex + 1} of ` +
            `${this.stack.entries.length} in the map drawing order.`
        );
        this.render({ key, action: "reorder" });
    }

    /**
     * Remove one Catalog Item from the retained stack.
     *
     * @param {Object} item Catalog Item.
     * @return {void}
     */
    remove(item) {
        this.recordIntent();
        const key = getCatalogItemKey(item);
        this.#invalidatePublication(key);
        if (this.records.has(key)) {
            this.removeKey(key);
        }
    }

    /**
     * Remove every retained and pending layer owned by one adapter.
     *
     * @param {MapLayerAdapter} adapter Owning feature adapter.
     * @return {void}
     */
    removeOwned(adapter) {
        this.recordIntent();
        for (const [key, pendingAdapter] of this.pendingAdapters) {
            if (pendingAdapter === adapter) {
                this.#invalidatePublication(key);
            }
        }
        const ownedKeys = this.stack.entries
            .filter((entry) => this.#requireRecord(entry.key).adapter === adapter)
            .map((entry) => entry.key);
        for (const key of ownedKeys) {
            if (this.records.has(key)) {
                this.removeKey(key);
            }
        }
        if (this.stack.entries.length === 0) {
            this.view.setStatus("");
            this.render();
        }
    }

    /**
     * Remove one retained layer by stable key.
     *
     * @param {string} key Stable map-layer key.
     * @return {void}
     */
    removeKey(key) {
        this.recordIntent();
        this.#invalidatePublication(key);
        const record = this.#requireRecord(key);
        const removedIndex = this.stack.entries.findIndex(
            (candidate) => candidate.key === key
        );
        const wasActive = this.presentationActiveKey === key;
        const removal = record.adapter.beforeRemove?.(record, { wasActive }) ?? {};
        const { removed, activeKey } = this.stack.remove(key);
        this.leafletLayers.remove(key);
        this.records.delete(key);
        record.adapter.removed?.(record, { wasActive });
        if (this.stack.entries.length > 0) {
            this.#applyLeafletOrder();
        }
        const focusKey =
            this.stack.entries[removedIndex]?.key ??
            this.stack.entries[removedIndex - 1]?.key ??
            null;
        if (wasActive && activeKey !== null && removal.activateFallback !== false) {
            this.#activate(activeKey, { key: activeKey, action: "style" });
        } else {
            if (wasActive) {
                this.presentationActiveKey = null;
            }
            this.render(
                focusKey === null ? null : { key: focusKey, action: "style" }
            );
        }
        this.view.setStatus(`${removed.label} was removed from map layers.`);
    }

    /**
     * Remove every retained and pending layer.
     *
     * @return {void}
     */
    clear() {
        this.recordIntent();
        for (const key of this.pendingPublications.keys()) {
            this.#invalidatePublication(key);
        }
        this.leafletLayers.clear();
        this.stack.clear();
        this.records.clear();
        this.presentationActiveKey = null;
        this.view.setStatus("");
        this.render();
    }

    /**
     * Build presentation-ready snapshots for the layer-list view.
     *
     * @return {Object[]} Retained layers in top-first order.
     */
    snapshots() {
        return this.stack.entries.map((entry) => {
            const record = this.#requireRecord(entry.key);
            return {
                ...entry,
                ...record.adapter.snapshot(record),
                styleClipboard: this.#styleClipboardSnapshot(record),
                error: record.error,
            };
        });
    }

    /**
     * Render and publish current retained-layer state.
     *
     * @param {{key:string,action:string}|null} [requestedFocus=null] Focus hint.
     * @return {void}
     */
    render(requestedFocus = null) {
        const layers = this.snapshots();
        this.view.render(layers, this.presentationActiveKey, requestedFocus);
        this.onLayersChange(layers);
    }

    /**
     * Permanently detach the controller and remove every retained layer.
     *
     * @return {void}
     */
    destroy() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.clear();
        this.styleClipboard = null;
        this.pendingStylePastes.clear();
        this.view.unbind();
    }

    /** @return {number} Number of map-attached retained layers. */
    get visibleCount() {
        return this.stack.visibleCount;
    }

    /**
     * Count visible retained layers owned by one adapter.
     *
     * @param {MapLayerAdapter} adapter Owning dataset adapter.
     * @return {number} Visible owned-layer count.
     */
    visibleCountFor(adapter) {
        return this.stack.entries.filter(
            (entry) =>
                entry.visible &&
                this.#requireRecord(entry.key).adapter === adapter
        ).length;
    }

    /** @return {string|null} Stack-selected retained-layer key. */
    get activeKey() {
        return this.stack.activeKey;
    }

    /** @return {Object[]} Retained records in top-first order. */
    get retainedRecords() {
        return this.stack.entries.map((entry) => this.#requireRecord(entry.key));
    }

    /**
     * Publish and create one new record under concurrency controls.
     *
     * @param {Object} item Catalog Item.
     * @param {MapLayerAdapter} adapter Owning dataset adapter.
     * @param {string} key Stable layer key.
     * @param {number} generation Publication generation.
     * @param {number} showRequestSequence Activation intent sequence.
     * @return {Promise<Object|null>} Publication or null after invalidation.
     */
    async #publish(item, adapter, key, generation, showRequestSequence) {
        const publication = await adapter.publish(item);
        if (
            this.destroyed ||
            this.publicationGenerations.get(key) !== generation
        ) {
            return null;
        }
        const label = adapter.label(item);
        const previousActiveKey = this.stack.activeKey;
        const { entry } = this.stack.add(item, label, showRequestSequence);
        const shouldActivate =
            showRequestSequence === this.activationIntentSequence;
        if (!shouldActivate && previousActiveKey !== null) {
            this.stack.activate(previousActiveKey);
        }
        const record = {
            entry,
            adapter,
            publication,
            state: null,
            error: null,
        };
        record.state = adapter.createState({ entry, publication, item });
        this.records.set(key, record);
        try {
            const layer = adapter.createLayer(record, () => {
                if (this.leafletLayers.get(key) !== layer) {
                    return;
                }
                record.error = adapter.tileErrorMessage;
                this.render();
                adapter.tileError?.(record);
            });
            this.leafletLayers.add(key, layer, entry);
            this.#applyLeafletOrder();
            adapter.added?.(record);
            if (shouldActivate) {
                this.#activate(key);
            } else {
                this.render();
            }
        } catch (error) {
            this.leafletLayers.remove(key);
            this.records.delete(key);
            this.stack.remove(key);
            if (
                previousActiveKey !== null &&
                this.stack.get(previousActiveKey) !== null
            ) {
                this.#activate(previousActiveKey);
            } else {
                this.render();
            }
            throw error;
        }
        this.view.announceStatus(`${label} was added and is visible.`);
        this.render();
        return publication;
    }

    /**
     * Activate without creating a second user-intent sequence.
     *
     * @param {string} key Stable layer key.
     * @param {{key:string,action:string}|null} [requestedFocus=null] Focus hint.
     * @return {Object} Activated record.
     */
    #activate(key, requestedFocus = null) {
        const record = this.#requireRecord(key);
        const previousRecord = this.presentationActiveKey === null
            ? null
            : this.records.get(this.presentationActiveKey) ?? null;
        if (
            previousRecord !== null &&
            previousRecord.entry.key !== record.entry.key
        ) {
            previousRecord.adapter.deactivate?.(previousRecord, record);
        }
        this.stack.activate(key);
        this.presentationActiveKey = key;
        record.adapter.activate?.(record);
        this.render(requestedFocus);
        return record;
    }

    /** Apply stack order to every retained Leaflet layer. */
    #applyLeafletOrder() {
        this.leafletLayers.setOrder(
            this.stack.entries.map((entry) => entry.key)
        );
    }

    /**
     * Invalidate pending publication work for one key.
     *
     * @param {string} key Stable layer key.
     */
    #invalidatePublication(key) {
        this.publicationGenerations.set(
            key,
            (this.publicationGenerations.get(key) ?? 0) + 1
        );
        this.pendingPublications.delete(key);
        this.pendingAdapters.delete(key);
    }

    /**
     * Require one retained record.
     *
     * @param {string} key Stable layer key.
     * @return {Object} Retained record.
     * @throws {RangeError} If the key is unknown.
     */
    #requireRecord(key) {
        const record = this.records.get(key);
        if (record === undefined) {
            throw new RangeError(`Unknown retained map layer: ${key}`);
        }
        return record;
    }

    /**
     * Build neutral copy/paste presentation state for one retained record.
     *
     * Dataset-specific compatibility remains delegated to the target adapter.
     * The controller handles only clipboard presence, pending lifecycle, and
     * the shared portable-style protocol.
     *
     * @param {Object} record Retained map-layer record.
     * @return {{canCopy:boolean,canPaste:boolean,sourceLabel:string|null,
     * pasteReason:string}} Presentation-ready clipboard availability.
     */
    #styleClipboardSnapshot(record) {
        const canCopy = typeof record.adapter.exportSavedState === "function";
        const sourceLabel = this.styleClipboard?.sourceLabel ?? null;
        if (this.styleClipboard === null) {
            return Object.freeze({
                canCopy,
                canPaste: false,
                sourceLabel,
                pasteReason: "Copy a layer style before pasting.",
            });
        }
        if (this.pendingStylePastes.has(record.entry.key)) {
            return Object.freeze({
                canCopy,
                canPaste: false,
                sourceLabel,
                pasteReason: `Pasting the style from ${sourceLabel}.`,
            });
        }
        if (
            typeof record.adapter.applySavedState !== "function" ||
            typeof record.adapter.checkSavedStateCompatibility !== "function"
        ) {
            return Object.freeze({
                canCopy,
                canPaste: false,
                sourceLabel,
                pasteReason: "Pasting styles is unavailable for this layer.",
            });
        }
        try {
            const reason = record.adapter.checkSavedStateCompatibility(
                record,
                this.styleClipboard.savedState
            );
            if (reason !== null && typeof reason !== "string") {
                throw new TypeError(
                    "Style compatibility must be null or a reason."
                );
            }
            return Object.freeze({
                canCopy,
                canPaste: reason === null,
                sourceLabel,
                pasteReason: reason ??
                    `Paste the style copied from ${sourceLabel}.`,
            });
        } catch (error) {
            return Object.freeze({
                canCopy,
                canPaste: false,
                sourceLabel,
                pasteReason: `Copied style is invalid: ${asErrorMessage(error)}`,
            });
        }
    }

    /**
     * Require the complete adapter contract.
     *
     * @param {MapLayerAdapter} adapter Candidate adapter.
     * @return {void}
     * @throws {TypeError} If a required method or message is absent.
     */
    #requireAdapter(adapter) {
        for (const method of [
            "label",
            "publish",
            "createState",
            "createLayer",
            "snapshot",
        ]) {
            if (typeof adapter?.[method] !== "function") {
                throw new TypeError(`Map-layer adapter requires ${method}().`);
            }
        }
        if (
            typeof adapter.tileErrorMessage !== "string" ||
            adapter.tileErrorMessage.length === 0
        ) {
            throw new TypeError(
                "Map-layer adapter requires a tile-error message."
            );
        }
    }
}

/**
 * Return a user-facing message for one thrown value.
 *
 * @param {unknown} candidate Thrown value.
 * @return {string} Ordinary error message or a safe fallback.
 */
function asErrorMessage(candidate) {
    return candidate instanceof Error && candidate.message.length > 0
        ? candidate.message
        : "Style operation failed.";
}
