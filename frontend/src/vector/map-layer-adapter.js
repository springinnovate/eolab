/** Focused vector publication and Leaflet adapter for shared map lifecycle. */

import { publishCatalogVector, styleCatalogVector } from "./api.js";
import { createVectorWmsLayer } from "./leaflet.js";
import { buildCatalogResultPresentation } from "../catalog-result-presentation.js";
import { normalizeVectorStyle, vectorStyleLegend } from "./style.js";

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
         * @return {{item:Object,style:Object,layer:Object|null}} Vector-owned state.
         */
        createState({ item, publication }) {
            return {
                item,
                style: normalizeVectorStyle(publication.style),
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
         * Return fixed presentation metadata for the shared layer view.
         *
         * @param {Object} record Neutral retained-layer record.
         * @return {{legend:{kind:"fixed",label:string,fill:string,stroke:string}}}
         * Neutral fixed-swatch snapshot contract.
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
