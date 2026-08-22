/**
 * Domain state and invariants for the retained raster layer stack.
 *
 * This module owns stable Catalog Item identity, active selection, visibility,
 * opacity, and top-first ordering. It performs no publication, DOM, Leaflet,
 * statistics, or styling work.
 */

/** Maximum raster layers that may issue map tile requests simultaneously. */
export const MAX_VISIBLE_RASTER_LAYERS = 2;

/** Raised when a visibility transition would exceed the stack contract. */
export class RasterLayerVisibilityLimitError extends Error {
    /** Create the fixed user-facing visibility-limit error. */
    constructor() {
        super(
            `Only ${MAX_VISIBLE_RASTER_LAYERS} raster layers can be visible ` +
            "at once. Hide one before showing another."
        );
        this.name = "RasterLayerVisibilityLimitError";
    }
}

/**
 * Return one stable stack key from a STAC Item's composite identity.
 *
 * @param {Object} item Catalog STAC Item.
 * @return {string} Collision-safe serialized collection and Item identity.
 * @throws {TypeError} If the Item identity violates the Catalog contract.
 */
export function getCatalogRasterLayerKey(item) {
    if (
        typeof item?.collection !== "string" ||
        item.collection.length === 0 ||
        typeof item?.id !== "string" ||
        item.id.length === 0
    ) {
        throw new TypeError(
            "Raster layer Items require non-empty collection and id strings."
        );
    }
    return JSON.stringify([item.collection, item.id]);
}

/**
 * @typedef {Object} RasterLayerStackEntry
 * @property {string} key Stable composite Catalog Item key.
 * @property {Object} item Catalog STAC Item.
 * @property {string} label Readable raster basename.
 * @property {number} retentionOrder Monotonic add-intent order.
 * @property {boolean} visible Whether the layer is attached to the map.
 * @property {number} opacity Ordinary-overlay opacity from zero through one.
 */

/** Own retained raster-layer order and cross-entry invariants. */
export class RasterLayerStack {
    /** Create an empty stack with no active layer. */
    constructor() {
        /** @type {RasterLayerStackEntry[]} */
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
     * @param {string} label Readable raster basename.
     * @param {number} [retentionOrder=this.nextRetentionOrder] Monotonic
     * add-intent order used to make asynchronous completion deterministic.
     * @return {{entry: RasterLayerStackEntry, added: boolean}} Result entry
     * and whether the stack changed.
     */
    add(item, label, retentionOrder = this.nextRetentionOrder) {
        const key = getCatalogRasterLayerKey(item);
        if (typeof label !== "string" || label.length === 0) {
            throw new TypeError("Raster layer labels must be non-empty strings.");
        }
        if (!Number.isSafeInteger(retentionOrder) || retentionOrder < 1) {
            throw new TypeError(
                "Raster layer retention order must be a positive safe integer."
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
                `Raster layer retention order is already used: ${retentionOrder}`
            );
        }
        const entry = {
            key,
            item,
            label,
            retentionOrder,
            visible: this.visibleCount < MAX_VISIBLE_RASTER_LAYERS,
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
     * @return {RasterLayerStackEntry|null} Matching entry or null.
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
        return this.get(getCatalogRasterLayerKey(item)) !== null;
    }

    /**
     * Select the layer edited by the shared raster controls.
     *
     * @param {string} key Stable layer key.
     * @return {RasterLayerStackEntry} Newly active entry.
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
     * @return {RasterLayerStackEntry} Updated entry.
     * @throws {RasterLayerVisibilityLimitError} If a third layer is requested.
     */
    setVisible(key, visible) {
        if (typeof visible !== "boolean") {
            throw new TypeError("Raster layer visibility must be boolean.");
        }
        const entry = this.#require(key);
        if (
            visible &&
            !entry.visible &&
            this.visibleCount >= MAX_VISIBLE_RASTER_LAYERS
        ) {
            throw new RasterLayerVisibilityLimitError();
        }
        entry.visible = visible;
        return entry;
    }

    /**
     * Change ordinary-overlay opacity.
     *
     * @param {string} key Stable layer key.
     * @param {number} opacity Finite opacity from zero through one.
     * @return {RasterLayerStackEntry} Updated entry.
     * @throws {RangeError} If opacity is outside its closed interval.
     */
    setOpacity(key, opacity) {
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            throw new RangeError(
                "Raster layer opacity must be from zero through one."
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
            throw new TypeError("Raster layers can move only up or down.");
        }
        const index = this.entries.findIndex((entry) => entry.key === key);
        if (index < 0) {
            throw new RangeError(`Unknown raster layer key: ${key}`);
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
     * @return {{removed: RasterLayerStackEntry, activeKey: string|null}}
     * Removed entry and resulting active key.
     */
    remove(key) {
        const index = this.entries.findIndex((entry) => entry.key === key);
        if (index < 0) {
            throw new RangeError(`Unknown raster layer key: ${key}`);
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

    /** Remove every retained entry and active selection. */
    clear() {
        this.entries.length = 0;
        this.activeKey = null;
        this.nextRetentionOrder = 1;
    }

    /** @return {number} Number of map-attached raster layers. */
    get visibleCount() {
        return this.entries.filter((entry) => entry.visible).length;
    }

    /**
     * Require one retained entry.
     *
     * @param {string} key Stable layer key.
     * @return {RasterLayerStackEntry} Matching entry.
     * @throws {RangeError} If key is not retained.
     */
    #require(key) {
        const entry = this.get(key);
        if (entry === null) {
            throw new RangeError(`Unknown raster layer key: ${key}`);
        }
        return entry;
    }
}
