/** One-shot feature inspection for visible published vector layers. */

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
const MAX_ATTRIBUTE_VALUE_CHARACTERS = 1000;

/**
 * @typedef {Object} VectorFeatureInspectionTarget
 * @property {string} sourceId Opaque retained-source identity from composition.
 * @property {string} label User-facing retained-layer label.
 * @property {{layerName:string,styleName:string}} publication Authorized WMS
 * publication identity.
 * @property {string|null} primaryGeometry Catalog-declared geometry field.
 */

/**
 * Return an immutable scalar-only observation for sibling analysis tools.
 *
 * Geometry and nested values stay owned by the feature inspector. The analysis
 * boundary contains only the fields needed to order and chart inspected rows.
 *
 * @param {{feature:Object,target:VectorFeatureInspectionTarget}} result Result.
 * @return {Readonly<Object>} Closed inspection-observation contract.
 */
export function vectorInspectionObservation({ feature, target }) {
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
        properties: Object.freeze(properties),
    });
}

/**
 * Format an arbitrary GeoJSON property as bounded display text.
 *
 * @param {*} value GeoJSON property value.
 * @return {string} Safe text capped at the presentation limit.
 */
export function formatVectorFeatureAttribute(value) {
    let text;
    if (value === null || value === undefined) {
        return "No value";
    }
    if (typeof value === "boolean") {
        return value ? "True" : "False";
    }
    if (typeof value === "object") {
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
 * Return user-facing properties while excluding geometry metadata.
 *
 * @param {Object} feature Validated GeoJSON Feature.
 * @param {string|null} primaryGeometry Catalog-declared geometry field.
 * @return {{name:string,value:string}[]} Bounded display attributes.
 */
export function vectorFeatureAttributes(feature, primaryGeometry = null) {
    const geometryNames = new Set(
        [primaryGeometry, "geometry", "the_geom", "boundedBy", "bbox"]
            .filter((name) => typeof name === "string")
    );
    const attributes = Object.entries(feature.properties)
        .filter(([name]) => !geometryNames.has(name))
        .map(([name, value]) => ({
            name,
            value: formatVectorFeatureAttribute(value),
        }));
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
    /**
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Initialized Leaflet map.
     * @param {() => VectorFeatureInspectionTarget[]}
     * configuration.getVisibleTargets Current visible vectors from composition.
     * @param {string} configuration.wmsUrl Restricted browser WMS URL.
     * @param {(visible:boolean) => void} configuration.onInspectionChange
     * Requests presentation changes without knowing the presentation owner.
     * @param {(sample:Readonly<Object>)=>void} configuration.onSampleChange
     * Publishes immutable bounded observations through application composition.
     * @param {()=>void} configuration.onTimeSeriesRequested Publishes analysis
     * intent without knowing the sibling time-series implementation.
     * @param {Document} [configuration.documentContext=document] DOM owner.
     * @param {typeof fetch} [configuration.fetchImplementation=globalThis.fetch]
     * HTTP implementation.
     */
    constructor({
        leaflet,
        leafletMap,
        getVisibleTargets,
        wmsUrl,
        onInspectionChange,
        onSampleChange,
        onTimeSeriesRequested,
        documentContext = document,
        fetchImplementation = globalThis.fetch,
    }) {
        if (typeof getVisibleTargets !== "function") {
            throw new TypeError("getVisibleTargets must be a function.");
        }
        if (typeof onInspectionChange !== "function") {
            throw new TypeError("onInspectionChange must be a function.");
        }
        if (typeof onSampleChange !== "function") {
            throw new TypeError("onSampleChange must be a function.");
        }
        if (typeof onTimeSeriesRequested !== "function") {
            throw new TypeError("onTimeSeriesRequested must be a function.");
        }
        this.leaflet = leaflet;
        this.map = leafletMap;
        this.getVisibleTargets = getVisibleTargets;
        this.wmsUrl = wmsUrl;
        this.onInspectionChange = onInspectionChange;
        this.onSampleChange = onSampleChange;
        this.onTimeSeriesRequested = onTimeSeriesRequested;
        this.document = documentContext;
        this.fetchImplementation = fetchImplementation;
        this.panel = documentContext.querySelector("#vector-feature-inspector");
        this.closeButton = documentContext.querySelector("#close-vector-inspector");
        this.timeSeriesButton = documentContext.querySelector(
            "#open-vector-time-series"
        );
        this.status = documentContext.querySelector("#vector-feature-status");
        this.result = documentContext.querySelector("#vector-feature-result");
        this.layerName = documentContext.querySelector("#vector-feature-layer");
        this.position = documentContext.querySelector("#vector-feature-position");
        this.attributes = documentContext.querySelector("#vector-feature-attributes");
        this.previous = documentContext.querySelector("#previous-vector-feature");
        this.next = documentContext.querySelector("#next-vector-feature");
        this.results = [];
        this.resultIndex = 0;
        this.highlightLayer = null;
        this.abortController = null;
        this.requestGeneration = 0;
        this.sampleTargetSignature = null;
        this.mapContainer = this.map.getContainer();
        this.onClose = () => this.close({ moveFocus: true });
        this.onOpenTimeSeries = () => this.onTimeSeriesRequested();
        this.onPrevious = () => this.showResult(this.resultIndex - 1);
        this.onNext = () => this.showResult(this.resultIndex + 1);
        this.onKeydown = (event) => {
            if (event.key !== "Escape" || this.panel.hidden || !(
                this.panel.contains(this.document.activeElement) ||
                this.document.activeElement === this.mapContainer
            )) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.close({ moveFocus: true });
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.timeSeriesButton.addEventListener("click", this.onOpenTimeSeries);
        this.previous.addEventListener("click", this.onPrevious);
        this.next.addEventListener("click", this.onNext);
        this.document.addEventListener("keydown", this.onKeydown);
        this.syncVisibleLayers();
    }

    /**
     * Return validated visible vector targets in top-first map order.
     *
     * @return {VectorFeatureInspectionTarget[]} Current inspection targets.
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
                typeof target?.publication?.layerName !== "string" ||
                typeof target?.publication?.styleName !== "string" ||
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
     * Close orphaned results after the last visible vector leaves the map.
     *
     * @return {void}
     */
    syncVisibleLayers() {
        const targets = this.visibleTargets();
        const available = targets.length > 0;
        const signature = this.#targetSignature(targets);
        if (
            this.sampleTargetSignature !== null &&
            signature !== this.sampleTargetSignature
        ) {
            this.requestGeneration += 1;
            this.abortController?.abort();
            this.abortController = null;
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
     * Project the Leaflet map click into the neutral WMS viewport contract.
     *
     * @param {{x:number,y:number}} containerPoint Click position in map pixels.
     * @return {{bbox:number[],width:number,height:number,x:number,y:number}}
     * Current WGS 84 viewport and click position.
     */
    mapViewport(containerPoint) {
        const size = this.map.getSize();
        const bounds = this.map.getBounds();
        const southwest = bounds.getSouthWest();
        const northeast = bounds.getNorthEast();
        return {
            bbox: [
                southwest.lng,
                southwest.lat,
                northeast.lng,
                northeast.lat,
            ],
            width: size.x,
            height: size.y,
            x: containerPoint.x,
            y: containerPoint.y,
        };
    }

    /**
     * Hide inspection, cancel work, clear results, and optionally focus the map.
     *
     * @param {Object} [options] Close options.
     * @param {boolean} [options.moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    close({ moveFocus = false } = {}) {
        this.requestGeneration += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.clearResults();
        this.status.textContent = "Click the map to inspect visible vector features.";
        this.onInspectionChange(false);
        if (moveFocus) this.mapContainer.focus();
    }

    /**
     * Inspect every currently visible vector target at one map click.
     *
     * @param {Object} event Leaflet map-click event.
     * @return {Promise<boolean>} Whether visible vector targets were inspected.
     */
    async inspect(event) {
        const targets = this.visibleTargets();
        if (targets.length === 0) {
            return false;
        }
        this.onInspectionChange(true);
        this.abortController?.abort();
        this.abortController = new AbortController();
        const generation = ++this.requestGeneration;
        this.sampleTargetSignature = this.#targetSignature(targets);
        this.clearResults();
        this.status.textContent = "Inspecting visible vector layers…";
        this.#publishSample(
            "loading",
            [],
            "Inspecting visible vector layers…"
        );
        const containerPoint = event.containerPoint ??
            this.map.latLngToContainerPoint(event.latlng);
        const responses = await Promise.allSettled(targets.map(async (target) => {
            const features = await fetchVectorFeatureInfo({
                wmsUrl: this.wmsUrl,
                publication: target.publication,
                viewport: this.mapViewport(containerPoint),
                signal: this.abortController.signal,
            }, this.fetchImplementation);
            return features.map((feature) => ({ feature, target }));
        }));
        if (generation !== this.requestGeneration) {
            return false;
        }
        this.abortController = null;
        this.results = responses.flatMap((response) =>
            response.status === "fulfilled" ? response.value : []
        );
        if (this.results.length > 0) {
            this.showResult(0);
            this.timeSeriesButton.disabled = this.results.length < 2;
            const failures = responses.filter(
                (response) => response.status === "rejected" &&
                    response.reason?.name !== "AbortError"
            ).length;
            this.status.textContent = failures === 0
                ? `${this.results.length} feature${this.results.length === 1 ? "" : "s"} found.`
                : `${this.results.length} feature${this.results.length === 1 ? "" : "s"} found; one visible layer could not be inspected.`;
            this.#publishSample(
                "ready",
                this.results,
                this.status.textContent
            );
            return true;
        }
        const failure = responses.find(
            (response) => response.status === "rejected" &&
                response.reason?.name !== "AbortError"
        );
        this.status.textContent = failure?.reason instanceof VectorFeatureInfoError
            ? failure.reason.message
            : "No vector feature was found at that location.";
        this.#publishSample("empty", [], this.status.textContent);
        return true;
    }

    /**
     * Return a stable set identity independent of drawing order and styling.
     *
     * @param {VectorFeatureInspectionTarget[]} targets Visible vector targets.
     * @return {string} Stable visible-publication signature.
     */
    #targetSignature(targets) {
        return targets.map((target) => target.publication.layerName)
            .sort()
            .join("\u0000");
    }

    /**
     * Publish one frozen inspection sample through application composition.
     *
     * @param {"loading"|"ready"|"empty"|"invalidated"} state Sample state.
     * @param {Object[]} results Inspector-owned feature results.
     * @param {string} message Browser-safe sample status.
     * @return {void}
     */
    #publishSample(state, results, message) {
        const observations = Object.freeze(
            results.map(vectorInspectionObservation)
        );
        this.onSampleChange(Object.freeze({ state, observations, message }));
    }

    /**
     * Present one result and replace its map highlight.
     *
     * @param {number} index Zero-based result index.
     * @return {void}
     */
    showResult(index) {
        if (this.results.length === 0) {
            return;
        }
        this.resultIndex = Math.min(this.results.length - 1, Math.max(0, index));
        const { feature, target } = this.results[this.resultIndex];
        this.result.hidden = false;
        this.layerName.textContent = target.label;
        this.position.textContent = `${this.resultIndex + 1} of ${this.results.length}`;
        this.previous.disabled = this.resultIndex === 0;
        this.next.disabled = this.resultIndex === this.results.length - 1;
        this.attributes.replaceChildren();
        const entries = vectorFeatureAttributes(feature, target.primaryGeometry);
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
        this.clearHighlight();
        if (feature.geometry !== null) {
            this.highlightLayer = this.leaflet.geoJSON(feature, {
                style: HIGHLIGHT_STYLE,
                pointToLayer: (_pointFeature, latlng) =>
                    this.leaflet.circleMarker(latlng, HIGHLIGHT_STYLE),
            }).addTo(this.map);
        }
    }

    /**
     * Clear result DOM and map highlight.
     *
     * @return {void}
     */
    clearResults() {
        this.results = [];
        this.resultIndex = 0;
        this.result.hidden = true;
        this.timeSeriesButton.disabled = true;
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
        this.closeButton.removeEventListener("click", this.onClose);
        this.timeSeriesButton.removeEventListener("click", this.onOpenTimeSeries);
        this.previous.removeEventListener("click", this.onPrevious);
        this.next.removeEventListener("click", this.onNext);
        this.document.removeEventListener("keydown", this.onKeydown);
    }
}
