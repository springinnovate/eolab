/** Publish, style and filter vector datasets displayed in the map's layer list. */

import {
    classifyVectorNumbers,
    filterVector,
    countVectorFilter,
    publishVector,
    styleVector,
    summarizeVectorCategories,
} from "./api.js";
import { EMPTY_VECTOR_FILTER, normalizeVectorFilter, vectorFilterStatus } from "./filter.js";
import { createVectorWmsLayer, vectorMapBounds } from "./leaflet.js";
import {
    defaultVectorNumericField,
    deriveDefaultVectorStyle,
    VECTOR_NUMERIC_DEFAULTS,
} from "./defaults.js";
import { buildCatalogResultPresentation } from "../catalog-result-presentation.js";
import {
    normalizeVectorStyle,
    sequentialPaletteColors,
    vectorCategoricalFieldKind,
    vectorCategoricalFields,
    vectorLabelFields,
    vectorNumericFields,
    vectorStyleLegend,
} from "./style.js";

/**
 * Source identity, attributes and geometry needed by vector consumers.
 * @typedef {Object} VectorSourceDescription
 * @property {Readonly<{uploadId:string}|{collectionId:string,itemId:string}>} source Original source identity.
 * @property {ReturnType<typeof vectorLabelFields>} fields Frozen non-geometry fields.
 * @property {"point"|"line"|"polygon"} geometryKind Normalized geometry family.
 * @property {string|null} primaryGeometry Catalog geometry field, when declared.
 */

/**
 * Return the original attribute names and types used by vector style and filter controls.
 * @param {import("./api.js").VectorSource} source Catalog Item or admitted upload.
 * @return {ReturnType<typeof vectorLabelFields>} Frozen non-geometry field options.
 */
function getVectorSourceFields(source) {
    return source.kind === "upload"
        ? Object.freeze(Object.entries(source.fields).map(([name, type]) => Object.freeze({ name, type })))
        : vectorLabelFields(source);
}

/**
 * Validate one untrusted saved vector style without accepting extra fields.
 * Rules from supported older maps receive only the new optional presentation
 * defaults; every other missing/extra field still fails the canonical check.
 *
 * @param {unknown} candidate Candidate saved style definition.
 * @return {Object} Canonical normalized vector style.
 * @throws {TypeError|RangeError} If saved data violates its owner contract.
 */
function normalizePortableVectorStyle(candidate) {
    const normalized = normalizeVectorStyle(candidate);
    const current = normalized.categorical === null ? candidate : {
        ...candidate, categorical: { ...candidate.categorical,
            rules: candidate.categorical.rules.map(rule => ({ ...rule,
                label: rule.label === undefined ? null : rule.label,
                opacity: rule.opacity === undefined ? 1 : rule.opacity })) },
    };
    if (canonicalJson(current) !== canonicalJson(normalized)) {
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
 * Reclassify a copied graduated style against its target vector source.
 *
 * Numeric rule boundaries describe source data rather than portable visual
 * intent. Field, method, requested class count, palette, and symbol settings
 * transfer, while the classification API validates and supplies the target's
 * authoritative ranges.
 *
 * @param {Object} record Target retained vector record.
 * @param {Object} copiedStyle Validated copied vector style.
 * @param {(source:import("./api.js").VectorSource,field:string,method:string,classCount:number)=>Promise<Object>}
 * classify API adapter returning a validated classification matching the request.
 * @return {Promise<Object>} Validated style using target-specific ranges.
 * @throws {Error} If classification fails or the resulting style is invalid.
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
    const summary = await classify(
        record.state.source,
        graduated.field,
        graduated.method,
        graduated.classCount
    );
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
 * Create the adapter that publishes vector layers and manages their styles and filters.
 *
 * @param {Object} configuration Adapter configuration.
 * @param {Object} configuration.leaflet Leaflet namespace.
 * @param {Object} configuration.leafletMap Initialized Leaflet map.
 * @param {string} configuration.wmsUrl Restricted browser WMS URL.
 * @param {(message:string,item:Object)=>void} configuration.onTileError
 * Report a layer-specific tile error.
 * @param {boolean} [configuration.fitToBounds=true] Whether a newly added
 * layer should fit the map to its assessed extent.
 * @param {(source:import("./api.js").VectorSource)=>Promise<Object>} [configuration.publish=publishVector]
 * Vector publication API adapter.
 * @param {(source:import("./api.js").VectorSource,style:Object)=>Promise<Object>} [configuration.style=styleVector]
 * Vector style API adapter.
 * @param {(source:import("./api.js").VectorSource,field:string)=>Promise<Object>}
 * [configuration.summarize=summarizeVectorCategories] Bounded category
 * summary API adapter.
 * @param {(source:import("./api.js").VectorSource,field:string,method:string,classCount:number)=>Promise<Object>}
 * [configuration.classify=classifyVectorNumbers] Bounded numeric
 * classification API adapter.
 * @param {(source:import("./api.js").VectorSource,filter:Object,signal:AbortSignal)=>Promise<Object>}
 * [configuration.filter=filterVector] Cancellable filter registration.
 * @param {(source:import("./api.js").VectorSource,filter:Object,signal:AbortSignal)=>Promise<Object>}
 * [configuration.countFilter=countVectorFilter] Exact count boundary.
 * @param {(record:Object)=>void} [configuration.onFilterChange] Composition callback after applied-state changes.
 * @return {Object} Immutable adapter consumed by the shared layer lifecycle.
 */
export function createVectorMapLayerAdapter({
    leaflet,
    leafletMap,
    wmsUrl,
    onTileError,
    fitToBounds = true,
    publish = publishVector,
    style = styleVector,
    summarize = summarizeVectorCategories,
    classify = classifyVectorNumbers,
    filter = filterVector,
    countFilter = countVectorFilter,
    onFilterChange = () => {},
}) {
    if (typeof fitToBounds !== "boolean") {
        throw new TypeError("fitToBounds must be boolean.");
    }
    if (typeof onTileError !== "function") {
        throw new TypeError("onTileError must be a function.");
    }
    /**
     * Accept checked rules, replacing the previous selection's rendering request and counts.
     * @param {Object} record Retained vector record.
     * @param {Object} candidate Filter already checked against the source fields.
     * @param {{matched:number,total:number,complete:true}|null} count Exact counts, or null to request them separately.
     * @return {Object} Detached accepted filter, also used to identify work for this selection.
     */
    function commitFilterState(record, candidate, count) {
        record.state.filterRenderAbort?.abort();
        record.state.filterRenderAbort = null;
        record.state.filterCountAbort?.abort();
        record.state.filterCountAbort = null;
        const accepted = structuredClone(candidate);
        record.state.filter = accepted;
        record.state.filterCount = structuredClone(count);
        record.state.filterCountError = null;
        record.state.filterCounting = count === null && candidate.enabled && candidate.rules.length > 0;
        onFilterChange(record);
        return accepted;
    }

    return Object.freeze({
        /**
         * Prepare initial colors with labels off before a new WMS layer is attached.
         *
         * Existing retained records never call this initializer. Saved styles
         * are applied by the existing detached restoration lifecycle afterwards.
         * Optional appearance failures retain the authorized fixed publication.
         *
         * @param {import("./api.js").VectorSource} source Catalog Item or admitted upload.
         * @return {Promise<Object>} Publication with applied defaults and any notice.
         * @throws {Error} If the underlying publication fails.
         */
        async publish(source) {
            const publication = await publish(source);
            const fields = getVectorSourceFields(source);
            const numericField = defaultVectorNumericField(fields);
            let candidate = deriveDefaultVectorStyle(publication.style, fields);
            let defaultStyleNotice = "";
            if (numericField !== null) {
                try {
                    const summary = await classify(source, numericField,
                        VECTOR_NUMERIC_DEFAULTS.method, VECTOR_NUMERIC_DEFAULTS.classCount);
                    candidate = deriveDefaultVectorStyle(publication.style, fields, summary);
                } catch {
                    defaultStyleNotice = "Automatic numeric coloring was unavailable. " +
                        "Choose Color by in Style to try again or use another field.";
                }
            }
            try {
                // Content-address even a solid default so cached tiles from
                // an older fixed initializer style cannot retain old colors.
                const result = await style(source, candidate);
                return {
                    ...publication,
                    styleName: result.styleName,
                    style: normalizeVectorStyle(result.style),
                    defaultStyleNotice,
                };
            } catch {
                return {
                    ...publication,
                    defaultStyleNotice: "Automatic coloring could not be applied. " +
                        "The layer uses a single color; open Style to try again.",
                };
            }
        },
        /**
         * Build a stable user-facing label.
         *
         * @param {import("./api.js").VectorSource} source Catalog Item or admitted upload.
         * @return {string} Upload name, catalog title or stable catalog identifier.
         */
        label(source) {
            if (source.kind === "upload") return source.name;
            const { filename, context } = buildCatalogResultPresentation(source, "Vector");
            return context?.startsWith("Layer: ")
                ? `${filename} — ${context.slice(7)}` : filename;
        },
        /**
         * Create adapter-owned state for one retained vector layer.
         *
         * @param {Object} context Neutral retained-layer context.
         * @param {Object} [context.item] Catalog Item supplied by catalog addition.
         * @param {{upload:import("./api.js").UploadedVectorSource,restore?:Object}} [context.source]
         * Uploaded source and optional filter/count captured for immediate removal Undo.
         * @param {Object} context.publication Published layer and current appearance.
         * @return {Object} Vector-owned source, filter, appearance and request state.
         */
        createState({ item, source, publication }) {
            const vectorSource = item ?? source.upload;
            return {
                source: vectorSource,
                filter: structuredClone(source?.restore?.filter ?? EMPTY_VECTOR_FILTER),
                filterCount: structuredClone(source?.restore?.filterCount ?? null),
                filterCounting: false,
                filterCountError: null,
                filterGeneration: 0,
                filterApplyAbort: null,
                filterRenderAbort: null,
                filterCountAbort: null,
                disposed: false,
                style: normalizeVectorStyle(publication.style),
                labelFields: getVectorSourceFields(vectorSource),
                defaultStyleNotice: publication.defaultStyleNotice ?? "",
                layer: null,
            };
        },
        /**
         * Read the source identity, fields and geometry used by vector controls.
         * Identity and fields are immutable; no publication or request is started.
         *
         * @param {Object} record Layer record owned by this adapter.
         * @return {VectorSourceDescription} Current source metadata.
         */
        describeSource(record) {
            return {
                source: Object.freeze(record.state.source.kind === "upload"
                    ? { uploadId: record.state.source.id }
                    : { collectionId: record.state.source.collection, itemId: record.state.source.id }),
                fields: record.state.labelFields,
                geometryKind: record.state.style.geometryKind,
                primaryGeometry: record.state.source.kind === "upload" ? null
                    : record.state.source.properties?.["table:primary_geometry"] ?? null,
            };
        },
        /**
         * Read the applied filter and its current whole-layer count feedback.
         * Rules are detached from adapter state. Read again after filter/count
         * notifications to obtain updated feedback; this method starts no work.
         *
         * @param {Object} record Layer record owned by this adapter.
         * @return {{filter:ReturnType<typeof normalizeVectorFilter>,status:string}}
         * Validated filter values and readable current status, without request state.
         */
        describeFilter(record) {
            return {
                filter: structuredClone(record.state.filter),
                status: vectorFilterStatus(record.state),
            };
        },
        /**
         * Read the applied appearance and its default-style explanation.
         * The style is detached so an editor cannot mutate the applied appearance.
         * Reading does not classify fields, apply styles or contact the server.
         *
         * @param {Object} record Layer record owned by this adapter.
         * @return {{style:ReturnType<typeof normalizeVectorStyle>,notice:string}}
         * Validated style values and the current default-style notice.
         */
        describeStyle(record) {
            return {
                style: structuredClone(record.state.style),
                notice: record.state.defaultStyleNotice,
            };
        },
        /**
         * Create one bounded WMS layer using the authorized initial appearance.
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
         * Describe the current authorized vector appearance for composition.
         *
         * @param {Object} record Retained vector publication and style state.
         * @return {{layerName:string,styleName:string,styleDefinition:Object}}
         * Complete feature-owned composite descriptor.
         */
        renderDescriptor(record) {
            return {
                layerName: record.publication.layerName,
                styleName: record.publication.styleName,
                styleDefinition: structuredClone(record.state.style),
            };
        },
        /**
         * Update the retained vector appearance and send it with subsequent WMS requests.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {Object} candidate Complete geometry-specific style state.
         * @return {Promise<Object>} Normalized applied style state.
         * @throws {Error} If the style cannot be validated or applied.
         */
        async applyStyle(record, candidate) {
            const normalized = normalizeVectorStyle(candidate);
            const result = await style(record.state.source, normalized);
            const applied = normalizeVectorStyle(result.style);
            record.publication = {
                ...record.publication,
                styleName: result.styleName,
                style: applied,
            };
            record.state.style = applied;
            record.state.defaultStyleNotice = "";
            record.state.layer.setParams({
                styles: result.styleName,
                vector_style: JSON.stringify(applied),
            });
            return applied;
        },
        /**
         * Cancel an unaccepted map edit while allowing the accepted filter to finish rendering.
         * @param {Object} record Retained vector record.
         * @return {void}
         */
        cancelPendingFilter(record) {
            record.state.filterGeneration++;
            record.state.filterApplyAbort?.abort();
            record.state.filterApplyAbort = null;
        },
        /**
         * Validate and apply map-filter edits, then request their feature counts.
         * @param {Object} record Retained vector record.
         * @param {Object} candidate Complete portable filter state.
         * @return {Promise<Object|null>} Applied state, or null for stale replies.
         * @throws {Error} If candidate validation or current rendering preparation fails; the accepted filter stays unchanged.
         */
        async applyFilterState(record, candidate) {
            const normalized = normalizeVectorFilter(candidate, record.state.labelFields);
            this.cancelPendingFilter(record);
            const generation = record.state.filterGeneration;
            const controller = new AbortController();
            record.state.filterApplyAbort = controller;
            let result;
            try {
                result = await filter(record.state.source, normalized, controller.signal);
            } catch (error) {
                if (record.state.disposed || generation !== record.state.filterGeneration) return null;
                throw error;
            } finally {
                if (record.state.filterApplyAbort === controller) record.state.filterApplyAbort = null;
            }
            if (record.state.disposed || generation !== record.state.filterGeneration) return null;
            record.publication = { ...record.publication, layerName: result.layerName };
            record.state.layer?.setParams({ layers: result.layerName });
            const accepted = commitFilterState(record, normalized, null);
            if (record.state.disposed || record.state.filter !== accepted) return null;
            if (record.state.filterCounting) {
                const counter = new AbortController();
                record.state.filterCountAbort = counter;
                void countFilter(record.state.source, normalized, counter.signal).then((count) => {
                    if (!counter.signal.aborted && !record.state.disposed) record.state.filterCount = count;
                }).catch((error) => {
                    // Counts are optional; the rendering predicate stays applied.
                    if (!counter.signal.aborted && !record.state.disposed) {
                        record.state.filterCountError = error.category ?? null;
                    }
                }).finally(() => {
                    if (counter.signal.aborted || record.state.disposed) return;
                    record.state.filterCounting = false;
                    record.state.filterCountAbort = null;
                    onFilterChange(record);
                });
            }
            return accepted;
        },
        /**
         * Accept independently checked rules and counts before updating their map rendering.
         * Rendering failure leaves the accepted selection and counts intact.
         * @param {Object} record Retained vector record.
         * @param {Object} candidate Filter checked by the original-source selection boundary.
         * @param {{matched:number,total:number,complete:true}} count Exact feature counts for these rules.
         * @return {Promise<Object|null>} Accepted rules after rendering preparation, or null when superseded.
         * @throws {Error} If current rendering preparation fails after the selection is accepted.
         */
        async applyCheckedFilter(record, candidate, count) {
            this.cancelPendingFilter(record);
            const accepted = commitFilterState(record, candidate, count);
            if (record.state.disposed || record.state.filter !== accepted) return null;
            const controller = new AbortController();
            record.state.filterRenderAbort = controller;
            let result;
            try {
                result = await filter(record.state.source, accepted, controller.signal);
            } catch (error) {
                if (record.state.disposed || record.state.filter !== accepted) return null;
                throw error;
            } finally {
                if (record.state.filterRenderAbort === controller) record.state.filterRenderAbort = null;
            }
            if (record.state.disposed || record.state.filter !== accepted) return null;
            record.publication = { ...record.publication, layerName: result.layerName };
            record.state.layer?.setParams({ layers: result.layerName });
            onFilterChange(record);
            return record.state.disposed || record.state.filter !== accepted ? null : accepted;
        },
        /**
         * Export filter state separately from copyable visual appearance.
         * @param {Object} record Retained vector record.
         * @return {Object} Validated portable filter rules.
         */
        exportFilterState(record) {
            return normalizeVectorFilter(record.state.filter, record.state.labelFields);
        },
        /**
         * Cancel removed-layer work so late responses cannot revive its state.
         * @param {Object} record Removed vector record.
         * @return {void}
         */
        removed(record) {
            this.discardStaged(record);
        },
        /**
         * Cancel filter requests for a detached layer whose preparation failed or became obsolete.
         * @param {Object} record Vector layer being discarded.
         * @return {void}
         */
        discardStaged(record) {
            record.state.disposed = true;
            this.cancelPendingFilter(record);
            record.state.filterRenderAbort?.abort();
            record.state.filterCountAbort?.abort();
        },
        /**
         * Capture an uploaded layer's source and display so removal can be undone without uploading again.
         * @param {Object} record Browser-owned uploaded vector layer.
         * @return {Object} Detached upload metadata, authorized publication, filter and count.
         */
        copyLayerForUndo(record) {
            return structuredClone({
                kind: "uploaded-vector",
                upload: record.state.source,
                publication: record.publication,
                filter: record.state.filter,
                filterCount: record.state.filterCount,
            });
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
         * Restore the exact appearance of the same removed vector, including chosen class ranges.
         * @param {Object} record Freshly published vector layer.
         * @param {Object} savedState Previously exported appearance.
         * @return {Promise<void>} Completion after the style service validates and applies it.
         * @throws {Error} If the current source no longer supports the saved appearance or styling fails.
         */
        async restoreRemovedStyle(record, savedState) {
            const problem = checkPortableVectorStyleCompatibility(record, savedState);
            if (problem) throw new Error(problem);
            await this.applyStyle(record, savedState.definition);
        },
        /**
         * Read category values and their counts for a source attribute.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {string} field Original source attribute field.
         * @return {Promise<Object>} Normalized category summary.
         * @throws {Error} If the category request fails.
         */
        summarizeCategories(record, field) {
            return summarize(record.state.source, field);
        },
        /**
         * Divide a numeric source attribute into classes for graduated styling.
         *
         * @param {Object} record Neutral retained-layer record.
         * @param {string} field Original numeric source attribute field.
         * @param {string} method Equal-interval, quantile, or percentile-interval classification.
         * @param {number} classCount Requested bounded class count.
         * @return {Promise<Object>} Normalized numeric classification.
         * @throws {Error} If classification fails.
         */
        classifyNumbers(record, field, method, classCount) {
            return classify(record.state.source, field, method, classCount);
        },
        /**
         * Return fixed presentation metadata for the shared layer view.
         *
         * @param {Object} record Neutral retained-layer record.
         * @return {{datasetKind:"vector",canInfo:boolean,canFilter:boolean,
         * filterActive:boolean,filterStatus:string,legend:Object}} Layer actions,
         * filter status and fixed, categorical or graduated legend.
         */
        snapshot(record) {
            return {
                datasetKind: "vector",
                canInfo: record.state.source.kind !== "upload",
                canFilter: true,
                filterActive: record.state.filter?.enabled === true && record.state.filter.rules.length > 0,
                filterStatus: vectorFilterStatus(record.state),
                legend: vectorStyleLegend(record.state.style),
            };
        },
        /**
         * Fit a publication extent, showing both edges for a date-line crossing.
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
            leafletMap.fitBounds(
                vectorMapBounds(record.publication.bbox),
                { maxZoom: 14, padding: [24, 24] }
            );
        },
        /**
         * Fit an uploaded layer's published extent using the ordinary vector map bounds.
         * @param {Object} record Uploaded vector layer retained by the map.
         * @return {void}
         */
        zoom(record) {
            leafletMap.fitBounds(vectorMapBounds(record.publication.bbox),
                { maxZoom: 14, padding: [24, 24] });
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
