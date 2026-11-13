/** Edit a vector selection, field roles and repeated rows declared by a Data tools recipe. */

/** One recipe-defined source attribute selector.
 * @typedef {{label:string,kind:"scalar"|"numeric"}} VectorFieldDefinition
 */

/** A repeatable group of source attributes and choice settings.
 * @typedef {Object} VectorInputRowsDefinition
 * @property {string} label User-facing title for the group.
 * @property {string} itemLabel Singular row name used in numbered legends and Add/Remove actions.
 * @property {Object<string,VectorFieldDefinition>} fields Required source attribute selectors in each row.
 * @property {Object<string,import("./inputs.js").ModelChoiceParameter>} parameters Required choice settings in each row.
 */

/** Attribute names and recipe choice values belonging to one repeated row.
 * @typedef {{fields:Object<string,string>,parameters:Object<string,string>}} VectorInputRowValue
 */

/** Captured source, fields and optional repeated rows passed to Processing.
 * @typedef {{selection:Object,fields:Object<string,string>,rows?:VectorInputRowValue[]}} VectorInputValue
 */

/** Recipe-declared vector selection and its required attribute selectors.
 * @typedef {Object} VectorInputDefinition
 * @property {"vector"} type Input family.
 * @property {string} label User-facing layer selector label.
 * @property {"polygon"} [geometry] Optional polygon restriction; composed calculation inputs currently contain polygon sources only.
 * @property {Object<string,VectorFieldDefinition>} [fields] Named field selectors; absent or empty for a source-only input.
 * @property {VectorInputRowsDefinition} [rows] Optional repeated controls, with at least one row and no maximum count.
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
 * @property {VectorInputRowValue[]} [rows] Ordered row values when the recipe declares repeated controls.
 * @property {Object<string,string[]>} [capturedRowFields] Saved field names available for each row role without reading the original source.
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

/** Initialize each declared attribute role without choosing a source field.
 * @param {Object<string,VectorFieldDefinition>} [fields={}] Required field selectors.
 * @return {Object<string,string>} Independent empty field choices.
 */
function emptyVectorFields(fields = {}) { return Object.fromEntries(Object.keys(fields).map(role => [role, ""])); }

/** Initialize one repeated row with empty attributes and the recipe's choice defaults.
 * @param {VectorInputRowsDefinition} definition Repeated control declarations.
 * @return {VectorInputRowValue} Independent editable row.
 */
function createVectorInputRow(definition) {
    return {fields: emptyVectorFields(definition.fields),
        parameters: Object.fromEntries(Object.entries(definition.parameters).map(([name, parameter]) => [name, parameter.default]))};
}

/** Clear source-dependent fields while preserving row count and choice settings.
 * @param {VectorInputState} state Current editable choices.
 * @param {VectorInputDefinition} definition Required attribute roles.
 * @return {{fields:Object<string,string>,rows?:VectorInputRowValue[]}} Fields to apply after changing or losing the source.
 */
function createClearedVectorFields(state, definition) {
    return {fields: emptyVectorFields(definition.fields), ...(definition.rows ? {
        rows: state.rows.map(row => ({fields: emptyVectorFields(definition.rows.fields), parameters: {...row.parameters}})),
    } : {})};
}

/** Initialize fields and one configured row without an implicit source choice.
 * @param {VectorInputDefinition} definition Installed input declaration.
 * @param {{vectors?:VectorInputSource[]}} context Current source metadata from composition.
 * @return {VectorInputState} Detached editable input state.
 */
function createVectorInputDraft(definition, context) {
    return {vectorKey: "", vectors: structuredClone(context.vectors ?? []), featureScope: "filtered",
        fields: emptyVectorFields(definition.fields), ...(definition.rows ? {rows: [createVectorInputRow(definition.rows)], capturedRowFields: {}} : {}),
        capturedSelection: null, selectionError: ""};
}

/** Validate required attribute choices against available source metadata.
 * @param {Object<string,string>} values Editable attribute selections.
 * @param {Object<string,VectorFieldDefinition>} definitions Required attribute roles.
 * @param {VectorInputSource|undefined} source Live source metadata, absent for a captured run.
 * @param {string} [context=""] Numbered row name for a useful validation message.
 * @return {Object<string,string>} Attribute names keyed by configured roles.
 * @throws {Error} If a required attribute is missing or unavailable.
 */
function captureVectorFields(values, definitions, source, context = "") {
    return Object.fromEntries(Object.entries(definitions).map(([role, field]) => {
        const selected = values[role], label = context ? `${context}: ${field.label}` : field.label;
        if (!selected) throw new Error(`Choose a field for ${label}.`);
        const choices = source ? field.kind === "numeric" ? source.numericFields : source.scalarFields : null;
        if (choices && !choices.some(value => value.name === selected)) throw new Error(`Choose an available field for ${label}.`);
        return [role, selected];
    }));
}

/** Capture one vector selection and all configured fields and repeated rows.
 * The selected predicate is captured when the user runs the tool; no features
 * are scanned here. Captured run inputs are reauthorized by Processing.
 * @param {VectorInputState} state Editable source and field choices.
 * @param {VectorInputDefinition} definition Required field labels and kinds.
 * @return {VectorInputValue} Detached invocation value for one Processing submission.
 * @throws {Error} If the source, a required field or a row choice is unavailable, or no configured rows remain.
 */
function captureVectorInput(state, definition) {
    const source = state.vectors.find(value => value.key === state.vectorKey);
    if (!source && !state.capturedSelection) throw new Error(`Choose a layer for ${definition.label}.`);
    const fields = captureVectorFields(state.fields, definition.fields ?? {}, source);
    let rows;
    if (definition.rows) {
        if (!state.rows.length) throw new Error(`Add at least one ${definition.rows.itemLabel.toLowerCase()}.`);
        rows = state.rows.map((row, index) => {
            const context = `${definition.rows.itemLabel} ${index + 1}`;
            const parameters = Object.fromEntries(Object.entries(definition.rows.parameters).map(([name, parameter]) => {
                const value = row.parameters[name];
                if (!parameter.choices.some(choice => choice.value === value)) throw new Error(`Choose an available option for ${context}: ${parameter.label}.`);
                return [name, value];
            }));
            return {fields: captureVectorFields(row.fields, definition.rows.fields, source, context), parameters};
        });
    }
    const selection = source ? state.featureScope === "all" ? source.allSelection : source.selection : state.capturedSelection;
    return structuredClone({selection, fields, ...(definition.rows ? {rows} : {})});
}

/** Refresh live layer choices while leaving an original run's captured input intact.
 * Removing the chosen live layer clears all fields, preserves row settings and
 * never selects a replacement.
 * @param {VectorInputState} state Editable input to update.
 * @param {VectorInputDefinition} definition Configured field roles.
 * @param {{vectors?:VectorInputSource[]}} context Current source metadata from composition.
 * @return {void}
 */
function refreshVectorInput(state, definition, context) {
    state.vectors = structuredClone(context.vectors ?? []);
    if (state.vectorKey && !state.vectors.some(source => source.key === state.vectorKey)) {
        state.vectorKey = "";
        Object.assign(state, createClearedVectorFields(state, definition));
        state.selectionError = "Add the vector layer to Map layers, or choose another layer.";
    }
}

/** Restore the original run's fields and rows without guessing a matching map view.
 * @param {VectorInputState} state Newly created editable input.
 * @param {VectorInputValue} value Validated saved invocation input.
 * @param {VectorInputDefinition} definition Installed declaration for the saved recipe version.
 * @return {void}
 */
function restoreVectorInput(state, value, definition) {
    Object.assign(state, {vectorKey: "", capturedSelection: structuredClone(value.selection), fields: structuredClone(value.fields)});
    if (definition.rows) Object.assign(state, {rows: structuredClone(value.rows),
        capturedRowFields: Object.fromEntries(Object.keys(definition.rows.fields).map(role => [role, [...new Set(value.rows.map(row => row.fields[role]))]]))});
}

/** Describe a saved vector input using configured field labels and its captured filter.
 * @param {VectorInputValue} value Validated saved invocation input.
 * @param {VectorInputDefinition} definition Installed field labels.
 * @param {{describeFilter:(filter:Object)=>string}} formatters Owning view's predicate formatter.
 * @return {string} Readable fields and numbered rows followed by the feature selection.
 */
function describeVectorInput(value, definition, formatters) {
    return [...Object.entries(definition.fields ?? {}).map(([role, field]) => `${field.label}: ${value.fields[role]}`),
        ...(definition.rows ? value.rows.map((row, index) => `${definition.rows.itemLabel} ${index + 1}: ${[
            ...Object.entries(definition.rows.fields).map(([role, field]) => `${field.label}: ${row.fields[role]}`),
            ...Object.entries(definition.rows.parameters).map(([name, parameter]) =>
                `${parameter.label}: ${parameter.choices.find(choice => choice.value === row.parameters[name]).label}`),
        ].join(", ")}`) : []),
        formatters.describeFilter(value.selection.filter)].join(" · ");
}

/** Stable controls for one editable row; index follows its current position.
 * @typedef {Object} VectorInputRowControls
 * @property {HTMLElement} root Numbered fieldset containing this row.
 * @property {HTMLElement} legend Accessible row title.
 * @property {Object<string,HTMLSelectElement>} fields Source attribute controls.
 * @property {Object<string,HTMLSelectElement>} parameters Choice controls.
 * @property {HTMLButtonElement} remove Button removing only this row.
 * @property {number} index Current row position in draft state.
 */

/** Keep source and configured field selectors stable while one vector input is edited. */
class VectorInputView {
    /** Build controls from the recipe rather than any operation's attribute roles.
     * @param {VectorInputUi} ui Owning view's DOM and predicate helpers.
     * @param {{onInput:(name:string,change:Object)=>void}} callbacks Submit edits to the draft owner.
     * @param {string} name Declared input name.
     * @param {VectorInputDefinition} definition Installed field-selector configuration.
     */
    constructor(ui, callbacks, name, definition) {
        Object.assign(this, {ui, definition, callbacks, name});
        this.rows = []; this.nextRowId = 0;
        this.root = ui.element("div", "", "models-spatial-input");
        this.source = ui.element("select"); this.source.required = true;
        this.source.addEventListener("change", () => callbacks.onInput(name, {
            vectorKey: this.source.value, capturedSelection: null,
            ...createClearedVectorFields(this.state, definition), ...(definition.rows ? {capturedRowFields: {}} : {}), selectionError: "",
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
        if (definition.rows) {
            const group = ui.element("fieldset", "", "models-vector-rows");
            this.rowContainer = ui.element("div", "", "models-vector-rows");
            this.add = ui.element("button", `Add ${definition.rows.itemLabel.toLowerCase()}`, "models-action models-vector-row-add");
            this.add.type = "button"; this.add.addEventListener("click", () => this.addRow());
            group.append(ui.element("legend", definition.rows.label), this.rowContainer, this.add);
            this.root.append(group);
        }
    }

    /** Append an independent default row and focus its first control.
     * @return {void}
     */
    addRow() {
        this.callbacks.onInput(this.name, {rows: [...this.state.rows, createVectorInputRow(this.definition.rows)]});
        Object.values(this.rows.at(-1).fields)[0].focus();
    }

    /** Change one row's field or setting without modifying neighboring rows.
     * @param {VectorInputRowControls} controls Stable controls for the edited row.
     * @param {"fields"|"parameters"} kind Attribute or choice mapping to update.
     * @param {string} role Configured mapping key.
     * @param {string} value Selected source attribute or choice value.
     * @return {void}
     */
    editRow(controls, kind, role, value) {
        this.callbacks.onInput(this.name, {rows: this.state.rows.map((row, index) => index === controls.index ?
            {...row, [kind]: {...row[kind], [role]: value}} : row)});
    }

    /** Remove one row and focus its neighbor, or the source selector if fields are disabled.
     * The last row's Remove button is disabled because a configured group requires one row.
     * @param {VectorInputRowControls} controls Row being removed.
     * @return {void}
     */
    removeRow(controls) {
        const index = controls.index;
        this.rows.splice(index, 1); controls.root.remove();
        this.callbacks.onInput(this.name, {rows: this.state.rows.filter((_, position) => position !== index)});
        const field = Object.values(this.rows[Math.min(index, this.rows.length - 1)].fields)[0];
        (field.disabled ? this.source : field).focus();
    }

    /** Build one numbered card with recipe-defined attribute and choice controls.
     * @return {VectorInputRowControls} Stable controls inserted after existing rows.
     */
    buildRow() {
        const {ui, definition} = this, id = `models-${this.name}-row-${++this.nextRowId}`;
        const root = ui.element("fieldset", "", "models-vector-row"), legend = ui.element("legend");
        const fields = ui.element("div", "", "models-vector-row-fields");
        const controls = {root, legend, fields: {}, parameters: {}, index: this.rows.length};
        for (const [role, field] of Object.entries(definition.rows.fields)) {
            const select = ui.element("select"); select.required = true; controls.fields[role] = select;
            select.addEventListener("change", () => this.editRow(controls, "fields", role, select.value));
            fields.append(ui.field(`${id}-field-${role}`, field.label, select));
        }
        for (const [name, parameter] of Object.entries(definition.rows.parameters)) {
            const select = ui.element("select"); select.required = true; controls.parameters[name] = select;
            ui.options(select, parameter.choices, parameter.default);
            select.addEventListener("change", () => this.editRow(controls, "parameters", name, select.value));
            fields.append(ui.field(`${id}-parameter-${name}`, parameter.label, select));
        }
        controls.remove = ui.element("button", "Remove", "models-action models-vector-row-remove"); controls.remove.type = "button";
        controls.remove.addEventListener("click", () => this.removeRow(controls));
        root.append(legend, fields, controls.remove); this.rowContainer.append(root);
        return controls;
    }

    /** Refresh one attribute dropdown from live metadata or saved source field names.
     * @param {HTMLSelectElement} control Stable attribute dropdown.
     * @param {VectorFieldDefinition} field Required attribute kind and user-facing label.
     * @param {string} selected Current attribute name.
     * @param {VectorInputSource|undefined} source Live source metadata, absent when using a saved selection.
     * @param {string[]|null} capturedFields Saved field names, or null when no captured selection exists.
     * @return {boolean} Whether a live source lacks attributes of the required kind.
     */
    renderField(control, field, selected, source, capturedFields) {
        const choices = source ? field.kind === "numeric" ? source.numericFields : source.scalarFields : (capturedFields ?? []).map(name => ({name}));
        this.ui.options(control, [{value: "", label: field.kind === "numeric" ? "Choose a numeric field…" : "Choose a field…"},
            ...choices.map(value => ({value: value.name, label: value.name}))], selected);
        control.disabled = !source && !capturedFields;
        return Boolean(source && !choices.length);
    }

    /** Refresh configured choices without scanning features or replacing selected values.
     * @param {VectorInputState} state Editable input with current source metadata.
     * @return {boolean} Whether the input is ready to capture for submission.
     */
    render(state) {
        this.state = state;
        const source = state.vectors.find(value => value.key === state.vectorKey);
        const captured = !source && state.capturedSelection;
        this.ui.options(this.source, [{value: "", label: captured ? "Layer and filter from original run" : "Choose a vector layer…"},
            ...state.vectors.map(value => ({value: value.key, label: value.label}))], state.vectorKey);
        this.source.required = !captured;
        this.scope.value = state.featureScope; this.scope.disabled = Boolean(captured);
        const unavailableFields = [];
        for (const [role, field] of Object.entries(this.definition.fields ?? {})) {
            if (this.renderField(this.fields[role], field, state.fields[role], source, captured ? [state.fields[role]] : null)) unavailableFields.push(field.label);
        }
        if (this.definition.rows) {
            while (this.rows.length < state.rows.length) this.rows.push(this.buildRow());
            while (this.rows.length > state.rows.length) this.rows.pop().root.remove();
            this.rows.forEach((controls, index) => {
                const row = state.rows[index], label = `${this.definition.rows.itemLabel} ${index + 1}`;
                controls.index = index; controls.legend.textContent = label;
                controls.remove.setAttribute("aria-label", `Remove ${label.toLowerCase()}`);
                controls.remove.disabled = state.rows.length === 1;
                for (const [role, field] of Object.entries(this.definition.rows.fields)) {
                    if (this.renderField(controls.fields[role], field, row.fields[role], source, captured ? state.capturedRowFields[role] : null))
                        unavailableFields.push(`${label}: ${field.label}`);
                }
                for (const name of Object.keys(this.definition.rows.parameters)) controls.parameters[name].value = row.parameters[name];
            });
            this.add.disabled = !source && !captured;
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
