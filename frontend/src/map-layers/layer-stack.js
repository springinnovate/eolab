/**
 * Domain state and invariants for the retained map-layer stack.
 *
 * This module owns active selection, visibility, opacity, and top-first
 * ordering keyed by the Catalog identity contract. It performs no publication,
 * DOM, Leaflet, statistics, or styling work.
 */

import { getCatalogItemKey } from "../catalog-item-identity.js";

/** Maximum retained layers that may issue map tile requests simultaneously. */
export const MAX_VISIBLE_MAP_LAYERS = 2;

/** Raised when a visibility transition would exceed the stack contract. */
export class MapLayerVisibilityLimitError extends Error {
    /** Create the fixed user-facing visibility-limit error. */
    constructor() {
        super(
            `Only ${MAX_VISIBLE_MAP_LAYERS} map layers can be visible ` +
            "at once. Hide one before showing another."
        );
        this.name = "MapLayerVisibilityLimitError";
    }
}

/**
 * @typedef {Object} MapLayerStackEntry
 * @property {string} key Stable composite Catalog Item key.
 * @property {Object} item Catalog STAC Item.
 * @property {string} label Readable layer label.
 * @property {number} retentionOrder Monotonic add-intent order.
 * @property {boolean} visible Whether the layer is attached to the map.
 * @property {number} opacity Ordinary-overlay opacity from zero through one.
 */

/** Own retained map-layer order and cross-entry invariants. */
export class MapLayerStack {
    /** Create an empty stack with no active layer. */
    constructor() {
        /** @type {MapLayerStackEntry[]} */
        this.entries = [];
        /** @type {string|null} */
        this.activeKey = null;
        this.nextRetentionOrder = 1;
    }

    /**
     * Add one unique Item at the top and make it active.
     *
     * A new entry is visible only when the two-layer map capacity permits it.
     * Adding an existing Item is idempotent and merely activates it.
     *
     * @param {Object} item Catalog STAC Item.
     * @param {string} label Readable layer label.
     * @param {number} [retentionOrder=this.nextRetentionOrder] Monotonic
     * add-intent order used to make asynchronous completion deterministic.
     * @return {{entry: MapLayerStackEntry, added: boolean}} Result entry
     * and whether the stack changed.
     */
    add(item, label, retentionOrder = this.nextRetentionOrder) {
        const key = getCatalogItemKey(item);
        if (typeof label !== "string" || label.length === 0) {
            throw new TypeError("Map layer labels must be non-empty strings.");
        }
        if (!Number.isSafeInteger(retentionOrder) || retentionOrder < 1) {
            throw new TypeError(
                "Map layer retention order must be a positive safe integer."
            );
        }
        const existingEntry = this.get(key);
        if (existingEntry !== null) {
            this.activeKey = key;
            return { entry: existingEntry, added: false };
        }
        if (
            this.entries.some(
                (entry) => entry.retentionOrder === retentionOrder
            )
        ) {
            throw new Error(
                `Map layer retention order is already used: ${retentionOrder}`
            );
        }
        const entry = {
            key,
            item,
            label,
            retentionOrder,
            visible: this.visibleCount < MAX_VISIBLE_MAP_LAYERS,
            opacity: 1,
        };
        const insertionIndex = this.entries.findIndex(
            (candidate) => candidate.retentionOrder < retentionOrder
        );
        if (insertionIndex < 0) {
            this.entries.push(entry);
        } else {
            this.entries.splice(insertionIndex, 0, entry);
        }
        this.nextRetentionOrder = Math.max(
            this.nextRetentionOrder,
            retentionOrder + 1
        );
        this.activeKey = key;
        return { entry, added: true };
    }

    /**
     * Return an entry by stable key.
     *
     * @param {string} key Stable layer key.
     * @return {MapLayerStackEntry|null} Matching entry or null.
     */
    get(key) {
        return this.entries.find((entry) => entry.key === key) ?? null;
    }

    /**
     * Return whether a Catalog Item is retained.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {boolean} Whether its composite identity exists in the stack.
     */
    hasItem(item) {
        return this.get(getCatalogItemKey(item)) !== null;
    }

    /**
     * Select the retained layer presented as active by its owning adapter.
     *
     * @param {string} key Stable layer key.
     * @return {MapLayerStackEntry} Newly active entry.
     * @throws {RangeError} If key is not retained.
     */
    activate(key) {
        const entry = this.#require(key);
        this.activeKey = entry.key;
        return entry;
    }

    /**
     * Change visibility while preserving the two-visible invariant.
     *
     * @param {string} key Stable layer key.
     * @param {boolean} visible Requested visibility.
     * @return {MapLayerStackEntry} Updated entry.
     * @throws {MapLayerVisibilityLimitError} If a third layer is requested.
     */
    setVisible(key, visible) {
        if (typeof visible !== "boolean") {
            throw new TypeError("Map layer visibility must be boolean.");
        }
        const entry = this.#require(key);
        if (
            visible &&
            !entry.visible &&
            this.visibleCount >= MAX_VISIBLE_MAP_LAYERS
        ) {
            throw new MapLayerVisibilityLimitError();
        }
        entry.visible = visible;
        return entry;
    }

    /**
     * Change ordinary-overlay opacity.
     *
     * @param {string} key Stable layer key.
     * @param {number} opacity Finite opacity from zero through one.
     * @return {MapLayerStackEntry} Updated entry.
     * @throws {RangeError} If opacity is outside its closed interval.
     */
    setOpacity(key, opacity) {
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            throw new RangeError(
                "Map layer opacity must be from zero through one."
            );
        }
        const entry = this.#require(key);
        entry.opacity = opacity;
        return entry;
    }

    /**
     * Move an entry one position in top-first drawing order.
     *
     * @param {string} key Stable layer key.
     * @param {"up"|"down"} direction Requested movement.
     * @return {boolean} Whether the entry moved.
     * @throws {TypeError} If direction is not part of the contract.
     */
    move(key, direction) {
        if (direction !== "up" && direction !== "down") {
            throw new TypeError("Map layers can move only up or down.");
        }
        const index = this.entries.findIndex((entry) => entry.key === key);
        if (index < 0) {
            throw new RangeError(`Unknown map layer key: ${key}`);
        }
        const nextIndex = direction === "up" ? index - 1 : index + 1;
        if (nextIndex < 0 || nextIndex >= this.entries.length) {
            return false;
        }
        [this.entries[index], this.entries[nextIndex]] = [
            this.entries[nextIndex],
            this.entries[index],
        ];
        return true;
    }

    /**
     * Remove one retained layer and choose a deterministic active fallback.
     *
     * @param {string} key Stable layer key.
     * @return {{removed: MapLayerStackEntry, activeKey: string|null}}
     * Removed entry and resulting active key.
     */
    remove(key) {
        const index = this.entries.findIndex((entry) => entry.key === key);
        if (index < 0) {
            throw new RangeError(`Unknown map layer key: ${key}`);
        }
        const [removed] = this.entries.splice(index, 1);
        if (this.activeKey === key) {
            this.activeKey =
                this.entries[index]?.key ??
                this.entries[index - 1]?.key ??
                null;
        }
        return { removed, activeKey: this.activeKey };
    }

    /**
     * Remove every retained entry and active selection.
     *
     * @return {void}
     */
    clear() {
        this.entries.length = 0;
        this.activeKey = null;
        this.nextRetentionOrder = 1;
    }

    /** @return {number} Number of map-attached layers. */
    get visibleCount() {
        return this.entries.filter((entry) => entry.visible).length;
    }

    /**
     * Require one retained entry.
     *
     * @param {string} key Stable layer key.
     * @return {MapLayerStackEntry} Matching entry.
     * @throws {RangeError} If key is not retained.
     */
    #require(key) {
        const entry = this.get(key);
        if (entry === null) {
            throw new RangeError(`Unknown map layer key: ${key}`);
        }
        return entry;
    }
}
