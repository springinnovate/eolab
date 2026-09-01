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
     * @param {MapLayerStack} [configuration.stack] Pure retained-layer state.
     * @param {LeafletLayerSet} [configuration.leafletLayers] Keyed Leaflet set.
     */
    constructor({
        leafletMap,
        view = new MapLayerStackView(),
        onLayersChange = () => {},
        stack = new MapLayerStack(),
        leafletLayers = new LeafletLayerSet(leafletMap),
    }) {
        this.view = view;
        this.onLayersChange = onLayersChange;
        this.stack = stack;
        this.leafletLayers = leafletLayers;
        this.records = new Map();
        this.publicationGenerations = new Map();
        this.pendingPublications = new Map();
        this.pendingAdapters = new Map();
        this.activationIntentSequence = 0;
        this.presentationActiveKey = null;
        this.destroyed = false;
        this.view.bind({
            onStyle: (key) => this.onStyle?.(key),
            onVisibility: (key, visible) => this.setVisible(key, visible),
            onMove: (key, direction) => this.move(key, direction),
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
     * Move one retained layer in top-first drawing order.
     *
     * @param {string} key Stable map-layer key.
     * @param {"up"|"down"} direction Requested movement.
     * @return {void}
     */
    move(key, direction) {
        if (!this.stack.move(key, direction)) {
            return;
        }
        this.#applyLeafletOrder();
        const record = this.#requireRecord(key);
        record.adapter.orderChanged?.(record);
        this.view.setStatus(
            `${record.entry.label} moved ${direction} in the map drawing order.`
        );
        this.render({ key, action: `move-${direction}` });
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
        this.view.setStatus(
            entry.visible
                ? `${label} was added and is visible.`
                : `${label} was added hidden because two map layers are ` +
                  "already visible. Hide one to show it."
        );
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
