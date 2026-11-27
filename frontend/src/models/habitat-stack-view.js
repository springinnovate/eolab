/** Choose Earth Engine inputs or a named raster stack for Habitat condition. */

/** List the source bands included by this role's choices, grouped by analysis period.
 * @param {import("../processing/api.js").HabitatDatasetSource} dataset Prepared source shown in this row.
 * @param {string} role Predictor or response group containing the row.
 * @param {string[]} selected Dataset IDs selected for this role.
 * @param {number} year Requested assessment year.
 * @return {string} Lines pairing each period with its bands, or an explanation when none apply.
 */
function describeSelectedBands(dataset, role, selected, year) {
    if (!selected.includes(dataset.id)) return "Excluded from this analysis.";
    const bandsByPeriod = new Map();
    for (const input of dataset.inputsByRole[role]) {
        if (!input.requiredDatasets.every(id => selected.includes(id))) continue;
        const period = input.periods[year];
        if (!period) return "Choose a supported assessment year.";
        if (!bandsByPeriod.has(period)) bandsByPeriod.set(period, new Set());
        for (const band of input.bands) bandsByPeriod.get(period).add(band);
    }
    if (!bandsByPeriod.size) return "No bands used with these dataset choices.";
    return ["Bands used", ...Array.from(bandsByPeriod, ([period, bands]) =>
        `${period} · ${[...bands].join(", ")}`)].join("\n");
}

/** Choose Habitat datasets or manual rasters while retaining focused controls. */
export class HabitatStackView {
    /** Group the configuration selector with its existing year and raster controls.
     * @param {Object} helpers Models presentation helpers.
     * @param {(state:Object,sources:Object[])=>Object} helpers.captureStack Capture and validate the model stack.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create a text-only element.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Create a labelled field.
     * @param {(label:string,action:()=>void,className?:string)=>HTMLButtonElement} helpers.button Create a button.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {Document} helpers.document Owning document, used to preserve focused edits.
     * @param {(host:HTMLElement,id:string,input:Object,onChange:(raster:Object|null)=>void,onResampling:(method:string)=>void)=>Object} helpers.buildRasterInput Build the ordinary raster chooser with row-specific source and method callbacks.
     * @param {(controls:Object,input:Object,value:Object,state:Object)=>boolean} helpers.renderRasterInput Update that chooser using current source availability.
     * @param {{onInput:(name:string,change:Object)=>void,onRefreshHabitat:(name:string)=>void,onRefreshMaps:()=>void}} handlers Input edits and retries for configuration or published map choices.
     * @param {string} name Recipe input name for this stack.
     * @param {{label:string}} input Declared stack input.
     */
    constructor({element, field, button, options, document, buildRasterInput, renderRasterInput, captureStack}, handlers, name, input) {
        Object.assign(this, {element, field, button, options, document, buildRasterInput, renderRasterInput, captureStack, handlers});
        this.inputName = name;
        this.predictors = []; this.responses = []; this.nextRowId = 0; this.categoricalRow = null;
        this.root = element("section", "", "models-vector");
        this.root.setAttribute("aria-label", input.label);
        this.source = element("select");
        this.source.addEventListener("change", () => handlers.onInput(name, {kind: this.source.value}));
        this.options(this.source, [{value: "earthEngine", label: "Prepared Earth Engine rasters"},
            {value: "manual", label: "Choose raster layers"}], "earthEngine");
        const attribution = element("p", "", "models-help");
        const modelLink = element("a", "NHI Terrestrial Integrity Modeling");
        modelLink.href = "https://github.com/springinnovate/nhi-terrestrial-integrity-modeling";
        modelLink.target = "_blank"; modelLink.rel = "noopener noreferrer";
        attribution.append(element("span", "Based on "), modelLink);
        this.configurationGroup = element("fieldset", "", "models-input-configuration");
        this.configurationGroup.setAttribute("aria-label", "Input data");
        this.year = element("select");
        this.year.addEventListener("change", () => handlers.onInput(name, {year: Number(this.year.value)}));
        this.automatic = element("fieldset", "", "models-vector");
        this.automatic.setAttribute("aria-label", "Earth Engine inputs");
        this.automatic.append(field(`models-${name}-year`, "Assessment year", this.year));
        const manageInputs = element("a", "Manage cached inputs");
        manageInputs.href = "/admin-eolab/habitat";
        manageInputs.target = "_blank"; manageInputs.rel = "noopener noreferrer";
        const administration = element("p", "", "models-help");
        administration.append(manageInputs, element("span", " (administrator password required)"));
        this.automatic.append(element("p", "The model uses the tiles your administrator has prepared for the analysis area and assessment year. Areas without prepared inputs are shown as NoData.", "models-help"), administration);
        this.datasetSources = element("div", "", "models-habitat-datasets");
        this.datasetGroups = {};
        for (const [role, title, fieldName] of [["predictor", "Select predictor datasets", "predictorDatasets"],
            ["response", "Select observed response datasets", "responseDatasets"]]) {
            const root = element("details", "", "models-details"), summary = element("summary", title), list = element("ul");
            root.open = false;
            root.append(summary, list); this.datasetSources.append(root);
            this.datasetGroups[role] = {root, summary, list, title, fieldName, controls: new Map()};
        }
        this.automatic.append(this.datasetSources);
        this.mapRetry = button("Retry catalog lookup", () => handlers.onRefreshMaps(), "models-action");
        this.automatic.append(this.mapRetry);
        this.acquisitionStatus = element("p", "", "models-help"); this.acquisitionStatus.setAttribute("role", "status");
        this.retry = button("Retry Earth Engine year choices", () => handlers.onRefreshHabitat(name), "models-action");
        this.automatic.append(this.acquisitionStatus, this.retry);
        this.manual = element("fieldset", "", "models-vector");
        this.manual.setAttribute("aria-label", "Custom raster layers");
        this.configurationGroup.append(field(`models-${name}-source`, "Input data", this.source), this.automatic, this.manual);
        this.root.append(attribution, this.configurationGroup);
        this.help = element("p", "Predictors describe environmental conditions. Observed responses are the ecosystem measurements to compare with the model's expectations. Each selected raster uses its first band.", "models-help");
        this.help.id = `models-${name}-help`;
        this.manual.append(this.help);
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
            this.manual.append(group);
        }
        this.addPredictor = this.groups.predictors.add; this.addResponse = this.groups.responses.add;
        this.categorical = element("select");
        this.categorical.addEventListener("change", () => {
            this.categoricalRow = this.categorical.value ? this.predictors.find(row => this.value.predictors[row.index].name === this.categorical.value) : null;
            handlers.onInput(name, {categoricalPredictor: this.categorical.value});
        });
        const categoryHelp = element("p", "If a raster contains categories such as landform classes, choose it here. All other predictors are treated as continuous measurements. Nearest neighbor and mode preserve category values; interpolation can create intermediate values.", "models-help");
        categoryHelp.id = `models-${name}-categorical-help`;
        this.categorical.setAttribute("aria-describedby", categoryHelp.id);
        this.status = element("p", "", "models-error"); this.status.setAttribute("role", "status");
        this.manual.append(field(`models-${name}-categorical`, "Categorical predictor (optional)", this.categorical), categoryHelp);
        this.configurationGroup.append(this.status);
    }

    /** Create one stable checkbox for a dataset's use as predictor or response.
     * @param {"predictor"|"response"} role Scientific role controlled by this checkbox.
     * @param {import("../processing/api.js").HabitatDatasetSource} dataset Configured source and role requirements.
     * @return {{root:HTMLElement,checkbox:HTMLInputElement,label:HTMLElement,link:HTMLAnchorElement,details:HTMLElement,maps:HTMLElement,mapLabel:HTMLElement,variable:HTMLSelectElement,add:HTMLButtonElement,message:HTMLElement}} Stable analysis and map controls.
     */
    buildDatasetChoice(role, dataset) {
        const root = this.element("li"), label = this.element("label", "", "models-habitat-dataset-choice");
        const checkbox = this.element("input"); checkbox.type = "checkbox";
        const name = this.element("span", dataset.label);
        label.append(checkbox, name);
        const link = this.element("a", "Source");
        link.target = "_blank"; link.rel = "noopener noreferrer";
        const details = this.element("div", "", "models-habitat-dataset-details");
        details.id = `models-${this.inputName}-${role}-${dataset.id}-details`;
        checkbox.setAttribute("aria-describedby", details.id);
        root.append(label, link, details);
        const maps = this.element("div", "", "models-habitat-map-choice");
        const mapLabel = this.element("span");
        const variable = this.element("select");
        variable.setAttribute("aria-label", `Map layer for ${dataset.label} (${role})`);
        variable.addEventListener("change", () => this.renderDatasetChoices(this.value.configuration));
        const add = this.button("Add to map", () => {
            const matches = this.mapLayers?.matches.get(variable.value);
            if (matches?.length === 1) void this.catalogRasters.add(matches[0]);
        }, "models-action");
        const message = this.element("span", "", "models-help");
        message.setAttribute("role", "status");
        maps.append(mapLabel, variable, add, message); root.append(maps);
        checkbox.addEventListener("change", () => {
            const {fieldName} = this.datasetGroups[role];
            const selected = this.value[fieldName];
            this.handlers.onInput(this.inputName, {[fieldName]: checkbox.checked ? [...selected, dataset.id] : selected.filter(id => id !== dataset.id)});
        });
        return {root, checkbox, label: name, link, details, maps, mapLabel, variable, add, message};
    }

    /** Show the published variable for this row and its current map membership.
     * @param {Object} controls Dataset row's stable controls.
     * @param {Array<{variable:string}>} inputs Prepared variables produced from this source in this role.
     * @return {void}
     */
    renderMapChoice(controls, inputs) {
        const {maps, mapLabel, variable, add, message} = controls;
        maps.hidden = !this.catalogRasters;
        if (maps.hidden) return;
        const labels = inputs.map(input => input.variable);
        const selected = labels.includes(variable.value) ? variable.value : labels[0];
        this.options(variable, labels.map(label => ({value: label, label})), selected);
        variable.hidden = labels.length === 1;
        mapLabel.textContent = variable.hidden ? selected : "Map layer";
        const matches = this.mapLayers?.matches.get(selected) ?? [];
        const state = matches.length === 1 ? this.catalogRasters.state(matches[0]) : null;
        add.textContent = state?.busy ? "Adding…" : state?.onMap ? "On map" : "Add to map";
        add.setAttribute("aria-label", `${add.textContent} · ${selected} (${this.value.year})`);
        add.disabled = !state || state.busy || state.onMap;
        let status = state?.error ?? "";
        if (this.mapLayers?.loading) status = "Checking catalog…";
        else if (this.mapLayers?.error) status = this.mapLayers.error;
        else if (!matches.length) status = `Unavailable for ${this.value.year}`;
        else if (matches.length > 1) status = "Multiple layers match. Choose one in the Catalog.";
        message.textContent = status;
        message.hidden = !status;
    }

    /** Refresh dataset choices in place so selection, focus and disclosures survive updates.
     * @param {{datasets:import("../processing/api.js").HabitatDatasetSource[]}} configuration Model-owned dataset choices.
     * @return {void}
     */
    renderDatasetChoices(configuration) {
        for (const [role, group] of Object.entries(this.datasetGroups)) {
            const datasets = configuration.datasets.filter(dataset => dataset.roles.includes(role));
            const selected = this.value[group.fieldName];
            for (const [id, controls] of group.controls) {
                if (!datasets.some(dataset => dataset.id === id)) { controls.root.remove(); group.controls.delete(id); }
            }
            for (const dataset of datasets) {
                let controls = group.controls.get(dataset.id);
                if (!controls) {
                    controls = this.buildDatasetChoice(role, dataset);
                    group.controls.set(dataset.id, controls); group.list.append(controls.root);
                }
                controls.label.textContent = dataset.label;
                controls.details.textContent = describeSelectedBands(dataset, role, selected, this.value.year);
                this.renderMapChoice(controls, dataset.inputsByRole[role]);
                controls.checkbox.checked = selected.includes(dataset.id);
                controls.link.href = dataset.url;
                controls.link.setAttribute("aria-label", `Source information for ${dataset.label}`);
            }
            group.summary.textContent = `${group.title} · ${selected.length} of ${datasets.length} selected`;
        }
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
        this.handlers.onInput(this.inputName, {[role]: [...this.value[role], {name: `${prefix}_${number}`, raster: null, resampling: "nearest"}]});
        this[role].at(-1).name.focus();
    }

    /** Replace one row and follow a renamed categorical predictor.
     * @param {"predictors"|"responses"} role Scientific role being edited.
     * @param {Object} controls Stable controls identifying the edited row.
     * @param {{name?:string,raster?:Object|null,resampling?:string}} change New variable name, raster or preparation method.
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
        const raster = this.buildRasterInput(root, id, definition, value => this.editRow(role, controls, {raster: value}),
            resampling => this.editRow(role, controls, {resampling}));
        controls.raster = raster; controls.source = raster.source; controls.resampling = raster.resampling;
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
        const automatic = this.value.kind === "earthEngine", configuration = this.value.configuration;
        this.source.value = this.value.kind;
        this.manual.hidden = this.manual.disabled = automatic;
        this.automatic.hidden = this.automatic.disabled = !automatic;
        this.datasetSources.hidden = !configuration;
        this.catalogRasters = state.catalogRasters;
        this.mapLayers = draft.setupState.mapLayers;
        this.mapRetry.hidden = !this.mapLayers?.error;
        if (automatic && configuration) this.renderDatasetChoices(configuration);
        this.year.required = automatic;
        this.options(this.year, configuration ? Array.from({length: configuration.maximumYear - configuration.minimumYear + 1},
            (_, index) => ({value: String(configuration.minimumYear + index), label: String(configuration.minimumYear + index)})) :
            [{value: "", label: "Loading years…"}], String(this.value.year ?? ""));
        this.acquisitionStatus.textContent = this.value.loading ? "Loading available years…" : this.value.error;
        this.acquisitionStatus.hidden = !this.acquisitionStatus.textContent;
        this.retry.hidden = !this.value.error; this.retry.disabled = this.value.loading;
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
                this.renderRasterInput(controls.raster, controls.definition, {raster: row.raster, resampling: row.resampling,
                    copiedFromRun: false}, state);
            });
        }
        if (this.value.categoricalPredictor && this.value.predictors[this.categoricalRow?.index]?.name !== this.value.categoricalPredictor) {
            this.categoricalRow = this.predictors.find(row => this.value.predictors[row.index].name === this.value.categoricalPredictor) ?? null;
        } else if (!this.value.categoricalPredictor && this.categoricalRow && this.value.predictors[this.categoricalRow.index]?.name !== "") {
            this.categoricalRow = null;
        }
        this.options(this.categorical, [{value: "", label: "None (all predictors are continuous)"},
            ...this.value.predictors.filter(row => row.name.trim()).map(row => ({value: row.name, label: row.name}))], this.value.categoricalPredictor);
        let error = "";
        try { this.captureStack(this.value, draft.sources); } catch (problem) { error = problem.message; }
        this.status.textContent = error; this.status.hidden = !error;
        return !error;
    }
}
