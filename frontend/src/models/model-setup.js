/** Register model-owned setup behavior while the shared UI hosts its lifecycle. */
import { habitatSetup } from "./habitat-setup.js";

/** Element builders and ordinary input presentation available to a setup integration.
 * @typedef {Object} ModelSetupUi
 * @property {(tag:string,text?:string,className?:string)=>HTMLElement} element Create a text-only element.
 * @property {(id:string,label:string,input:HTMLElement)=>HTMLLabelElement} field Label an input.
 * @property {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} options Update choice labels and selection.
 * @property {(label:string,action:()=>void,className?:string)=>HTMLButtonElement} button Create an action button.
 * @property {Document} document Owning document for focus-preserving rendering.
 * @property {(filter:Object)=>string} describeFilter Explain the selected predicate.
 * @property {(source:Object)=>string} sourceKey Compare original source identities.
 * @property {(raster:Object,sources:Object[],type?:string)=>Object} captureRaster Capture an available original raster reference.
 * @property {(root:HTMLElement)=>void} append Place an integration-owned control in the form.
 * @property {(host:HTMLElement,name:string,input:Object,onChange?:(value:Object|null)=>void,onResampling?:(method:string)=>void)=>Object} buildRasterInput Build an ordinary raster chooser.
 * @property {(controls:Object,input:Object,value:Object,state:Object)=>boolean} renderRasterInput Render ordinary raster choices and readiness.
 * @property {(name:string,input:Object)=>Object} buildSpatialInput Build ordinary spatial controls in the form.
 * @property {(controls:Object,input:Object,value:Object,state:Object)=>boolean} renderSpatialInput Render ordinary spatial choices and readiness.
 */

/** Only notifications owned by editable setup, excluding run/history actions.
 * @typedef {Object} ModelSetupActions
 * @property {(name:string,change:Object)=>void} onInput Update one declared input.
 * @property {(action:string,value?:unknown)=>Promise<void>|void} onSetupAction Dispatch an integration-owned action.
 */

/** Model-owned input controls hosted inside the ordinary setup form.
 * Additional fields belong to the integration or ordinary input builder that
 * created them; the host only calls renderModelInput for readiness.
 * @typedef {Object} ModelSetupControls
 * @property {(draft:Object,state:Object)=>boolean} renderModelInput Update presentation and report whether this input is ready.
 */

/** Transport and notifications supplied to one model-owned async session.
 * @typedef {Object} ModelSetupDependencies
 * @property {Object} api Existing Processing API transport; the integration selects its own endpoints.
 * @property {(source:Object,signal?:AbortSignal)=>Promise<Object>} getCatalogItem Read exact Catalog metadata for display.
 * @property {()=>void} render Request a render while this draft is current.
 * @property {()=>void} refreshGrid Refresh shared grid choices while this draft is current.
 * @property {()=>void} closeInputEditor Close an active input editor while this draft is current.
 */

/** One model integration's draft, input presentation and asynchronous setup lifecycle.
 * Model-owned state is opaque to the host. No integration receives a controller,
 * viewer or map object; dependencies expose only transport and explicit UI callbacks.
 * @typedef {Object} ModelSetupIntegration
 * @property {(model:Object,inputs:Object,context:Object,helpers:{viewportArea:(bounds:Object)=>Object})=>Object} createState Create model-owned state and adjust initial input defaults.
 * @property {(definition:Object,preparation:Object)=>Object|undefined} createInput Create an owned input, or defer to ordinary input handling.
 * @property {(draft:Object,name:string,helpers:{captureRaster:(raster:Object,sources:Object[])=>Object})=>Object|undefined} captureInput Capture an owned input, or defer to ordinary capture.
 * @property {(draft:Object,name:string,value:Object)=>boolean} restoreInput Restore an owned input and report whether it handled the value.
 * @property {(draft:Object,inputs:Object)=>void} restoreState Restore cross-input setup state after ordinary input restoration.
 * @property {(draft:Object)=>{key:string,label:string,sourceCrs:string,grid:Object}|null} acquisitionGrid Supply an optional model-provided grid choice.
 * @property {(ui:ModelSetupUi,handlers:ModelSetupActions,name:string,definition:Object,draft:Object)=>ModelSetupControls|null} buildInput Build owned controls or defer to ordinary controls.
 * @property {(draft:Object,dependencies:ModelSetupDependencies)=>ModelSetupSession} createSession Bind transport and explicit UI notifications to one draft.
 */

/** Async work belonging to one editable model draft.
 * @typedef {Object} ModelSetupSession
 * @property {()=>Promise<void>} start Load choices after creation or restoration.
 * @property {(name:string,change:Object)=>void} inputChanged React to a declared input edit.
 * @property {(action:string,value:unknown)=>Promise<void>|void} action Handle an action emitted by the integration's own controls.
 * @property {()=>void} dispose Cancel reads and prevent abandoned-draft updates.
 */

/** Find setup behavior for the recipe's installed input family.
 * @param {Object} model Validated installed recipe.
 * @return {ModelSetupIntegration|null} Model-owned integration, or ordinary shared setup.
 */
export function getModelSetupIntegration(model) {
    return Object.values(model.inputs).some(input => input.type === "habitat_stack") ? habitatSetup : null;
}
