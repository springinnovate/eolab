/** Present polygon-source and attribute choices for a grouped vector summary. */
import { captureVectorSummary, describeModelFilter } from "./inputs.js";

/** Keep a vector summary's source, feature scope and field selectors stable. */
export class VectorSummaryView {
    /** Build controls inside the existing Data tools setup form.
     * @param {Object} ui Existing element, field and option helpers.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} ui.element Create a view-owned DOM element.
     * @param {(id:string,label:string,input:HTMLElement)=>HTMLElement} ui.field Associate a label with its control.
     * @param {(input:HTMLSelectElement,choices:Array<{value:string,label:string}>,selected:string)=>void} ui.options Replace choices while preserving the selected value.
     * @param {{onInput:(name:string,change:Object)=>void}} handlers Submit edits to the owning Data tools draft.
     * @param {string} name Declared input name.
     * @param {{label:string}} input Installed input declaration.
     */
    constructor(ui, handlers, name, input) {
        this.ui = ui;
        this.root = ui.element("div", "", "models-spatial-input");
        this.source = ui.element("select"); this.source.required = true;
        this.source.addEventListener("change", () => handlers.onInput(name, {
            vectorKey: this.source.value, capturedSelection: null, groupField: "", valueField: "", selectionError: "",
        }));
        this.scope = ui.element("select");
        ui.options(this.scope, [{value: "filtered", label: "Features matching the layer filter"},
            {value: "all", label: "All features in the layer"}], "filtered");
        this.scope.addEventListener("change", () => handlers.onInput(name, {featureScope: this.scope.value}));
        this.group = ui.element("select"); this.group.required = true;
        this.value = ui.element("select"); this.value.required = true;
        this.group.addEventListener("change", () => handlers.onInput(name, {groupField: this.group.value}));
        this.value.addEventListener("change", () => handlers.onInput(name, {valueField: this.value.value}));
        this.status = ui.element("p", "", "models-help"); this.status.setAttribute("role", "status");
        this.description = ui.element("p", "", "models-help");
        this.root.append(ui.field(`models-${name}-source`, input.label, this.source),
            ui.field(`models-${name}-scope`, "Features to summarize", this.scope),
            ui.field(`models-${name}-group`, "Group by", this.group),
            ui.field(`models-${name}-value`, "Field to sum", this.value), this.description, this.status,
            ui.element("p", "Boundary detail is approximate in metres and changes the outlines only. Totals use every included value. Use 0 to retain detailed merged boundaries.", "models-help"));
    }

    /** Refresh choices without scanning the polygon file or changing selected values.
     * @param {Parameters<typeof captureVectorSummary>[0]} state Editable input with current layer metadata and captured fields.
     * @return {boolean} Whether the input can be captured for submission.
     */
    render(state) {
        const source = state.vectors.find(value => value.key === state.vectorKey);
        const captured = !source && state.capturedSelection;
        const sources = [{value: "", label: captured ? "Layer and filter from original run" : "Choose a polygon layer…"},
            ...state.vectors.map(value => ({value: value.key, label: value.label}))];
        this.ui.options(this.source, sources, state.vectorKey);
        this.scope.value = state.featureScope; this.scope.disabled = Boolean(captured);
        const groups = source ? source.scalarFields : captured ? [{name: state.groupField}] : [];
        const numbers = source ? source.numericFields : captured ? [{name: state.valueField}] : [];
        this.ui.options(this.group, [{value: "", label: "Choose a grouping field…"}, ...groups.map(field => ({value: field.name, label: field.name}))], state.groupField);
        this.ui.options(this.value, [{value: "", label: "Choose a numeric field…"}, ...numbers.map(field => ({value: field.name, label: field.name}))], state.valueField);
        this.group.disabled = this.value.disabled = !source && !captured;
        this.description.textContent = captured ? `Uses the original run's selection. ${describeModelFilter(captured.filter)}` :
            source ? state.featureScope === "all" ? "All features are included, regardless of the layer's map filter or visibility."
                : `Uses the layer's filter when you run the tool. ${describeModelFilter(source.filter)}` : "Add a polygon layer to Map layers to choose it here.";
        this.status.textContent = state.selectionError || (source && !numbers.length ? "This layer has no numeric field to sum." : "");
        try { captureVectorSummary(state); return true; } catch { return false; }
    }
}
