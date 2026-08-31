/** Explicit click-to-inspect interaction for visible published vector layers. */

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

/** Format an arbitrary GeoJSON property as bounded display text. */
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

/** Return user-facing properties while excluding the source geometry field. */
export function vectorFeatureAttributes(feature, item) {
    const primaryGeometry = item?.properties?.["table:primary_geometry"];
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

/** Own vector-inspection enablement, requests, results, and map highlight. */
export class VectorFeatureInspectorController {
    /**
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Initialized Leaflet map.
     * @param {Object} configuration.mapLayers Retained map-layer controller.
     * @param {Object} configuration.vectorAdapter Vector layer identity.
     * @param {string} configuration.wmsUrl Restricted browser WMS URL.
     * @param {Object} configuration.inspection Shared map-side presentation.
     * @param {() => void} configuration.onEnable Pauses competing map tools.
     * @param {Document} [configuration.documentContext=document] DOM owner.
     * @param {typeof fetch} [configuration.fetchImplementation=globalThis.fetch]
     * HTTP implementation.
     */
    constructor({
        leaflet,
        leafletMap,
        mapLayers,
        vectorAdapter,
        wmsUrl,
        inspection,
        onEnable,
        documentContext = document,
        fetchImplementation = globalThis.fetch,
    }) {
        this.leaflet = leaflet;
        this.map = leafletMap;
        this.mapLayers = mapLayers;
        this.vectorAdapter = vectorAdapter;
        this.wmsUrl = wmsUrl;
        this.inspection = inspection;
        this.onEnable = onEnable;
        this.document = documentContext;
        this.fetchImplementation = fetchImplementation;
        this.opener = documentContext.querySelector("#open-vector-inspector");
        this.panel = documentContext.querySelector("#vector-feature-inspector");
        this.closeButton = documentContext.querySelector("#close-vector-inspector");
        this.status = documentContext.querySelector("#vector-feature-status");
        this.result = documentContext.querySelector("#vector-feature-result");
        this.layerName = documentContext.querySelector("#vector-feature-layer");
        this.position = documentContext.querySelector("#vector-feature-position");
        this.attributes = documentContext.querySelector("#vector-feature-attributes");
        this.previous = documentContext.querySelector("#previous-vector-feature");
        this.next = documentContext.querySelector("#next-vector-feature");
        this.active = false;
        this.results = [];
        this.resultIndex = 0;
        this.highlightLayer = null;
        this.abortController = null;
        this.requestGeneration = 0;
        this.mapContainer = this.map.getContainer();
        this.onOpen = () => this.enable();
        this.onClose = () => this.disable({ moveFocus: true });
        this.onPrevious = () => this.showResult(this.resultIndex - 1);
        this.onNext = () => this.showResult(this.resultIndex + 1);
        this.onMapClick = (event) => this.inspect(event);
        this.onKeydown = (event) => {
            if (
                event.key !== "Escape" || !this.active ||
                !(
                    this.panel.contains(this.document.activeElement) ||
                    this.document.activeElement === this.mapContainer
                )
            ) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.disable({ moveFocus: true });
        };
        this.opener.addEventListener("click", this.onOpen);
        this.closeButton.addEventListener("click", this.onClose);
        this.previous.addEventListener("click", this.onPrevious);
        this.next.addEventListener("click", this.onNext);
        this.document.addEventListener("keydown", this.onKeydown);
        this.syncVisibleLayers();
    }

    /** Return visible vector records in top-first map order. */
    visibleVectorRecords() {
        return this.mapLayers.retainedRecords.filter(
            (record) => record.entry.visible && record.adapter === this.vectorAdapter
        );
    }

    /** Synchronize opener availability and close an orphaned interaction. */
    syncVisibleLayers() {
        const available = this.visibleVectorRecords().length > 0;
        this.opener.hidden = !available;
        this.opener.disabled = !available;
        if (!available && this.active) {
            this.disable();
        }
    }

    /** Enable explicit inspection without moving keyboard focus. */
    enable() {
        if (this.active || this.visibleVectorRecords().length === 0) {
            return;
        }
        this.active = true;
        this.onEnable();
        this.map.on("click", this.onMapClick);
        this.mapContainer.classList.add("is-inspecting-vector-features");
        this.opener.hidden = true;
        this.opener.setAttribute("aria-expanded", "true");
        this.status.textContent = "Click a visible vector feature to inspect it.";
        this.inspection.showFeatureInspector();
    }

    /** Disable inspection, cancel work, clear results, and optionally restore focus. */
    disable({ moveFocus = false } = {}) {
        if (this.active) {
            this.map.off("click", this.onMapClick);
        }
        this.active = false;
        this.requestGeneration += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.clearResults();
        this.mapContainer.classList.remove("is-inspecting-vector-features");
        this.inspection.hideFeatureInspector();
        this.opener.setAttribute("aria-expanded", "false");
        this.syncVisibleLayers();
        if (moveFocus && !this.opener.hidden) {
            this.opener.focus();
        }
    }

    /** Inspect every currently visible vector layer at one map click. */
    async inspect(event) {
        const records = this.visibleVectorRecords();
        if (!this.active || records.length === 0) {
            return;
        }
        this.abortController?.abort();
        this.abortController = new AbortController();
        const generation = ++this.requestGeneration;
        this.clearResults();
        this.status.textContent = "Inspecting visible vector layers…";
        const containerPoint = event.containerPoint ??
            this.map.latLngToContainerPoint(event.latlng);
        const responses = await Promise.allSettled(records.map(async (record) => {
            const features = await fetchVectorFeatureInfo({
                wmsUrl: this.wmsUrl,
                leafletMap: this.map,
                publication: record.publication,
                containerPoint,
                signal: this.abortController.signal,
            }, this.fetchImplementation);
            return features.map((feature) => ({ feature, record }));
        }));
        if (!this.active || generation !== this.requestGeneration) {
            return;
        }
        this.abortController = null;
        this.results = responses.flatMap((response) =>
            response.status === "fulfilled" ? response.value : []
        );
        if (this.results.length > 0) {
            this.showResult(0);
            const failures = responses.filter(
                (response) => response.status === "rejected" &&
                    response.reason?.name !== "AbortError"
            ).length;
            this.status.textContent = failures === 0
                ? `${this.results.length} feature${this.results.length === 1 ? "" : "s"} found.`
                : `${this.results.length} feature${this.results.length === 1 ? "" : "s"} found; one visible layer could not be inspected.`;
            return;
        }
        const failure = responses.find(
            (response) => response.status === "rejected" &&
                response.reason?.name !== "AbortError"
        );
        this.status.textContent = failure?.reason instanceof VectorFeatureInfoError
            ? failure.reason.message
            : "No vector feature was found at that location.";
    }

    /** Present one result and replace its map highlight. */
    showResult(index) {
        if (this.results.length === 0) {
            return;
        }
        this.resultIndex = Math.min(this.results.length - 1, Math.max(0, index));
        const { feature, record } = this.results[this.resultIndex];
        this.result.hidden = false;
        this.layerName.textContent = record.entry.label;
        this.position.textContent = `${this.resultIndex + 1} of ${this.results.length}`;
        this.previous.disabled = this.resultIndex === 0;
        this.next.disabled = this.resultIndex === this.results.length - 1;
        this.attributes.replaceChildren();
        const entries = vectorFeatureAttributes(feature, record.state.item);
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

    /** Clear result DOM and map highlight. */
    clearResults() {
        this.results = [];
        this.resultIndex = 0;
        this.result.hidden = true;
        this.attributes.replaceChildren();
        this.clearHighlight();
    }

    /** Remove the selected feature overlay if one exists. */
    clearHighlight() {
        if (this.highlightLayer !== null) {
            this.map.removeLayer(this.highlightLayer);
            this.highlightLayer = null;
        }
    }

    /** Permanently release listeners and transient state. */
    destroy() {
        this.disable();
        this.opener.removeEventListener("click", this.onOpen);
        this.closeButton.removeEventListener("click", this.onClose);
        this.previous.removeEventListener("click", this.onPrevious);
        this.next.removeEventListener("click", this.onNext);
        this.document.removeEventListener("keydown", this.onKeydown);
    }
}
