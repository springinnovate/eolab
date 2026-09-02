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
    normalizeVectorNumericClassification,
    normalizeVectorStyle,
    sequentialPaletteColors,
    vectorCategoricalFieldKind,
    vectorCategoricalFields,
    vectorLabelFields,
    vectorNumericFields,
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
 * Check one copied vector style against a target vector record.
 *
 * Geometry and Catalog field compatibility are feature-owned concerns. The
 * backend remains authoritative when the style is applied, but this bounded
 * check prevents known-incompatible paste actions from being offered.
 *
 * @param {Object} record Target retained vector record.
 * @param {Object} savedState Candidate portable style envelope.
 * @return {string|null} Null when compatible or a user-facing reason.
 */
function checkPortableVectorStyleCompatibility(record, savedState) {
    if (savedState?.kind !== "vector") {
        return "Only copied vector styles can be pasted onto vector layers.";
    }
    let style;
    try {
        style = normalizePortableVectorStyle(savedState.definition);
    } catch (error) {
        return error instanceof Error
            ? `Copied vector style is invalid: ${error.message}`
            : "Copied vector style is invalid.";
    }
    const targetGeometry = normalizeVectorStyle(
        record.state.style
    ).geometryKind;
    if (style.geometryKind !== targetGeometry) {
        return `A ${style.geometryKind} style cannot be pasted onto a ` +
            `${targetGeometry} layer.`;
    }
    const fields = record.state.labelFields;
    const fieldNames = new Set(fields.map(({ name }) => name));
    if (style.label !== null && !fieldNames.has(style.label.field)) {
        return `The target layer does not contain label field ` +
            `“${style.label.field}”.`;
    }
    if (
        style.categorical !== null
    ) {
        const targetField = vectorCategoricalFields(fields).find(
            ({ name }) => name === style.categorical.field
        );
        const targetKind = vectorCategoricalFieldKind(targetField?.type);
        const valuesAreCompatible = style.categorical.rules.every(
            ({ value }) => value.kind === targetKind
        );
        if (targetField === undefined || !valuesAreCompatible) {
            return `The target layer does not contain compatible category ` +
                `field “${style.categorical.field}”.`;
        }
    }
    if (
        style.graduated !== null &&
        !vectorNumericFields(fields).some(
            ({ name }) => name === style.graduated.field
        )
    ) {
        return `The target layer does not contain compatible numeric field ` +
            `“${style.graduated.field}”.`;
    }
    return null;
}

/**
 * Reclassify a copied graduated style against its target vector Item.
 *
 * Numeric rule boundaries describe source data rather than portable visual
 * intent. Field, method, requested class count, palette, and symbol settings
 * transfer, while the existing bounded-classification boundary supplies the
 * target's authoritative ranges. The style service repeats that classification
 * during apply so a source change between the two bounded reads still fails
 * safely.
 *
 * @param {Object} record Target retained vector record.
 * @param {Object} copiedStyle Validated copied vector style.
 * @param {(item:Object,field:string,method:string,classCount:number)=>Promise<Object>}
 * classify Bounded numeric-classification API adapter.
 * @return {Promise<Object>} Validated style using target-specific ranges.
 * @throws {TypeError} If the classification response does not match the
 * copied field, method, and requested class count.
 */
async function adaptPortableVectorStyleToTarget(
    record,
    copiedStyle,
    classify
) {
    const graduated = copiedStyle.graduated;
    if (graduated === null) {
        return copiedStyle;
    }
    const summary = normalizeVectorNumericClassification(
        await classify(
            record.state.item,
            graduated.field,
            graduated.method,
            graduated.classCount
        )
    );
    if (
        summary.field !== graduated.field ||
        summary.method !== graduated.method ||
        summary.requestedClassCount !== graduated.classCount
    ) {
        throw new TypeError("Numeric classification changed unexpectedly.");
    }
    const colors = sequentialPaletteColors(
        graduated.palette,
        summary.actualClassCount
    );
    return normalizeVectorStyle({
        ...copiedStyle,
        graduated: {
            ...graduated,
            rules: summary.classes.map((numericClass, index) => ({
                minimum: numericClass.minimum,
                maximum: numericClass.maximum,
                color: colors[index]
            })),
            missingColor: summary.nullCount > 0
                ? graduated.missingColor
                : null
        }
    });
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
         * Check geometry and Catalog fields before offering a paste action.
         *
         * @param {Object} record Target retained vector record.
         * @param {Object} savedState Candidate portable style envelope.
         * @return {string|null} Null when compatible or a user-facing reason.
         */
        checkSavedStateCompatibility(record, savedState) {
            return checkPortableVectorStyleCompatibility(record, savedState);
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
            const copiedStyle = normalizePortableVectorStyle(
                savedState.definition
            );
            await this.applyStyle(
                record,
                await adaptPortableVectorStyleToTarget(
                    record,
                    copiedStyle,
                    classify
                )
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
         * @param {Object} [context] Neutral addition context.
         * @param {boolean} [context.fitToBounds=true] Whether this addition may
         * move the viewport.
         * @return {void}
         */
        added(record, { fitToBounds: mayFitToBounds = true } = {}) {
            if (!fitToBounds || !mayFitToBounds) {
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
