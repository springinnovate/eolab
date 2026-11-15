/** Edit view-owned arithmetic fields and retain unfinished work per layer. */
import {calculateVectorFields, validateVectorFieldCalculation} from "./api.js";

/** The composition-supplied view that receives an accepted calculation.
 * @typedef {Object} FieldCalculatorTarget
 * @property {object} identity Stable retained-record identity, used to discard removed targets.
 * @property {string} label Current layer label.
 * @property {import("./api.js").VectorFieldValueSource} source Original source identity.
 * @property {ReadonlyArray<{name:string,type:string}>} fields Original and accepted calculated field choices.
 * @property {ReadonlyArray<import("../calculated-fields.js").CalculatedField>} calculatedFields Installed definitions in evaluation order.
 * @property {(name:string)=>string|null} removalError Explain a retained use that prevents deleting or renaming a field.
 * @property {string|null} displayWarning Accepted fields whose map refresh needs retrying.
 * @property {(signal:AbortSignal)=>Promise<string|null>} retryDisplay Refresh the map using accepted definitions.
 * @property {(result:import("./api.js").FieldCalculationResult,signal:AbortSignal)=>Promise<string|null>} apply Synchronously commit accepted definitions, then resolve with a display warning if presentation refresh fails.
 */

/** Quote an exact field name for the arithmetic expression grammar.
 * @param {string} name Original or calculated attribute name.
 * @return {string} Reference with embedded apostrophes doubled.
 */
export function quoteVectorField(name) { return `'${name.replaceAll("'", "''")}'`; }

/** A retained calculator form whose drafts survive layer-list refreshes. */
export class VectorFieldCalculator {
    /** Connect the calculator to composition-supplied vector targets.
     * @param {Object} options Calculator dependencies.
     * @param {Document} options.document Owning document.
     * @param {(key:string)=>FieldCalculatorTarget|null} options.getTarget Current metadata and installation callback.
     * @param {typeof calculateVectorFields} [options.calculate=calculateVectorFields] Whole-source calculation transport.
     * @param {typeof validateVectorFieldCalculation} [options.validate=validateVectorFieldCalculation] Advisory formula validation using the server grammar.
     */
    constructor({document, getTarget, calculate = calculateVectorFields, validate = validateVectorFieldCalculation}) {
        Object.assign(this, {document, getTarget, calculate, validate});
        this.key = null;
        this.request = null;
        this.validation = null;
        this.validationTimer = null;
        this.validationReason = "";
        this.calculationSaved = false;
        this.editing = "";
        this.newDraft = null;
        this.deleted = null;
        this.drafts = new Map();
        this.fieldActions = [];
        this.dialog = this.element("dialog", "", "vector-field-calculator");
        this.dialog.setAttribute("aria-labelledby", "vector-field-calculator-heading");
        const header = this.element("header", "", "fc-header");
        const heading = this.element("h2", "Field calculator");
        heading.id = "vector-field-calculator-heading";
        const layer = this.element("div", "", "fc-layer");
        this.layerName = this.element("strong");
        layer.append(this.element("span", "Layer:"), this.layerName);
        this.name = this.element("input", "", "fc-output");
        this.name.id = "vector-field-calculator-output";
        this.name.type = "text";
        this.name.maxLength = 256;
        this.name.placeholder = "Name the output field";
        this.name.autocomplete = "off";
        this.name.setAttribute("aria-label", "Output field name");
        const output = this.element("div", "", "fc-output-row");
        const outputLabel = this.element("label", "Output");
        outputLabel.htmlFor = this.name.id;
        this.editingLabel = this.element("span", "Editing", "fc-editing");
        output.append(outputLabel, this.name, this.editingLabel);
        this.close = this.button("×", "fc-close");
        this.close.setAttribute("aria-label", "Close field calculator");
        header.append(heading, layer, output, this.close);
        const body = this.element("div", "", "fc-body");
        this.form = this.element("form", "", "fc-form");
        this.form.noValidate = true;
        const editor = this.element("div", "", "fc-editor");
        const bar = this.element("div", "", "fc-editor-bar");
        const expressionLabel = this.element("label", "Expression");
        expressionLabel.htmlFor = "vector-field-calculator-expression";
        this.numericText = this.element("input");
        this.numericText.type = "checkbox";
        const conversion = this.element("label", "", "fc-numeric");
        conversion.append(this.numericText, this.element("span", "Treat numeric text as numbers"));
        this.insert = this.button("+ Insert field ⌄", "fc-insert");
        this.insert.setAttribute("aria-expanded", "false");
        this.insert.setAttribute("aria-controls", "vector-field-calculator-picker");
        this.picker = this.element("section", "", "fc-picker");
        this.picker.id = "vector-field-calculator-picker";
        this.picker.hidden = true;
        this.picker.setAttribute("aria-label", "Insert a field");
        const search = this.element("div", "", "fc-search");
        this.search = this.element("input");
        this.search.type = "search";
        this.search.placeholder = "Search fields";
        this.search.setAttribute("aria-label", "Search fields");
        search.append(this.search);
        this.options = this.element("div", "", "fc-options");
        this.options.setAttribute("role", "group");
        this.options.setAttribute("aria-label", "Available fields");
        this.picker.append(search, this.options);
        bar.append(expressionLabel, conversion, this.insert, this.picker);
        this.expression = this.element("textarea", "", "fc-expression");
        this.expression.id = expressionLabel.htmlFor;
        this.expression.rows = 2;
        this.expression.maxLength = 4096;
        this.expression.spellcheck = false;
        this.expression.setAttribute("autocapitalize", "off");
        this.expression.setAttribute("autocorrect", "off");
        const footer = this.element("div", "", "fc-editor-footer");
        const operators = this.element("div", "", "fc-operators");
        operators.append(this.element("span", "Operators"), this.element("code", "+  -  *  /  ( )"));
        const actions = this.element("div", "", "fc-actions");
        this.cancelEdit = this.button("Cancel edit", "fc-cancel");
        this.cancel = this.button("Cancel calculation");
        this.cancel.hidden = true;
        this.submitControl = this.element("div", "", "fc-calculate-control");
        this.submit = this.button("Calculate", "fc-calculate");
        this.reason = this.element("span", "", "fc-disabled-reason");
        this.reason.id = "vector-field-calculator-reason";
        this.reason.setAttribute("role", "tooltip");
        this.submit.setAttribute("aria-describedby", this.reason.id);
        this.submitControl.append(this.submit, this.reason);
        actions.append(this.cancelEdit, this.cancel, this.submitControl);
        footer.append(operators, actions);
        this.status = this.element("p", "", "fc-notice");
        this.status.setAttribute("role", "status");
        this.status.setAttribute("aria-live", "polite");
        this.retry = this.button("Retry map refresh", "fc-retry");
        this.retry.hidden = true;
        this.progress = this.element("progress", "", "fc-progress");
        this.progress.hidden = true;
        this.progress.setAttribute("aria-label", "Calculating fields");
        editor.append(bar, this.expression, footer, this.progress, this.status, this.retry);
        this.form.append(editor);
        this.fields = this.element("details", "", "fc-fields");
        this.summary = this.element("summary");
        this.fieldList = this.element("div", "", "fc-field-list");
        this.deletedRow = this.element("div", "", "fc-deleted");
        this.deletedLabel = this.element("span");
        this.undo = this.button("Undo", "fc-undo");
        this.deletedRow.append(this.deletedLabel, this.undo);
        this.fields.append(this.summary, this.fieldList, this.deletedRow);
        body.append(this.form, this.fields);
        this.dialog.append(header, body);
        document.body.append(this.dialog);
        this.form.addEventListener("submit", event => { event.preventDefault(); void this.submitCalculation(); });
        this.submit.addEventListener("click", () => { void this.submitCalculation(); });
        this.name.addEventListener("keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); void this.submitCalculation(); }
        });
        for (const input of [this.name, this.expression, this.numericText]) input.addEventListener("input", () => {
            this.message(""); this.saveDraft(); this.scheduleValidation();
        });
        this.insert.addEventListener("click", () => this.togglePicker());
        this.search.addEventListener("input", () => this.renderOptions());
        this.picker.addEventListener("keydown", event => this.navigatePicker(event));
        this.dialog.addEventListener("click", event => {
            if (!this.picker.contains(event.target) && !this.insert.contains(event.target)) this.closePicker();
        });
        this.cancelEdit.addEventListener("click", () => { this.restoreNewDraft(); this.name.focus(); });
        this.undo.addEventListener("click", () => { void this.undoDeletion(); });
        this.retry.addEventListener("click", () => { void this.retryMapRefresh(); });
        this.cancel.addEventListener("click", () => this.cancelCalculation());
        this.close.addEventListener("click", () => this.dialog.close());
        this.dialog.addEventListener("close", () => {
            this.saveDraft(); this.cancelCalculation(); this.stopValidation(); this.closePicker();
            const opener = this.opener?.isConnected ? this.opener :
                this.document.querySelector(`[data-layer-key="${CSS.escape(this.key)}"][data-layer-action="field-calculator"]`);
            opener?.focus();
        });
    }

    /** Create a text-only DOM element.
     * @param {string} tag HTML tag. @param {string} [text=""] Visible text.
     * @param {string} [className=""] Component classes. @return {HTMLElement} Detached element.
     */
    element(tag, text = "", className = "") {
        const element = this.document.createElement(tag);
        element.textContent = text; element.className = className;
        return element;
    }

    /** Create a compact action that never implicitly submits the form.
     * @param {string} text Visible action. @param {string} [className=""] Component classes.
     * @return {HTMLButtonElement} Detached action button.
     */
    button(text, className = "") {
        const button = this.element("button", text, `secondary-button ${className}`);
        button.type = "button";
        return button;
    }

    /** Open a layer's retained draft and current generated fields.
     * @param {string} key Retained custom vector layer identity. @return {void}
     */
    open(key) {
        const target = this.getTarget(key);
        if (!target) return;
        if (this.dialog.open) this.saveDraft();
        this.cancelCalculation(); this.stopValidation(); this.closePicker();
        this.key = key;
        this.opener = this.document.activeElement;
        this.layerName.textContent = target.label;
        const draft = this.drafts.get(key);
        this.editing = target.calculatedFields.some(field => field.name === draft?.editing) ? draft.editing : "";
        this.newDraft = draft?.newDraft ?? null;
        this.name.value = draft?.name ?? "";
        this.expression.value = draft?.expression ?? "";
        this.numericText.checked = draft?.numericText ?? false;
        this.deleted = null;
        this.fields.open = false;
        this.displayWarning = target.displayWarning ?? null;
        this.message(this.displayWarning ?? "");
        this.retry.hidden = !target.displayWarning;
        this.renderFields(); this.setBusy(false);
        if (!this.dialog.open) this.dialog.showModal();
        this.scheduleValidation(); this.name.focus();
    }

    /** Build the complete ordered definitions for the current editor values.
     * @param {FieldCalculatorTarget} target Current accepted layer.
     * @return {import("../calculated-fields.js").CalculatedField[]} Proposed definitions.
     */
    proposedFields(target) {
        const definition = {version: 1, name: this.name.value.trim(), expression: this.expression.value, numericText: this.numericText.checked};
        const definitions = [...target.calculatedFields];
        const index = definitions.findIndex(field => field.name === this.editing);
        if (index < 0) definitions.push(definition); else definitions[index] = definition;
        return definitions;
    }

    /** Return a local blocker without interpreting the arithmetic grammar.
     * @return {string} Explanation, or empty when server validation may proceed.
     */
    inputProblem() {
        const target = this.getTarget(this.key);
        if (!target) return "This layer was removed.";
        if (!this.name.value.trim()) return "Name the output field.";
        if (!this.expression.value.trim()) return "Enter an expression.";
        if (this.editing && this.editing !== this.name.value.trim()) return target.removalError(this.editing) ?? "";
        return "";
    }

    /** Cancel obsolete advisory work and its pending debounce.
     * @return {void}
     */
    stopValidation() {
        clearTimeout(this.validationTimer);
        this.validationTimer = null;
        this.validation?.abort(); this.validation = null;
    }

    /** Disable Calculate immediately and validate once typing pauses.
     * @return {void}
     */
    scheduleValidation() {
        this.stopValidation();
        this.validationReason = this.inputProblem() || "Checking expression…";
        this.updateCalculateState();
        if (!this.inputProblem()) this.validationTimer = setTimeout(() => { void this.validateDraft(); }, 250);
    }

    /** Validate the proposed list against original metadata, discarding stale replies.
     * @return {Promise<void>} Completion after the current advisory result is displayed.
     */
    async validateDraft() {
        this.stopValidation();
        const problem = this.inputProblem();
        if (problem) { this.validationReason = problem; this.updateCalculateState(); return; }
        const target = this.getTarget(this.key);
        const installed = new Set(target.calculatedFields.map(field => field.name));
        const originalFields = target.fields.filter(field => !installed.has(field.name));
        const validation = new AbortController();
        this.validation = validation;
        this.validationReason = "Checking expression…"; this.updateCalculateState();
        try {
            await this.validate(originalFields, this.proposedFields(target), validation.signal);
            if (validation.signal.aborted || this.getTarget(this.key)?.identity !== target.identity) return;
            this.validationReason = "";
        } catch (error) {
            if (validation.signal.aborted) return;
            this.validationReason = error.message;
        } finally {
            if (this.validation === validation) { this.validation = null; this.updateCalculateState(); }
        }
    }

    /** Update the focusable disabled action and its hover/focus explanation.
     * @return {void}
     */
    updateCalculateState() {
        const reason = this.request ? "Calculation in progress." : this.inputProblem() || this.validationReason;
        this.submit.setAttribute("aria-disabled", String(Boolean(reason)));
        this.reason.textContent = reason; this.reason.hidden = !reason;
        this.submit.textContent = this.editing ? "Recalculate" : "Calculate";
        this.cancelEdit.hidden = this.editing === "";
        this.editingLabel.hidden = this.editing === "";
    }

    /** Return insertable original and earlier generated fields for this editor.
     * @return {Array<{name:string,type:string}>} Picker choices with readable type labels.
     */
    availableFields() {
        const target = this.getTarget(this.key);
        if (!target) return [];
        const index = target.calculatedFields.findIndex(field => field.name === this.editing);
        const excluded = new Set(index < 0 ? [] : target.calculatedFields.slice(index).map(field => field.name));
        return target.fields.filter(field => !excluded.has(field.name)).map(field => {
            const type = field.type.toLowerCase().split(":")[0];
            return {...field, type: /^(int(16|32|64)?|integer(64)?|float(32|64)?|real)$/.test(type) ? "number" : ["str", "string"].includes(type) ? "text" : type};
        }).filter(field => field.type === "number" || field.type === "text");
    }

    /** Open searchable choices while preserving the textarea selection.
     * @return {void}
     */
    togglePicker() {
        if (!this.picker.hidden) { this.closePicker(); this.insert.focus(); return; }
        this.selection = {start: this.expression.selectionStart, end: this.expression.selectionEnd};
        this.search.value = ""; this.renderOptions();
        this.picker.hidden = false; this.insert.setAttribute("aria-expanded", "true"); this.search.focus();
    }

    /** Close choices without changing the editor selection.
     * @return {void}
     */
    closePicker() { this.picker.hidden = true; this.insert.setAttribute("aria-expanded", "false"); }

    /** Render matching field references as keyboard-accessible insertion buttons.
     * @return {void}
     */
    renderOptions() {
        const query = this.search.value.trim().toLowerCase();
        this.optionButtons = this.availableFields().filter(field => field.name.toLowerCase().includes(query)).map(field => {
            const option = this.button("", "fc-option");
            option.setAttribute("aria-label", `Insert ${field.name} (${field.type})`);
            option.append(this.element("code", quoteVectorField(field.name)), this.element("span", field.type, "fc-type"));
            option.addEventListener("click", () => this.insertField(field.name));
            return option;
        });
        this.options.replaceChildren(...this.optionButtons);
        if (!this.optionButtons.length) this.options.append(this.element("p", "No matching fields.", "fc-empty"));
    }

    /** Navigate the searchable picker without submitting or closing the dialog.
     * @param {KeyboardEvent} event Picker key event. @return {void}
     */
    navigatePicker(event) {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.closePicker(); this.insert.focus(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const index = this.optionButtons.indexOf(this.document.activeElement);
            this.optionButtons[event.key === "ArrowDown" ? Math.min(index + 1, this.optionButtons.length - 1) : Math.max(index - 1, 0)]?.focus();
        }
        if (event.key === "Enter" && event.target === this.search) { event.preventDefault(); this.optionButtons[0]?.click(); }
    }

    /** Replace the remembered selection with a quoted reference and resume typing.
     * @param {string} name Exact selected attribute. @return {void}
     */
    insertField(name) {
        this.expression.setRangeText(quoteVectorField(name), this.selection.start, this.selection.end, "end");
        this.closePicker(); this.expression.focus(); this.message(""); this.saveDraft(); this.scheduleValidation();
    }

    /** Save editable values and the prior new-field draft for this layer.
     * @return {void}
     */
    saveDraft() {
        if (this.key === null) return;
        this.drafts.set(this.key, {editing: this.editing, name: this.name.value,
            expression: this.expression.value, numericText: this.numericText.checked, newDraft: this.newDraft});
    }

    /** Load an existing field while retaining unfinished new-field work.
     * @param {import("../calculated-fields.js").CalculatedField} field Installed definition.
     * @return {void}
     */
    editField(field) {
        if (this.request) return;
        if (!this.editing) this.newDraft = {name: this.name.value, expression: this.expression.value, numericText: this.numericText.checked};
        this.editing = field.name; this.name.value = field.name;
        this.expression.value = field.expression; this.numericText.checked = field.numericText;
        this.closePicker(); this.message(""); this.saveDraft(); this.scheduleValidation(); this.expression.focus();
    }

    /** Restore the unfinished new-field form after editing or saving.
     * @return {void}
     */
    restoreNewDraft() {
        this.name.value = this.newDraft?.name ?? "";
        this.expression.value = this.newDraft?.expression ?? "";
        this.numericText.checked = this.newDraft?.numericText ?? false;
        this.editing = ""; this.newDraft = null;
        this.closePicker(); this.message(""); this.saveDraft(); this.scheduleValidation();
    }

    /** Show generated fields with their expressions and explicit edit/delete actions.
     * @return {void}
     */
    renderFields() {
        const target = this.getTarget(this.key);
        this.fieldActions = [];
        this.fieldList.replaceChildren();
        this.summary.textContent = `${target.calculatedFields.length} existing user-generated ${target.calculatedFields.length === 1 ? "field" : "fields"}`;
        for (const field of target.calculatedFields) {
            const row = this.element("div", "", "fc-field-row");
            row.setAttribute("role", "group"); row.setAttribute("aria-label", field.name);
            const formula = this.element("code", "", "fc-field-formula");
            formula.append(this.element("span", "= ", "fc-field-operator"));
            // Color accepted text only; the server owns parsing and validation.
            for (const token of field.expression.match(/'(?:[^']|'')*'|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+*/()\-]|\s+|./g) ?? []) {
                formula.append(this.element("span", token, token.startsWith("'") ? "fc-field-ref" : /^(\d|\.\d)/.test(token) ? "fc-field-number" : "fc-field-operator"));
            }
            const actions = this.element("div", "", "fc-field-actions");
            const edit = this.button("Edit"); edit.setAttribute("aria-label", `Edit ${field.name}`);
            edit.addEventListener("click", () => this.editField(field));
            const remove = this.button("Delete"); remove.setAttribute("aria-label", `Delete ${field.name}`);
            remove.addEventListener("click", () => { void this.deleteField(field); });
            this.fieldActions.push(edit, remove); actions.append(edit, remove);
            row.append(this.element("span", field.name, "fc-field-name"), formula, actions);
            this.fieldList.append(row);
        }
        if (!target.calculatedFields.length) this.fieldList.append(this.element("p", "None yet", "fc-empty"));
        this.deletedRow.hidden = !this.deleted;
        this.deletedLabel.textContent = this.deleted ? `${this.deleted.field.name} deleted.` : "";
        for (const button of this.fieldActions) button.disabled = Boolean(this.request);
    }

    /** Calculate the validated editor values using the authorized source schema.
     * @return {Promise<void>} Completion after installation or an actionable error.
     */
    async submitCalculation() {
        if (this.request) return;
        if (this.inputProblem()) { this.submit.focus(); return; }
        if (this.validationReason) {
            if (!this.validation && !this.validationTimer) await this.validateDraft();
            this.submit.focus();
            return;
        }
        const target = this.getTarget(this.key);
        const name = this.name.value.trim();
        await this.runCalculation(target, this.proposedFields(target), name, "save");
    }

    /** Remove one unused field through the ordinary calculation/install contract.
     * @param {import("../calculated-fields.js").CalculatedField} field Installed definition.
     * @return {Promise<void>} Completion; dependent formulas or display uses remain unchanged on failure.
     */
    async deleteField(field) {
        if (this.request) return;
        const target = this.getTarget(this.key);
        if (!target) return;
        const reason = target.removalError(field.name);
        if (reason) { this.message(reason, true); return; }
        await this.runCalculation(target, target.calculatedFields.filter(item => item.name !== field.name), field.name, "delete");
    }

    /** Restore the last removed field at its original evaluation position.
     * @return {Promise<void>} Completion through the current layer's calculation contract.
     */
    async undoDeletion() {
        if (this.request || !this.deleted) return;
        const target = this.getTarget(this.key);
        if (!target || target.identity !== this.deleted.identity) return;
        const definitions = [...target.calculatedFields];
        definitions.splice(this.deleted.index, 0, this.deleted.field);
        await this.runCalculation(target, definitions, this.deleted.field.name, "undo");
    }

    /** Calculate a proposed list, then commit it before awaiting map refresh.
     * @param {FieldCalculatorTarget} target Retained layer at submission.
     * @param {ReadonlyArray<import("../calculated-fields.js").CalculatedField>} definitions Proposed ordered definitions.
     * @param {string} name Affected field for result feedback.
     * @param {"save"|"delete"|"undo"} action Requested change.
     * @return {Promise<void>} Completion with accepted values or an actionable message.
     */
    async runCalculation(target, definitions, name, action) {
        const request = new AbortController();
        this.request = request; this.calculationSaved = false;
        this.stopValidation(); this.closePicker(); this.setBusy(true); this.saveDraft();
        this.message(action === "save" ? "Calculating…" : action === "delete" ? "Deleting field…" : "Restoring field…");
        try {
            const result = await this.calculate(target.source, definitions, request.signal);
            if (request.signal.aborted) return;
            if (this.getTarget(this.key)?.identity !== target.identity) throw new Error("This layer changed or was removed. Reopen the calculator and try again.");
            const removedIndex = target.calculatedFields.findIndex(field => field.name === name);
            const removedField = target.calculatedFields[removedIndex];
            const refresh = target.apply(result, request.signal);
            this.calculationSaved = true;
            this.deleted = action === "delete" ? {field: removedField, index: removedIndex, identity: target.identity} : null;
            if (action === "save" || (action === "delete" && this.editing === name)) this.restoreNewDraft();
            this.fields.open = true; this.renderFields(); this.cancel.hidden = true;
            this.message("Field saved. Updating the map…"); this.saveDraft();
            const warning = await refresh;
            if (request.signal.aborted || this.request !== request) return;
            this.displayWarning = warning;
            this.retry.hidden = !warning;
            const missing = result.missingCounts[name] ?? 0;
            const message = action === "delete" ? `${name} deleted.` : action === "undo" ? `${name} restored.` :
                `${name} saved for ${result.featureCount.toLocaleString()} ${result.featureCount === 1 ? "feature" : "features"}.${missing ? ` ${missing.toLocaleString()} empty ${missing === 1 ? "value" : "values"}.` : ""}`;
            this.message(message + (warning ? ` ${warning}` : ""));
        } catch (error) {
            if (!request.signal.aborted) this.message(error.message, true);
        } finally {
            if (this.request === request) {
                this.request = null; this.setBusy(false); this.scheduleValidation();
                if (action === "delete" && this.calculationSaved) this.undo.focus();
            }
        }
    }

    /** Retry presentation of accepted fields without recalculating or replacing the draft.
     * @return {Promise<void>} Completion with updated display or a retained retry action.
     */
    async retryMapRefresh() {
        if (this.request) return;
        const target = this.getTarget(this.key);
        if (!target) return;
        const request = new AbortController();
        this.request = request; this.calculationSaved = true;
        this.stopValidation(); this.closePicker(); this.setBusy(true);
        this.message("Updating the map…");
        try {
            const warning = await target.retryDisplay(request.signal);
            if (request.signal.aborted || this.request !== request || this.getTarget(this.key)?.identity !== target.identity) return;
            this.displayWarning = warning;
            this.retry.hidden = !warning;
            this.message(warning ?? "Map refreshed.");
        } catch (error) {
            if (!request.signal.aborted && this.getTarget(this.key)?.identity === target.identity) this.message(error.message, true);
        } finally {
            if (this.request === request) { this.request = null; this.setBusy(false); this.scheduleValidation(); }
        }
    }

    /** Cancel pending work while preserving the draft or an already saved field.
     * @return {void}
     */
    cancelCalculation() {
        if (!this.request) return;
        this.request.abort(); this.request = null; this.setBusy(false);
        this.message(this.calculationSaved ? "Field saved. Map refresh stopped." : "Calculation cancelled. Your expression is still here.");
        this.scheduleValidation();
    }

    /** Follow layer removal or relabelling without disrupting retained drafts.
     * @return {void}
     */
    refresh() {
        if (!this.dialog.open) return;
        const target = this.getTarget(this.key);
        if (!target) {
            this.cancelCalculation(); this.stopValidation(); this.closePicker();
            this.message("This layer was removed. Close this calculator and add the layer again.", true);
            this.updateCalculateState();
        } else {
            this.layerName.textContent = target.label;
            if (!this.request && target.displayWarning !== this.displayWarning) {
                this.displayWarning = target.displayWarning;
                this.retry.hidden = !this.displayWarning;
                this.message(this.displayWarning ?? "");
            }
        }
    }

    /** Prevent overlapping edits while keeping cancellation and dismissal available.
     * @param {boolean} busy Whether calculation or installation is pending. @return {void}
     */
    setBusy(busy) {
        for (const input of [this.name, this.insert, this.expression, this.numericText, this.cancelEdit, this.undo, this.retry, ...this.fieldActions]) input.disabled = busy;
        this.cancel.hidden = this.progress.hidden = !busy;
        this.dialog.setAttribute("aria-busy", String(busy)); this.updateCalculateState();
    }

    /** Show concise progress or an actionable error inside the editor.
     * @param {string} text Message. @param {boolean} [error=false] Error emphasis. @return {void}
     */
    message(text, error = false) {
        this.status.textContent = text; this.status.hidden = !text;
        this.status.classList.toggle("is-error", error);
    }
}
