/** Present the model library, editable setup and one run's results in Analysis. */
import { ACTIVE_JOB_STATES } from "../processing/jobs.js";
import { processingDownloadUrl } from "../processing/api.js";
import { formatDownloadBytes } from "../processing/presentation.js";
import { calculationValue } from "../processing/calculation-result-view.js";
import { modelSourceKey, describeModelFilter, modelSupportsArea } from "./inputs.js";

const RESULT_STATES = {no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
    invalid_arithmetic: "The expression has no defined numeric result.", overflow: "The result exceeded the supported numeric range."};

/** Describe the explicit area shown in setup and saved run details.
 * @param {Object|null} area Model area descriptor.
 * @return {string} Source, bounds rounded to four decimal places, or predicate description.
 */
export function describeModelArea(area) {
    if (!area) return "No analysis area selected.";
    if (area.kind === "wholeRaster") return "Whole raster";
    if (area.kind === "selectedArea") {
        const b = Object.fromEntries(Object.entries(area.selectedBounds).map(([key, value]) =>
            [key, Number.isFinite(value) ? value.toFixed(4) : "—"]));
        return `Box · W ${b.west}°, S ${b.south}°, E ${b.east}°, N ${b.north}°`;
    }
    if (area.kind === "catalogSelection") return `${area.selection.layerName} · ${describeModelFilter(area.selection.filter)}`;
    return "Previously selected polygons; the server checks that the input is still available.";
}

/** Describe measured stage progress without inventing an overall percentage.
 * @param {Object} job Current model run status.
 * @return {string} State or current stage with measured work when available.
 */
export function describeModelProgress(job) {
    const status = job.status === "ready" && Date.parse(job.expiresAt) <= Date.now() ? "expired" : job.status;
    if (status !== "running") return ({queued: "Queued", cancelling: "Cancelling…", ready: "Ready", failed: "Failed",
        cancelled: "Cancelled", interrupted: "Interrupted", expired: "Results expired", deleted: "Deleted"})[status] ?? status;
    const phase = ({preparing: "Preparing inputs", preparing_selected_polygons: "Reading selected features",
        preparing_polygon_mask: "Creating the analysis mask", calculating: "Calculating", writing_results: "Writing results",
        clipping: "Clipping raster", creating_cog: "Preparing GeoTIFF", validating: "Checking GeoTIFF", checksumming: "Finishing download"})[job.progress.phase] ?? "Preparing calculation";
    return job.progress.total > 0 ? `${phase} · ${job.progress.completed ?? 0} of ${job.progress.total} ${job.progress.unit ?? "units"}` : `${phase}…`;
}

/** Keep setup fields and run controls stable while progress updates arrive. */
export class ModelsView {
    /** Bind the existing Models panel markup.
     * @param {Document} [documentContext=globalThis.document] Owning document.
     */
    constructor(documentContext = globalThis.document) {
        this.document = documentContext; this.listeners = []; this.runCards = new Map();
        this.elements = Object.fromEntries(["heading", "close", "library", "setup", "run", "runs", "error", "recovery", "recover", "query",
            "library-items", "library-status", "refresh", "runs-list", "runs-status", "more", "refresh-runs", "yaml"]
            .map(name => [name, documentContext.querySelector(`#models-${name}`)]));
        this.navigation = Object.fromEntries(["library", "setup", "runs"].map(name => [name, documentContext.querySelector(`#models-nav-${name}`)]));
        this.openers = ["open-models", "open-model-runs"].map(id => documentContext.querySelector(`#${id}`));
    }

    /** Create a text-only element.
     * @param {string} tag HTML tag.
     * @param {string} [text=""] Visible text.
     * @param {string} [className=""] Presentation class.
     * @return {HTMLElement} New element.
     */
    element(tag, text = "", className = "") {
        const node = this.document.createElement(tag); node.textContent = text; node.className = className; return node;
    }

    /** Create a native button for a semantic action.
     * @param {string} label Visible and accessible action name.
     * @param {()=>void} action Click callback.
     * @return {HTMLButtonElement} Button.
     */
    button(label, action) { const button = this.element("button", label, "secondary-button"); button.type = "button"; button.addEventListener("click", action); return button; }

    /** Connect navigation and persistent controls to controller actions.
     * @param {Object<string,Function>} handlers Semantic user actions.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.listeners = [[this.openers[0], "click", handlers.onOpen], [this.openers[1], "click", () => { handlers.onPage("runs"); handlers.onOpen(); }],
            [this.elements.close, "click", handlers.onClose], [this.elements.query, "input", () => handlers.onQuery(this.elements.query.value)],
            [this.elements.refresh, "click", handlers.onRefresh], [this.elements["refresh-runs"], "click", handlers.onRefreshRuns],
            [this.elements.more, "click", handlers.onMore], [this.elements.recover, "click", handlers.onRetry],
            ...Object.entries(this.navigation).map(([page, node]) => [node, "click", () => handlers.onPage(page)])];
        for (const [node, event, callback] of this.listeners) node.addEventListener(event, callback);
    }

    /** Focus the panel heading after an explicit setup or run choice.
     * @return {void}
     */
    focusHeading() { this.elements.heading.focus(); }

    /** Build a labelled input with a stable ID for keyboard users.
     * @param {string} id Unique control ID.
     * @param {string} caption Field label.
     * @param {HTMLElement} input Native field.
     * @return {HTMLLabelElement} Field wrapper.
     */
    field(id, caption, input) {
        input.id = id; const label = this.element("label", caption, "models-field"); label.htmlFor = id; label.append(input); return label;
    }

    /** Replace choice options only when their labels or values change.
     * @param {HTMLSelectElement} select Native select.
     * @param {{value:string,label:string}[]} options Choices.
     * @param {string} selected Selected value.
     * @return {void}
     */
    options(select, options, selected) {
        const signature = JSON.stringify(options);
        if (select.optionsSignature !== signature) {
            select.replaceChildren(...options.map(choice => { const node = this.element("option", choice.label); node.value = choice.value; return node; }));
            select.optionsSignature = signature;
        }
        select.value = selected;
    }

    /** Construct the editable fields for one draft, retaining their DOM identities.
     * @param {Object} draft New draft.
     * @return {void}
     */
    buildSetup(draft) {
        const form = this.element("form", "", "models-form");
        const fields = this.element("fieldset"); const legend = this.element("legend", draft.model.title); fields.append(legend);
        const description = this.element("p", draft.model.description, "models-help"); fields.append(description);
        const label = this.element("input"); label.type = "text"; label.maxLength = 80; label.required = true;
        label.addEventListener("input", () => this.handlers.onEdit({label: label.value}));
        fields.append(this.field("models-run-label", "Run name", label));
        const source = this.element("select"); source.required = true;
        source.addEventListener("change", () => this.handlers.onEdit({raster: this.state.draft.sources.find(value => modelSourceKey(value) === source.value) ?? null,
            sourceReason: "Choose a raster from Map layers."}));
        const reason = this.element("p", "", "models-help"); reason.id = "models-source-reason"; source.setAttribute("aria-describedby", reason.id);
        fields.append(this.field("models-raster", Object.values(draft.model.inputs).find(input => input.type === "catalog_raster")?.label ?? "Raster", source), reason);
        const areaMode = this.element("select");
        areaMode.addEventListener("change", () => this.handlers.onArea(areaMode.value));
        fields.append(this.field("models-area", Object.values(draft.model.inputs).find(input => ["summary_area", "clip_area"].includes(input.type))?.label ?? "Analysis area", areaMode));
        const vectorGroup = this.element("div", "", "models-vector");
        const vector = this.element("select"); vector.addEventListener("change", () => this.handlers.onVector(vector.value));
        vectorGroup.append(this.field("models-vector", "Vector layer", vector));
        const selectionCard = this.element("section", "", "models-selection");
        selectionCard.setAttribute("aria-label", "Selected features");
        const selectionHeader = this.element("div", "", "models-selection-header");
        const selectedCount = this.element("strong"); selectedCount.setAttribute("role", "status");
        const editFilter = this.button("Edit filter", this.handlers.onEditFilter); editFilter.classList.add("models-edit-filter");
        editFilter.setAttribute("aria-controls", "models-filter-editor");
        selectionHeader.append(selectedCount, editFilter);
        const filterDescription = this.element("p", "", "models-selection-filter");
        const vectorStatus = this.element("p", "", "models-help"); vectorStatus.setAttribute("role", "status");
        const mapFilterStatus = this.element("p", "", "models-help"); mapFilterStatus.setAttribute("role", "status");
        selectionCard.append(selectionHeader, filterDescription, vectorStatus, mapFilterStatus);
        const filterHost = this.element("div", "", "models-filter-editor"); filterHost.id = "models-filter-editor";
        vectorGroup.append(selectionCard, filterHost);
        const areaDescription = this.element("p", "", "models-help"); areaDescription.setAttribute("role", "status");
        const mapHelp = this.element("p", "", "models-help");
        fields.append(vectorGroup, areaDescription, mapHelp);
        const parameters = {};
        for (const [name, parameter] of Object.entries(draft.model.parameters)) {
            const input = this.element(parameter.type === "summary_expression" ? "textarea" : "input");
            if (parameter.type === "summary_expression") { input.rows = 2; input.maxLength = 4096; input.spellcheck = false; }
            else { input.type = "number"; input.step = "any"; if (parameter.minimum != null) input.min = String(parameter.minimum); }
            input.addEventListener("input", () => this.handlers.onEdit({parameters: {...this.state.draft.parameters,
                [name]: parameter.type === "summary_expression" ? input.value : input.value === "" ? null : Number(input.value)}}));
            parameters[name] = input;
            fields.append(this.field(`models-parameter-${name}`, `${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ""}`, input));
            if (parameter.type === "summary_expression") fields.append(this.element("p", "a is the selected raster. Examples: sum(a), mean(a), stdev(a), min(a), max(a), count(a), areaha(a > 10), sum(a, where=a > 10).", "models-help"));
        }
        const run = this.button("Run model", () => {}); run.type = "submit";
        const hint = this.element("p", "Run model uses the choices shown here. You can keep using the map while it runs. To stop it, choose Cancel run.", "models-help");
        fields.append(hint, run); form.append(fields);
        form.addEventListener("submit", event => { event.preventDefault(); this.handlers.onSubmit(); });
        const details = this.recipeDetails();
        this.elements.setup.replaceChildren(form, details.root);
        this.setup = {id: draft.id, form, fields, label, source, reason, areaMode, vectorGroup, vector, areaDescription,
            parameters, run, details, mapHelp, editFilter, vectorStatus, filterDescription, selectedCount, selectionCard, filterHost, mapFilterStatus};
    }

    /** Provide an inline location for the independently owned vector filter editor.
     * @return {HTMLElement} Stable host inside the current model setup.
     */
    getVectorFilterHost() { return this.setup.filterHost; }

    /** Create the secondary YAML actions without expanding permanent setup chrome.
     * @return {Object} Details wrapper and download controls.
     */
    recipeDetails() {
        const root = this.element("details", "", "models-details"); root.append(this.element("summary", "Recipe & downloads"));
        const actions = this.element("div", "", "models-actions");
        const preview = this.button("View Model YAML", this.handlers.onYaml);
        const model = this.element("a", "Download Model YAML"); model.download = "";
        const run = this.element("a", "Download Run YAML"); run.download = "";
        const message = this.element("p", "", "models-help");
        actions.append(preview, model, run); root.append(actions, message);
        return {root, preview, model, run, message};
    }

    /** Update form values while leaving the field being typed into untouched.
     * @param {Object} state Controller snapshot.
     * @return {void}
     */
    renderSetup(state) {
        const draft = state.draft; if (!draft) return;
        if (this.setup?.id !== draft.id) this.buildSetup(draft);
        const s = this.setup;
        s.fields.disabled = state.submitting;
        if (this.document.activeElement !== s.label) s.label.value = draft.label;
        this.options(s.source, [{value: "", label: "Choose a raster…"}, ...draft.sources.map(source => ({value: modelSourceKey(source),
            label: source.label + (source.visible === false ? " (hidden on map)" : "")}))], draft.raster ? modelSourceKey(draft.raster) : "");
        s.reason.textContent = draft.sourceReason;
        const areaChoices = [{value: "viewport", label: "Visible map area"},
            {value: "samplingArea", label: "Sampling area"}, {value: "vector", label: "Vector layer"}];
        if (modelSupportsArea(draft.model, {kind: "wholeRaster"})) areaChoices.unshift({value: "whole", label: "Entire raster"});
        if (draft.capturedArea?.kind === "polygonArea" && draft.areaOrigin === "map" && modelSupportsArea(draft.model, draft.capturedArea)) {
            areaChoices.push({value: "mapPolygons", label: "Polygons selected on map"});
        }
        if (draft.areaOrigin === "run" && draft.capturedArea?.kind !== "wholeRaster") {
            areaChoices.push({value: "captured", label: "Area from original run"});
        }
        this.options(s.areaMode, areaChoices, draft.areaMode);
        s.vectorGroup.hidden = draft.areaMode !== "vector";
        this.options(s.vector, [{value: "", label: "Choose a vector layer…"}, ...draft.vectors.map(source => ({value: modelSourceKey(source), label: source.label}))], draft.vectorKey);
        s.mapHelp.hidden = !["viewport", "samplingArea", "mapPolygons", "captured"].includes(draft.areaMode);
        s.mapHelp.textContent = ({
            viewport: "Uses the visible map area when you choose Run model. Pan or zoom to change it.",
            samplingArea: "Uses the sampling area shown in Raster distributions. Click the map to move the box. Run model uses its latest position and size.",
            mapPolygons: "Uses the polygons selected on the map when you choose Run model.",
            captured: "Uses the exact area from the original run. Choose another area above to change it.",
        })[draft.areaMode] ?? "";
        const vectorSource = draft.vectors.find(value => modelSourceKey(value) === draft.vectorKey);
        s.selectionCard.hidden = !vectorSource;
        s.editFilter.disabled = !vectorSource || Boolean(draft.filterEditing);
        s.editFilter.textContent = draft.filterOpening ? "Opening filter…" : "Edit filter";
        s.editFilter.setAttribute("aria-expanded", String(Boolean(draft.filterEditing)));
        s.filterHost.hidden = !draft.filterEditing;
        s.selectedCount.textContent = draft.selecting ? "Checking selected features…" : draft.vectorInfo ?
            `${draft.vectorInfo.matched} of ${draft.vectorInfo.total} features selected` : draft.area?.kind === "catalogSelection" ? "Features from original run" : "Selection needs checking";
        s.filterDescription.textContent = vectorSource ? describeModelFilter(draft.area?.selection?.filter ?? vectorSource.filter) : "";
        s.vectorStatus.textContent = draft.selecting ? "You can edit the filter while this check runs." : draft.selectionError;
        s.mapFilterStatus.textContent = draft.mapFilterMessage ?? "";
        s.areaDescription.hidden = draft.areaMode === "vector" && Boolean(vectorSource);
        s.areaDescription.textContent = draft.selectionError || (draft.areaMode === "vector" && !vectorSource ? "Choose a vector layer from Map layers." : "") ||
            `${describeModelArea(draft.area)}${draft.areaMode === "captured" ? ` · ${draft.areaDescription}` : ""}`;
        for (const [name, input] of Object.entries(s.parameters)) if (this.document.activeElement !== input) input.value = draft.parameters[name] ?? "";
        const supported = Object.values(draft.model.inputs).every(input => ["catalog_raster", "summary_area", "clip_area"].includes(input.type));
        s.run.disabled = state.submitting || Boolean(state.pending) || draft.selecting || draft.filterEditing || !draft.area || !draft.raster || !supported;
        s.run.textContent = state.submitting ? "Submitting…" : "Run model";
        s.details.model.href = `/api/processing/models/${draft.model.id}/versions/${draft.model.version}/yaml`;
        s.details.run.hidden = true;
        s.details.message.textContent = supported ? `Model version ${draft.model.version}. Results are temporary.` : "This model requires input controls not yet available in this interface.";
    }

    /** Build stable controls for a selected run.
     * @param {string} id Run identity.
     * @return {void}
     */
    buildRun(id) {
        const title = this.element("h3"); const status = this.element("p"); status.setAttribute("role", "status");
        const progress = this.element("progress"); progress.setAttribute("aria-label", "Current model stage progress");
        const error = this.element("p", "", "models-error"); const result = this.element("div", "", "models-results");
        const actions = this.element("div", "", "models-actions");
        const cancel = this.button("Cancel run", this.handlers.onCancel); const duplicate = this.button("Duplicate with changes", this.handlers.onDuplicate);
        actions.append(cancel, duplicate);
        const expiry = this.element("p", "", "models-help");
        const inputs = this.element("details", "", "models-details"); inputs.append(this.element("summary", "Inputs used for this run"));
        const inputsBody = this.element("div"); inputs.append(inputsBody);
        const details = this.recipeDetails();
        this.elements.run.replaceChildren(title, status, progress, error, result, actions, expiry, inputs, details.root);
        this.run = {id, title, status, progress, error, result, cancel, duplicate, expiry, inputsBody, details};
    }

    /** Render current run progress, immutable setup and available result downloads.
     * @param {Object} state Controller snapshot.
     * @return {void}
     */
    renderRun(state) {
        const id = state.selectedRun; if (!id) return;
        if (this.run?.id !== id) this.buildRun(id);
        const r = this.run; const job = state.runs.find(run => run.jobId === id);
        r.title.textContent = job?.label ?? "Model run";
        r.status.textContent = job ? describeModelProgress(job) : "Reading run…";
        r.error.textContent = state.invocationError || job?.error?.message || job?.error?.detail || ""; r.error.hidden = !r.error.textContent;
        r.cancel.hidden = !job || !ACTIVE_JOB_STATES.has(job.status); r.cancel.disabled = state.actionBusy || job?.status === "cancelling";
        r.duplicate.disabled = !state.invocation || Boolean(state.actionBusy);
        r.progress.hidden = job?.status !== "running";
        if (job?.progress.total > 0) { r.progress.max = job.progress.total; r.progress.value = job.progress.completed ?? 0; }
        else r.progress.removeAttribute("value");
        const available = job?.status === "ready" && Date.parse(job.expiresAt) > Date.now();
        const signature = JSON.stringify([available, job?.result]);
        if (r.resultSignature !== signature) {
            r.resultSignature = signature; r.result.replaceChildren();
            if (available && job.result) {
                if (job.result.kind === "raster") {
                    const card = this.element("article", "", "models-result");
                    card.append(this.element("strong", "Clipped raster"), this.element("span", job.result.filename),
                        this.element("span", `${job.result.grid.width.toLocaleString()} × ${job.result.grid.height.toLocaleString()} pixels · ${job.result.validPixels.toLocaleString()} valid pixels`),
                        this.element("span", `${formatDownloadBytes(job.result.bytes)} · GeoTIFF`));
                    r.result.append(card);
                }
                for (const row of job.result.rows ?? []) {
                    const card = this.element("article", "", "models-result");
                    card.append(this.element("strong", row.label), this.element("code", row.expression),
                        this.element("strong", calculationValue(row), "models-result-value"));
                    if (row.state !== "ok") card.append(this.element("p", RESULT_STATES[row.state] ?? row.state));
                    r.result.append(card);
                }
                const links = this.element("div", "", "models-actions");
                for (const [kind, label] of [["result", job.result.kind === "raster" ? "Download GeoTIFF" : "Download CSV"], ["provenance", "Download provenance"]]) {
                    const link = this.element("a", label); link.href = processingDownloadUrl(kind === "result" ? job.result.url : job.result.provenanceUrl, id, kind); link.download = ""; links.append(link);
                }
                r.result.append(links);
            }
        }
        r.expiry.textContent = job ? `Temporary run in this browser session.${job.expiresAt ? ` Result files expire ${new Date(job.expiresAt).toLocaleString()}.` : ""}` +
            (job.metadataExpiresAt ? ` Saved inputs expire ${new Date(job.metadataExpiresAt).toLocaleString()}.` : "") : "";
        const invocation = state.invocation;
        if (invocation && r.invocation !== invocation) {
            r.invocation = invocation;
            const list = this.element("dl");
            for (const [name, input] of Object.entries(invocation.model.definition.inputs)) {
                const value = invocation.inputs[name];
                list.append(this.element("dt", input.label), this.element("dd", input.type === "catalog_raster" ? `${value.collectionId} / ${value.itemId}` : describeModelArea(value)));
            }
            for (const [name, parameter] of Object.entries(invocation.model.definition.parameters)) list.append(this.element("dt", parameter.label), this.element("dd", String(invocation.parameters[name])));
            r.inputsBody.replaceChildren(list);
        } else if (!invocation) { r.inputsBody.textContent = state.invocationError || "Reading saved inputs…"; r.invocation = null; }
        const metadataAvailable = job && job.status !== "deleted" && (!job.metadataExpiresAt || Date.parse(job.metadataExpiresAt) > Date.now());
        r.details.preview.disabled = !metadataAvailable; r.details.model.hidden = r.details.run.hidden = !metadataAvailable;
        r.details.model.href = processingDownloadUrl(`/api/processing/jobs/${id}/model-yaml`, id, "model-yaml");
        r.details.run.href = processingDownloadUrl(`/api/processing/jobs/${id}/run-yaml`, id, "run-yaml");
        r.details.message.textContent = metadataAvailable ? `Recipe ${job.model.title} · ${job.model.version}` : "Saved recipe and inputs are no longer available.";
    }

    /** Update only changed presentation, preserving focus and open details.
     * @param {Object} state Controller snapshot.
     * @return {void}
     */
    render(state) {
        this.state = state;
        for (const page of ["library", "setup", "runs", "run"]) this.elements[page].hidden = state.page !== page;
        for (const [page, node] of Object.entries(this.navigation)) node.setAttribute("aria-pressed", String(state.page === page || page === "runs" && state.page === "run"));
        this.navigation.setup.disabled = !state.draft;
        this.elements.heading.textContent = ({library: "Model library", setup: "Model setup", runs: "Model runs", run: "Model run"})[state.page];
        const error = state.error || (state.page === "setup" ? "" : state.observationError) || "";
        this.elements.error.textContent = error; this.elements.error.hidden = !error;
        this.elements.recovery.hidden = !state.pending; this.elements.recover.disabled = state.submitting;
        const filtered = state.library.filter(model => `${model.title} ${model.description}`.toLowerCase().includes(state.query.toLowerCase()));
        const signature = JSON.stringify(filtered);
        if (signature !== this.librarySignature) {
            this.librarySignature = signature;
            this.elements["library-items"].replaceChildren(...filtered.map(model => {
                const card = this.element("article", "", "models-library-card");
                card.append(this.element("h3", model.title), this.element("p", model.description),
                    this.element("p", `Inputs: ${Object.values(model.inputs).map(input => input.label).join(", ")}`, "models-help"),
                    this.element("p", `Outputs: ${Object.entries(model.outputs).map(([name, output]) => `${name} (${output.presentation})`).join(", ")}`, "models-help"),
                    this.button("Set up model", () => this.handlers.onChoose(model))); return card;
            }));
        }
        this.elements["library-status"].textContent = state.loading ? "Loading model library…" : filtered.length ? "" : "No matching models.";
        this.elements.refresh.disabled = state.loading;
        this.renderSetup(state); this.renderRun(state);
        for (const job of state.runs) {
            let card = this.runCards.get(job.jobId);
            if (!card) {
                const root = this.element("article", "", "models-history-row"); const button = this.button(job.label, () => this.handlers.onRun(job.jobId));
                const status = this.element("small"); root.append(button, status); card = {root, button, status}; this.runCards.set(job.jobId, card);
                this.elements["runs-list"].append(root);
            }
            card.button.textContent = job.label; card.status.textContent = `${describeModelProgress(job)} · ${new Date(job.createdAt).toLocaleString()}`;
        }
        // Move retained nodes only when ordering changes, keeping focus during status reads.
        const order = state.runs.map(job => job.jobId).join();
        if (order !== this.runOrder) { this.runOrder = order; for (const job of state.runs) this.elements["runs-list"].append(this.runCards.get(job.jobId).root); }
        this.elements["runs-status"].textContent = state.historyLoading ? "Loading runs…" : state.runs.length ? "Runs belong to this browser session. Closing Models does not cancel them." : "No model runs in this browser session yet.";
        this.elements.more.hidden = !state.nextCursor; this.elements.more.disabled = state.historyLoading;
        this.elements["refresh-runs"].disabled = state.historyLoading;
        this.elements.yaml.hidden = !state.yaml; this.elements.yaml.textContent = state.yaml ?? "";
    }

    /** Detach persistent event listeners.
     * @return {void}
     */
    destroy() { for (const [node, event, callback] of this.listeners) node.removeEventListener(event, callback); }
}
