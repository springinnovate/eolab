/** Edit a vector selection and field roles declared by a Data tools recipe. */

/** Recipe-declared vector selection and its required attribute selectors.
 * @typedef {Object} VectorInputDefinition
 * @property {"vector"} type Input family.
 * @property {string} label User-facing layer selector label.
 * @property {"polygon"} [geometry] Optional polygon restriction; composed calculation inputs currently contain polygon sources only.
 * @property {Object<string,{label:string,kind:"scalar"|"numeric"}>} [fields] Named field selectors; absent or empty for a source-only input.
 */

/** Composed vector metadata available without opening the original file.
 * @typedef {Object} VectorInputSource
 * @property {string} key Map-layer identity, independent of its visibility.
 * @property {string} label User-facing layer name.
 * @property {Object} filter Accepted field predicate.
 * @property {Array<{name:string,type:string}>} scalarFields Attributes supporting scalar comparisons.
 * @property {Array<{name:string,type:string}>} numericFields Numeric attributes.
 * @property {Object} selection Path-free source/layer identity and accepted predicate.
 * @property {Object} allSelection Same source/layer identity with no predicate.
 */

/** Independent choices retained while one vector input is edited.
 * @typedef {Object} VectorInputState
 * @property {string} vectorKey Selected live layer key, or empty for a captured run source.
 * @property {VectorInputSource[]} vectors Current composed source choices.
 * @property {"all"|"filtered"} featureScope Whether to use the whole layer or its accepted filter.
 * @property {Object<string,string>} fields Chosen attribute name for each configured role.
 * @property {Object|null} capturedSelection Original run's source/layer and predicate, or null for live input.
 * @property {string} selectionError User-facing reason a live layer is unavailable, or an empty string.
 */

/** DOM helpers supplied by the owning Models view.
 * @typedef {Object} VectorInputUi
 * @property {(tag:string,text?:string,className?:string)=>HTMLElement} element Create a view-owned element.
 * @property {(id:string,label:string,input:HTMLElement)=>HTMLElement} field Associate a label with a control.
 * @property {(input:HTMLSelectElement,choices:Array<{value:string,label:string}>,selected:string)=>void} options Replace choices while preserving selection.
 * @property {(filter:Object)=>string} describeFilter Format an accepted field predicate.
 */

/** Initialize every field role from the recipe with no implicit source choice.
 * @param {VectorInputDefinition} definition Installed input declaration.
 * @param {{vectors?:VectorInputSource[]}} context Current source metadata from composition.
 * @return {VectorInputState} Detached editable input state.
 */
function createVectorInputDraft(definition, context) {
    return {vectorKey: "", vectors: structuredClone(context.vectors ?? []), featureScope: "filtered",
        fields: Object.fromEntries(Object.keys(definition.fields ?? {}).map(role => [role, ""])),
        capturedSelection: null, selectionError: ""};
}

/** Capture the selected vector and the recipe's named attribute choices.
 * The selected predicate is captured when the user runs the tool; no features
 * are scanned here. Captured run inputs are reauthorized by Processing.
 * @param {VectorInputState} state Editable source and field choices.
 * @param {VectorInputDefinition} definition Required field labels and kinds.
 * @return {{selection:Object,fields:Object<string,string>}} Detached invocation value.
 * @throws {Error} If the source or a required field choice is unavailable.
 */
function captureVectorInput(state, definition) {
    const source = state.vectors.find(value => value.key === state.vectorKey);
    if (!source && !state.capturedSelection) throw new Error(`Choose a layer for ${definition.label}.`);
    const fields = {};
    for (const [role, field] of Object.entries(definition.fields ?? {})) {
        const selected = state.fields[role];
        if (!selected) throw new Error(`Choose a field for ${field.label}.`);
        const choices = source ? field.kind === "numeric" ? source.numericFields : source.scalarFields : null;
        if (choices && !choices.some(value => value.name === selected)) throw new Error(`Choose an available field for ${field.label}.`);
        fields[role] = selected;
    }
    const selection = source ? state.featureScope === "all" ? source.allSelection : source.selection : state.capturedSelection;
    return structuredClone({selection, fields});
}

/** Refresh live layer choices while leaving an original run's captured input intact.
 * Removing the chosen live layer clears its fields and never selects a replacement.
 * @param {VectorInputState} state Editable input to update.
 * @param {VectorInputDefinition} definition Configured field roles.
 * @param {{vectors?:VectorInputSource[]}} context Current source metadata from composition.
 * @return {void}
 */
function refreshVectorInput(state, definition, context) {
    state.vectors = structuredClone(context.vectors ?? []);
    if (state.vectorKey && !state.vectors.some(source => source.key === state.vectorKey)) {
        state.vectorKey = "";
        state.fields = Object.fromEntries(Object.keys(definition.fields ?? {}).map(role => [role, ""]));
        state.selectionError = "Add the vector layer to Map layers, or choose another layer.";
    }
}

/** Restore the original run's fields and selection without guessing a matching map view.
 * @param {VectorInputState} state Newly created editable input.
 * @param {{selection:Object,fields:Object<string,string>}} value Validated saved invocation input.
 * @param {VectorInputDefinition} _definition Installed declaration for the saved recipe version.
 * @return {void}
 */
function restoreVectorInput(state, value, _definition) {
    Object.assign(state, {vectorKey: "", capturedSelection: structuredClone(value.selection), fields: structuredClone(value.fields)});
}

/** Describe a saved vector input using configured field labels and its captured filter.
 * @param {{selection:Object,fields:Object<string,string>}} value Validated saved invocation input.
 * @param {VectorInputDefinition} definition Installed field labels.
 * @param {{describeFilter:(filter:Object)=>string}} formatters Owning view's predicate formatter.
 * @return {string} Readable selected fields followed by the feature selection.
 */
function describeVectorInput(value, definition, formatters) {
    return [...Object.entries(definition.fields ?? {}).map(([role, field]) => `${field.label}: ${value.fields[role]}`),
        formatters.describeFilter(value.selection.filter)].join(" · ");
}

/** Keep source and configured field selectors stable while one vector input is edited. */
class VectorInputView {
    /** Build controls from the recipe rather than any operation's attribute roles.
     * @param {VectorInputUi} ui Owning view's DOM and predicate helpers.
     * @param {{onInput:(name:string,change:Object)=>void}} callbacks Submit edits to the draft owner.
     * @param {string} name Declared input name.
     * @param {VectorInputDefinition} definition Installed field-selector configuration.
     */
    constructor(ui, callbacks, name, definition) {
        Object.assign(this, {ui, definition});
        this.root = ui.element("div", "", "models-spatial-input");
        this.source = ui.element("select"); this.source.required = true;
        this.source.addEventListener("change", () => callbacks.onInput(name, {
            vectorKey: this.source.value, capturedSelection: null,
            fields: Object.fromEntries(Object.keys(definition.fields ?? {}).map(role => [role, ""])), selectionError: "",
        }));
        this.scope = ui.element("select");
        ui.options(this.scope, [{value: "filtered", label: "Features matching the layer filter"},
            {value: "all", label: "All features in the layer"}], "filtered");
        this.scope.addEventListener("change", () => callbacks.onInput(name, {featureScope: this.scope.value}));
        this.root.append(ui.field(`models-${name}-source`, definition.label, this.source),
            ui.field(`models-${name}-scope`, "Features to use", this.scope));
        this.fields = {};
        for (const [role, field] of Object.entries(definition.fields ?? {})) {
            const control = ui.element("select"); control.required = true;
            control.addEventListener("change", () => callbacks.onInput(name, {
                fields: Object.fromEntries(Object.entries(this.fields).map(([key, select]) => [key, select.value])),
            }));
            this.fields[role] = control;
            this.root.append(ui.field(`models-${name}-field-${role}`, field.label, control));
        }
        this.description = ui.element("p", "", "models-help");
        this.status = ui.element("p", "", "models-help"); this.status.setAttribute("role", "status");
        this.root.append(this.description, this.status);
    }

    /** Refresh configured choices without scanning features or replacing selected values.
     * @param {VectorInputState} state Editable input with current source metadata.
     * @return {boolean} Whether the input is ready to capture for submission.
     */
    render(state) {
        const source = state.vectors.find(value => value.key === state.vectorKey);
        const captured = !source && state.capturedSelection;
        this.ui.options(this.source, [{value: "", label: captured ? "Layer and filter from original run" : "Choose a vector layer…"},
            ...state.vectors.map(value => ({value: value.key, label: value.label}))], state.vectorKey);
        this.source.required = !captured;
        this.scope.value = state.featureScope; this.scope.disabled = Boolean(captured);
        const unavailableFields = [];
        for (const [role, field] of Object.entries(this.definition.fields ?? {})) {
            const choices = source ? field.kind === "numeric" ? source.numericFields : source.scalarFields : captured ? [{name: state.fields[role]}] : [];
            this.ui.options(this.fields[role], [{value: "", label: field.kind === "numeric" ? "Choose a numeric field…" : "Choose a field…"},
                ...choices.map(value => ({value: value.name, label: value.name}))], state.fields[role]);
            this.fields[role].disabled = !source && !captured;
            if (source && !choices.length) unavailableFields.push(field.label);
        }
        this.description.textContent = captured ? `Uses the original run's selection. ${this.ui.describeFilter(captured.filter)}` :
            source ? state.featureScope === "all" ? "All features are included, regardless of the layer's map filter or visibility."
                : `Uses the layer's filter when you run the tool. ${this.ui.describeFilter(source.filter)}` : "Add a vector layer to Map layers to choose it here.";
        this.status.textContent = state.selectionError || (unavailableFields.length ? `No eligible fields are available for: ${unavailableFields.join(", ")}.` : "");
        try { captureVectorInput(state, this.definition); return true; } catch { return false; }
    }
}

/** Build the registered vector input's synchronous view without accessing global DOM state.
 * @param {VectorInputUi} ui Owning view's helpers.
 * @param {{onInput:(name:string,change:Object)=>void}} callbacks Draft edit callbacks.
 * @param {string} name Declared input name.
 * @param {VectorInputDefinition} definition Installed vector configuration.
 * @return {VectorInputView} Stable controls for this input.
 */
function buildVectorInputView(ui, callbacks, name, definition) { return new VectorInputView(ui, callbacks, name, definition); }

/** Registered vector-selection behavior, reusable by recipes with different field roles.
 * @type {import("./input-handlers.js").ModelInputHandler}
 */
export const vectorInputHandler = Object.freeze({createDraft: createVectorInputDraft, refresh: refreshVectorInput,
    capture: captureVectorInput, restore: restoreVectorInput, describe: describeVectorInput, buildView: buildVectorInputView});
