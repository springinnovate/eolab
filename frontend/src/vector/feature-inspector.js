/** Feature inspection and selection history for visible published vector layers. */

import { getFeatureInfoViewport } from "./feature-info-viewport.js";
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
    "Compare numeric fields across the features at this location.";
const TIME_SERIES_UNAVAILABLE_HELP =
    "Click a location with at least two features to compare their fields.";
const MAX_ATTRIBUTE_VALUE_CHARACTERS = 1000;
const MAX_SELECTION_HISTORY_ENTRIES = 20;

/**
 * @typedef {Readonly<{lng:number,lat:number}>} InspectionPosition The sampled map point.
 */

/**
 * @typedef {{feature:Object,target:import("./feature-info.js").VectorFeatureInspectionTarget,
 * inspectionPosition:InspectionPosition}} InspectedVectorFeature A bounded feature-info result.
 */

/**
 * @typedef {{identity:string|null,results:InspectedVectorFeature[],position:InspectionPosition,
 * resultIndex:number,state:"ready"|"empty",message:string,failedLayers:number}} FeatureSelection
 * A completed inspection with its last highlighted feature.
 */

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
 * @param {{lng:number,lat:number}} configuration.inspectionPosition Accepted
 * WGS 84 map-click position.
 * @return {Readonly<Object>} Feature center and optional geographic bounds.
 * Without bounds the click is retained only as context, never a zoom destination.
 * @throws {TypeError} If the inspection position is outside WGS 84.
 */
function vectorFeatureFocus({ feature, inspectionPosition }) {
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
 * @param {{feature:Object,target:import("./feature-info.js").VectorFeatureInspectionTarget,
 * inspectionPosition:{lng:number,lat:number}}} result Result.
 * @return {Readonly<Object>} Closed inspection-observation contract.
 */
export function vectorInspectionObservation({ feature, target, inspectionPosition }) {
    const properties = {};
    for (const [name, value] of Object.entries(feature.properties)) {
        if (
            value === null ||
            typeof value === "string" ||
            typeof value === "boolean" ||
            typeof value === "number"
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
    if (format?.format && Number.isFinite(value)) {
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
    #selectionHistoryIndex = -1;
    /** @type {InspectionPosition|null} */
    #inspectionPosition = null;

    /**
     * Connect map clicks to feature results, navigation and map highlights.
     *
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Initialized Leaflet map.
     * @param {() => import("./feature-info.js").VectorFeatureInspectionTarget[]}
     * configuration.getVisibleTargets Current visible vectors from composition.
     * @param {string} configuration.wmsUrl Restricted browser WMS URL.
     * @param {(visible:boolean) => void} configuration.onInspectionChange
     * Requests presentation changes without knowing the presentation owner.
     * @param {(sample:Readonly<import("./inspection-observation.js").VectorInspectionSample>,change:"inspection"|"labels")=>void} configuration.onSampleChange
     * Publishes observations through composition. Label edits refresh plots without announcing another map result.
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
     * @param {(focus:Readonly<Object>)=>boolean}
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
        this.results = [];
        this.resultIndex = 0;
        this.highlightLayer = null;
        this.abortController = null;
        this.requestGeneration = 0;
        this.sampleTargetSignature = null;
        this.mapContainer = this.map.getContainer();
        /** Dismiss the Features tab and stop outstanding reads. Keep the observations
         * and navigation already available to open plots. @return {void}
         */
        this.onClose = () => {
            if (this.abortController !== null) {
                this.#cancelInspection();
                this.#publishSample("interrupted", this.results,
                    "Inspection stopped before all layers were inspected. Click the map to try again.",
                    this.lastSample.failedLayers);
            }
            this.clearHighlight();
            this.onInspectionChange(false);
            this.mapContainer.focus();
        };
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
        /** Dismiss Features where Escape was pressed, keeping keyboard panning on the map.
         * @param {KeyboardEvent} event Original key event, including its originating control.
         * @return {void}
         */
        this.onKeydown = (event) => {
            if (event.key !== "Escape" || event.defaultPrevented || this.panel.hidden) return;
            const fromMap = event.target === this.mapContainer;
            if (!fromMap && event.target !== this.closeButton && !this.panel.contains(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            if (fromMap) this.onClose();
            else this.closeButton.click();
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.featureProfileButton.addEventListener(
            "click",
            this.onOpenFeatureProfile
        );
        this.timeSeriesButton.addEventListener("click", this.onOpenTimeSeries);
        this.styleButton.addEventListener("click", this.onOpenStyle);
        this.zoomFeatureButton.addEventListener("click", this.onZoomFeature);
        this.previous.addEventListener("click", this.onPrevious);
        this.next.addEventListener("click", this.onNext);
        this.document.addEventListener("keydown", this.onKeydown);
        if (this.filterButton) this.filterButton.hidden = true;
        this.styleButton.hidden = true;
        this.styleButton.disabled = true;
        this.zoomFeatureButton.disabled = true;
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
     * Clear results and history if the visible vector sources change.
     * Close the inspector after the last visible vector leaves.
     * Refresh display names without repeating feature queries or discarding results.
     *
     * @return {void}
     */
    syncVisibleLayers() {
        const targets = this.visibleTargets();
        if (this.#refreshResultNames(targets) && this.results.length) {
            this.showResult(this.resultIndex, { updateHighlight: false });
            if (this.lastSample) this.#publishSample(this.lastSample.state, this.results,
                this.lastSample.message, this.lastSample.failedLayers, "labels");
        }
        const available = targets.length > 0;
        const signature = this.#targetSignature(targets);
        if (
            this.sampleTargetSignature !== null &&
            signature !== this.sampleTargetSignature
        ) {
            this.#cancelInspection();
            this.#clearSelectionHistory();
            this.clearResults();
            this.sampleTargetSignature = null;
            this.status.textContent = available
                ? "Visible vector layers changed. Click the map to sample again."
                : "Show a vector layer, then click the map to inspect features.";
            this.#publishSample(
                "invalidated",
                [],
                "Visible vector layers changed. Click the map to sample again."
            );
        }
        if (!available && (
            !this.panel.hidden || this.abortController !== null ||
            this.results.length > 0
        )) {
            this.close();
        }
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
     * Hide inspection, cancel work, clear results and history, and optionally focus the map.
     *
     * @param {Object} [options] Close options.
     * @param {boolean} [options.moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    close({ moveFocus = false } = {}) {
        this.#cancelInspection();
        this.#clearSelectionHistory();
        this.clearResults();
        this.#publishSelectionNavigation();
        this.status.textContent = "Click the map to inspect visible vector features.";
        this.onInspectionChange(false);
        if (moveFocus) this.mapContainer.focus();
    }

    /** Whether the map may start another feature inspection. */
    #pickingEnabled = true;

    /**
     * Enable map-click acquisition or cancel unfinished work and restore the last completed selection.
     * Existing results remain available to the inspector and its plots.
     * @param {boolean} enabled Whether map clicks may acquire features.
     * @return {void}
     */
    setPickingEnabled(enabled) {
        this.#pickingEnabled = enabled;
        if (enabled || this.abortController === null) return;
        this.#cancelInspection();
        if (this.#selectionHistoryIndex >= 0) {
            this.#restoreSelection(this.#selectionHistoryIndex);
            return;
        }
        this.#inspectionPosition = null;
        this.clearResults();
        const message = "Feature inspection cancelled.";
        this.status.textContent = message;
        this.#publishSample("empty", [], message);
        this.onInspectionChange(false);
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
        this.sampleTargetSignature = this.#targetSignature(visibleTargets);
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
     * Identify the returned feature set independently of layer and feature order.
     * @param {InspectedVectorFeature[]} results Features from one completed inspection.
     * @return {string|null} Source and feature IDs, or null if a feature has no ID.
     */
    #identifyFeatureSelection(results) {
        const ids = [];
        for (const { feature, target } of results) {
            const id = feature.id;
            if (typeof id !== "number" && !(typeof id === "string" && id.length)) return null;
            ids.push(JSON.stringify([target.sourceId, id]));
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
        this.#publishSample(state, this.results, message, failedLayers);
    }

    /**
     * Locate an adjacent saved selection. If a click is unfinished or failed,
     * going back restores the last displayed completed selection.
     *
     * @param {"previous"|"next"} direction History direction.
     * @return {number} Index of the destination, or -1 if unavailable.
     */
    #adjacentSelectionIndex(direction) {
        const index = this.#selectionHistoryIndex;
        const displayingSavedSelection = this.#selectionHistory[index]?.results === this.results;
        if (direction === "previous") return displayingSavedSelection ? index - 1 : index;
        return displayingSavedSelection && index + 1 < this.#selectionHistory.length ? index + 1 : -1;
    }

    /**
     * Tell composition which directions currently lead to a saved selection.
     * @return {void}
     */
    #publishSelectionNavigation() {
        this.onSelectionNavigationChange(Object.freeze({
            canPrevious: this.#adjacentSelectionIndex("previous") >= 0,
            canNext: this.#adjacentSelectionIndex("next") >= 0,
        }));
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

        this.#cancelInspection();
        this.#restoreSelection(index);
    }

    /** Present a completed selection from the inspector's existing history.
     * @param {number} index Position of the completed selection in history.
     * @return {void}
     */
    #restoreSelection(index) {
        const selection = this.#selectionHistory[index];
        this.#selectionHistoryIndex = index;
        this.#inspectionPosition = selection.position;
        if (selection.state === "ready") {
            this.results = selection.results;
            this.#refreshResultNames(this.visibleTargets());
            this.showResult(selection.resultIndex);
            this.#updateTimeSeriesAction(this.results.length);
        } else {
            this.clearResults();
            this.results = selection.results;
        }
        this.status.textContent = selection.message;
        this.onInspectionChange(selection.state === "ready");
        this.#publishSample(selection.state, selection.results, selection.message, selection.failedLayers);
    }

    /**
     * Update retained result labels from current visible targets without changing their identities.
     * @param {import("./feature-info.js").VectorFeatureInspectionTarget[]} targets Current map-layer presentation.
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
     * @param {import("./inspection-observation.js").VectorInspectionSample["state"]} state Sample state.
     * @param {InspectedVectorFeature[]} results Inspector-owned feature results.
     * @param {string} message Browser-safe sample status.
     * @param {number} [failedLayers=0] Completed layers whose inspection failed.
     * @param {"inspection"|"labels"} [change="inspection"] Whether the inspection changed or its layer names were edited.
     * @return {void}
     */
    #publishSample(state, results, message, failedLayers = 0, change = "inspection") {
        const observations = Object.freeze(
            results.map(vectorInspectionObservation)
        );
        this.lastSample = Object.freeze({ state, observations, message, failedLayers, position: this.#inspectionPosition });
        this.onSampleChange(this.lastSample, change);
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
     * @param {Object} [options] Selected feature presentation.
     * @param {boolean} [options.updateHighlight=true] Draw the selection on the map. A layer rename only refreshes its text.
     * @return {void}
     */
    showResult(index, { updateHighlight = true } = {}) {
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
        this.zoomFeatureButton.disabled = false;
        if (this.lastSample) this.status.textContent = this.lastSample.message;
        this.styleButton.setAttribute("aria-label", `Style ${target.label}`);
        this.position.textContent = `${navigation.position} of ${navigation.total}`;
        this.previous.disabled = !navigation.canPrevious;
        this.next.disabled = !navigation.canNext;
        this.featureProfileButton.disabled = !Object.values(observation.properties).some(Number.isFinite);
        this.onCurrentObservationChange(observation, navigation);
        this.#showAttributes(this.results[this.resultIndex]);
        if (!updateHighlight) return;
        this.clearHighlight();
        if (typeof feature.id === "string" && feature.id.length > 0) {
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
     * @param {{feature:Object,target:import("./feature-info.js").VectorFeatureInspectionTarget}} selected Inspected feature and layer.
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
        this.close();
        this.fieldDisplay.destroy();
        this.closeButton.removeEventListener("click", this.onClose);
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
        this.document.removeEventListener("keydown", this.onKeydown);
    }
}
