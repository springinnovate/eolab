/** Render planning-tool authoring controls without reading map or transport state. */

/** Author actions supplied by the Planning controller.
 * @typedef {Object} PlanningActions
 * @property {()=>void} onOpen Show the panel.
 * @property {()=>void} onClose Hide the panel.
 * @property {()=>void} onNew Start a new tool.
 * @property {()=>void} onLibrary Return to the saved-tool list.
 * @property {()=>Promise<void>} onRefresh Refresh the saved-tool list.
 * @property {()=>void} onResume Return to the retained draft.
 * @property {(id:string)=>Promise<void>} onLoad Open a saved tool.
 * @property {()=>Promise<void>} onSave Persist the current draft.
 * @property {(title:string)=>void} onTitle Edit the title.
 * @property {(role:"aoi"|"parcels",key:string)=>void} onLayer Choose a live layer.
 * @property {(field:string)=>void} onIdField Choose the original ID field.
 * @property {()=>Promise<void>} onCheckIds Validate original IDs.
 * @property {(role:"aoi"|"parcels")=>void} onFilter Open the ordinary filter editor.
 * @property {()=>void} onAddIntervention Append an intervention.
 * @property {(id:string,label:string)=>void} onIntervention Rename an intervention.
 * @property {(id:string)=>void} onRemoveIntervention Remove an intervention.
 */

/** Present the saved-tool library and one retained configuration form. */
export class PlanningView {
    /** Build controls inside the existing Planning panel.
     * @param {Document} [documentContext=document] Owning browser document.
     */
    constructor(documentContext = document) {
        this.document = documentContext; this.panel = documentContext.querySelector("#planning-panel");
        this.openButton = documentContext.querySelector("#open-planning"); this.callbacks = null;
        this.interventionRows = new Map();
        const header = this.element("header", "", "planning-header");
        this.heading = this.element("h2", "Planning tools");
        this.close = this.button("Close", () => this.callbacks.onClose());
        this.close.setAttribute("aria-label", "Close Planning tools");
        header.append(this.heading, this.close);
        this.error = this.element("p", "", "planning-error"); this.error.setAttribute("role", "alert");
        this.message = this.element("p", "", "planning-help"); this.message.setAttribute("role", "status");
        this.library = this.element("div", "", "planning-library");
        const libraryActions = this.element("div", "", "planning-actions");
        this.create = this.button("New planning tool", () => this.callbacks.onNew());
        this.refresh = this.button("Refresh list", () => this.callbacks.onRefresh());
        this.resume = this.button("Resume editing", () => this.callbacks.onResume());
        libraryActions.append(this.create, this.refresh, this.resume);
        this.tools = this.element("div", "", "planning-tool-list");
        this.library.append(this.element("p", "Configure the area, parcels and allowed interventions. Saved tools belong to this browser.", "planning-help"), libraryActions, this.tools);
        this.form = this.element("form", "", "planning-form");
        this.back = this.button("Your planning tools", () => this.callbacks.onLibrary());
        this.title = this.element("input"); this.title.type = "text"; this.title.maxLength = 160; this.title.required = true;
        this.title.addEventListener("input", () => this.callbacks.onTitle(this.title.value));
        this.aoi = this.element("select"); this.aoi.required = true;
        this.parcels = this.element("select"); this.parcels.required = true;
        this.aoi.addEventListener("change", () => this.callbacks.onLayer("aoi", this.aoi.value));
        this.parcels.addEventListener("change", () => this.callbacks.onLayer("parcels", this.parcels.value));
        this.aoiFilter = this.button("Edit area filter", () => this.callbacks.onFilter("aoi"));
        this.parcelFilter = this.button("Edit parcel filter", () => this.callbacks.onFilter("parcels"));
        this.aoiSummary = this.element("p", "", "planning-help"); this.parcelSummary = this.element("p", "", "planning-help");
        const areaGroup = this.element("fieldset"); areaGroup.append(this.element("legend", "Area and parcels"),
            this.element("p", "Choose custom polygon layers made with Duplicate vector in Map contents. Filters stay linked to these map layers.", "planning-help"),
            this.field("planning-aoi", "Area of interest", this.aoi), this.aoiSummary, this.aoiFilter,
            this.field("planning-parcels", "Parcel layer", this.parcels), this.parcelSummary, this.parcelFilter);
        this.idField = this.element("select"); this.idField.required = true;
        this.idField.addEventListener("change", () => this.callbacks.onIdField(this.idField.value));
        this.checkIds = this.button("Check parcel IDs", () => this.callbacks.onCheckIds());
        this.idMessage = this.element("p", "", "planning-help"); this.idMessage.setAttribute("role", "status");
        areaGroup.append(this.field("planning-parcel-id", "Unique parcel ID field", this.idField),
            this.element("p", "Use one original integer or text field. IDs must be unique and present across the entire source layer, including parcels outside its filter.", "planning-help"),
            this.checkIds, this.idMessage);
        const interventions = this.element("fieldset");
        this.interventions = this.element("div", "", "planning-interventions");
        this.addIntervention = this.button("Add intervention", () => this.callbacks.onAddIntervention());
        interventions.append(this.element("legend", "Allowed interventions"),
            this.element("p", "Name up to 64 distinct choices participants will be allowed to assign to parcels.", "planning-help"), this.interventions, this.addIntervention);
        this.saveButton = this.element("button", "Save planning tool", "planning-action planning-primary"); this.saveButton.type = "submit";
        this.saveStatus = this.element("span", "", "planning-help");
        const saveActions = this.element("div", "", "planning-actions"); saveActions.append(this.saveButton, this.saveStatus);
        this.form.append(this.back, this.field("planning-title", "Planning tool name", this.title), areaGroup, interventions, saveActions);
        this.form.addEventListener("submit", event => { event.preventDefault(); this.callbacks.onSave(); });
        this.panel.append(header, this.error, this.message, this.library, this.form);
        this.openListener = () => this.callbacks.onOpen();
    }

    /** Connect author action callbacks after the view is constructed.
     * @param {PlanningActions} callbacks Planning-owned actions. @return {void}
     */
    bind(callbacks) { this.callbacks = callbacks; this.openButton.addEventListener("click", this.openListener); }

    /** Create an owned text-only element.
     * @template {keyof HTMLElementTagNameMap} Tag
     * @param {Tag} tag HTML tag. @param {string} [text=""] Text content. @param {string} [className=""] CSS classes.
     * @return {HTMLElementTagNameMap[Tag]} Detached element of the requested kind.
     */
    element(tag, text = "", className = "") {
        const node = this.document.createElement(tag); node.textContent = text; if (className) node.setAttribute("class", className); return node;
    }

    /** Create an accessible ordinary action button.
     * @param {string} label Visible action. @param {()=>void} action Click handler. @return {HTMLButtonElement} Button.
     */
    button(label, action) { const button = this.element("button", label, "planning-action"); button.type = "button"; button.addEventListener("click", action); return button; }

    /** Associate a visible label with one form control.
     * @param {string} id Stable control ID. @param {string} text Visible label. @param {HTMLElement} control Form control.
     * @return {HTMLElement} Field containing the label and control.
     */
    field(id, text, control) {
        control.id = id; const wrapper = this.element("div", "", "planning-field"), label = this.element("label", text);
        label.setAttribute("for", id); wrapper.append(label, control); return wrapper;
    }

    /** Replace choices while preserving an unavailable selected value as an explicit option.
     * @param {HTMLSelectElement} control Existing select. @param {Array<{value:string,label:string}>} choices Eligible options.
     * @param {string} selected Selected value. @param {string} placeholder Empty-choice label. @return {void}
     */
    options(control, choices, selected, placeholder) {
        const values = [{value: "", label: placeholder}, ...choices];
        if (selected && !values.some(value => value.value === selected)) values.push({value: selected, label: "Selected layer or field unavailable"});
        control.replaceChildren(...values.map(value => { const option = this.element("option", value.label); option.value = value.value; return option; }));
        control.value = selected;
    }

    /** Refresh the library and retained form without replacing text inputs or intervention identities.
     * @param {import("./controller.js").PlanningState} state Planning-owned view state.
     * @param {Map<string,Object>} savedLayers Saved definitions retained for unavailable role labels.
     * @return {void}
     */
    render(state, savedLayers) {
        const busy = state.saving || state.loading, draft = state.draft;
        this.panel.setAttribute("aria-busy", String(busy));
        this.library.hidden = state.page !== "library"; this.form.hidden = state.page !== "editor" || !draft;
        this.heading.textContent = state.page === "editor" ? "Configure planning tool" : "Planning tools";
        this.error.textContent = state.error; this.error.hidden = !state.error;
        this.message.textContent = state.loading ? "Opening planning tool and its map layers…" : state.message;
        this.message.hidden = !this.message.textContent;
        this.create.disabled = this.refresh.disabled = state.saving; this.resume.hidden = !draft; this.resume.disabled = busy;
        this.tools.replaceChildren(...(state.library.length ? state.library.map(tool => {
            const button = this.button(tool.title, () => this.callbacks.onLoad(tool.id)); button.disabled = state.saving;
            button.setAttribute("class", "planning-tool"); return button;
        }) : [this.element("p", "No planning tools saved yet.", "planning-help")]));
        if (!draft) return;
        if (this.title.value !== draft.title) this.title.value = draft.title;
        const choices = state.choices.map(choice => ({value: choice.key, label: choice.label}));
        this.options(this.aoi, choices, draft.aoiKey, "Choose a custom area layer…");
        this.options(this.parcels, choices, draft.parcelKey, "Choose a custom parcel layer…");
        const aoi = state.choices.find(choice => choice.key === draft.aoiKey), parcels = state.choices.find(choice => choice.key === draft.parcelKey);
        for (const [choice, key, summary, button] of [[aoi, draft.aoiKey, this.aoiSummary, this.aoiFilter], [parcels, draft.parcelKey, this.parcelSummary, this.parcelFilter]]) {
            const saved = key.startsWith("missing:") ? savedLayers.get(key.slice(8)) : null;
            summary.textContent = choice ? choice.filterSummary : saved ? `${saved.customName ?? saved.catalogItem.id}: could not restore this saved layer. Choose an available custom layer or reopen to retry.` : key ? "This layer is no longer in Map contents." : "";
            button.disabled = busy || !choice;
        }
        this.options(this.idField, (parcels?.idFields ?? []).map(field => ({value: field.name, label: field.name})), draft.parcelIdField, "Choose an original ID field…");
        this.idMessage.textContent = state.idCheck.message;
        this.idMessage.setAttribute("class", state.idCheck.phase === "error" ? "planning-error" : "planning-help");
        this.checkIds.disabled = busy || !parcels || !draft.parcelIdField || state.idCheck.phase === "checking";
        this.idField.disabled = busy || !parcels;
        this.title.disabled = this.aoi.disabled = this.parcels.disabled = busy;
        this.addIntervention.disabled = busy || draft.interventions.length >= 64;
        this.back.disabled = state.saving; this.saveButton.disabled = busy;
        this.saveButton.textContent = state.saving ? "Saving…" : "Save planning tool";
        this.saveStatus.textContent = state.dirty ? "Unsaved changes" : "Saved";
        const ids = new Set(draft.interventions.map(item => item.id));
        for (const [id, row] of this.interventionRows) { if (!ids.has(id)) { row.root.remove(); this.interventionRows.delete(id); } }
        for (const [index, intervention] of draft.interventions.entries()) {
            let row = this.interventionRows.get(intervention.id);
            if (!row) {
                const root = this.element("div", "", "planning-intervention-row"), input = this.element("input");
                input.type = "text"; input.maxLength = 160; input.required = true;
                input.addEventListener("input", () => this.callbacks.onIntervention(intervention.id, input.value));
                const remove = this.button("Remove", () => this.callbacks.onRemoveIntervention(intervention.id));
                root.append(input, remove); row = {root, input, remove}; this.interventionRows.set(intervention.id, row); this.interventions.append(root);
            }
            if (row.input.value !== intervention.label) row.input.value = intervention.label;
            row.input.setAttribute("aria-label", `Intervention ${index + 1} name`);
            row.remove.setAttribute("aria-label", `Remove intervention ${index + 1}`);
            row.input.disabled = row.remove.disabled = busy;
        }
    }

    /** Focus a new configuration's name. @return {void} */
    focusTitle() { this.title.focus(); }

    /** Focus the newly appended intervention's name. @return {void} */
    focusLastIntervention() { [...this.interventionRows.values()].at(-1)?.input.focus(); }

    /** Detach the external entry-point listener owned by this view. @return {void} */
    destroy() { this.openButton.removeEventListener("click", this.openListener); }
}
