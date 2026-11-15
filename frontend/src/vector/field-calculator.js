/** Edit view-owned numeric fields without changing the source dataset. */
import { calculateVectorFields } from "./api.js";
import { vectorFilterFieldKind } from "./filter.js";

/** The composition-supplied view that receives an accepted calculation.
 * @typedef {Object} FieldCalculatorTarget
 * @property {object} identity Stable retained-record identity, used to discard removed targets.
 * @property {string} label Current layer label.
 * @property {import("./api.js").VectorFieldValueSource} source Original source identity.
 * @property {ReadonlyArray<{name:string,type:string}>} fields Original and accepted calculated field choices.
 * @property {ReadonlyArray<import("../calculated-fields.js").CalculatedField>} calculatedFields Installed definitions in evaluation order.
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
     * @param {(key:string)=>FieldCalculatorTarget|null} options.getTarget Current view metadata and its accepted-field installation callback.
     * @param {typeof calculateVectorFields} [options.calculate=calculateVectorFields] Whole-source calculation transport.
     */
    constructor({document, getTarget, calculate = calculateVectorFields}) {
        Object.assign(this, {document, getTarget, calculate});
        this.key = null;
        this.request = null;
        this.calculationSaved = false;
        this.drafts = new Map();
        this.dialog = document.createElement("dialog");
        this.dialog.className = "vector-field-calculator";
        this.dialog.setAttribute("aria-labelledby", "vector-field-calculator-heading");
        const heading = this.element("h2", "Field calculator");
        heading.id = "vector-field-calculator-heading";
        this.layerName = this.element("p");
        this.layerName.className = "vector-field-calculator-layer";
        const help = this.element("p", "Add a numeric field to this layer. The original data stays unchanged.");
        this.form = this.element("form");
        this.field = this.element("select");
        this.name = this.element("input");
        this.name.type = "text";
        this.name.required = true;
        this.name.maxLength = 256;
        this.picker = this.element("select");
        this.expression = this.element("textarea");
        this.expression.rows = 4;
        this.expression.required = true;
        this.expression.maxLength = 4096;
        this.expression.spellcheck = false;
        this.expression.setAttribute("autocapitalize", "off");
        this.expression.setAttribute("autocorrect", "off");
        this.expression.setAttribute("aria-describedby", "vector-field-calculator-syntax");
        const syntax = this.element("p", "Operators: + - * / ( ). Put field names in single quotes, for example 'Population' / 'Area km2'.");
        syntax.id = "vector-field-calculator-syntax";
        syntax.className = "vector-field-calculator-help";
        this.numericText = this.element("input");
        this.numericText.type = "checkbox";
        const conversion = this.label("Treat numeric text as numbers", this.numericText);
        conversion.className = "vector-field-calculator-conversion";
        const rules = this.element("p", "Calculates every feature, including those outside the map or hidden by a filter. Missing inputs, invalid numbers and division by zero leave an empty value.");
        rules.className = "vector-field-calculator-help";
        this.status = this.element("p");
        this.status.setAttribute("role", "status");
        this.status.setAttribute("aria-live", "polite");
        this.progress = this.element("progress");
        this.progress.hidden = true;
        this.progress.setAttribute("aria-label", "Calculating fields");
        const actions = this.element("div");
        actions.className = "vector-field-calculator-actions";
        this.submit = this.element("button", "Calculate");
        this.submit.type = "submit";
        this.cancel = this.element("button", "Cancel calculation");
        this.cancel.type = "button";
        this.cancel.hidden = true;
        this.close = this.element("button", "Close");
        this.close.type = "button";
        this.close.className = "secondary-button";
        actions.append(this.submit, this.cancel, this.close);
        this.form.append(this.label("Field", this.field), this.label("Output field", this.name),
            this.label("Insert field", this.picker), this.label("Expression", this.expression), syntax,
            conversion, rules, this.progress, this.status, actions);
        this.dialog.append(heading, this.layerName, help, this.form);
        document.body.append(this.dialog);
        this.form.addEventListener("submit", event => { event.preventDefault(); void this.submitCalculation(); });
        this.field.addEventListener("change", () => this.chooseField());
        this.picker.addEventListener("change", () => this.insertField());
        for (const input of [this.name, this.expression, this.numericText]) input.addEventListener("input", () => this.saveDraft());
        this.cancel.addEventListener("click", () => this.cancelCalculation());
        this.close.addEventListener("click", () => this.dialog.close());
        this.dialog.addEventListener("close", () => {
            this.saveDraft();
            this.cancelCalculation();
            const opener = this.opener?.isConnected ? this.opener :
                this.document.querySelector(`[data-layer-key="${CSS.escape(this.key)}"][data-layer-action="field-calculator"]`);
            opener?.focus();
        });
    }

    /** Create one text-only DOM element.
     * @param {string} tag HTML tag. @param {string} [text=""] Visible text.
     * @return {HTMLElement} Detached element.
     */
    element(tag, text = "") {
        const element = this.document.createElement(tag);
        element.textContent = text;
        return element;
    }

    /** Associate a visible label with its control.
     * @param {string} text Label text. @param {HTMLElement} input Form control.
     * @return {HTMLLabelElement} Label containing the control.
     */
    label(text, input) {
        const label = this.element("label", text);
        label.append(input);
        return label;
    }

    /** Open a layer's retained draft and current field choices.
     * @param {string} key Retained custom vector layer identity.
     * @return {void}
     */
    open(key) {
        const target = this.getTarget(key);
        if (!target) return;
        this.cancelCalculation();
        this.key = key;
        this.opener = this.document.activeElement;
        this.layerName.textContent = target.label;
        const draft = this.drafts.get(key);
        this.updateFieldChoices(target, draft?.field ?? "");
        this.name.value = draft?.name ?? "";
        this.expression.value = draft?.expression ?? "";
        this.numericText.checked = draft?.numericText ?? false;
        this.name.readOnly = this.field.value !== "";
        this.message("");
        this.setBusy(false);
        if (!this.dialog.open) this.dialog.showModal();
        this.name.focus();
    }

    /** Refresh accepted field choices without rebuilding the editable form.
     * @param {FieldCalculatorTarget} target Accepted view metadata and definitions.
     * @param {string} [selected=this.field.value] Installed field being revised, or empty for a new field.
     * @return {void}
     */
    updateFieldChoices(target, selected = this.field.value) {
        this.field.replaceChildren();
        this.picker.replaceChildren();
        for (const [value, text] of [["", "New field"], ...target.calculatedFields.map(field => [field.name, `Edit ${field.name}`])]) {
            const option = this.element("option", text); option.value = value; this.field.append(option);
        }
        this.field.value = selected;
        const placeholder = this.element("option", "Choose a field…"); placeholder.value = ""; this.picker.append(placeholder);
        const editingIndex = target.calculatedFields.findIndex(field => field.name === selected);
        const excluded = new Set(editingIndex < 0 ? [] : target.calculatedFields.slice(editingIndex).map(field => field.name));
        for (const field of target.fields) {
            const kind = vectorFilterFieldKind(field.type);
            if (excluded.has(field.name) || !["number", "string"].includes(kind)) continue;
            const option = this.element("option", field.name + (kind === "string" ? " (text)" : ""));
            option.value = field.name;
            this.picker.append(option);
        }
        this.picker.value = "";
    }

    /** Load an installed definition for revision or begin a new field.
     * @return {void}
     */
    chooseField() {
        const target = this.getTarget(this.key);
        if (!target) return;
        const definition = target.calculatedFields.find(field => field.name === this.field.value);
        this.updateFieldChoices(target);
        this.name.value = definition?.name ?? "";
        this.name.readOnly = Boolean(definition);
        this.expression.value = definition?.expression ?? "";
        this.numericText.checked = definition?.numericText ?? false;
        this.message("");
        this.saveDraft();
        (definition ? this.expression : this.name).focus();
    }

    /** Insert the selected field at the text selection and resume typing there.
     * @return {void}
     */
    insertField() {
        if (!this.picker.value) return;
        const reference = quoteVectorField(this.picker.value);
        this.expression.setRangeText(reference, this.expression.selectionStart, this.expression.selectionEnd, "end");
        this.picker.value = "";
        this.expression.focus();
        this.saveDraft();
    }

    /** Retain this layer's editable draft independently of applied definitions.
     * @return {void}
     */
    saveDraft() {
        if (this.key === null) return;
        this.drafts.set(this.key, {field: this.field.value, name: this.name.value,
            expression: this.expression.value, numericText: this.numericText.checked});
    }

    /** Calculate and atomically install all definitions, preserving the draft on failure.
     * @return {Promise<void>} Completion with accepted values or an actionable message.
     */
    async submitCalculation() {
        if (this.request) return;
        const target = this.getTarget(this.key);
        if (!target) { this.message("This layer was removed. Reopen its calculator after adding it again.", true); return; }
        const definition = {version: 1, name: this.name.value.trim(), expression: this.expression.value, numericText: this.numericText.checked};
        const definitions = structuredClone(target.calculatedFields);
        const index = definitions.findIndex(field => field.name === this.field.value);
        if (index < 0) definitions.push(definition); else definitions[index] = definition;
        const request = new AbortController();
        this.request = request;
        this.calculationSaved = false;
        this.setBusy(true);
        this.saveDraft();
        this.message("Calculating every feature…");
        try {
            const result = await this.calculate(target.source, definitions, request.signal);
            if (request.signal.aborted) return;
            if (this.getTarget(this.key)?.identity !== target.identity) throw new Error("This layer changed or was removed. Reopen the calculator and try again.");
            this.message("Field calculated. Updating the map…");
            this.cancel.hidden = true;
            const refresh = target.apply(result, request.signal);
            this.calculationSaved = true;
            this.updateFieldChoices(this.getTarget(this.key), definition.name);
            this.name.readOnly = true;
            this.saveDraft();
            const warning = await refresh;
            if (request.signal.aborted || this.request !== request) return;
            const missing = result.missingCounts[definition.name] ?? 0;
            this.message(`${definition.name} saved for ${result.featureCount.toLocaleString()} ${result.featureCount === 1 ? "feature" : "features"}.${missing ? ` ${missing.toLocaleString()} empty ${missing === 1 ? "value" : "values"}.` : ""} ${warning ?? "Choose it in Style or Filter, or click a feature to see its value."}`);
        } catch (error) {
            if (!request.signal.aborted) this.message(error.message, true);
        } finally {
            if (this.request === request) { this.request = null; this.setBusy(false); }
        }
    }

    /** Cancel pending work while preserving the draft or an already saved field.
     * @return {void}
     */
    cancelCalculation() {
        if (!this.request) return;
        this.request.abort();
        this.request = null;
        this.setBusy(false);
        this.message(this.calculationSaved ? "Field saved. Map refresh stopped." : "Calculation cancelled. Your expression is still here.");
    }

    /** Follow a removed target without disrupting typing on a retained layer.
     * @return {void}
     */
    refresh() {
        if (!this.dialog.open) return;
        const target = this.getTarget(this.key);
        if (!target) { this.cancelCalculation(); this.message("This layer was removed. Close this calculator and add the layer again.", true); this.submit.disabled = true; }
        else this.layerName.textContent = target.label;
    }

    /** Prevent overlapping edits while keeping cancellation and dismissal available.
     * @param {boolean} busy Whether calculation or installation is pending.
     * @return {void}
     */
    setBusy(busy) {
        for (const input of [this.field, this.name, this.picker, this.expression, this.numericText, this.submit]) input.disabled = busy;
        this.cancel.hidden = this.progress.hidden = !busy;
        this.dialog.setAttribute("aria-busy", String(busy));
    }

    /** Show concise progress or an actionable error.
     * @param {string} text Message. @param {boolean} [error=false] Error emphasis.
     * @return {void}
     */
    message(text, error = false) { this.status.textContent = text; this.status.classList.toggle("is-error", error); }
}
