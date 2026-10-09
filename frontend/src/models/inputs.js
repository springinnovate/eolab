/** Build model drafts from catalog identities and explicit analysis areas. */
import { normalizeCalculationArea } from "../processing/calculation-area.js";

/** Identify a catalog source without using its label or map visibility.
 * @param {Object} source Catalog collection and item IDs.
 * @return {string} Composite identity for a choice list.
 */
export function modelSourceKey(source) { return JSON.stringify([source.collectionId, source.itemId]); }

/** Explain the saved polygon selection without exposing server paths.
 * @param {Object} filter Typed catalog filter.
 * @return {string} Readable predicate, including its all/any rule.
 */
export function describeModelFilter(filter) {
    if (!filter?.enabled || !filter.rules.length) return "All features (no filter)";
    const operators = {eq: "equals", ne: "does not equal", gt: ">", ge: "≥", lt: "<", le: "≤", contains: "contains", missing: "is missing", present: "is present"};
    return filter.rules.map(rule => `${rule.field} ${operators[rule.operator] ?? rule.operator}${["missing", "present"].includes(rule.operator) ? "" : ` ${JSON.stringify(rule.value)}`}`)
        .join(filter.match === "any" ? " OR " : " AND ");
}

/** Translate a browser calculation area to the model submission schema.
 * @param {Object} area Explicit browser area descriptor.
 * @return {Object} Model area with catalog selections and upload references preserved.
 * @throws {Error} If the area is invalid.
 */
export function modelAreaInput(area) {
    const value = normalizeCalculationArea(area);
    if (value.kind === "catalogSelection") return {kind: value.kind, selection: value.catalogSelection};
    if (value.kind === "polygonArea") return {kind: value.kind, reference: value.polygonArea};
    return structuredClone(value);
}

/** Capture the visible part of the map within the canonical geographic world.
 * Blank margins outside the single map world are excluded from the rectangle.
 * @param {{west:number,south:number,east:number,north:number}|null} bounds Visible WGS 84 map bounds.
 * @return {Object} Independent, validated model area.
 * @throws {Error} If the viewport has no valid geographic rectangle.
 */
export function modelViewportArea(bounds) {
    if (!bounds || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) {
        throw new Error("The visible map extent is unavailable. Move the map or choose a vector layer.");
    }
    if (bounds.west === bounds.east || bounds.south === bounds.north) {
        throw new Error("The map has no visible area. Make room for the map, or choose a vector layer.");
    }
    const selectedBounds = {west: Math.max(-180, bounds.west), south: Math.max(-90, bounds.south),
        east: Math.min(180, bounds.east), north: Math.min(90, bounds.north)};
    if (selectedBounds.west >= selectedBounds.east || selectedBounds.south >= selectedBounds.north) {
        throw new Error("Move the map inside the world bounds, or choose another analysis area.");
    }
    return modelAreaInput({kind: "selectedArea", selectedBounds});
}

/** Create an editable setup with suggestions and the current map area's meaning.
 * selectedArea is the same box around a map location used by raster histograms.
 * @param {Object} model Installed recipe.
 * @param {Object} context Catalog and map choices supplied by browser composition.
 * @param {string} id Local draft identity.
 * @return {Object} Draft values and independent copies of suggested inputs.
 */
export function createModelDraft(model, context, id) {
    const sources = structuredClone(context.rasters ?? []);
    const enabled = sources.filter(source => source.visible);
    const suggestion = enabled.length === 1 ? enabled[0] : sources.length === 1 ? sources[0] : null;
    const area = context.area ? modelAreaInput(context.area) : {kind: "wholeRaster"};
    return {id, model, label: model.title, sources, vectors: structuredClone(context.vectors ?? []),
        raster: suggestion ? structuredClone(suggestion) : null,
        sourceReason: sources.length ? "Choose a raster from Map layers." : "Add a raster to Map layers to use this model.",
        area, capturedArea: structuredClone(area), areaMode: ({wholeRaster: "whole", selectedArea: "mapBox", polygonArea: "mapPolygons"})[area.kind] ?? "captured", areaOrigin: "map", areaDescription: context.areaDescription ?? "Area selected on the map.",
        vectorKey: "", vectorInfo: null, selecting: false, selectionError: "",
        parameters: Object.fromEntries(Object.entries(model.parameters).map(([name, parameter]) => [name, parameter.default])),
        };
}

/** Capture one draft as a model request, validating area and source choices.
 * @param {Object} draft Editable model setup.
 * @param {string} requestId Stable retry identity generated before dispatch.
 * @return {Object} Independent submission, unaffected by later map or draft edits.
 * @throws {Error} If a required input, label, area or parameter is missing.
 */
export function captureModelSubmission(draft, requestId) {
    if (!draft.label.trim() || draft.label.length > 80) throw new Error("Name this run using 1–80 characters.");
    if (!draft.raster || !draft.sources.some(source => modelSourceKey(source) === modelSourceKey(draft.raster)))
        throw new Error("Choose a raster from Map layers.");
    if (draft.area?.kind === "catalogSelection" && !draft.vectors.some(source => modelSourceKey(source) === modelSourceKey(draft.area.selection)))
        throw new Error("Add the selected vector layer to Map layers before running this model.");
    if (draft.selecting) throw new Error("Wait for the selected features to finish loading.");
    if (!draft.area) throw new Error(draft.selectionError || "Choose an analysis area before running the model.");
    const inputs = {};
    for (const [name, input] of Object.entries(draft.model.inputs)) {
        if (input.type === "catalog_raster") inputs[name] = {collectionId: draft.raster.collectionId, itemId: draft.raster.itemId};
        else if (input.type === "summary_area") inputs[name] = structuredClone(draft.area);
        else throw new Error(`This model requires an input type this interface does not yet support: ${input.type}.`);
    }
    const area = Object.values(inputs).find(value => value.kind);
    if (area.kind === "selectedArea") modelAreaInput(area);
    else if (area.kind === "catalogSelection") modelAreaInput({kind: area.kind, catalogSelection: area.selection});
    else if (area.kind === "polygonArea") modelAreaInput({kind: area.kind, polygonArea: area.reference});
    for (const [name, parameter] of Object.entries(draft.model.parameters)) {
        const value = draft.parameters[name];
        if (parameter.type === "summary_expression" && (typeof value !== "string" || !value.trim())) throw new Error("Enter a summary formula.");
        if (["number", "optional_number"].includes(parameter.type) && !(value === null && parameter.type === "optional_number") &&
            (!Number.isFinite(value) || parameter.minimum != null && value < parameter.minimum ||
                parameter.exclusiveMinimum != null && value <= parameter.exclusiveMinimum)) throw new Error(`Check ${parameter.label}.`);
    }
    const {id, version, definitionSha256} = draft.model;
    return structuredClone({requestId, model: {id, version, definitionSha256}, inputs, parameters: draft.parameters, label: draft.label.trim()});
}
