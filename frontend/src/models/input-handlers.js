/** Register self-contained Data tools input controls and their draft lifecycle. */
import { vectorInputHandler } from "./vector-input.js";

/** One input type's state, capture, restoration and presentation behavior.
 * Registered handlers receive source metadata through composition, never map state.
 * @typedef {Object} ModelInputHandler
 * @property {(definition:Object,context:Object)=>Object} createDraft Create independent editable state from recipe settings and current sources.
 * @property {(state:Object,definition:Object,context:Object)=>void} refresh Update live choices while preserving captured run inputs.
 * @property {(state:Object,definition:Object)=>Object} capture Return detached invocation data, throwing Error for incomplete user choices.
 * @property {(state:Object,value:Object,definition:Object)=>void} restore Copy a saved invocation into the newly created draft.
 * @property {(ui:Object,callbacks:Object,name:string,definition:Object)=>{root:HTMLElement,render:(state:Object)=>boolean}} buildView Build stable controls whose render method reports input readiness.
 * @property {(value:Object,definition:Object,formatters:Object)=>string} describe Describe a saved input with recipe-provided labels.
 */

/** Existing input families retain their established controller and view behavior.
 * @type {Set<string>}
 */
const BUILTIN_INPUT_TYPES = new Set(["raster", "catalog_raster", "optional_raster", "summary_area", "clip_area",
    "mask_source", "habitat_references", "habitat_stack", "raster_preparation", "temporal_interval", "temporal_reduction", "area_statistic"]);

/** Installed input handlers, independent of individual model recipes.
 * @type {Map<string,ModelInputHandler>}
 */
const INPUT_HANDLERS = new Map([["vector", vectorInputHandler]]);

/** Find a registered input handler without changing the established input families.
 * @param {string} type Recipe input type.
 * @return {ModelInputHandler|null} Handler, or null for an existing or unsupported type.
 */
export function getModelInputHandler(type) { return INPUT_HANDLERS.get(type) ?? null; }

/** Report whether Data tools can edit the recipe's declared input type.
 * @param {string} type Recipe input type.
 * @return {boolean} Whether the input has registered or established controls.
 */
export function supportsModelInput(type) { return INPUT_HANDLERS.has(type) || BUILTIN_INPUT_TYPES.has(type); }
