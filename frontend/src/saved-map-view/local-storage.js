/** Browser-local persistence adapter for one validated saved-map document. */

export const REMEMBERED_MAP_VIEW_STORAGE_KEY = "eolab.remembered-map-view.v1";

/**
 * Own failure-tolerant access to the browser's origin-scoped local storage.
 *
 * The adapter stores opaque serialized content. Saved-map parsing, validation,
 * restoration, and lifecycle decisions remain with SavedMapViewController.
 */
export class SavedMapViewLocalStorage {
    /**
     * Create one origin-local storage boundary.
     *
     * @param {Storage|null} [storageContext] Browser Storage implementation, or
     * null when persistence is unavailable.
     * @param {string} [key] Versioned private storage key.
     */
    constructor(
        storageContext = resolveBrowserLocalStorage(),
        key = REMEMBERED_MAP_VIEW_STORAGE_KEY
    ) {
        if (typeof key !== "string" || key === "") {
            throw new TypeError("Saved-map storage key must be nonempty text");
        }
        this.storage = storageContext;
        this.key = key;
    }

    /**
     * Read the remembered serialized view without interpreting it.
     *
     * @return {string|null} Stored content, or null when absent or unavailable.
     */
    read() {
        try {
            return this.storage?.getItem(this.key) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Replace the remembered serialized view when storage is available.
     *
     * @param {string} serialized Validated saved-map JSON from the owner.
     * @return {boolean} Whether the browser accepted the value.
     */
    write(serialized) {
        if (typeof serialized !== "string") {
            throw new TypeError("Remembered saved-map content must be text");
        }
        try {
            if (this.storage === null) return false;
            this.storage.setItem(this.key, serialized);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Forget a corrupt or deliberately reset remembered document.
     *
     * @return {boolean} Whether storage was available and accepted removal.
     */
    clear() {
        try {
            if (this.storage === null) return false;
            this.storage.removeItem(this.key);
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Resolve localStorage without allowing browser security policy to break startup.
 *
 * @return {Storage|null} Origin-local browser storage when accessible.
 */
function resolveBrowserLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}
