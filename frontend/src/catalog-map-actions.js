/**
 * Catalog map-action and completed vector-assessment state.
 *
 * Assessment and publication requests belong to a Catalog Item's composite
 * identity. Pending actions retain busy presentation across selection changes,
 * while completed assessment metadata bridges only an overlapping refresh.
 */

import { getCatalogItemKey } from "./catalog-item-identity.js";

/** Scanner-owned rendering metadata on a vector Item's properties. */
const VECTOR_RENDERING_METADATA_KEY = "eolab:vector_rendering";

/**
 * Return whether two STAC Items have the same composite identity.
 *
 * @param {Object|null} first First Item.
 * @param {Object|null} second Second Item.
 * @return {boolean} Whether collection and Item identifiers match.
 */
export function catalogItemsMatch(first, second) {
    return first !== null && second !== null &&
        first.collection === second.collection && first.id === second.id;
}

/** Retain vector assessments until a refreshed equivalent Item consumes one. */
export class CatalogVectorAssessmentCache {
    /** Create an empty completed-assessment cache. */
    constructor() {
        this.assessments = new Map();
    }

    /**
     * Record one completed assessment under its requested Item identity.
     *
     * The originally requested instance is updated immediately. The retained
     * response remains available if a Catalog refresh has already replaced it
     * with an equivalent Item instance.
     *
     * @param {Object} requestedItem Item instance sent for assessment.
     * @param {Object} assessedItem Assessment response returned by the backend.
     * @return {void}
     */
    record(requestedItem, assessedItem) {
        const key = getCatalogItemKey(requestedItem);
        const vectorMetadata =
            assessedItem.properties?.[VECTOR_RENDERING_METADATA_KEY];
        if (vectorMetadata === undefined) {
            throw new TypeError(
                "Completed vector assessments require rendering metadata."
            );
        }
        Object.assign(requestedItem, assessedItem);
        this.assessments.set(key, vectorMetadata);
    }

    /**
     * Hydrate missing rendering metadata for an Item with the same identity.
     *
     * An Item that already carries rendering metadata under the completed
     * assessment's policy is authoritative, so it consumes the cache unchanged.
     * Metadata under an obsolete policy is replaced by the current assessment.
     *
     * @param {Object} item Catalog Item to hydrate.
     * @return {boolean} Whether a completed assessment matched the Item.
     */
    apply(item) {
        const key = getCatalogItemKey(item);
        const assessment = this.assessments.get(key);
        if (assessment === undefined) {
            return false;
        }
        const currentMetadata = item.properties?.[VECTOR_RENDERING_METADATA_KEY];
        if (
            currentMetadata?.policy === assessment.policy
        ) {
            this.assessments.delete(key);
            return false;
        }
        item.properties[VECTOR_RENDERING_METADATA_KEY] = assessment;
        this.assessments.delete(key);
        return true;
    }

    /**
     * Discard results from assessments completed before a new Catalog request.
     *
     * @return {void}
     */
    clear() {
        this.assessments.clear();
    }
}

/** Own the currently running assessment or publication for each Catalog Item. */
export class CatalogMapActionRegistry {
    /** Create an empty pending-action registry. */
    constructor() {
        this.actions = new Map();
    }

    /**
     * Begin one action under the selected Item's composite identity.
     *
     * @param {Object} item Selected Catalog Item.
     * @param {string} buttonText In-progress action label.
     * @param {string} statusText In-progress status explanation.
     * @return {{item:Object,key:string,buttonText:string,statusText:string}}
     * Identity token required to finish this action.
     * @throws {Error} If the Item already owns an in-flight action.
     */
    begin(item, buttonText, statusText) {
        const key = getCatalogItemKey(item);
        if (this.actions.has(key)) {
            throw new Error(`Catalog map action is already pending: ${key}`);
        }
        const action = { item, key, buttonText, statusText };
        this.actions.set(key, action);
        return action;
    }

    /**
     * Return the action running for one Item.
     *
     * @param {Object} item Catalog Item to inspect.
     * @return {{item:Object,key:string,buttonText:string,statusText:string}|null}
     * Matching action, or null when the Item has no pending action.
     */
    get(item) {
        return this.actions.get(getCatalogItemKey(item)) ?? null;
    }

    /**
     * Finish the action only when its token still owns that Item identity.
     *
     * @param {{key:string}} action Token returned by begin.
     * @return {boolean} Whether this action was removed.
     */
    finish(action) {
        if (this.actions.get(action.key) !== action) {
            return false;
        }
        this.actions.delete(action.key);
        return true;
    }
}
