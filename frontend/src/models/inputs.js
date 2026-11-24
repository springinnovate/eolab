/** Build model drafts from available source identities and explicit analysis areas. */
import { getModelSetupIntegration } from "./model-setup.js";
import { normalizeCalculationArea } from "../processing/calculation-area.js";
import { createTemporalDraft, captureTemporalInput, captureTemporalReduction } from "./temporal-inputs.js";
import { getModelInputHandler } from "./input-handlers.js";
import { captureModelRaster, modelSourceKey } from "./raster-input.js";
import { captureMapViewportArea as modelViewportArea } from "../selected-area.js";
export { captureModelRaster, modelSourceKey, modelViewportArea };

/** @typedef {{key:string,label:string,polygons:Array<{type:"Polygon",coordinates:number[][][]}>,total:number}} DrawnPolygonLayer */

/** A recipe setting whose string value is selected from named options.
 * @typedef {Object} ModelChoiceParameter
 * @property {"choice"} type Parameter family.
 * @property {string} label User-facing setting name.
 * @property {Array<{value:string,label:string}>} choices Nonempty options with unique values and readable labels.
 * @property {string} default Initial value, matching one declared option.
 */

/** Check whether a model declares an input of the requested type.
 * @param {Object} model Installed recipe.
 * @param {string} type Input type from the model contract.
 * @return {boolean} Whether the recipe needs this control.
 */
export function modelHasInput(model, type) { return Object.values(model.inputs).some(input => input.type === type); }

/** Report whether a recipe can use committed drawn polygon layers.
 * @param {Object} model Installed recipe.
 * @return {boolean} Whether to request polygon drawings from browser composition.
 */
export function modelSupportsDrawnAreas(model) {
    return model.id === "habitat-condition" || modelHasInput(model, "explicit_area") || modelHasInput(model, "polygon_layer");
}

/** Report whether the shared area picker owns this input.
 * @param {string} type Recipe input type.
 * @return {boolean} Whether to use ordinary spatial input controls.
 */
export function isModelSpatialInput(type) {
    return ["summary_area", "clip_area", "explicit_area", "mask_source", "habitat_references"].includes(type);
}

/** List unexpired raster outputs available as inputs to another model run.
 * @param {Object[]} runs Run status and file lists already loaded by Models.
 * @return {Object[]} Source choices; display previews and transient files are excluded.
 */
export function modelResultSources(runs) {
    return runs.filter(run => run.status === "ready" && Date.parse(run.expiresAt) > Date.now() && run.artifacts?.availability === "available")
        .flatMap(run => run.artifacts.files.filter(file => file.mediaType === "image/tiff" && ["result", "intermediate"].includes(file.role))
            .map(file => ({kind: "runArtifact", jobId: run.jobId, artifactId: file.artifactId, label: file.displayName ?? `${file.label} · ${run.label}`, available: true, expiresAt: run.expiresAt})));
}

/** List the editable raster values used by a draft's declared inputs.
 * Refresh and run observation use these locations to follow every selected file,
 * including stack rows and reference rasters. Inactive reference-raster choices
 * are left alone until the user switches that input back to raster mode.
 * @param {Object} draft Model setup with named input state.
 * @return {Array<{state:Object,field:"raster"|"maskRaster",optional:boolean}>} Mutable source
 * locations. Optional choices retain a missing source so it cannot become an
 * omitted mask without the user clearing it.
 */
export function getModelRasterFields(draft) {
    const fields = [];
    for (const [name, definition] of Object.entries(draft.model.inputs)) {
        const state = draft.inputs[name];
        if (["raster", "catalog_raster", "optional_raster"].includes(definition.type)) {
            fields.push({state, field: "raster", optional: definition.type === "optional_raster"});
        } else if (["mask_source", "habitat_references"].includes(definition.type) && state.areaMode === "raster") {
            fields.push({state, field: "maskRaster", optional: false});
        } else if (definition.type === "habitat_stack" && state.kind === "manual") {
            for (const row of [...state.predictors, ...state.responses]) fields.push({state: row, field: "raster", optional: false});
        }
    }
    return fields;
}

/** List selected raster sources so the existing observer can follow their runs.
 * Input handlers resolve their own bindings without exposing mutable field layouts.
 * @param {Object} draft Model setup with named input state.
 * @return {Object[]} Selected source metadata, excluding empty choices.
 */
export function getModelRasterSources(draft) {
    const sources = getModelRasterFields(draft).map(({state, field}) => state[field]).filter(Boolean);
    for (const [name, definition] of Object.entries(draft.model.inputs)) {
        const handler = getModelInputHandler(definition.type);
        if (handler?.getRasterSources) sources.push(...handler.getRasterSources(draft.inputs[name]));
    }
    return sources;
}

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

/** Check whether an area is accepted by one declared input type.
 * @param {string} type Recipe area, starting-mask or reference-sites input type.
 * @param {{kind:string}|null} area Explicit area descriptor.
 * @return {boolean} Whether this field accepts the area kind.
 */
export function modelSupportsArea(type, area) {
    const supportedAreaKinds = type === "clip_area" ? ["selectedArea", "samplingBox", "catalogSelection", "polygonGroup"] :
        type === "explicit_area" ? ["selectedArea", "samplingBox", "catalogSelection", "polygonArea"] :
        type === "summary_area" ? ["selectedArea", "samplingBox", "catalogSelection", "wholeRaster", "polygonArea"] :
            type === "habitat_references" ? ["catalogSelection", "polygonArea"] : type === "mask_source" ? ["catalogSelection"] : [];
    return supportedAreaKinds.includes(area?.kind);
}

/** Resolve the Raster clip group against current original-source choices and filters.
 * @param {Object} input Clip setup with its group ID, groups and available polygon views.
 * @return {void} Updates the submitted area or an explanation of what must be fixed.
 */
export function updateClipPolygonGroup(input) {
    input.area = null;
    const group = input.polygonGroups.find(candidate => candidate.id === input.polygonGroupId);
    if (!group) {
        input.selectionError = "Choose a polygon group from Map contents.";
        return;
    }
    const vectors = new Map(input.vectors.map(source => [source.key, source]));
    const unavailable = group.members.filter(layer => !vectors.has(layer.key));
    if (unavailable.length) {
        input.selectionError = `Add these layers to Map contents or edit the group. ${unavailable.map(layer => layer.label).join(", ")}`;
        return;
    }
    input.selectionError = "";
    input.area = {kind: "polygonGroup", name: group.name, members: group.members.map(layer => {
        const source = vectors.get(layer.key);
        return {label: source.label, selection: source.selection};
    })};
}

/** Find this field's drawn layer in the latest committed map snapshot.
 * @param {{drawnPolygonLayers:DrawnPolygonLayer[]}} draft Available drawn layers and their applied filters' polygons.
 * @param {{drawnPolygonKey:string}} input This field's independent layer choice.
 * @return {DrawnPolygonLayer|undefined} Filtered layer, or undefined when it is absent.
 */
export function selectedDrawnPolygonLayer(draft, input) {
    return draft.drawnPolygonLayers.find(layer => layer.key === input.drawnPolygonKey);
}

/** Create independent setup state for each declared raster and spatial input.
 * The selectedArea input is the sampling area used by raster histograms.
 * Models with a starting mask require the user to choose that mask explicitly.
 * Registered model setup owns specialized initial choices and cross-input state.
 * @param {Object} model Installed recipe.
 * @param {Object & {drawnPolygonLayers?:DrawnPolygonLayer[]}} context Catalog and map choices supplied by browser composition, with detached drawn layers for tools that accept them.
 * @param {string} id Local draft identity.
 * @param {import("./model-setup.js").ModelSetupIntegration|null} [integration] Registered setup owner or explicit ordinary setup.
 * @return {Object} Draft with field state in inputs[name], shared source choices,
 * temporal controls and parameters. Ordinary raster inputs track copiedFromRun
 * until an explicit source choice replaces that provenance. Spatial fields select live vector views or
 * retain an explicitly captured area from the map or an earlier run.
 * @throws {Error} If the supplied map selection is invalid.
 */
export function createModelDraft(model, context, id, integration = getModelSetupIntegration(model)) {
    const sources = structuredClone(context.rasters ?? []);
    const catalogRasters = sources.filter(source => source.kind !== "runArtifact");
    const visibleCatalogRasters = catalogRasters.filter(source => source.visible);
    const suggestedRaster = visibleCatalogRasters.length === 1 ? visibleCatalogRasters[0] : catalogRasters.length === 1 ? catalogRasters[0] : null;
    const usesStartingMask = modelHasInput(model, "mask_source");
    const usesTemporal = modelHasInput(model, "temporal_interval");
    const statisticType = Object.values(model.inputs).find(input => ["temporal_reduction", "area_statistic"].includes(input.type))?.type;
    const inputs = {};
    for (const [name, input] of Object.entries(model.inputs)) {
        const handler = getModelInputHandler(input.type);
        const owned = integration?.createInput(input);
        if (owned !== undefined) inputs[name] = owned;
        else if (handler) inputs[name] = handler.createDraft(input, context);
        else if (["raster", "catalog_raster", "optional_raster"].includes(input.type)) {
            inputs[name] = {
                raster: input.type !== "optional_raster" && !usesStartingMask && suggestedRaster ? structuredClone(suggestedRaster) : null,
                copiedFromRun: false,
            };
        } else if (isModelSpatialInput(input.type)) {
            const explicitSelection = ["mask_source", "habitat_references"].includes(input.type);
            let area = explicitSelection ? null : context.area ? modelAreaInput(context.area) : {kind: "wholeRaster"};
            let areaMode = explicitSelection ? "vector" : ({wholeRaster: "whole", selectedArea: "samplingArea", samplingBox: "samplingArea", polygonArea: "mapPolygons"})[area.kind] ?? "captured";
            let selectionError = "";
            if (!explicitSelection && (!modelSupportsArea(input.type, area) || usesTemporal && !context.area)) {
                areaMode = "viewport"; area = null;
                try { area = modelViewportArea(context.viewportBounds); }
                catch (error) { selectionError = error.message; }
            }
            inputs[name] = {
                area, capturedArea: structuredClone(area), areaMode, areaOrigin: "map", areaDescription: context.areaDescription ?? "Area selected on the map.",
                vectorKey: "", vectorInfo: null, drawnPolygonKey: "", selecting: false, selectionError, maskRaster: null,
                vectors: structuredClone(context.vectors ?? []),
                ...(input.type === "clip_area" ? {polygonGroups: context.polygonGroups ?? [], polygonGroupId: ""} : {}),
            };
        }
    }
    return {id, model, label: model.title, sources, inputs, integration,
        setupState: integration?.createState(model, inputs, context, {viewportArea: modelViewportArea}) ?? null,
        drawnPolygonLayers: modelSupportsDrawnAreas(model) ? context.drawnPolygonLayers ?? [] : [],
        temporal: usesTemporal ? createTemporalDraft(context.temporalDatasets ?? [], statisticType,
            statisticType === "temporal_reduction" ? model.steps[0].inputs.precipitation.value : null) : null,
        reduction: statisticType ? {reducer: "mean", percentile: 90} : null,
        parameters: Object.fromEntries(Object.entries(model.parameters).map(([name, parameter]) => [name, parameter.default])),
    };
}

/** Capture the checked model inputs independently of later map and draft edits.
 * Drawn polygon choices are captured as local geometry for the controller to
 * replace with private area references before sending or saving the request.
 * Registered integrations capture their owned inputs through the same invocation contract.
 * @param {Object} draft Editable model setup with raster and spatial state in inputs[name].
 * @param {string} requestId Stable retry identity generated before dispatch.
 * @param {number} [utcOffsetMinutes=-new Date().getTimezoneOffset()] Local minutes east of UTC, captured once for this submission and its retries.
 * @return {Object} Detached submission with any drawn polygons awaiting upload.
 * @throws {Error} If a required input, label, area or parameter is missing or a choice is not declared by the recipe.
 */
export function captureModelSubmission(draft, requestId, utcOffsetMinutes = -new Date().getTimezoneOffset()) {
    if (!draft.label.trim() || [...draft.label.trim()].length > 80) throw new Error("Name this run using 1–80 characters.");
    const inputs = {};
    for (const [name, input] of Object.entries(draft.model.inputs)) {
        const state = draft.inputs[name];
        const handler = getModelInputHandler(input.type);
        const owned = draft.integration?.captureInput(draft, name, {captureRaster: captureModelRaster});
        if (owned !== undefined) inputs[name] = owned;
        else if (handler) inputs[name] = handler.capture(state, input);
        else if (["raster", "catalog_raster", "optional_raster"].includes(input.type))
            inputs[name] = input.type === "optional_raster" && state.raster === null ? null : captureModelRaster(state.raster, draft.sources, input.type);
        else if (input.type === "temporal_interval") inputs[name] = captureTemporalInput(draft.temporal, draft.reduction.reducer);
        else if (input.type === "temporal_reduction") inputs[name] = captureTemporalReduction(draft.reduction);
        else if (input.type === "area_statistic") inputs[name] = draft.reduction.reducer;
        else if (isModelSpatialInput(input.type)) {
            if (state.selecting) throw new Error("Wait for the selected features to finish loading.");
            const startingMask = input.type === "mask_source";
            const references = input.type === "habitat_references";
            if (state.areaMode === "drawnPolygons") {
                const layer = selectedDrawnPolygonLayer(draft, state);
                if (!layer) throw new Error(`Choose a drawn polygon layer for ${input.label.toLowerCase()}.`);
                if (!layer.polygons.length) throw new Error(`No polygons match in ${layer.label}. Add a polygon or change the layer's filter.`);
                inputs[name] = {kind: "drawnPolygons", key: layer.key, polygons: layer.polygons};
            } else if ((startingMask || references) && state.areaMode === "raster") {
                const raster = state.maskRaster;
                inputs[name] = {kind: references ? "raster" : "catalogRaster", source: captureModelRaster(raster, draft.sources, input.type)};
            } else {
                const area = state.area;
                if (!area) throw new Error(state.selectionError || (startingMask ? "Choose the vector features where flow should start." : references ? "Choose the reference sites." : "Choose an analysis area before running the tool."));
                if (!modelSupportsArea(input.type, area)) throw new Error("Choose an area supported by this tool.");
                if (area.kind === "catalogSelection" && state.areaMode !== "captured" &&
                    !state.vectors.some(source => modelSourceKey(source) === modelSourceKey(area.selection)))
                    throw new Error("Add the selected vector dataset to Map contents before running this tool.");
                if (["selectedArea", "samplingBox"].includes(area.kind)) modelAreaInput(area);
                else if (area.kind === "catalogSelection") modelAreaInput({kind: area.kind, catalogSelection: area.selection});
                else if (area.kind === "polygonArea") modelAreaInput({kind: area.kind, polygonArea: area.reference});
                inputs[name] = references && area.kind === "catalogSelection"
                    ? {kind: "vector", selection: structuredClone(area.selection)} : structuredClone(area);
            }
        }
        else throw new Error(`This tool requires an input type this interface does not yet support: ${input.type}.`);
    }
    for (const [name, parameter] of Object.entries(draft.model.parameters)) {
        const value = draft.parameters[name];
        if (parameter.type === "boolean" && typeof value !== "boolean") throw new Error("Choose a value for " + parameter.label + ".");
        if (parameter.type === "choice" && !parameter.choices.some(choice => choice.value === value))
            throw new Error(`Choose an available option for ${parameter.label}.`);
        if (parameter.type === "summary_expression" && (typeof value !== "string" || !value.trim())) throw new Error("Enter a summary formula.");
        if (["number", "optional_number"].includes(parameter.type) && !(value === null && parameter.type === "optional_number")) {
            if (!Number.isFinite(value)) throw new Error(`Enter a number for ${parameter.label}.`);
            const unit = parameter.unit ? ` ${parameter.unit}` : "";
            if (parameter.minimum != null && value < parameter.minimum) throw new Error(`${parameter.label} must be at least ${parameter.minimum}${unit}.`);
            if (parameter.exclusiveMinimum != null && value <= parameter.exclusiveMinimum) throw new Error(`${parameter.label} must be greater than ${parameter.exclusiveMinimum}${unit}.`);
        }
    }
    const {id, version, definitionSha256} = draft.model;
    return structuredClone({requestId, model: {id, version, definitionSha256}, inputs, parameters: draft.parameters,
        label: draft.label.trim(), utcOffsetMinutes: utcOffsetMinutes === 0 ? 0 : utcOffsetMinutes});
}
