/** Focused vector publication and Leaflet adapter for shared map lifecycle. */

import { publishCatalogVector } from "./api.js";
import { createVectorWmsLayer, VECTOR_DEFAULT_SYMBOLOGY } from "./leaflet.js";
import { buildCatalogResultPresentation } from "../catalog-result-presentation.js";

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
 * @return {Object} Immutable adapter consumed by the shared layer lifecycle.
 */
export function createVectorMapLayerAdapter({
    leaflet,
    leafletMap,
    wmsUrl,
    onTileError,
    fitToBounds = true,
    publish = publishCatalogVector,
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
         * @return {{item:Object}} Vector-owned state.
         */
        createState({ item }) {
            return { item };
        },
        /**
         * Create one bounded fixed-style WMS layer.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {() => void} reportTileError One-shot tile failure callback.
         * @return {Object} Leaflet-compatible WMS layer.
         */
        createLayer(record, reportTileError) {
            return createVectorWmsLayer(
                leaflet,
                wmsUrl,
                record.publication,
                reportTileError
            );
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
                legend: {
                    kind: "fixed",
                    ...VECTOR_DEFAULT_SYMBOLOGY[
                        record.publication.geometryKind
                    ],
                },
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
