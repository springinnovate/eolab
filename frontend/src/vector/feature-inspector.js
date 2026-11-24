/** Own selected vector attributes and history acquired by map clicks or Lasso. */

import { getFeatureInfoViewport } from "./feature-info-viewport.js";
import { getSelectedVectorFeatures } from "./api.js";
import { isNumericFeatureValue } from "./inspection-observation.js";
import { selectLassoFeatures } from "./lasso.js";
import { DEFAULT_FIELD_FORMATS } from "../feature-field-formats.js";
import { VectorFeatureFieldDisplay } from "./feature-field-display.js";

import {
    fetchVectorFeatureInfo,
    VectorFeatureInfoError,
} from "./feature-info.js";

const HIGHLIGHT_STYLE = Object.freeze({
    color: "#111827",
    weight: 3,
    opacity: 1,
    fillColor: "#facc15",
    fillOpacity: 0.35,
});
const TIME_SERIES_AVAILABLE_HELP =
    "Compare numeric fields across the selected features.";
const TIME_SERIES_UNAVAILABLE_HELP =
    "Select at least two features with Picker or Lasso to compare their fields.";
const MAX_ATTRIBUTE_VALUE_CHARACTERS = 1000;
const MAX_SELECTION_HISTORY_ENTRIES = 20;

/**
 * @typedef {Readonly<{lng:number,lat:number}>} InspectionPosition The sampled map point.
 */

/**
 * @typedef {{key:string,label:string,selection:Object}} VectorSelectionTarget
 * Retained view identity and path-free original source with its applied predicate.
 * @typedef {{polygon:Object,geometry:Object|null,count:number,label:string}} FeatureSelectionDisplay
 * Optional Lasso display, independent of attributes and plotting eligibility.
 * @typedef {{kind:"click",signature:string}|{kind:"lasso",key:string,selection:Object}} FeatureSelectionContext
 * Source context used to reject stale reads and history after a source or predicate changes.
 * @typedef {{feature:Object,target:{sourceId:string,label:string,primaryGeometry?:string|null,
 * publication?:Object,geometryKind?:string},inspectionPosition:InspectionPosition|null}} InspectedVectorFeature
 * Selected attributes with optional published display metadata and click context.
 */

/**
 * @typedef {{identity:string|null,results:InspectedVectorFeature[],position:InspectionPosition|null,
 * context:FeatureSelectionContext,display:FeatureSelectionDisplay|null,
 * resultIndex:number,state:"ready"|"empty",message:string,failedLayers:number}} FeatureSelection
 * A completed inspection with its last highlighted feature.
 */

/**
 * Describe completed Lasso results using the layer's current display name.
 * @param {FeatureSelectionDisplay} display Selected count, layer name and optional highlight geometry.
 * @return {string} Selection status for Features and retained history.
 */
function formatLassoSelectionStatus({count, label, geometry}) {
    return `${count} feature${count === 1 ? "" : "s"} selected in ${label}.` +
        (count && geometry === null ? " Map highlights are unavailable; attributes and plots are ready." : "");
}

/**
 * Format elapsed inspection time without implying unavailable precision.
 *
 * @param {number} elapsedMilliseconds Monotonic elapsed milliseconds.
 * @return {string} Concise duration for progressive and final status text.
 */
function formatInspectionDuration(elapsedMilliseconds) {
    const boundedMilliseconds = Math.max(0, elapsedMilliseconds);
    if (boundedMilliseconds < 100) return "under 0.1 s";
    return `${(boundedMilliseconds / 1000).toFixed(1)} s`;
}

/**
 * Build an immutable geometry-neutral map target for one inspected feature.
 *
 * @param {Object} configuration Focus inputs.
 * @param {Object} configuration.feature Bounded GeoJSON feature result with
 * geographic bounds validated at the response boundary.
 * @param {{lng:number,lat:number}|null} configuration.inspectionPosition Accepted
 * WGS 84 map-click position, or null for attributes acquired without a point.
 * @return {Readonly<Object>|null} Feature center and optional geographic bounds,
 * or null when the read supplies neither bounds nor a click.
 * Without bounds the click is retained only as context, never a zoom destination.
 * @throws {TypeError} If the inspection position is outside WGS 84.
 */
function vectorFeatureFocus({ feature, inspectionPosition }) {
    if (inspectionPosition === null) return null;
    const longitude = inspectionPosition?.lng;
    const latitude = inspectionPosition?.lat;
    if (
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    ) {
        throw new TypeError("Invalid vector feature inspection position.");
    }
    const bounds = feature.bbox == null ? null : [...feature.bbox];
    const center = bounds === null
        ? [longitude, latitude]
        : [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    return Object.freeze({
        center: Object.freeze(center),
        bounds: bounds === null ? null : Object.freeze(bounds),
    });
}


/**
 * Return an immutable scalar-only observation for sibling analysis tools.
 *
 * Geometry and nested values stay owned by the feature inspector. The analysis
 * boundary contains only chart fields and the small geometry-neutral map focus
 * needed to navigate back to an inspected row.
 *
 * @param {InspectedVectorFeature} result Selected feature and optional click context.
 * @return {Readonly<Object>} Closed inspection-observation contract.
 */
export function vectorInspectionObservation({ feature, target, inspectionPosition }) {
    const properties = {};
    for (const [name, value] of Object.entries(feature.properties)) {
        if (
            value === null ||
            typeof value === "string" ||
            typeof value === "boolean" ||
            typeof value === "number" || typeof value === "bigint"
        ) {
            properties[name] = value;
        }
    }
    return Object.freeze({
        sourceId: target.sourceId,
        layerLabel: target.label,
        featureId: typeof feature.id === "string" || typeof feature.id === "number"
            ? feature.id
            : null,
        focus: vectorFeatureFocus({ feature, inspectionPosition }),
        properties: Object.freeze(properties),
    });
}

/**
 * Return whether one WGS 84 position is inside an authoritative Item extent.
 *
 * Inclusive edges preserve inspection of features whose coordinates coincide
 * with a Catalog bounding-box boundary. Crossing extents contain either
 * longitude interval adjacent to the date line.
 *
 * @param {number[]} bbox West, south, east, north Catalog Item bounds.
 * @param {{lng:number,lat:number}} position Leaflet WGS 84 click position.
 * @return {boolean} Whether the target can contain the clicked feature.
 */
function vectorBoundsContainPosition(bbox, position) {
    const [west, south, east, north] = bbox;
    const longitudeInside = west <= east
        ? position.lng >= west && position.lng <= east
        : position.lng >= west || position.lng <= east;
    return longitudeInside && position.lat >= south && position.lat <= north;
}

/**
 * Format an arbitrary property for the inspector, using the layer's optional numeric display.
 *
 * @param {*} value GeoJSON property value.
 * @param {import("../feature-field-formats.js").FeatureFieldFormat} [format] Inspector settings; a label alone preserves default display.
 * @return {string} Safe text capped at the presentation limit.
 */
export function formatVectorFeatureAttribute(value, format) {
    let text;
    if (value === null || value === undefined) {
        return "No value";
    }
    if (typeof value === "boolean") {
        return value ? "True" : "False";
    }
    if (format?.format && isNumericFeatureValue(value)) {
        /** @type {Intl.NumberFormatOptions} */
        const options = {};
        if (format.format === "currency") {
            options.style = "currency";
            options.currency = format.currency;
        }
        if (format.decimals !== undefined) {
            options.minimumFractionDigits = format.decimals;
            options.maximumFractionDigits = format.decimals;
        } else if (format.format === "number") {
            options.maximumSignificantDigits = 21;
        }
        text = new Intl.NumberFormat(undefined, options).format(value);
        if (format.unit) text += ` ${format.unit}`;
    } else if (typeof value === "object") {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    } else {
        text = String(value);
    }
    return text.length <= MAX_ATTRIBUTE_VALUE_CHARACTERS
        ? text
        : `${text.slice(0, MAX_ATTRIBUTE_VALUE_CHARACTERS - 1)}…`;
}

/**
 * Return inspector labels and formatted values without changing source properties or including geometry metadata.
 *
 * @param {Object} feature Validated GeoJSON Feature.
 * @param {string|null} primaryGeometry Catalog-declared geometry field.
 * @param {import("../feature-field-formats.js").FeatureFieldFormats} [formats] Labels and numeric display settings for this view.
 * @return {{name:string,value:string}[]} Bounded display attributes.
 */
export function vectorFeatureAttributes(feature, primaryGeometry = null, formats = DEFAULT_FIELD_FORMATS) {
    const geometryNames = new Set(
        [primaryGeometry, "geometry", "the_geom", "boundedBy", "bbox"]
            .filter((name) => typeof name === "string")
    );
    const attributes = Object.entries(feature.properties)
        .filter(([name]) => !geometryNames.has(name))
        .map(([name, value]) => {
            const format = Object.hasOwn(formats, name) ? formats[name] : undefined;
            return {name: format?.displayName ?? name, value: formatVectorFeatureAttribute(value, format)};
        });
    if (typeof feature.id === "string" || typeof feature.id === "number") {
        attributes.unshift({
            name: "Feature ID",
            value: formatVectorFeatureAttribute(feature.id),
        });
    }
    return attributes;
}

/** Own vector-inspection requests, results, and map highlight. */
export class VectorFeatureInspectorController {
    /** @type {FeatureSelection[]} */
    #selectionHistory = [];
    /** @type {number} Saved selection index, or the entry before an unfinished or invalidated view. */
    #selectionHistoryIndex = -1;
    /** @type {InspectionPosition|null} */
    #inspectionPosition = null;
    /** @type {FeatureSelectionContext|null} Context of the active read or displayed selection. */
    #selectionContext = null;
    /** @type {FeatureSelectionDisplay|null} Optional display retained with the active selection. */
    #selectionDisplay = null;

    /**
     * Connect click and Lasso acquisition to one feature selection and its history.
     *
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Initialized Leaflet map.
     * @param {() => import("./feature-info.js").VectorFeatureInspectionTarget[]}
     * configuration.getVisibleTargets Current visible vectors from composition.
     * @param {()=>VectorSelectionTarget[]} [configuration.getSelectionTargets] Retained original sources, including hidden views.
     * @param {(display:FeatureSelectionDisplay|null,options?:{cancelGesture:boolean})=>void} [configuration.onSelectionDisplayChange]
     * Publishes the current Lasso outline and optional highlights through composition.
     * @param {string} configuration.wmsUrl Restricted browser WMS URL.
     * @param {(visible:boolean) => void} configuration.onInspectionChange
     * Requests presentation changes without knowing the presentation owner.
     * @param {(sample:Readonly<import("./inspection-observation.js").VectorInspectionSample>)=>void} configuration.onSampleChange
     * Publishes immutable bounded observations through application composition.
     * @param {(navigation:Readonly<{canPrevious:boolean,canNext:boolean}>)=>void}
     * configuration.onSelectionNavigationChange Publishes available directions
     * between completed map selections.
     * @param {(observation:Readonly<Object>|null,navigation:Readonly<Object>|null)=>void}
     * configuration.onCurrentObservationChange Publishes the current paged
     * result and its immutable position within the inspector-owned result set.
     * @param {()=>void} configuration.onFeatureProfileRequested Publishes
     * single-feature plotting intent without knowing its implementation.
     * @param {()=>void} configuration.onTimeSeriesRequested Publishes analysis
     * intent for all selected features without knowing its implementation.
     * @param {(sourceId:string)=>void} configuration.onStyleRequested Publishes
     * styling intent with the selected feature's opaque source identity.
     * @param {(sourceId:string)=>void} [configuration.onFilterRequested] Publishes
     * filtering intent with the selected feature's opaque source identity.
     * @param {(focus:Readonly<Object>|null)=>boolean}
     * configuration.onFeatureZoomRequested Publishes current-feature map
     * navigation intent without owning viewport movement.
     * @param {(sourceId:string)=>import("./feature-field-display.js").FeatureFieldDisplay|null}
     * configuration.getFieldDisplay Reads and updates the inspected view's attribute formats.
     * @param {Document} [configuration.documentContext=document] DOM owner.
     * @param {typeof fetch} [configuration.fetchImplementation=globalThis.fetch]
     * HTTP implementation.
     * @param {()=>number} [configuration.now] Monotonic clock used only for
     * user-facing request progress.
     * @throws {TypeError} If a required collaborator is not a function.
     */
    constructor({
        leaflet,
        leafletMap,
        getVisibleTargets,
        getSelectionTargets = () => [],
        onSelectionDisplayChange = () => {},
        wmsUrl,
        onInspectionChange,
        onSampleChange,
        onSelectionNavigationChange,
        onCurrentObservationChange,
        onFeatureProfileRequested,
        onTimeSeriesRequested,
        onStyleRequested,
        onFilterRequested = () => {},
        onFeatureZoomRequested,
        getFieldDisplay,
        documentContext = document,
        fetchImplementation = globalThis.fetch,
        now = () => globalThis.performance.now(),
    }) {
        if (typeof getVisibleTargets !== "function") {
            throw new TypeError("getVisibleTargets must be a function.");
        }
        if (typeof getFieldDisplay !== "function") {
            throw new TypeError("getFieldDisplay must be a function.");
        }
        if (typeof onInspectionChange !== "function") {
            throw new TypeError("onInspectionChange must be a function.");
        }
        if (typeof onSampleChange !== "function") {
            throw new TypeError("onSampleChange must be a function.");
        }
        if (typeof onSelectionNavigationChange !== "function") {
            throw new TypeError("onSelectionNavigationChange must be a function.");
        }
        if (typeof onCurrentObservationChange !== "function") {
            throw new TypeError("onCurrentObservationChange must be a function.");
        }
        if (typeof onFeatureProfileRequested !== "function") {
            throw new TypeError("onFeatureProfileRequested must be a function.");
        }
        if (typeof onTimeSeriesRequested !== "function") {
            throw new TypeError("onTimeSeriesRequested must be a function.");
        }
        if (typeof onStyleRequested !== "function") {
            throw new TypeError("onStyleRequested must be a function.");
        }
        if (typeof onFeatureZoomRequested !== "function") {
            throw new TypeError("onFeatureZoomRequested must be a function.");
        }
        if (typeof now !== "function") {
            throw new TypeError("now must be a function.");
        }
        this.leaflet = leaflet;
        this.map = leafletMap;
        this.getVisibleTargets = getVisibleTargets;
        this.getSelectionTargets = getSelectionTargets;
        this.onSelectionDisplayChange = onSelectionDisplayChange;
        this.getFieldDisplay = getFieldDisplay;
        this.wmsUrl = wmsUrl;
        this.onInspectionChange = onInspectionChange;
        this.onSampleChange = onSampleChange;
        this.onSelectionNavigationChange = onSelectionNavigationChange;
        this.onCurrentObservationChange = onCurrentObservationChange;
        this.onFeatureProfileRequested = onFeatureProfileRequested;
        this.onTimeSeriesRequested = onTimeSeriesRequested;
        this.onStyleRequested = onStyleRequested;
        this.onFilterRequested = onFilterRequested;
        this.filterButton = documentContext.querySelector("#filter-inspected-vector-layer");
        this.onFeatureZoomRequested = onFeatureZoomRequested;
        this.document = documentContext;
        this.fetchImplementation = fetchImplementation;
        this.now = now;
        this.panel = documentContext.querySelector("#vector-feature-inspector");
        this.heading = documentContext.querySelector("#vector-feature-inspector-heading");
        this.closeButton = documentContext.querySelector("#close-vector-inspector");
        this.clearButton = documentContext.querySelector("#clear-vector-selection");
        this.timeSeriesButton = documentContext.querySelector(
            "#open-vector-time-series"
        );
        this.timeSeriesHelp = documentContext.querySelector(
            "#vector-time-series-action-help"
        );
        this.featureProfileButton = documentContext.querySelector(
            "#open-vector-feature-profile"
        );
        this.styleButton = documentContext.querySelector(
            "#style-inspected-vector-layer"
        );
        this.zoomFeatureButton = documentContext.querySelector(
            "#zoom-inspected-vector-feature"
        );
        this.status = documentContext.querySelector("#vector-feature-status");
        this.result = documentContext.querySelector("#vector-feature-result");
        this.layerName = documentContext.querySelector("#vector-feature-layer");
        this.position = documentContext.querySelector("#vector-feature-position");
        this.attributes = documentContext.querySelector("#vector-feature-attributes");
        this.fieldDisplay = new VectorFeatureFieldDisplay(documentContext, formatVectorFeatureAttribute,
            () => this.#showAttributes(this.results[this.resultIndex]));
        this.previous = documentContext.querySelector("#previous-vector-feature");
        this.next = documentContext.querySelector("#next-vector-feature");
        this.previousSelection = documentContext.querySelector("#previous-vector-selection");
        this.nextSelection = documentContext.querySelector("#next-vector-selection");
        this.results = [];
        this.resultIndex = 0;
        this.highlightLayer = null;
        this.abortController = null;
        this.requestGeneration = 0;
        this.mapContainer = this.map.getContainer();
        this.onClose = () => this.close({ moveFocus: true });
        /** Clear the selected attributes and all derived presentation. @return {void} */
        this.onClear = () => this.clearSelection();
        this.onOpenFeatureProfile = () => {
            if (!this.featureProfileButton.disabled) {
                this.onFeatureProfileRequested();
            }
        };
        this.onOpenTimeSeries = () => {
            if (!this.timeSeriesButton.disabled) this.onTimeSeriesRequested();
        };
        this.onOpenFilter = () => {
            const selected = this.results[this.resultIndex];
            if (selected !== undefined) this.onFilterRequested(selected.target.sourceId);
        };
        this.filterButton?.addEventListener("click", this.onOpenFilter);
        this.onOpenStyle = () => {
            const selected = this.results[this.resultIndex];
            if (selected !== undefined && !this.styleButton.disabled) {
                this.onStyleRequested(selected.target.sourceId);
            }
        };
        this.onZoomFeature = () => {
            const selected = this.results[this.resultIndex];
            if (selected === undefined || this.zoomFeatureButton.disabled) return;
            const observation = vectorInspectionObservation(selected);
            if (!this.onFeatureZoomRequested(observation.focus)) {
                this.zoomFeatureButton.disabled = true;
                this.status.textContent = "Feature location is unavailable. The map has not moved.";
            }
        };
        this.onPrevious = () => this.navigateResult("previous");
        this.onNext = () => this.navigateResult("next");
        this.onPreviousSelection = () => this.navigateSelection("previous");
        this.onNextSelection = () => this.navigateSelection("next");
        this.onKeydown = (event) => {
            if (event.key !== "Escape" || this.panel.hidden || !(
                this.panel.contains(this.document.activeElement) ||
                this.document.activeElement === this.closeButton ||
                this.document.activeElement === this.mapContainer
            )) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.close({ moveFocus: true });
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.clearButton.addEventListener("click", this.onClear);
        this.featureProfileButton.addEventListener(
            "click",
            this.onOpenFeatureProfile
        );
        this.timeSeriesButton.addEventListener("click", this.onOpenTimeSeries);
        this.styleButton.addEventListener("click", this.onOpenStyle);
        this.zoomFeatureButton.addEventListener("click", this.onZoomFeature);
        this.previous.addEventListener("click", this.onPrevious);
        this.next.addEventListener("click", this.onNext);
        this.previousSelection.addEventListener("click", this.onPreviousSelection);
        this.nextSelection.addEventListener("click", this.onNextSelection);
        this.document.addEventListener("keydown", this.onKeydown);
        if (this.filterButton) this.filterButton.hidden = true;
        this.styleButton.hidden = true;
        this.styleButton.disabled = true;
        this.zoomFeatureButton.disabled = true;
        this.clearButton.disabled = true;
        this.status.textContent = "Use Picker or Lasso to select features, then inspect their attributes or plot their fields.";
        this.#updateTimeSeriesAction(0);
        this.syncVisibleLayers();
    }

    /**
     * Return validated visible vector targets in top-first map order.
     *
     * @return {import("./feature-info.js").VectorFeatureInspectionTarget[]} Current inspection targets.
     * @throws {TypeError} If composition violates the target contract.
     */
    visibleTargets() {
        const targets = this.getVisibleTargets();
        if (!Array.isArray(targets)) {
            throw new TypeError("getVisibleTargets must return an array.");
        }
        for (const target of targets) {
            if (
                typeof target?.sourceId !== "string" ||
                target.sourceId.length === 0 ||
                typeof target?.label !== "string" ||
                target.label.length === 0 ||
                !Array.isArray(target?.bbox) ||
                target.bbox.length !== 4 ||
                !target.bbox.every(Number.isFinite) ||
                Math.abs(target.bbox[0]) > 180 ||
                Math.abs(target.bbox[2]) > 180 ||
                target.bbox[1] < -90 ||
                target.bbox[3] > 90 ||
                target.bbox[1] > target.bbox[3] ||
                typeof target?.publication?.layerName !== "string" ||
                typeof target?.publication?.styleName !== "string" ||
                !["point", "line", "polygon"].includes(target?.geometryKind) ||
                !Array.isArray(target?.propertyNames) ||
                !target.propertyNames.every((name) =>
                    typeof name === "string" && name.length > 0
                ) ||
                !(
                    target?.primaryGeometry === null ||
                    typeof target?.primaryGeometry === "string"
                )
            ) {
                throw new TypeError("Invalid vector feature inspection target.");
            }
        }
        return targets;
    }

    /**
     * Invalidate removed or changed sources without coupling Lasso to map visibility.
     * Click history retains its published-view context; Lasso retains its original
     * source and predicate. Valid history remains available after an invalidation.
     * Refresh display names without repeating feature queries or discarding results.
     *
     * @return {void}
     */
    syncVisibleLayers() {
        const targets = [...this.getSelectionTargets().map(target => ({sourceId: target.key, label: target.label})), ...this.visibleTargets()];
        if (this.#refreshResultNames(targets)) {
            if (this.results.length) this.showResult(this.resultIndex);
            this.onSelectionDisplayChange(this.#selectionDisplay);
            if (this.lastSample) {
                const message = this.#selectionDisplay === null ? this.lastSample.message :
                    formatLassoSelectionStatus(this.#selectionDisplay);
                this.status.textContent = message;
                this.#publishSample(this.lastSample.state, this.results, message, this.lastSample.failedLayers);
            }
        }
        let retainedIndex = -1;
        this.#selectionHistory = this.#selectionHistory.filter((selection, index) => {
            const retained = this.#selectionIsCurrent(selection.context);
            if (retained && index <= this.#selectionHistoryIndex) retainedIndex++;
            return retained;
        });
        this.#selectionHistoryIndex = retainedIndex;
        if (this.#selectionContext !== null && !this.#selectionIsCurrent(this.#selectionContext)) {
            this.#cancelInspection();
            this.clearResults();
            this.#selectionContext = null;
            this.#inspectionPosition = null;
            this.#selectionDisplay = null;
            this.onSelectionDisplayChange(null);
            this.status.textContent = "The selected layer or filter changed. Use Picker or Lasso to select features again.";
            this.#publishSample("invalidated", [], this.status.textContent);
        }
        this.#publishSelectionNavigation();
    }

    /** Check a saved source context against composition's current sources.
     * @param {FeatureSelectionContext} context Acquisition context.
     * @return {boolean} Whether its source and predicate are still available.
     */
    #selectionIsCurrent(context) {
        if (context.kind === "click") return context.signature === this.#targetSignature(this.visibleTargets());
        return this.getSelectionTargets().some(target => target.key === context.key &&
            JSON.stringify(target.selection) === JSON.stringify(context.selection));
    }

    /**
     * Convert optional WMS result geometry from the map CRS to longitude/latitude.
     *
     * Attribute-only requests normally return null geometry. Layers without
     * attributes can return geometry in the requested CRS; focus and GeoJSON
     * highlighting still need geographic coordinates. Preserve nesting and altitude.
     *
     * @param {Object} feature Feature returned by GetFeatureInfo in the map CRS.
     * @return {Object} Feature with geographic geometry, or the unchanged
     * attribute-only feature.
     */
    featureWithGeographicGeometry(feature) {
        if (!feature.geometry) return feature;
        const geometry = structuredClone(feature.geometry);
        const geometries = [geometry];
        const coordinates = [];
        while (geometries.length > 0) {
            const current = geometries.pop();
            if (Array.isArray(current?.geometries)) {
                for (const child of current.geometries) geometries.push(child);
            } else if (Array.isArray(current?.coordinates)) {
                coordinates.push(current.coordinates);
            }
        }
        while (coordinates.length > 0) {
            const current = coordinates.pop();
            if (Number.isFinite(current[0]) && Number.isFinite(current[1])) {
                const geographic = this.map.options.crs.unproject({ x: current[0], y: current[1] });
                current[0] = geographic.lng;
                current[1] = geographic.lat;
            } else {
                for (const child of current) {
                    if (Array.isArray(child)) coordinates.push(child);
                }
            }
        }
        return { ...feature, geometry };
    }

    /**
     * Hide feature details while retaining the completed selection for plots and history.
     * Cancel an unfinished replacement and restore the last completed selection.
     *
     * @param {Object} [options] Close options.
     * @param {boolean} [options.moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    close({ moveFocus = false } = {}) {
        const pending = this.abortController !== null;
        this.#cancelInspection();
        if (pending) this.#restoreCompletedSelection();
        this.onInspectionChange(false);
        if (moveFocus) this.mapContainer.focus();
    }

    /** Clear selected features, plots and history, and cancel any unfinished replacement.
     * @return {void}
     */
    clearSelection() {
        this.#cancelInspection();
        this.#clearSelectionHistory();
        this.clearResults();
        this.#selectionContext = null;
        this.#selectionDisplay = null;
        this.onSelectionDisplayChange(null, {cancelGesture:true});
        this.status.textContent = "Selection cleared. Use Picker or Lasso to select features.";
        this.#publishSample("empty", [], this.status.textContent);
    }

    /** Whether the map may start another feature inspection. */
    #pickingEnabled = true;

    /**
     * Enable map-click acquisition or cancel an unfinished click and restore completed selection.
     * Lasso acquisition has its own cancellation signal and is unaffected.
     * Existing results remain available to the inspector and its plots.
     * @param {boolean} enabled Whether map clicks may acquire features.
     * @return {void}
     */
    setPickingEnabled(enabled) {
        this.#pickingEnabled = enabled;
        if (enabled || this.abortController === null || this.#selectionContext?.kind !== "click") return;
        this.#cancelInspection();
        this.#restoreCompletedSelection();
        if (this.#selectionHistoryIndex < 0) this.onInspectionChange(false);
    }

    /** Restore the preceding completed selection after cancelling a replacement.
     * Keep forward history available when no earlier completed selection remains.
     * @return {void}
     */
    #restoreCompletedSelection() {
        if (this.#selectionHistoryIndex >= 0) {
            this.#restoreSelection(this.#selectionHistoryIndex);
            return;
        }
        this.#selectionContext = null;
        this.#inspectionPosition = null;
        this.#selectionDisplay = null;
        this.onSelectionDisplayChange(null);
        this.clearResults();
        const message = "Feature inspection cancelled.";
        this.status.textContent = message;
        this.#publishSample("empty", [], message);
    }

    /**
     * Replace selected features with exact Lasso membership and original scalar attributes.
     * This acquisition is independent of map-click picking and WMS publication.
     * Cancelling restores the previous completed selection; a failed read publishes
     * an error with no partial attributes and leaves completed history available.
     * @param {VectorSelectionTarget} target Captured retained source and predicate.
     * @param {Object} polygon Closed WGS 84 Lasso polygon.
     * @param {AbortSignal} signal Gesture owner's cancellation signal.
     * @return {Promise<void>} Completes after attributes and display are published.
     * @throws {Error} If selection or attribute reading fails.
     * @throws {DOMException} If cancelled, cleared or superseded.
     */
    async inspectLasso(target, polygon, signal) {
        signal.throwIfAborted();
        const generation = this.#cancelInspection();
        const abort = new AbortController();
        this.abortController = abort;
        this.#selectionContext = {kind: "lasso", key: target.key, selection: structuredClone(target.selection)};
        this.#inspectionPosition = null;
        this.#selectionDisplay = null;
        this.clearResults();
        this.status.textContent = `Selecting features in ${target.label}…`;
        this.onInspectionChange(true);
        this.#publishSample("loading", [], this.status.textContent);
        /** Restore completed selection when the gesture owner cancels this acquisition. @return {void} */
        const cancel = () => {
            if (generation !== this.requestGeneration) return;
            this.#cancelInspection();
            this.#restoreCompletedSelection();
        };
        signal.addEventListener("abort", cancel, {once: true});
        try {
            const selected = await selectLassoFeatures(target.selection, polygon, abort.signal, this.fetchImplementation);
            abort.signal.throwIfAborted();
            this.status.textContent = `Reading attributes for ${selected.matched} selected features in ${target.label}…`;
            this.#publishSample("loading", [], this.status.textContent);
            const rows = selected.matched === 0 ? [] : await getSelectedVectorFeatures(
                target.selection, selected.featureIds, abort.signal, this.fetchImplementation);
            abort.signal.throwIfAborted();
            const currentTarget = this.getSelectionTargets().find(value => value.key === target.key);
            if (!this.#selectionIsCurrent(this.#selectionContext)) {
                this.syncVisibleLayers();
                throw new DOMException("The selected source changed.", "AbortError");
            }
            this.results = rows.map(row => ({
                feature: {...row, geometry: null},
                target: {sourceId: target.key, label: currentTarget.label},
                inspectionPosition: null,
            }));
            this.#selectionDisplay = {polygon, geometry: selected.geometry, count: selected.matched, label: currentTarget.label};
            this.#updateTimeSeriesAction(rows.length);
            if (rows.length) this.showResult(0);
            this.status.textContent = formatLassoSelectionStatus(this.#selectionDisplay);
            this.#finishSelection(rows.length ? "ready" : "empty", this.status.textContent);
        } catch (error) {
            if (generation === this.requestGeneration && error.name !== "AbortError") {
                this.clearResults();
                this.#selectionDisplay = null;
                this.onSelectionDisplayChange(null);
                this.status.textContent = error.message;
                this.#finishSelection("empty", error.message, 1);
            }
            throw error;
        } finally {
            signal.removeEventListener("abort", cancel);
            if (generation === this.requestGeneration) this.abortController = null;
        }
    }

    /**
     * Inspect every currently visible vector target at one map click when picking is active.
     *
     * @param {Object} event Leaflet map-click event.
     * @return {Promise<boolean>} Whether visible vector targets were inspected.
     */
    async inspect(event) {
        if (!this.#pickingEnabled) return false;
        const visibleTargets = this.visibleTargets();
        if (visibleTargets.length === 0) {
            return false;
        }
        const generation = this.#cancelInspection();
        const position = Object.freeze({ lng: event.latlng.lng, lat: event.latlng.lat });
        this.#inspectionPosition = position;
        this.#selectionContext = {kind: "click", signature: this.#targetSignature(visibleTargets)};
        this.#selectionDisplay = null;
        this.onSelectionDisplayChange(null);
        this.clearResults();
        const targets = visibleTargets.filter((target) =>
            vectorBoundsContainPosition(target.bbox, position)
        );
        if (targets.length === 0) {
            const message = "No vector feature was found at that location.";
            this.status.textContent =
                "Click the map to inspect visible vector features.";
            if (!this.panel.hidden) this.onInspectionChange(false);
            this.#finishSelection("empty", message);
            return true;
        }
        const abortController = new AbortController();
        this.abortController = abortController;
        const startedAt = this.now();
        const targetResults = targets.map(() => ({
            complete: false,
            results: [],
            failure: null,
        }));
        const initialMessage = `Inspecting ${targets.length} visible vector ` +
            `layer${targets.length === 1 ? "" : "s"}…`;
        this.status.textContent = initialMessage;
        // Composition reveals availability; the inspection workspace owns focus.
        this.onInspectionChange(true);
        this.#publishSample(
            "loading",
            [],
            initialMessage
        );
        const containerPoint = event.containerPoint ??
            this.map.latLngToContainerPoint(event.latlng);
        const viewport = getFeatureInfoViewport(this.map, containerPoint);
        await Promise.all(targets.map(async (target, targetIndex) => {
            let results = [];
            let failure = null;
            try {
                const features = await fetchVectorFeatureInfo({
                    wmsUrl: this.wmsUrl,
                    publication: target.publication,
                    propertyNames: target.propertyNames,
                    includeBounds: true,
                    viewport,
                    signal: abortController.signal,
                }, this.fetchImplementation);
                results = features.map((feature) => ({
                    feature: this.featureWithGeographicGeometry(feature),
                    target,
                    inspectionPosition: position,
                }));
            } catch (error) {
                failure = error;
            }
            if (generation !== this.requestGeneration) return;
            targetResults[targetIndex] = {
                complete: true,
                results,
                failure,
            };
            this.#presentProgress({ targetResults, startedAt });
        }));
        if (generation !== this.requestGeneration) {
            return false;
        }
        this.abortController = null;
        return true;
    }

    /**
     * Merge one or more completed target slots and update progressive UI state.
     *
     * Slots retain visible-layer order even when network responses complete out
     * of order. If a late result belongs before the selected feature, selection
     * follows the same result object instead of unexpectedly changing feature.
     *
     * @param {Object} progress Current inspection progress.
     * @param {Object[]} progress.targetResults Ordered per-target result slots.
     * @param {number} progress.startedAt Monotonic inspection start time.
     * @return {void}
     */
    #presentProgress({ targetResults, startedAt }) {
        const previouslySelected = this.results[this.resultIndex] ?? null;
        this.results = targetResults.flatMap((targetResult) =>
            targetResult.results
        );
        this.#refreshResultNames(this.visibleTargets());
        if (this.results.length > 0) {
            const retainedIndex = previouslySelected === null
                ? 0
                : this.results.indexOf(previouslySelected);
            this.showResult(retainedIndex < 0 ? 0 : retainedIndex);
        }
        this.#updateTimeSeriesAction(this.results.length);

        const completedCount = targetResults.filter(
            (targetResult) => targetResult.complete
        ).length;
        const pendingCount = targetResults.length - completedCount;
        const failureResults = targetResults.filter((targetResult) =>
            targetResult.complete &&
            targetResult.failure !== null &&
            targetResult.failure?.name !== "AbortError"
        );
        const duration = formatInspectionDuration(this.now() - startedAt);
        if (pendingCount > 0) {
            const featureSummary = this.results.length === 0
                ? ""
                : `${this.results.length} feature` +
                  `${this.results.length === 1 ? "" : "s"} found; `;
            this.status.textContent = featureSummary +
                `${completedCount} of ${targetResults.length} vector layers ` +
                `inspected in ${duration}; waiting for ${pendingCount} more…`;
            this.#publishSample("loading", this.results, this.status.textContent, failureResults.length);
            return;
        }
        if (this.results.length > 0) {
            const failureSummary = failureResults.length === 0
                ? ""
                : `; ${failureResults.length} of ${targetResults.length} vector ` +
                  `layers could not be inspected`;
            this.status.textContent = `${this.results.length} feature` +
                `${this.results.length === 1 ? "" : "s"} found in ${duration}` +
                `${failureSummary}.`;
            this.#finishSelection("ready", this.status.textContent, failureResults.length);
            return;
        }
        const failure = failureResults[0]?.failure;
        const message = failure instanceof VectorFeatureInfoError
            ? failure.message
            : failure ? "Vector inspection failed. Click the map to retry."
                : "No vector feature was found at that location.";
        if (failure) {
            this.status.textContent = `${message} Inspection finished in ${duration}.`;
        } else {
            this.status.textContent =
                "Click the map to inspect visible vector features.";
            if (!this.panel.hidden) this.onInspectionChange(false);
        }
        this.#finishSelection("empty", message, failureResults.length);
    }

    /**
     * Cancel the active feature request and supersede any responses still in flight.
     * @return {number} Generation used to accept results from the next inspection.
     */
    #cancelInspection() {
        this.requestGeneration += 1;
        this.abortController?.abort();
        this.abortController = null;
        return this.requestGeneration;
    }

    /**
     * Release saved selections when their inspection context ends.
     * @return {void}
     */
    #clearSelectionHistory() {
        this.#selectionHistory = [];
        this.#selectionHistoryIndex = -1;
        this.#inspectionPosition = null;
    }

    /**
     * Identify a feature set without equating WMS display IDs with original IDs.
     * Repeated selections deduplicate within the same original source or publication.
     * @param {InspectedVectorFeature[]} results Features from one completed inspection.
     * @return {string|null} Source, publication and feature IDs, or null if a feature has no ID.
     */
    #identifyFeatureSelection(results) {
        const ids = [];
        for (const { feature, target } of results) {
            const id = feature.id;
            if (typeof id !== "number" && !(typeof id === "string" && id.length)) return null;
            ids.push(JSON.stringify([target.sourceId, target.publication?.layerName ?? null, String(id)]));
        }
        return JSON.stringify(ids.sort());
    }

    /**
     * Save a completed result and publish it to the current plots and inspector.
     * A different selection drops forward entries. An unsuccessful read with no
     * features leaves the prior selections available.
     *
     * @param {"ready"|"empty"} state Completed result state.
     * @param {string} message Status for the completed inspection.
     * @param {number} [failedLayers=0] Layers whose reads failed.
     * @return {void}
     */
    #finishSelection(state, message, failedLayers = 0) {
        if (state === "ready" || failedLayers === 0) {
            const identity = this.#identifyFeatureSelection(this.results);
            const selection = {
                identity, results: this.results, resultIndex: this.resultIndex,
                position: this.#inspectionPosition, state, message, failedLayers,
                context: this.#selectionContext, display: this.#selectionDisplay,
            };
            const current = this.#selectionHistory[this.#selectionHistoryIndex];
            if (identity !== null && identity === current?.identity) {
                this.#selectionHistory[this.#selectionHistoryIndex] = selection;
            } else {
                this.#selectionHistory.splice(this.#selectionHistoryIndex + 1, this.#selectionHistory.length, selection);
                if (this.#selectionHistory.length > MAX_SELECTION_HISTORY_ENTRIES) this.#selectionHistory.shift();
                this.#selectionHistoryIndex = this.#selectionHistory.length - 1;
            }
        }
        this.onSelectionDisplayChange(this.#selectionDisplay);
        this.#publishSample(state, this.results, message, failedLayers);
    }

    /**
     * Locate a saved selection before or after the current history position.
     * An unfinished, failed or invalidated view lies after its preceding retained
     * entry, so Previous restores that entry and Next preserves forward navigation.
     *
     * @param {"previous"|"next"} direction History direction.
     * @return {number} Index of the destination, or -1 if unavailable.
     */
    #adjacentSelectionIndex(direction) {
        const index = this.#selectionHistoryIndex;
        const displayingSavedSelection = this.#selectionHistory[index]?.results === this.results;
        if (direction === "previous") return displayingSavedSelection ? index - 1 : index;
        return index + 1 < this.#selectionHistory.length ? index + 1 : -1;
    }

    /**
     * Enable the available history directions in Features and publish them to the plot.
     * @return {void}
     */
    #publishSelectionNavigation() {
        const navigation = Object.freeze({
            canPrevious: this.#adjacentSelectionIndex("previous") >= 0,
            canNext: this.#adjacentSelectionIndex("next") >= 0,
        });
        this.previousSelection.disabled = !navigation.canPrevious;
        this.nextSelection.disabled = !navigation.canNext;
        this.onSelectionNavigationChange(navigation);
    }

    /**
     * Restore the features, location and active highlight from one adjacent
     * selection. Supersede unfinished inspection without moving the map.
     *
     * @param {"previous"|"next"} direction History direction.
     * @return {void}
     * @throws {TypeError} If direction is invalid.
     */
    navigateSelection(direction) {
        if (direction !== "previous" && direction !== "next") {
            throw new TypeError("Selection navigation direction must be previous or next.");
        }
        const index = this.#adjacentSelectionIndex(direction);
        if (index < 0) return;

        const button = direction === "previous" ? this.previousSelection : this.nextSelection;
        const opposite = direction === "previous" ? this.nextSelection : this.previousSelection;
        const wasFocused = this.document.activeElement === button;
        this.#cancelInspection();
        this.#restoreSelection(index, {cancelGesture:true});
        if (wasFocused && button.disabled && !opposite.disabled) opposite.focus();
    }

    /** Present a completed selection and keep the history controls available across empty results.
     * @param {number} index Position of the completed selection in history.
     * @param {{cancelGesture:boolean}} [options] Cancel the map gesture when the user navigates history.
     * @return {void}
     */
    #restoreSelection(index, options) {
        const selection = this.#selectionHistory[index];
        this.#selectionHistoryIndex = index;
        this.#inspectionPosition = selection.position;
        this.#selectionContext = selection.context;
        this.#selectionDisplay = selection.display;
        this.results = selection.results;
        this.#refreshResultNames([...this.getSelectionTargets().map(target => ({sourceId: target.key, label: target.label})), ...this.visibleTargets()]);
        if (selection.state === "ready") {
            this.showResult(selection.resultIndex);
            this.#updateTimeSeriesAction(this.results.length);
            this.onInspectionChange(true);
        } else {
            this.clearResults();
            this.results = selection.results;
        }
        const message = selection.display === null ? selection.message : formatLassoSelectionStatus(selection.display);
        this.status.textContent = message;
        this.onSelectionDisplayChange(this.#selectionDisplay, options);
        this.#publishSample(selection.state, selection.results, message, selection.failedLayers);
    }

    /**
     * Update selected attributes and optional Lasso display labels without changing identities.
     * @param {Array<{sourceId:string,label:string}>} targets Current source display names.
     * @return {boolean} Whether any result name changed.
     */
    #refreshResultNames(targets) {
        const names = new Map(targets.map(target => [target.sourceId, target.label]));
        let changed = false;
        for (const result of this.results) {
            const label = names.get(result.target.sourceId);
            if (label !== undefined && label !== result.target.label) {
                result.target = { ...result.target, label };
                changed = true;
            }
        }
        if (this.#selectionDisplay !== null && this.#selectionContext?.kind === "lasso") {
            const label = names.get(this.#selectionContext.key);
            if (label !== undefined && this.#selectionDisplay.label !== label) {
                this.#selectionDisplay.label = label;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * Return a stable source and publication identity independent of drawing order and styling.
     *
     * @param {import("./feature-info.js").VectorFeatureInspectionTarget[]} targets Visible vector targets.
     * @return {string} Stable visible-publication signature.
     */
    #targetSignature(targets) {
        return JSON.stringify(targets.map(({ sourceId, publication }) =>
            JSON.stringify([sourceId, publication.layerName])
        ).sort());
    }

    /**
     * Publish the frozen inspection sample and available history directions through composition.
     *
     * @param {"loading"|"ready"|"empty"|"invalidated"} state Sample state.
     * @param {InspectedVectorFeature[]} results Inspector-owned feature results.
     * @param {string} message Browser-safe sample status.
     * @param {number} [failedLayers=0] Completed layers whose inspection failed.
     * @return {void}
     */
    #publishSample(state, results, message, failedLayers = 0) {
        this.clearButton.disabled = state !== "loading" && results.length === 0 && this.#selectionHistory.length === 0;
        const observations = Object.freeze(
            results.map(vectorInspectionObservation)
        );
        this.lastSample = Object.freeze({ state, observations, message, failedLayers, position: this.#inspectionPosition });
        this.onSampleChange(this.lastSample);
        this.#publishSelectionNavigation();
    }

    /**
     * Keep selected-feature action eligibility and its explanation together.
     *
     * @param {number} featureCount Number of results at the inspected location.
     * @return {void}
     */
    #updateTimeSeriesAction(featureCount) {
        const available = featureCount >= 2;
        this.timeSeriesButton.disabled = !available;
        this.timeSeriesHelp.textContent = available
            ? TIME_SERIES_AVAILABLE_HELP
            : TIME_SERIES_UNAVAILABLE_HELP;
    }

    /**
     * Move to an adjacent result while retaining ownership of selection state.
     *
     * @param {"previous"|"next"} direction Adjacent result to select.
     * @return {void}
     */
    navigateResult(direction) {
        if (direction !== "previous" && direction !== "next") {
            throw new TypeError("Feature navigation direction must be previous or next.");
        }
        if (this.results.length === 0) return;
        const offset = direction === "previous" ? -1 : 1;
        const nextIndex = this.resultIndex + offset;
        if (nextIndex < 0 || nextIndex >= this.results.length) return;
        this.showResult(nextIndex);
    }

    /**
     * Present one result with its returned feature ID and replace its map highlight.
     * Results without an ID retain the plain inspector heading.
     * WMS highlights remain visible through the map's maximum zoom of 22.
     *
     * @param {number} index Zero-based result index.
     * @return {void}
     */
    showResult(index) {
        if (this.results.length === 0) {
            return;
        }
        this.resultIndex = Math.min(this.results.length - 1, Math.max(0, index));
        const selection = this.#selectionHistory[this.#selectionHistoryIndex];
        if (selection?.results === this.results) selection.resultIndex = this.resultIndex;
        const { feature, target } = this.results[this.resultIndex];
        const observation = vectorInspectionObservation(
            this.results[this.resultIndex]
        );
        const navigation = Object.freeze({
            position: this.resultIndex + 1,
            total: this.results.length,
            canPrevious: this.resultIndex > 0,
            canNext: this.resultIndex < this.results.length - 1,
        });
        this.result.hidden = false;
        this.heading.textContent = observation.featureId === null
            ? "Feature inspector"
            : `Feature inspector (FID ${observation.featureId})`;
        this.heading.title = this.heading.textContent;
        this.layerName.textContent = target.label;
        if (this.filterButton) this.filterButton.hidden = false;
        this.styleButton.hidden = false;
        this.styleButton.disabled = false;
        this.zoomFeatureButton.disabled = observation.focus === null;
        this.zoomFeatureButton.title = observation.focus === null ? "Feature location is unavailable for this selection." : "";
        if (this.lastSample) this.status.textContent = this.lastSample.message;
        this.styleButton.setAttribute("aria-label", `Style ${target.label}`);
        this.position.textContent = `${navigation.position} of ${navigation.total}`;
        this.previous.disabled = !navigation.canPrevious;
        this.next.disabled = !navigation.canNext;
        this.featureProfileButton.disabled = !Object.values(observation.properties).some(isNumericFeatureValue);
        this.onCurrentObservationChange(observation, navigation);
        this.#showAttributes(this.results[this.resultIndex]);
        this.clearHighlight();
        if (target.publication && typeof feature.id === "string" && feature.id.length > 0) {
            const highlightLayer = this.leaflet.tileLayer.wms(this.wmsUrl, {
                layers: target.publication.layerName,
                styles: `vector-highlight-${target.geometryKind}`,
                format: "image/png",
                transparent: true,
                version: "1.1.1",
                featureid: feature.id,
                maxZoom: 22,
            });
            this.highlightLayer = highlightLayer.addTo(this.map);
        } else if (feature.geometry !== null) {
            this.highlightLayer = this.leaflet.geoJSON(feature, {
                style: HIGHLIGHT_STYLE,
                pointToLayer: (_pointFeature, latlng) =>
                    this.leaflet.circleMarker(latlng, HIGHLIGHT_STYLE),
            }).addTo(this.map);
        }
    }

    /**
     * Present the selected feature's attributes using the current view's display settings.
     * @param {InspectedVectorFeature} selected Inspected feature and its original source or published layer.
     * @return {void}
     */
    #showAttributes({feature, target}) {
        const display = this.getFieldDisplay(target.sourceId);
        this.fieldDisplay.show(display && {...display, sourceId: target.sourceId, properties: feature.properties});
        this.attributes.replaceChildren();
        const entries = vectorFeatureAttributes(feature, target.primaryGeometry, display?.formats);
        if (entries.length === 0) {
            const term = this.document.createElement("dt");
            term.textContent = "Attributes";
            const description = this.document.createElement("dd");
            description.textContent = "No user-facing attributes were returned.";
            this.attributes.append(term, description);
        } else {
            for (const entry of entries) {
                const term = this.document.createElement("dt");
                term.textContent = entry.name;
                const description = this.document.createElement("dd");
                description.textContent = entry.value;
                this.attributes.append(term, description);
            }
        }
    }

    /**
     * Clear selected results and their map highlight, restoring the plain heading.
     *
     * @return {void}
     */
    clearResults() {
        this.results = [];
        this.resultIndex = 0;
        this.result.hidden = true;
        this.heading.textContent = "Feature inspector";
        this.heading.title = this.heading.textContent;
        this.#updateTimeSeriesAction(0);
        this.featureProfileButton.disabled = true;
        if (this.filterButton) this.filterButton.hidden = true;
        this.styleButton.hidden = true;
        this.styleButton.disabled = true;
        this.zoomFeatureButton.disabled = true;
        this.styleButton.setAttribute(
            "aria-label", "Style selected vector layer"
        );
        this.onCurrentObservationChange(null, null);
        this.fieldDisplay.show(null);
        this.attributes.replaceChildren();
        this.clearHighlight();
    }

    /**
     * Remove the selected feature overlay if one exists.
     *
     * @return {void}
     */
    clearHighlight() {
        if (this.highlightLayer !== null) {
            this.map.removeLayer(this.highlightLayer);
            this.highlightLayer = null;
        }
    }

    /**
     * Permanently release listeners and transient state.
     *
     * @return {void}
     */
    destroy() {
        this.clearSelection();
        this.close();
        this.fieldDisplay.destroy();
        this.closeButton.removeEventListener("click", this.onClose);
        this.clearButton.removeEventListener("click", this.onClear);
        this.featureProfileButton.removeEventListener(
            "click",
            this.onOpenFeatureProfile
        );
        this.timeSeriesButton.removeEventListener("click", this.onOpenTimeSeries);
        this.styleButton.removeEventListener("click", this.onOpenStyle);
        this.filterButton?.removeEventListener("click", this.onOpenFilter);
        this.zoomFeatureButton.removeEventListener("click", this.onZoomFeature);
        this.previous.removeEventListener("click", this.onPrevious);
        this.next.removeEventListener("click", this.onNext);
        this.previousSelection.removeEventListener("click", this.onPreviousSelection);
        this.nextSelection.removeEventListener("click", this.onNextSelection);
        this.document.removeEventListener("keydown", this.onKeydown);
    }
}
