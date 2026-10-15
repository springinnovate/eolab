/**
 * Own Catalog Add/Remove, Style, Zoom, and their per-Item action state.
 *
 * Assessment and publication requests belong to a Catalog Item's composite
 * identity. Pending actions retain busy presentation across selection changes,
 * while completed assessment metadata bridges only an overlapping refresh.
 */

import { getCatalogItemKey } from "./catalog-item-identity.js";
import { formatCatalogVisualizationReason, getCatalogVisualization } from "./catalog.js";

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

/**
 * State consumed by Catalog result rows and the separate inspector view.
 * @typedef {Object} CatalogMapActionState
 * @property {{kind:"raster"|"vector",metadata:Object|undefined}|null} visualization Current rendering assessment.
 * @property {boolean} supported Whether the Item has a map visualization adapter.
 * @property {boolean} retained Whether the Item is in Map layers, even if hidden.
 * @property {boolean} canZoom Whether the Item has usable map bounds.
 * @property {{item:Object,key:string,buttonText:string,statusText:string}|null} pendingAction In-flight action for this composite identity.
 * @property {{message:string,isError:boolean,retained:boolean}|null} feedback Outcome matching current map membership.
 */

/** Manage Catalog map actions without owning selection, DOM, or map controllers. */
export class CatalogMapActions {
    #pending = new CatalogMapActionRegistry();
    #assessments = new CatalogVectorAssessmentCache();
    /** @type {Map<string, {message:string,isError:boolean,retained:boolean}>} */
    #feedback = new Map();

    /**
     * Connect existing publication and presentation commands through composition.
     *
     * Callbacks run synchronously in the documented order except prepare/show.
     * The owner never captures the selected Item; onPrepared/onRemoved must use
     * the current selection when coordinating inspector metadata and analysis.
     *
     * @param {Object} commands Narrow commands supplied by browser composition.
     * @param {(item:Object)=>boolean} commands.contains Read retained membership.
     * @param {(item:Object)=>Promise<Object>} commands.prepare Assess a vector or pass through a raster.
     * @param {(item:Object)=>Promise<Object|null>} commands.show Publish the prepared Item; null means canceled.
     * @param {(item:Object)=>void} commands.remove Remove with the existing Undo behavior.
     * @param {(item:Object|null)=>number[][]|null} commands.getBounds Read usable map corners.
     * @param {(key:string)=>void} commands.openStyle Open the editor for a composite identity.
     * @param {(bounds:number[][])=>void} commands.zoomToBounds Fit the viewport using existing map options.
     * @param {(item:Object,visualization:{kind:"raster"|"vector",metadata:Object|undefined}|null)=>void} commands.onPrepared Refresh matching selected details after assessment, before publication.
     * @param {(item:Object,kind:"raster"|"vector")=>void} commands.onRemoved Preserve selected analysis after removal, before feedback.
     * @param {()=>void} commands.onAdded Reveal Map layers after success feedback, before pending cleanup.
     * @param {()=>void} commands.onChange Refresh rows and inspector from their current Items.
     */
    constructor(commands) {
        this.commands = commands;
    }

    /**
     * Describe one Item's action without selecting it or changing map membership.
     *
     * Feedback expires when external removal/restoration changes membership.
     * @param {Object|null} item Catalog Item or no inspector selection.
     * @return {CatalogMapActionState} Current state for row or inspector projection.
     */
    state(item) {
        const visualization = getCatalogVisualization(item);
        const retained = item !== null && this.commands.contains(item);
        const key = item === null ? null : getCatalogItemKey(item);
        let feedback = this.#feedback.get(key) ?? null;
        if (feedback !== null && feedback.retained !== retained) {
            this.#feedback.delete(key);
            feedback = null;
        }
        return {
            visualization, supported: visualization !== null, retained,
            canZoom: this.commands.getBounds(item) !== null,
            pendingAction: item === null ? null : this.#pending.get(item),
            feedback,
        };
    }

    /**
     * Hydrate a refreshed or selected Item from an overlapping vector assessment.
     * @param {Object} item Current Catalog Item instance.
     * @return {boolean} Whether matching cached metadata was applied.
     */
    applyAssessment(item) {
        return this.#assessments.apply(item);
    }

    /**
     * Discard completed feedback and assessments when a Catalog search starts.
     *
     * Pending actions survive and can update replacement rows with the same
     * composite identity. Search owns replacing the views; this does not notify.
     * @return {void}
     */
    clearTransientState() {
        this.#assessments.clear();
        this.#feedback.clear();
    }

    /**
     * Add or remove the requested Item independently of Catalog selection.
     *
     * Duplicate requests are ignored while preparation/publication is pending.
     * Assessment metadata is recorded before onPrepared; ineligible vectors
     * never publish. Canceled publication produces no success or reveal callback.
     * Preparation/publication failures become retryable per-Item feedback.
     * @param {Object|null} item Item requested by a row or inspector control.
     * @return {Promise<void>} Completion after feedback and pending cleanup.
     */
    async toggle(item) {
        const visualization = getCatalogVisualization(item);
        if (visualization === null || this.#pending.get(item) !== null) return;
        const datasetNoun = visualization.kind === "raster" ? "Raster" : "Vector layer";
        if (this.commands.contains(item)) {
            this.commands.remove(item);
            this.commands.onRemoved(item, visualization.kind);
            this.#setFeedback(item, `${datasetNoun} removed from the map.`);
            return;
        }

        this.#feedback.delete(getCatalogItemKey(item));
        const pendingAction = this.#pending.begin(
            item,
            "Adding to map...",
            visualization.kind === "vector"
                ? "Checking whether this vector layer can be rendered."
                : "Publishing this prepared raster."
        );
        this.commands.onChange();
        try {
            const preparedItem = await this.commands.prepare(item);
            if (visualization.kind === "vector") {
                this.#assessments.record(item, preparedItem);
            }
            const currentVisualization = getCatalogVisualization(preparedItem);
            this.commands.onPrepared(item, currentVisualization);
            if (currentVisualization?.kind === "vector" &&
                currentVisualization.metadata?.eligible !== true) {
                this.#setFeedback(item, formatCatalogVisualizationReason(
                    item, currentVisualization.metadata?.reason
                ) || "Visualization is unavailable for this item.", true);
                return;
            }
            const publication = await this.commands.show(preparedItem);
            if (publication === null) return;
            this.#setFeedback(item, `${datasetNoun} added to the map.`);
            this.commands.onAdded();
        } catch (error) {
            this.#setFeedback(item, formatCatalogVisualizationReason(
                item, error.message
            ), true);
        } finally {
            if (this.#pending.finish(pendingAction)) this.commands.onChange();
        }
    }

    /**
     * Open the editor for a retained, nonpending Item without changing selection.
     * @param {Object|null} item Item requested by a row or inspector shortcut.
     * @return {void}
     */
    style(item) {
        if (item === null || !this.commands.contains(item) ||
            this.#pending.get(item) !== null) return;
        this.commands.openStyle(getCatalogItemKey(item));
    }

    /**
     * Fit a retained, nonpending Item's bounds without changing map membership.
     * @param {Object|null} item Item requested by a row or inspector shortcut.
     * @return {boolean} Whether usable retained Item bounds were fitted.
     */
    zoom(item) {
        const bounds = this.commands.getBounds(item);
        if (bounds === null || !this.commands.contains(item) ||
            this.#pending.get(item) !== null) return false;
        this.commands.zoomToBounds(bounds);
        return true;
    }

    /**
     * Record an outcome tied to current membership and refresh its presentation.
     * @param {Object} item Item whose action completed.
     * @param {string} message Accessible result or error text.
     * @param {boolean} [isError=false] Whether to display failure feedback.
     * @return {void}
     */
    #setFeedback(item, message, isError = false) {
        this.#feedback.set(getCatalogItemKey(item), {
            message, isError, retained: this.commands.contains(item),
        });
        this.commands.onChange();
    }
}
