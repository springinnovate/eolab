/** Focused vector publication and Leaflet adapter for shared map lifecycle. */

import {
    classifyCatalogVectorNumbers,
    publishCatalogVector,
    styleCatalogVector,
    summarizeCatalogVectorCategories,
} from "./api.js";
import { createVectorWmsLayer } from "./leaflet.js";
import { buildCatalogResultPresentation } from "../catalog-result-presentation.js";
import {
    normalizeVectorStyle,
    vectorLabelFields,
    vectorStyleLegend,
} from "./style.js";

/**
 * Validate one untrusted saved vector style without accepting extra fields.
 *
 * @param {unknown} candidate Candidate saved style definition.
 * @return {Object} Canonical normalized vector style.
 */
function normalizePortableVectorStyle(candidate) {
    const normalized = normalizeVectorStyle(candidate);
    if (canonicalJson(candidate) !== canonicalJson(normalized)) {
        throw new TypeError(
            "Saved vector style contains missing or unsupported fields."
        );
    }
    return normalized;
}

/**
 * Return deterministic JSON for a validated JSON-shaped value.
 *
 * @param {unknown} candidate JSON-shaped scalar, array, or object.
 * @return {string} Canonical text with object keys in lexical order.
 */
function canonicalJson(candidate) {
    if (Array.isArray(candidate)) {
        return `[${candidate.map(canonicalJson).join(",")}]`;
    }
    if (candidate !== null && typeof candidate === "object") {
        return `{${Object.keys(candidate).sort().map(
            (key) => `${JSON.stringify(key)}:${canonicalJson(candidate[key])}`
        ).join(",")}}`;
    }
    return JSON.stringify(candidate);
}

/**
 * Create the vector implementation of the neutral external-map-layer contract.
 *
 * @param {Object} configuration Adapter configuration.
 * @param {Object} configuration.leaflet Leaflet namespace.
 * @param {Object} configuration.leafletMap Initialized Leaflet map.
 * @param {string} configuration.wmsUrl Restricted browser WMS URL.
 * @param {(message:string,item:Object)=>void} configuration.onTileError
 * Report a layer-specific tile error.
 * @param {boolean} [configuration.fitToBounds=true] Whether a newly added
 * layer should fit the map to its assessed extent.
 * @param {(item:Object)=>Promise<Object>} [configuration.publish=publishCatalogVector]
 * Vector publication API adapter.
 * @param {(item:Object,style:Object)=>Promise<Object>} [configuration.style=styleCatalogVector]
 * Vector style API adapter.
 * @param {(item:Object,field:string)=>Promise<Object>}
 * [configuration.summarize=summarizeCatalogVectorCategories] Bounded category
 * summary API adapter.
 * @param {(item:Object,field:string,method:string,classCount:number)=>Promise<Object>}
 * [configuration.classify=classifyCatalogVectorNumbers] Bounded numeric
 * classification API adapter.
 * @return {Object} Immutable adapter consumed by the shared layer lifecycle.
 */
export function createVectorMapLayerAdapter({
    leaflet,
    leafletMap,
    wmsUrl,
    onTileError,
    fitToBounds = true,
    publish = publishCatalogVector,
    style = styleCatalogVector,
    summarize = summarizeCatalogVectorCategories,
    classify = classifyCatalogVectorNumbers,
}) {
    if (typeof fitToBounds !== "boolean") {
        throw new TypeError("fitToBounds must be boolean.");
    }
    if (typeof onTileError !== "function") {
        throw new TypeError("onTileError must be a function.");
    }
    return Object.freeze({
        publish,
        /**
         * Build a stable user-facing label.
         *
         * @param {Object} item Catalog vector Item.
         * @return {string} Item title or stable identifier.
         */
        label(item) {
            const { filename, context } = buildCatalogResultPresentation(item, "Vector");
            return context?.startsWith("Layer: ")
                ? `${filename} — ${context.slice(7)}` : filename;
        },
        /**
         * Create adapter-owned state for one retained vector layer.
         *
         * @param {{item:Object}} context Neutral retained-layer context.
         * @return {{item:Object,style:Object,labelFields:ReadonlyArray,
         * layer:Object|null}} Vector-owned state.
         */
        createState({ item, publication }) {
            return {
                item,
                style: normalizeVectorStyle(publication.style),
                labelFields: vectorLabelFields(item),
                layer: null,
            };
        },
        /**
         * Create one bounded fixed-style WMS layer.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {() => void} reportTileError One-shot tile failure callback.
         * @return {Object} Leaflet-compatible WMS layer.
         */
        createLayer(record, reportTileError) {
            const layer = createVectorWmsLayer(
                leaflet,
                wmsUrl,
                record.publication,
                reportTileError
            );
            record.state.layer = layer;
            return layer;
        },
        /**
         * Apply a validated per-layer style and refresh the existing WMS layer.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {Object} candidate Complete geometry-specific style state.
         * @return {Promise<Object>} Normalized applied style state.
         */
        async applyStyle(record, candidate) {
            const normalized = normalizeVectorStyle(candidate);
            const result = await style(record.state.item, normalized);
            const applied = normalizeVectorStyle(result.style);
            record.publication = {
                ...record.publication,
                styleName: result.styleName,
                style: applied,
            };
            record.state.style = applied;
            record.state.layer.setParams({ styles: result.styleName });
            return applied;
        },
        /**
         * Export only the validated vector appearance owned by this adapter.
         *
         * @param {Object} record Neutral retained-layer record.
         * @return {{kind:string,definition:Object}} Portable vector style.
         */
        exportSavedState(record) {
            return {
                kind: "vector",
                definition: structuredClone(
                    normalizeVectorStyle(record.state.style)
                ),
            };
        },
        /**
         * Validate and apply one portable vector appearance through GeoServer.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {Object} savedState Candidate saved style envelope.
         * @return {Promise<void>} Completion after the current style is applied.
         */
        async applySavedState(record, savedState) {
            if (savedState?.kind !== "vector") {
                throw new TypeError("Saved style does not belong to a vector.");
            }
            await this.applyStyle(
                record,
                normalizePortableVectorStyle(savedState.definition)
            );
        },
        /**
         * Read bounded typed categories for one authoritative Catalog field.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {string} field Current Catalog attribute field.
         * @return {Promise<Object>} Normalized category summary.
         */
        summarizeCategories(record, field) {
            return summarize(record.state.item, field);
        },
        /**
         * Read bounded numeric classes for one authoritative Catalog field.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {string} field Current numeric Catalog attribute field.
         * @param {string} method Equal-interval or quantile classification.
         * @param {number} classCount Requested bounded class count.
         * @return {Promise<Object>} Normalized numeric classification.
         */
        classifyNumbers(record, field, method, classCount) {
            return classify(record.state.item, field, method, classCount);
        },
        /**
         * Return fixed presentation metadata for the shared layer view.
         *
         * @param {Object} record Neutral retained-layer record.
         * @return {{legend:Object}} Neutral fixed, categorical, or graduated legend snapshot.
         */
        snapshot(record) {
            return {
                legend: vectorStyleLegend(record.state.style),
            };
        },
        /**
         * Fit the map to one WGS 84 publication extent.
         *
         * @param {Object} record Neutral retained-layer record.
         * @return {void}
         */
        added(record) {
            if (!fitToBounds) {
                return;
            }
            const [west, south, east, north] = record.publication.bbox;
            leafletMap.fitBounds(
                [[south, west], [north, east]],
                { maxZoom: 14, padding: [24, 24] }
            );
        },
        /**
         * Report a tile failure through application composition.
         *
         * @param {Object} record Neutral retained-layer record.
         * @return {void}
         */
        tileError(record) {
            onTileError(record.error, record.entry.item);
        },
        tileErrorMessage: "Vector map tiles could not be rendered.",
    });
}
