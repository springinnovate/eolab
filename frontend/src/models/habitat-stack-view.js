/** Edit the named raster stack used to fit Habitat condition. */
import { captureHabitatStack } from "./inputs.js";

/** Keep predictor and response rows stable while the user chooses and names rasters. */
export class HabitatStackView {
    /** Build stack controls using the Models form's existing raster chooser.
     * @param {Object} helpers Models presentation helpers.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create a text-only element.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Create a labelled field.
     * @param {(label:string,action:()=>void,className?:string)=>HTMLButtonElement} helpers.button Create a button.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {Document} helpers.document Owning document, used to preserve focused edits.
     * @param {(host:HTMLElement,id:string,input:Object,onChange:(raster:Object|null)=>void)=>Object} helpers.buildRasterInput Build the ordinary raster chooser with a row-specific change callback.
     * @param {(controls:Object,input:Object,value:Object,state:Object)=>boolean} helpers.renderRasterInput Update that chooser using current source availability.
     * @param {{onInput:(name:string,change:Object)=>void}} handlers Controller-owned input edits.
     * @param {string} name Recipe input name for this stack.
     * @param {{label:string}} input Declared stack input.
     * @param {Object} model Installed recipe supplying the fixed Habitat settings.
     */
    constructor({element, field, button, options, document, buildRasterInput, renderRasterInput}, handlers, name, input, model) {
        Object.assign(this, {element, field, button, options, document, buildRasterInput, renderRasterInput, handlers});
        this.inputName = name;
        this.predictors = []; this.responses = []; this.nextRowId = 0; this.categoricalRow = null;
        this.root = element("section", "", "models-vector");
        this.root.setAttribute("aria-label", input.label);
        this.help = element("p", "Predictors describe the environment; observed responses describe the habitat condition to model. Each selected raster uses its first band.", "models-help");
        this.help.id = `models-${name}-help`;
        this.root.append(this.help);
        this.groups = {};
        for (const [role, title, addLabel] of [
            ["predictors", "Predictor rasters", "Add predictor"],
            ["responses", "Observed response rasters", "Add observed response"],
        ]) {
            const group = element("fieldset", "", "models-vector");
            const rows = element("div", "", "models-vector");
            const add = button(addLabel, () => this.addRow(role), "models-action");
            group.append(element("legend", title), rows, add);
            this.groups[role] = {root: group, rows, add};
            this.root.append(group);
        }
        this.addPredictor = this.groups.predictors.add; this.addResponse = this.groups.responses.add;
        this.categorical = element("select"); this.categorical.required = true;
        this.categorical.addEventListener("change", () => {
            this.categoricalRow = this.categorical.value ? this.predictors.find(row => this.value.predictors[row.index].name === this.categorical.value) : null;
            handlers.onInput(name, {categoricalPredictor: this.categorical.value});
        });
        const categoryHelp = element("p", "Choose the predictor whose values identify categories, such as habitat types. All other predictors are treated as continuous measurements.", "models-help");
        categoryHelp.id = `models-${name}-categorical-help`;
        this.categorical.setAttribute("aria-describedby", categoryHelp.id);
        this.status = element("p", "", "models-error"); this.status.setAttribute("role", "status");
        this.root.append(field(`models-${name}-categorical`, "Categorical predictor", this.categorical), categoryHelp,
            element("p", "The optional habitat assessment mask uses cells equal to 1. It limits where results are calculated; it does not limit the reference sites used for training.", "models-help"), this.status);

        this.settings = element("details", "", "models-details");
        this.settings.append(element("summary", "Scientific settings"),
            element("p", "These settings come from the administrator's model recipe and are fixed for this run.", "models-help"));
        const labels = {
            fold_count: "Spatial validation folds",
            sampling_block_size_meters: "Sampling block width (m)",
            validation_block_size_meters: "Validation block width (m)",
            minimum_predictor_coverage: "Minimum predictor coverage (fraction)",
            maximum_row_missing_fraction: "Maximum missing predictors per sample (fraction)",
            spline_knot_count: "Spline knots per continuous predictor",
            minimum_response_coverage: "Minimum response coverage (fraction)",
            ridge_alpha: "Ridge regularization strength",
            samples_per_class_per_block: "Maximum samples per block, inside/outside reference sites",
            random_seed: "Sampling seed",
            tile_size_pixels: "Sampling tile width (pixels)",
            tile_origin: "Sampling tile origin (m, EPSG:6933)",
            window_size_pixels: "Prediction window width (pixels)",
            covariance_shrinkage: "Covariance shrinkage (fraction)",
        };
        const settings = model.steps.find(step => step.operation === "habitat.condition.v1").inputs.settings.value;
        const values = element("dl");
        for (const [key, value] of Object.entries(settings)) {
            values.append(element("dt", labels[key]), element("dd", Array.isArray(value) ? value.join(", ") : String(value)));
        }
        this.settings.append(values); this.root.append(this.settings);
    }

    /** Add one explicitly named row without changing the existing choices.
     * @param {"predictors"|"responses"} role Scientific role receiving another raster.
     * @return {void}
     */
    addRow(role) {
        const prefix = role === "predictors" ? "predictor" : "response";
        const names = new Set([...this.value.predictors, ...this.value.responses].map(row => row.name.trim()));
        let number = this.value[role].length + 1;
        while (names.has(`${prefix}_${number}`)) number += 1;
        this.handlers.onInput(this.inputName, {[role]: [...this.value[role], {name: `${prefix}_${number}`, raster: null}]});
        this[role].at(-1).name.focus();
    }

    /** Replace one row and follow a renamed categorical predictor.
     * @param {"predictors"|"responses"} role Scientific role being edited.
     * @param {Object} controls Stable controls identifying the edited row.
     * @param {{name?:string,raster?:Object|null}} change New variable name or raster choice.
     * @return {void}
     */
    editRow(role, controls, change) {
        const rows = this.value[role].map((row, index) => index === controls.index ? {...row, ...change} : row);
        const edit = {[role]: rows};
        if (role === "predictors" && controls === this.categoricalRow && change.name !== undefined) edit.categoricalPredictor = change.name;
        this.handlers.onInput(this.inputName, edit);
    }

    /** Remove only the chosen row, preserving other controls and their selections.
     * @param {"predictors"|"responses"} role Scientific role containing the row.
     * @param {Object} controls Stable controls for the removed row.
     * @return {void}
     */
    removeRow(role, controls) {
        const index = controls.index;
        const edit = {[role]: this.value[role].filter((_, position) => position !== index)};
        if (controls === this.categoricalRow) { this.categoricalRow = null; edit.categoricalPredictor = ""; }
        this[role].splice(index, 1); controls.root.remove();
        this.handlers.onInput(this.inputName, edit);
        (this[role][Math.min(index, this[role].length - 1)]?.name ?? this.groups[role].add).focus();
    }

    /** Build a stable row with the shared raster chooser and an editable variable name.
     * @param {"predictors"|"responses"} role Scientific role for the new controls.
     * @return {Object} Row controls; index is updated when earlier rows are removed.
     */
    buildRow(role) {
        const root = this.element("fieldset", "", "models-vector");
        const legend = this.element("legend"); root.append(legend);
        const name = this.element("input"); name.type = "text"; name.required = true; name.spellcheck = false;
        name.setAttribute("aria-describedby", this.help.id);
        const id = `${this.inputName}-${role}-${++this.nextRowId}`;
        root.append(this.field(`models-${id}-name`, "Variable name", name));
        const definition = {type: "raster", label: role === "predictors" ? "Predictor raster" : "Observed response raster"};
        const controls = {root, legend, name, definition, index: this[role].length};
        const raster = this.buildRasterInput(root, id, definition, value => this.editRow(role, controls, {raster: value}));
        controls.raster = raster; controls.source = raster.source;
        name.addEventListener("input", () => this.editRow(role, controls, {name: name.value}));
        controls.remove = this.button(role === "predictors" ? "Remove predictor" : "Remove response", () => this.removeRow(role, controls), "models-action");
        root.append(controls.remove); this.groups[role].rows.append(root);
        return controls;
    }

    /** Refresh choices and guidance without replacing rows during typing.
     * @param {Object} draft Model setup containing the named stack and shared sources.
     * @param {Object} state Controller snapshot used by the ordinary raster chooser.
     * @return {boolean} Whether the stack can be captured for submission.
     */
    render(draft, state) {
        this.value = draft.inputs[this.inputName];
        for (const role of ["predictors", "responses"]) {
            while (this[role].length < this.value[role].length) this[role].push(this.buildRow(role));
            while (this[role].length > this.value[role].length) this[role].pop().root.remove();
            this[role].forEach((controls, index) => {
                controls.index = index;
                const row = this.value[role][index];
                const label = `${role === "predictors" ? "Predictor" : "Observed response"} ${index + 1}`;
                controls.legend.textContent = label;
                controls.remove.setAttribute("aria-label", `Remove ${label.toLowerCase()}`);
                if (this.document.activeElement !== controls.name) controls.name.value = row.name;
                this.renderRasterInput(controls.raster, controls.definition, {raster: row.raster,
                    sourceReason: row.raster?.available === false ? "This raster result is no longer available. Choose another input." : "Choose a raster from Map layers or a completed run."}, state);
            });
        }
        if (this.value.categoricalPredictor && this.value.predictors[this.categoricalRow?.index]?.name !== this.value.categoricalPredictor) {
            this.categoricalRow = this.predictors.find(row => this.value.predictors[row.index].name === this.value.categoricalPredictor) ?? null;
        } else if (!this.value.categoricalPredictor && this.categoricalRow && this.value.predictors[this.categoricalRow.index]?.name !== "") {
            this.categoricalRow = null;
        }
        this.options(this.categorical, [{value: "", label: "Choose the categorical predictor…"},
            ...this.value.predictors.filter(row => row.name.trim()).map(row => ({value: row.name, label: row.name}))], this.value.categoricalPredictor);
        let error = "";
        try { captureHabitatStack(this.value, draft.sources); } catch (problem) { error = problem.message; }
        this.status.textContent = error; this.status.hidden = !error;
        return !error;
    }
}
