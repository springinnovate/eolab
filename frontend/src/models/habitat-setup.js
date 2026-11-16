/** Own Habitat setup choices, coverage policy and request lifetime. */
import { vectorSelectionsEqual } from "../selected-area.js";
import { HabitatStackView } from "./habitat-stack-view.js";
import { HabitatPreparationSelectionView } from "./habitat-preparation-selection-view.js";

/** Find the active Earth Engine stack in this model's editable inputs.
 * @param {Object} draft Model draft with named input state.
 * @return {Object|undefined} Habitat stack state, absent when manual rasters are selected.
 */
export function getHabitatEarthEngineInput(draft) {
    const name = Object.keys(draft.model.inputs).find(key => draft.model.inputs[key].type === "habitat_stack");
    const input = draft.inputs[name];
    return input?.kind === "earthEngine" ? input : undefined;
}

/** Capture existing Catalog features after checking this draft's preparation coverage.
 * The server independently checks preparation membership and source access at admission.
 * Manual area state remains separate and is never used for Earth Engine capture.
 * @param {Object} draft Habitat draft with model-owned preparation selections and coverage.
 * @return {{kind:"catalogSelection",selection:Object}} Detached original Catalog selection.
 * @throws {Error} If choices or coverage are pending, unavailable, empty or unselected.
 */
export function captureHabitatPreparationSelection(draft) {
    const state = draft.setupState;
    if (state.loading || !state.loaded) throw new Error(state.error || "Wait for preparation selections to load.");
    if (state.error) throw new Error(state.error);
    if (!state.selections.length) throw new Error("No preparation selections are available. Ask an administrator to prepare inputs for a Catalog selection.");
    const selection = state.selections.find(value => vectorSelectionsEqual(value, state.selectedSelection));
    if (!selection) throw new Error(state.unavailable
        ? "The original Catalog selection is not available for preparation. Choose another selection."
        : "Choose a Catalog selection with prepared inputs.");
    if (state.coverageError) throw new Error(state.coverageError);
    if (state.coverageLoading || !state.coverage) throw new Error("Wait for prepared-input coverage to be checked.");
    if (!state.coverage.cachedTiles) throw new Error("No prepared inputs are available for this area and year. Choose another area or year, or ask an administrator to prepare the inputs.");
    return {kind: "catalogSelection", selection: structuredClone(selection)};
}

/** Capture selected Earth Engine datasets for a year or named Habitat rasters.
 * @param {Object} state Editable mode, year, dataset selections, server options and manual rows.
 * @param {Object[]} sources Current source choices in this model setup.
 * @param {(raster:Object,sources:Object[])=>Object} captureRaster Ordinary authorized-source value capture.
 * @return {Object} Earth Engine year and dataset IDs, or named predictors/responses with ordinary raster references.
 * @throws {Error} If choices have not loaded, or the year, dataset selections, roles, names or raster selections are invalid.
 */
export function captureHabitatStack(state, sources, captureRaster) {
    if (state.kind === "earthEngine") {
        if (!state.configuration) throw new Error("Wait for the Earth Engine year choices to load, or retry.");
        if (!Number.isInteger(state.year) || state.year < state.configuration.minimumYear || state.year > state.configuration.maximumYear)
            throw new Error("Choose an assessment year from the available years.");
        const selected = {};
        for (const [role, field, label] of [["predictor", "predictorDatasets", "predictor"], ["response", "responseDatasets", "observed response"]]) {
            const choices = state.configuration.datasets.filter(dataset => dataset.roles.includes(role));
            const ids = state[field];
            if (!ids.length) throw new Error(`Select at least one ${label} dataset.`);
            if (ids.some(id => !choices.some(dataset => dataset.id === id))) throw new Error(`A selected ${label} dataset is no longer available. Review the dataset choices.`);
            const missing = choices.find(dataset => dataset.requiredRoles.includes(role) && !ids.includes(dataset.id));
            if (missing) throw new Error(`${missing.label} is required by the model.`);
            selected[field] = choices.filter(dataset => ids.includes(dataset.id)).map(dataset => dataset.id);
        }
        return {kind: "earthEngine", year: state.year, ...selected};
    }
    if (!state.predictors.length || !state.responses.length) throw new Error("Choose at least one predictor and one observed response.");
    const names = [...state.predictors, ...state.responses].map(row => row.name.trim());
    if (names.some(name => !name)) throw new Error("Name each predictor and observed response.");
    if (new Set(names).size !== names.length) throw new Error("Give each predictor and observed response a different name.");
    const categoricalPredictor = state.categoricalPredictor.trim();
    if (!state.predictors.some(row => row.name.trim() === categoricalPredictor)) throw new Error("Choose the categorical predictor.");
    return {predictors: state.predictors.map(row => ({name: row.name.trim(), source: captureRaster(row.raster, sources)})),
        responses: state.responses.map(row => ({name: row.name.trim(), source: captureRaster(row.raster, sources)})), categoricalPredictor};
}

/** Load and validate Habitat setup for one draft without accessing its shared controller. */
class HabitatSetupSession {
    /** Bind only the services and UI notifications needed by Habitat setup.
     * @param {Object} draft Editable Habitat inputs and model-owned setup state.
     * @param {import("./model-setup.js").ModelSetupDependencies} dependencies Explicit transport and UI callbacks.
     * @param {Object} dependencies.api Processing transport for Habitat metadata and coverage.
     * @param {(selection:Object,signal:AbortSignal)=>Promise<Object>} dependencies.getCatalogItem Read display metadata for an exact Item.
     * @param {()=>void} dependencies.render Notify the host that draft presentation changed.
     * @param {()=>void} dependencies.refreshGrid Refresh ordinary raster-grid choices.
     * @param {()=>void} dependencies.closeInputEditor Close an active editor before mode changes.
     */
    constructor(draft, {api, getCatalogItem, render, refreshGrid, closeInputEditor}) {
        Object.assign(this, {draft, api, getCatalogItem, render, refreshGrid, closeInputEditor});
        this.disposed = false;
    }

    /** Load model options and preparation choices after the draft has been restored.
     * @return {Promise<void>} Completion after initial choices and coverage settle.
     */
    async start() {
        const name = Object.keys(this.draft.model.inputs).find(key => this.draft.model.inputs[key].type === "habitat_stack");
        await Promise.all([this.loadOptions(this.draft, name), this.loadSelections(this.draft)]);
    }

    /** Apply Habitat's mode/year dependencies after the host edits one input.
     * @param {string} name Recipe input whose value changed.
     * @param {Object} change Edited fields from that input's control.
     * @return {void}
     */
    inputChanged(name, change) {
        if (this.draft.model.inputs[name].type !== "habitat_stack") return;
        if (change.kind) {
            for (const [key, definition] of Object.entries(this.draft.model.inputs)) {
                if (definition.type === "raster_preparation") Object.assign(this.draft.inputs[key], {mode: "auto", sourceKey: ""});
                if (definition.type === "summary_area" && this.draft.inputs[key].filterEditing) this.closeInputEditor();
            }
            this.cancelPreparationReads();
            if (change.kind === "earthEngine" && !this.draft.setupState.loaded) void this.loadSelections(this.draft);
        }
        void this.refreshCoverage();
    }

    /** Dispatch an action emitted by Habitat's own setup controls.
     * @param {string} action Selection or retry action registered by the Habitat view.
     * @param {unknown} value Selected descriptor or stack input name when required.
     * @return {Promise<void>|void} Completion for reads, or immediate selection change.
     */
    action(action, value) {
        if (action === "refresh-options") return this.loadOptions(this.draft, value);
        if (action === "select-preparation") return this.chooseSelection(value);
        if (action === "refresh-preparations") return this.loadSelections(this.draft);
        if (action === "refresh-coverage") return this.refreshCoverage(true);
    }

    /** Cancel setup reads so replaced drafts cannot receive late updates.
     * @return {void}
     */
    dispose() {
        this.disposed = true;
        this.optionsAbort?.abort();
        this.cancelPreparationReads();
    }

    /** Load Habitat's years, dataset choices and acquisition grid for model setup.
     * Manual raster setup remains usable if this request fails. Replaced drafts
     * ignore late replies. New drafts select every dataset; refreshes and duplicated
     * runs retain their existing year, dataset selections and output grid.
     * @param {Object} draft Draft requesting the configuration.
     * @param {string} name Habitat stack input declared by that recipe.
     * @return {Promise<void>} Resolves after choices or retry guidance are displayed.
     */
    async loadOptions(draft, name) {
        const input = draft.inputs[name];
        if (input.loading) return;
        input.loading = true; input.error = ""; this.render();
        const abort = new AbortController(); this.optionsAbort = abort;
        try {
            const options = await this.api.getHabitatEarthEngineOptions(abort.signal);
            if (abort.signal.aborted || this.disposed) return;
            input.configuration = options; input.year ??= options.defaultYear;
            for (const [role, field] of [["predictor", "predictorDatasets"], ["response", "responseDatasets"]])
                input[field] ??= options.datasets.filter(dataset => dataset.roles.includes(role)).map(dataset => dataset.id);
        } catch (error) {
            if (abort.signal.aborted || this.disposed) return;
            input.error = `Could not load Earth Engine choices: ${error.message}`;
        } finally {
            input.loading = false;
            if (!abort.signal.aborted && !this.disposed) {
                this.refreshGrid(); void this.refreshCoverage(); this.render();
            }
        }
    }

    /** Cancel preparation-selection and coverage reads without changing accepted run inputs.
     * Draft replacement, mode changes and destruction invalidate their late responses.
     * @return {void}
     */
    cancelPreparationReads() {
        this.selectionsAbort?.abort(); this.coverageAbort?.abort();
        this.coverageKey = null;
        const state = this.draft?.setupState;
        if (state) { state.loading = false; state.coverageLoading = false; state.coverage = null; }
    }

    /** Load Catalog selections used for preparation and retain only an exact selection match.
     * Catalog titles load separately and never authorize or delay coverage checks.
     * @param {Object} draft Habitat draft whose preparation selections are being loaded.
     * @return {Promise<void>} Completion after selections and selected-year coverage settle.
     */
    async loadSelections(draft) {
        if (!draft || this.disposed || !getHabitatEarthEngineInput(draft)) return;
        this.selectionsAbort?.abort(); this.coverageAbort?.abort();
        this.coverageKey = null;
        const abort = new AbortController(); this.selectionsAbort = abort;
        const state = draft.setupState;
        Object.assign(state, {loading: true, error: "", coverage: null, coverageLoading: false, coverageError: ""});
        const isCurrent = () => !abort.signal.aborted && !this.disposed && Boolean(getHabitatEarthEngineInput(draft));
        this.render();
        try {
            const {selections} = await this.api.getHabitatPreparationSelections(abort.signal);
            if (!isCurrent()) return;
            state.selections = selections; state.loaded = true;
            const previous = state.restoreSelection ?? state.selectedSelection;
            if (previous) {
                const restored = selections.find(selection => vectorSelectionsEqual(selection, previous));
                state.selectedSelection = restored ?? null; state.unavailable = !restored;
                if (restored) state.restoreSelection = null;
            }
            void this.loadTitles(draft, selections, abort);
        } catch (error) {
            if (isCurrent()) state.error = "Preparation selections could not be loaded. Refresh to try again. " + error.message;
        } finally {
            if (isCurrent()) {
                state.loading = false; this.render(); await this.refreshCoverage();
            }
        }
    }

    /** Read each distinct Catalog Item's title without gating a preparation selection.
     * Unavailable metadata leaves the layer name as the display fallback. Late replies
     * cannot replace titles after refresh, mode changes or draft replacement.
     * @param {Object} draft Habitat draft receiving presentation-only titles.
     * @param {Object[]} selections Validated Catalog selections, possibly sharing an Item.
     * @param {AbortController} abort Cancellation owned by the selection-list request.
     * @return {Promise<void>} Completion after all current title reads settle.
     */
    async loadTitles(draft, selections, abort) {
        const items = new Map(selections.map(selection => [JSON.stringify([selection.collectionId, selection.itemId]), selection]));
        await Promise.all([...items].map(async ([key, selection]) => {
            try {
                const item = await this.getCatalogItem(selection, abort.signal);
                if (abort.signal.aborted || this.disposed) return;
                draft.setupState.titles[key] = item.properties?.title ?? item.id;
                this.render();
            } catch { /* The exact Catalog identity remains a usable display fallback. */ }
        }));
    }

    /** Choose an existing Catalog selection independently of the manual analysis area.
     * @param {Object|null} selection Descriptor chosen from preparation selections, or null to clear it.
     * @return {void}
     */
    chooseSelection(selection) {
        const draft = this.draft;
        if (!draft || !getHabitatEarthEngineInput(draft)) return;
        Object.assign(draft.setupState, {selectedSelection: selection, restoreSelection: null, unavailable: false});
        void this.refreshCoverage(); this.render();
    }

    /** Check the selected Catalog features and year, ignoring superseded replies.
     * Repeated renders and unrelated input changes reuse this completed check;
     * explicit retry, year/selection edits and mode changes request current coverage.
     * @param {boolean} [retry=false] Refresh the same selection/year after user action.
     * @return {Promise<void>} Completion after current coverage or retry guidance is displayed.
     */
    async refreshCoverage(retry = false) {
        const draft = this.draft;
        const stack = draft && getHabitatEarthEngineInput(draft), state = draft?.setupState;
        if (!stack || !state) return;
        const ready = state.loaded && !state.loading && !state.error &&
            state.selections.some(selection => vectorSelectionsEqual(selection, state.selectedSelection)) && Number.isInteger(stack.year);
        const key = ready ? JSON.stringify([draft.id, state.selectedSelection, stack.year]) : null;
        if (!retry && key && key === this.coverageKey) return;
        this.coverageAbort?.abort(); this.coverageKey = key;
        state.coverage = null; state.coverageError = ""; state.coverageLoading = Boolean(key);
        if (!key) { this.render(); return; }
        const selection = state.selectedSelection, year = stack.year, abort = new AbortController();
        this.coverageAbort = abort;
        const isCurrent = () => !abort.signal.aborted && !this.disposed &&
            getHabitatEarthEngineInput(draft) === stack && state.selectedSelection === selection && stack.year === year;
        this.render();
        try {
            const coverage = await this.api.getHabitatPreparationCoverage(selection, year, abort.signal);
            if (isCurrent()) state.coverage = coverage;
        } catch (error) {
            if (isCurrent()) state.coverageError = "Prepared-input coverage could not be checked. Try again. " + error.message;
        } finally {
            if (isCurrent()) { state.coverageLoading = false; this.render(); }
        }
    }

}

/** Create preparation-selection state without replacing the ordinary manual AOI.
 * @param {Object} model Installed Habitat recipe.
 * @param {Object} inputs Ordinary input drafts, adjusted only for the default manual AOI.
 * @param {Object} context Initial source and viewport choices.
 * @param {{viewportArea:(bounds:Object)=>Object}} helpers Ordinary viewport-area capture.
 * @return {Object} Empty asynchronous choices, exact selection and coverage state.
 */
function createState(model, inputs, context, {viewportArea}) {
    for (const [name, definition] of Object.entries(model.inputs)) {
        const input = inputs[name];
        if (definition.type !== "summary_area" || input.area?.kind !== "wholeRaster") continue;
        input.areaMode = "viewport"; input.area = null;
        try { input.area = viewportArea(context.viewportBounds); }
        catch (error) { input.selectionError = error.message; }
        input.capturedArea = structuredClone(input.area);
    }
    return {selections: [], titles: {}, loaded: false, loading: false, error: "",
        selectedSelection: null, restoreSelection: null, unavailable: false,
        coverage: null, coverageLoading: false, coverageError: ""};
}

/** Create the Habitat stack with independent manual raster choices.
 * @param {Object} definition Recipe input definition.
 * @param {Object} preparation Ordinary per-raster preparation defaults.
 * @return {Object|undefined} Stack draft, or undefined for another input family.
 */
function createInput(definition, preparation) {
    if (definition.type !== "habitat_stack") return undefined;
    return {kind: "earthEngine", year: null, configuration: null, loading: false, error: "", predictorDatasets: null, responseDatasets: null,
        predictors: [{name: "predictor_1", raster: null, ...preparation}], responses: [{name: "response_1", raster: null, ...preparation}], categoricalPredictor: ""};
}

/** Capture Habitat's stack or prepared AOI through the existing invocation contract.
 * @param {Object} draft Editable Habitat inputs and preparation state.
 * @param {string} name Recipe input to capture.
 * @param {{captureRaster:(raster:Object,sources:Object[])=>Object}} helpers Ordinary source-value capture.
 * @return {Object|undefined} Captured value, or undefined to use ordinary input capture.
 * @throws {Error} If stack choices or preparation coverage are incomplete.
 */
function captureInput(draft, name, {captureRaster}) {
    const definition = draft.model.inputs[name];
    if (definition.type === "habitat_stack") return captureHabitatStack(draft.inputs[name], draft.sources, captureRaster);
    if (definition.type === "summary_area" && getHabitatEarthEngineInput(draft)) return captureHabitatPreparationSelection(draft);
    return undefined;
}

/** Restore Habitat stack values while leaving ordinary spatial restoration to its owner.
 * @param {Object} draft New editable Habitat draft.
 * @param {string} name Recipe input receiving its saved invocation value.
 * @param {Object} value Saved stack value.
 * @return {boolean} Whether this integration restored the input.
 */
function restoreInput(draft, name, value) {
    if (draft.model.inputs[name].type !== "habitat_stack") return false;
    const input = draft.inputs[name];
    if (value.kind === "earthEngine") Object.assign(input, {kind: value.kind, year: value.year,
        predictorDatasets: value.predictorDatasets == null ? null : [...value.predictorDatasets],
        responseDatasets: value.responseDatasets == null ? null : [...value.responseDatasets]});
    else Object.assign(input, {kind: "manual",
        predictors: value.predictors.map(row => ({name: row.name, raster: structuredClone(row.source)})),
        responses: value.responses.map(row => ({name: row.name, raster: structuredClone(row.source)})),
        categoricalPredictor: value.categoricalPredictor});
    return true;
}

/** Require the duplicated Earth Engine AOI to match a current prepared selection.
 * @param {Object} draft Draft after its ordinary inputs have been restored.
 * @param {Object} inputs Saved invocation values keyed by recipe input name.
 * @return {void}
 */
function restoreState(draft, inputs) {
    if (!getHabitatEarthEngineInput(draft)) return;
    const name = Object.keys(draft.model.inputs).find(key => draft.model.inputs[key].type === "summary_area");
    const area = inputs[name];
    draft.setupState.restoreSelection = area.kind === "catalogSelection" ? structuredClone(area.selection) : null;
    draft.setupState.unavailable = true;
}

/** Offer the installed Earth Engine acquisition grid only in automatic input mode.
 * @param {Object} draft Current Habitat setup.
 * @return {{key:string,label:string,sourceCrs:string,grid:Object}|null} Model-provided grid choice.
 */
function acquisitionGrid(draft) {
    const grid = getHabitatEarthEngineInput(draft)?.configuration?.grid;
    return grid ? {key: "earthEngine", label: "Earth Engine inputs", sourceCrs: grid.crs, grid} : null;
}

/** Build Habitat setup, keeping its optional output mask in a collapsed disclosure.
 * Reuse ordinary spatial/raster controls for source selection and readiness.
 * @param {import("./model-setup.js").ModelSetupUi} ui Element, formatting and ordinary input builders supplied by the host view.
 * @param {{onInput:(name:string,change:Object)=>void,onSetupAction:(action:string,value?:unknown)=>void}} handlers Generic input edits and integration actions.
 * @param {string} name Recipe input name.
 * @param {Object} definition Declared input type and label.
 * @param {Object} draft Current Habitat draft.
 * @return {import("./model-setup.js").ModelSetupControls|null} Owned controls with renderModelInput, or null for ordinary controls.
 */
function buildInput(ui, handlers, name, definition, draft) {
    if (definition.type === "habitat_stack") {
        const controls = new HabitatStackView({...ui, captureStack: (value, sources) => captureHabitatStack(value, sources, ui.captureRaster)}, {onInput: handlers.onInput,
            onRefreshHabitat: inputName => handlers.onSetupAction("refresh-options", inputName)}, name, definition);
        ui.append(controls.root);
        controls.renderModelInput = (value, state) => controls.render(value, state);
        return controls;
    }
    if (name === "habitat_mask" && definition.type === "optional_raster") {
        const root = ui.element("details", "", "models-details models-output-mask");
        root.open = false;
        const summary = ui.element("summary", "Advanced");
        const fields = ui.element("div", "", "models-vector");
        const controls = ui.buildRasterInput(fields, name, {...definition, label: "Limit output to a raster mask (optional)"});
        const hint = ui.element("p", "Only cells equal to 1 receive results.", "models-help");
        hint.id = `models-${name}-help`;
        controls.source.setAttribute("aria-describedby", `${hint.id} ${controls.reason.id}`);
        fields.append(hint); root.append(summary, fields); ui.append(root);
        Object.assign(controls, {root, summary, hint});
        controls.renderModelInput = (value, state) => {
            const input = value.inputs[name];
            const ready = ui.renderRasterInput(controls, definition, input, state);
            summary.textContent = input.raster
                ? `Advanced · Output mask: ${input.raster.label ?? "Selected raster"}${input.raster.available === false ? " (unavailable)" : ""}`
                : "Advanced";
            return ready;
        };
        return controls;
    }
    if (definition.type !== "summary_area") return null;
    const controls = ui.buildSpatialInput(name, definition);
    controls.preparationSelection = new HabitatPreparationSelectionView({...ui, captureSelection: captureHabitatPreparationSelection}, {
        onHabitatPreparationSelection: selection => handlers.onSetupAction("select-preparation", selection),
        onRefreshHabitatPreparationSelections: () => handlers.onSetupAction("refresh-preparations"),
        onRefreshHabitatCoverage: () => handlers.onSetupAction("refresh-coverage"),
    }, name, definition.label);
    ui.append(controls.preparationSelection.root);
    controls.renderModelInput = (value, state) => {
        const prepared = Boolean(getHabitatEarthEngineInput(value));
        controls.group.hidden = prepared;
        controls.source.disabled = prepared;
        controls.preparationSelection.root.hidden = !prepared;
        controls.preparationSelection.source.disabled = !prepared;
        return prepared ? controls.preparationSelection.render(value)
            : ui.renderSpatialInput(controls, definition, value.inputs[name], state);
    };
    return controls;
}

/** Bind one draft's Habitat-owned asynchronous lifetime.
 * @param {Object} draft Editable model inputs and opaque setup state.
 * @param {import("./model-setup.js").ModelSetupDependencies} dependencies Explicit transport and UI callbacks documented by HabitatSetupSession.
 * @return {import("./model-setup.js").ModelSetupSession} Draft-owned integration session.
 */
function createSession(draft, dependencies) { return new HabitatSetupSession(draft, dependencies); }

/** Habitat integration registered once at the model setup boundary.
 * @type {import("./model-setup.js").ModelSetupIntegration}
 */
export const habitatSetup = Object.freeze({createState, createInput, captureInput, restoreInput, restoreState, acquisitionGrid, buildInput, createSession});
