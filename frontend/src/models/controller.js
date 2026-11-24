/** Own model setup and run navigation while accepted work remains on the server. */
import { ACTIVE_JOB_STATES } from "../processing/jobs.js";
import { getModelSetupIntegration } from "./model-setup.js";
import { ProcessingRequestError } from "../processing/api.js";
import { createModelDraft, captureModelSubmission, modelSourceKey, modelAreaInput, modelViewportArea, modelResultSources, getModelRasterFields, getModelRasterSources, isModelSpatialInput, modelSupportsDrawnAreas, updateClipPolygonGroup } from "./inputs.js";
import { getTemporalStatistics } from "./temporal-inputs.js";
import { getModelInputHandler, supportsModelInput } from "./input-handlers.js";
import { snapTemporalHour, getTemporalMonthBoundaries } from "../temporal-period.js";

const RECOVERY_KEY = "eolab.models.pending.v1";
const DELETIONS_KEY = "eolab.models.deletions.v1";

/** Compare the filter and calculated fields captured from the same vector view.
 * @param {Object|null|undefined} left Previous view or accepted selection.
 * @param {Object|null|undefined} right Current view or accepted selection.
 * @return {boolean} Whether both use the same predicate and arithmetic definitions.
 */
function vectorAreaInputsEqual(left, right) {
    return JSON.stringify([left?.filter, left?.calculatedFields ?? []]) ===
        JSON.stringify([right?.filter, right?.calculatedFields ?? []]);
}

/** Keep editable model drafts separate from accepted, session-owned runs. */
export class ModelsController {
    /** Connect the Models view to API transport and composed catalog inputs.
     * @param {Object} dependencies Component dependencies.
     * @param {Object} dependencies.api Processing API client.
     * @param {Object} dependencies.jobs Existing shared Processing job observer.
     * @param {Object} dependencies.view Models view.
     * @param {(options?:{includeDrawnPolygons?:boolean})=>Object & {drawnPolygonLayers?:import("./inputs.js").DrawnPolygonLayer[]}} dependencies.getContext Catalog and map choices, with optional detached drawn polygons.
     * @param {(identity:{collectionId:string,itemId:string},signal?:AbortSignal)=>Promise<Object>} dependencies.getCatalogItem Read an exact Catalog Item for input metadata and display titles.
     * @param {import("./model-setup.js").ModelSetupDependencies["showAreaOutline"]} dependencies.showAreaOutline Show a model's chosen polygon through map composition.
     * @param {(item:Object,variable:string,month?:string,signal?:AbortSignal)=>Promise<Object>} dependencies.loadTemporalTimes Read actual observation labels for one month.
     * @param {(source:Object,signal:AbortSignal)=>Promise<Object>} dependencies.prepareVector Read a captured vector predicate and counts.
     * @param {(request:{key:string,host:HTMLElement,source:Object,filter:Object,isCurrent:()=>boolean,apply:(filter:Object)=>Promise<Object|null>,complete:()=>void,cancel:()=>void,close:()=>void})=>Promise<void>|void} dependencies.editVectorFilter Open the composed filter editor inside model setup.
     * @param {()=>void} dependencies.closeVectorFilter Close the composed inline editor.
     * @param {(source:Object,area:Object)=>Promise<Object|null>} dependencies.applyMapFilter Commit checked features to their vector view before updating its rendering; display failure must not block analysis.
     * @param {Storage|null} [dependencies.storage=null] Per-tab submission recovery storage.
     * @param {readonly string[]|null} [dependencies.allowedModelIds=null] Recipe IDs this map
     * offers for new runs. Null offers every installed recipe supported by setup.
     * @param {string} [dependencies.recoveryScope=""] Published map identifier for recovering
     * its selected recipes' unconfirmed submissions in this tab.
     * @param {()=>void} dependencies.onOpen Open the composed Analysis panel.
     * @param {()=>void} dependencies.onClose Hide the panel without cancelling jobs.
     * @param {(label:string)=>void} [dependencies.onViewLabel] Present the current page, selected model or run name in the workspace.
     * @param {(job:Object,file:Object)=>Promise<void>} [dependencies.showOutput] Show one chosen file through composition.
     * @param {(jobId:string,artifactId:string,file:Object)=>Object} [dependencies.outputState] Display-only map capability, inclusion and feedback.
     * @param {(job:Object)=>void} [dependencies.onRunChange] Notify composition of authoritative run availability and expiry.
     * @param {(jobId:string)=>Object[]} [dependencies.captureRunLayers] Capture display state through composition before deletion.
     * @param {(layers:Object[],isCurrent:()=>boolean)=>Promise<void>} [dependencies.restoreRunLayers] Restore captured displays through their existing owners.
     * @param {Object} [dependencies.clock=globalThis] Timeout scheduler for deletion notices.
     * @param {()=>string} [dependencies.newId] Generate draft and request identities.
     * @param {(model:Object)=>import("./model-setup.js").ModelSetupIntegration|null} [dependencies.getSetupIntegration] Resolve the installed setup adapter.
     */
    constructor({api, jobs, view, getContext, getCatalogItem, showAreaOutline, loadTemporalTimes, prepareVector, editVectorFilter, closeVectorFilter, applyMapFilter, storage = null, onOpen, onClose,
        showOutput = async () => {}, outputState = () => ({}), onRunChange = () => {}, onViewLabel = () => {},
        captureRunLayers = () => [], restoreRunLayers = async () => {}, clock = globalThis,
        allowedModelIds = null, recoveryScope = "",
        newId = () => globalThis.crypto.randomUUID().replaceAll("-", ""), getSetupIntegration = getModelSetupIntegration}) {
        Object.assign(this, {api, jobs, view, getContext, prepareVector, editVectorFilter, closeVectorFilter, applyMapFilter, storage, onOpen, onClose, newId});
        Object.assign(this, {getCatalogItem, showAreaOutline, loadTemporalTimes});
        this.getSetupIntegration = getSetupIntegration;
        this.allowedModelIds = allowedModelIds === null ? null : new Set(allowedModelIds);
        this.recoveryScope = recoveryScope;
        this.installedModels = null;
        this.outputState = outputState;
        this.onRunChange = onRunChange;
        this.onViewLabel = onViewLabel;
        Object.assign(this, {captureRunLayers, restoreRunLayers, clock});
        this.deletions = new Map();
        this.state = {page: "library", active: false, library: [], missingModels: false, loading: false, libraryError: "", error: "", query: "", draft: null,
            runs: [], nextCursor: null, historyLoading: false, historyError: "", selectedRun: null, invocation: null, invocationError: "", yaml: null,
            habitatDatasetLabels: null,
            pending: null, submitting: false, actionBusy: false, renamingRun: null, deleteConfirmation: null, actionMessage: ""};
        this.runSnapshots = new Map(); this.revision = 0; this.historyRevision = 0; this.temporalRevision = 0;
        this.vectorSelectionRequests = new Map();
        /** @type {Map<string,string[]>} Uploaded polygon IDs owned by each retry slot in this tab. */
        this.pendingPolygonAreas = new Map();
        this.tracked = new Set(); this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.observeJobs());
        view.bind({onOpen: () => this.open(), onClose, onPage: page => this.navigate(page),
            onQuery: query => { this.state.query = query; this.render(); }, onChoose: model => this.chooseModel(model),
            onEdit: change => this.editDraft(change), onInput: (name, change) => this.editInput(name, change),
            onSetupAction: (action, value) => {
                if (!this.state.draft || this.state.submitting) return;
                this.state.error = ""; return this.setupSession?.action(action, value);
            },
            onArea: (name, mode) => this.chooseArea(name, mode),
            onTemporalDataset: key => void this.chooseTemporalDataset(key),
            onTemporalVariable: variable => void this.chooseTemporalVariable(variable),
            onTemporalMonth: month => void this.loadTemporalDates(month),
            onRefreshTemporal: () => void this.loadTemporalDates(undefined, true),
            onUseTemporalMonth: () => this.useTemporalMonth(),
            onTemporalEdit: change => {
                Object.assign(this.state.draft.temporal, change); this.editDraft({});
            },
            onVector: (name, key) => void this.chooseVector(name, key), onEditFilter: name => void this.openVectorFilter(name),
            onSubmit: () => void this.submit(), onRetry: () => void this.submit(true),
            onRefreshRuns: () => void this.loadRuns(), onMore: () => void this.loadRuns(true), onRun: id => void this.showRun(id),
            onCancel: () => void this.cancelRun(), onDuplicate: () => void this.duplicateRun(), onYaml: () => void this.showYaml(),
            onRename: label => this.renameRun(label),
            onRenew: () => void this.renewRun(), onDelete: () => this.requestRunDeletion(), onConfirmDelete: () => void this.deleteRun(),
            onUndoDelete: id => void this.resolveDeletion(id, true), onDismissDelete: id => void this.resolveDeletion(id, false),
            onKeepRun: () => { this.state.deleteConfirmation = null; this.render(); this.view.focusRunDelete?.(); },
            onShowOutput: artifactId => {
                const job = this.runSnapshots.get(this.state.selectedRun);
                const file = job?.artifacts?.files.find(value => value.artifactId === artifactId);
                if (file) void showOutput(job, file);
            }});
    }

    /** Recover an unconfirmed request without automatically executing it.
     * @return {void}
     */
    start() {
        this.#restorePendingSubmission();
        void this.recoverDeletions();
        this.render();
    }

    /** Return the tab's retry slot for a recipe. Configured maps keep separate slots
     * so a restricted retry cannot block or overwrite another map or model's work.
     * @param {string|null} id Recipe identifier, or null to read the unrestricted slot.
     * @return {string} Session storage key.
     */
    #recoveryKey(id) {
        return this.allowedModelIds === null ? RECOVERY_KEY : `${RECOVERY_KEY}.${this.recoveryScope}.${id}`;
    }

    /** Find the first permitted unconfirmed request in this tab without submitting it.
     * @param {string|null} [finishedKey=null] Ignore the completed request if storage cleanup failed.
     * @return {void}
     */
    #restorePendingSubmission(finishedKey = null) {
        this.state.pending = null;
        for (const id of this.allowedModelIds ?? [null]) {
            const key = this.#recoveryKey(id);
            if (key === finishedKey) continue;
            try {
                const value = JSON.parse(this.storage?.getItem(key) ?? "null");
                if (value && typeof value.requestId === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(value.requestId) &&
                    value.model && value.inputs && value.parameters && (id === null || value.model.id === id)) {
                    this.state.pending = value;
                    return;
                }
            } catch (error) {
                this.state.error = "A saved submission could not be read from this tab. Check Runs before starting it again.";
                // Malformed JSON affects one recipe. A storage access failure affects the tab.
                if (!(error instanceof SyntaxError)) return;
            }
        }
    }

    /** Apply a map's new-run choices before setup, retry or duplication can start work.
     * Close superseded input editors and restore any permitted retry in this tab.
     * @param {readonly string[]|null} ids Allowed recipe identifiers, or null for unrestricted setup.
     * @return {void}
     */
    setAllowedModelIds(ids) {
        this.allowedModelIds = ids === null ? null : new Set(ids);
        this.#restorePendingSubmission();
        this.#updateSetupLibrary();
        this.render();
    }

    /** Check the active map's choice for all installed versions of a recipe.
     * @param {string|undefined} id Recipe identifier, or undefined while run details load.
     * @return {boolean} Whether the map offers this model. A configured map requires a known ID.
     */
    #allowsModel(id) {
        return this.allowedModelIds === null || this.allowedModelIds.has(id);
    }

    /** Return the offered recipe with the exact version and definition used by a setup or run.
     * @param {{id:string,version:string,definitionSha256:string}} recipe Captured model identity.
     * @return {Object|undefined} Matching installed recipe, when available on this map.
     */
    #findSetupVersion(recipe) {
        return this.state.library.find(model => model.id === recipe.id && model.version === recipe.version &&
            model.definitionSha256 === recipe.definitionSha256);
    }

    /** Check a model choice against the map and, once loaded, the current recipe library.
     * @param {{id:string,version:string,definitionSha256:string}} recipe Model chosen for setup.
     * @return {boolean} Whether this version can open or retain an editable setup.
     */
    #canSetUp(recipe) {
        return this.installedModels === null ? this.#allowsModel(recipe.id) : Boolean(this.#findSetupVersion(recipe));
    }

    /** Update the picker after discovery or a map choice changes. Close a superseded
     * draft through normal navigation so its input jobs stop being observed.
     * @return {void}
     */
    #updateSetupLibrary() {
        const installed = this.installedModels ?? [];
        const allowed = this.allowedModelIds;
        const library = allowed === null ? installed : installed.filter(model => allowed.has(model.id));
        this.state.library = library;
        this.state.missingModels = this.installedModels !== null && allowed !== null &&
            new Set(library.map(model => model.id)).size < allowed.size;

        const draft = this.state.draft;
        if (!draft || this.#canSetUp(draft.model)) return;
        this.#discardSetup();
        if (this.state.page !== "setup") return;
        this.state.yaml = null;
        this.navigate("library");
        if (this.#allowsModel(draft.model.id)) {
            this.state.error = `This version of ${draft.model.title} is no longer available. Choose a tool from the library.`;
        }
        if (this.state.active) this.view.focusPage();
    }

    /** Open the retained Models page and refresh its library and history.
     * @return {Promise<void>} Completion of the library and history refresh requested here.
     */
    async open() {
        this.onOpen();
        await Promise.all([this.loadLibrary(), this.loadRuns()]);
    }

    /** Change visibility and refresh a map-linked setup without changing server work.
     * @param {boolean} active Whether Models is the visible Analysis tool.
     * @return {void}
     */
    setActive(active) {
        this.state.active = active;
        if (!active) this.closeVectorFilter();
        if (active) { this.refreshMapLayers(); this.refreshMapArea(); }
        this.#updateRunTracking();
        this.render();
    }

    /** Discover the installed recipe versions that Data tools can set up.
     * Publisher settings use these same choices before applying a map's selection.
     * @return {Promise<Object[]>} Installed recipe documents with supported input types.
     * @throws {Error} If model discovery fails.
     */
    async listSetupModels() {
        return (await this.api.discoverModels()).filter(model =>
            Object.values(model.inputs).every(input => supportsModelInput(input.type)));
    }

    /** Load installed recipes whose inputs this setup form can edit.
     * Other recipes remain available through the API and existing run history.
     * @return {Promise<void>}
     */
    async loadLibrary() {
        if (this.state.loading) return;
        this.state.loading = true; this.state.libraryError = ""; this.render();
        try {
            this.installedModels = await this.listSetupModels();
            this.#updateSetupLibrary();
        }
        catch (error) { this.state.libraryError = `Data tools unavailable: ${error.message}`; }
        finally { this.state.loading = false; this.render(); }
    }

    /** Switch pages and observe the runs used by the newly visible page.
     * @param {string} page Library, setup, runs or run.
     * @return {void}
     */
    navigate(page) {
        if (page === "setup" && !this.state.draft) return;
        if (page !== "setup" && this.state.draft) this.closeVectorFilter();
        this.revision += 1;
        this.state.page = page;
        this.state.error = "";
        this.#updateRunTracking();
        if (page === "setup") this.refreshMapArea();
        this.render();
        if (page === "runs") void this.loadRuns();
    }

    /** Dispose the draft and cancel its input requests before replacing or closing setup.
     * @return {void}
     */
    #discardSetup() {
        this.setupSession?.dispose();
        this.setupSession = null;
        this.closeVectorFilter();
        this.cancelVectorSelections();
        this.temporalAbort?.abort();
        this.temporalRevision += 1;
        this.state.draft = null;
    }

    /** Create a draft with independent manual areas and load model-specific Catalog choices.
     * @param {Object} model Installed recipe chosen by the user.
     * @return {void}
     */
    chooseModel(model) {
        if (!this.#canSetUp(model)) return;
        this.revision += 1;
        this.#discardSetup();
        this.state.draft = createModelDraft(model, this.inputContext(model), this.newId(), this.getSetupIntegration(model));
        this.state.page = "setup"; this.state.error = ""; this.state.yaml = null;
        this.#updateRunTracking();
        this.render(); this.view.focusPage();
        const draft = this.state.draft;
        if (draft.temporal?.datasets.length === 1) void this.chooseTemporalDataset(modelSourceKey(draft.temporal.datasets[0]));
        this.bindModelSetup(draft);
        void this.setupSession?.start();
    }

    /** Stop vector checks when their entire model draft is replaced or destroyed.
     * @return {void}
     */
    cancelVectorSelections() {
        for (const request of this.vectorSelectionRequests.values()) request.abort();
        this.vectorSelectionRequests.clear();
    }

    /** Bind one model-owned setup session using only explicit host capabilities.
     * Draft replacement disposes its predecessor before the new session starts.
     * @param {Object} draft Current editable model draft.
     * @return {void}
     */
    bindModelSetup(draft) {
        const current = () => !this.destroyed && this.state.draft === draft;
        this.setupSession = draft.integration?.createSession(draft, {
            api: this.api, getCatalogItem: this.getCatalogItem, showAreaOutline: this.showAreaOutline,
            render: () => { if (current()) this.render(); },
            closeInputEditor: () => { if (current()) this.closeVectorFilter(); },
        }) ?? null;
    }

    /** Change one named input and notify its model-owned setup session.
     * An explicit raster choice replaces its copied-run provenance.
     * @param {string} name Input name declared by the recipe.
     * @param {Object} change Edited source, area or model-specific choices.
     * @return {void}
     */
    editInput(name, change) {
        if (!this.state.draft || this.state.submitting) return;
        const input = this.state.draft.inputs[name];
        if ("raster" in change) input.copiedFromRun = false;
        Object.assign(input, change);
        this.setupSession?.inputChanged(name, change);
        this.#refreshEditedInputs();
    }

    /** Refresh source choices and status tracking after an input or area mode changes.
     * A pending submission retains its captured sources while the form displays the edit.
     * @return {void}
     */
    #refreshEditedInputs() {
        this.state.error = "";
        this.#updateRunTracking();
        if (this.state.pending) this.render();
        else this.refreshMapLayers();
    }

    /** Update the draft name, parameters or temporal settings and render the edited form.
     * Selecting Precipitation total rounds the visible period to whole UTC hours.
     * @param {Object} change Edited model choices, including the statistic or parameters.
     * @return {void}
     */
    editDraft(change) {
        if (!this.state.draft || this.state.submitting) return;
        Object.assign(this.state.draft, change);
        if (change.reduction?.reducer === "precipitation_total") {
            const temporal = this.state.draft.temporal;
            temporal.startTime = snapTemporalHour(temporal.startTime);
            temporal.endTime = snapTemporalHour(temporal.endTime);
        }
        this.state.error = ""; this.render();
    }

    /** Load a chosen dataset without inheriting the map's displayed variable or date.
     * @param {string} key Dataset choice identity, or empty to clear it.
     * @return {Promise<void>} Completion after Catalog metadata is available or its error is displayed.
     */
    async chooseTemporalDataset(key) {
        const temporal = this.state.draft?.temporal;
        if (!temporal || this.state.submitting) return;
        this.temporalAbort?.abort(); this.temporalRevision += 1;
        Object.assign(temporal, {datasetKey: key, item: null, variable: "", choices: null, loading: false, error: "", datesError: ""});
        this.state.error = ""; this.render();
        if (key) await this.loadTemporalDates(undefined, true);
    }

    /** Choose a variable and its supported statistic, then load date guidance.
     * @param {string} variable Catalog variable identifier from the setup control.
     * @return {Promise<void>} Completion after monthly guidance or a visible discovery error.
     */
    async chooseTemporalVariable(variable) {
        const temporal = this.state.draft?.temporal;
        if (!temporal || this.state.submitting) return;
        Object.assign(temporal, {variable, choices: null, error: "", datesError: ""});
        this.configureTemporalVariable(this.state.draft);
        await this.loadTemporalDates();
    }

    /** Keep the selected statistic or choose Mean when the new variable does not support it.
     * Refreshing guidance and copying a saved run preserve their existing choices instead.
     * @param {Object} draft Current temporal model setup with its chosen variable.
     * @return {void}
     */
    configureTemporalVariable(draft) {
        const temporal = draft.temporal, variable = temporal.item.properties["cube:variables"][temporal.variable];
        const statistics = getTemporalStatistics(variable, temporal);
        if (statistics.length && !statistics.some(choice => choice.value === draft.reduction.reducer))
            draft.reduction.reducer = statistics[0].value;
    }

    /** Read one month's actual dates, optionally reloading the current Catalog metadata.
     * This guidance does not preflight the requested interval or submit a calculation.
     * Refresh preserves the chosen variable and period, including removed choices that
     * need the user's attention. Superseded replies cannot change a later draft.
     * @param {string} [month] UTC month to inspect; omission asks for the latest available month.
     * @param {boolean} [reloadItem=false] Whether to reload Catalog metadata before reading dates.
     * @return {Promise<void>} Completion after the guidance or read error is shown.
     */
    async loadTemporalDates(month, reloadItem = false) {
        const draft = this.state.draft, temporal = draft?.temporal;
        if (!temporal?.datasetKey || this.state.submitting) return;
        const source = temporal.datasets.find(value => modelSourceKey(value) === temporal.datasetKey);
        this.temporalAbort?.abort(); const revision = ++this.temporalRevision;
        const abort = new AbortController(); this.temporalAbort = abort;
        const isCurrent = () => !this.destroyed && this.state.draft === draft && this.temporalRevision === revision;
        temporal.loading = true; temporal.error = ""; temporal.datesError = ""; this.render();
        try {
            if (reloadItem) {
                const item = await this.getCatalogItem(source, abort.signal);
                if (!isCurrent()) return;
                temporal.item = item;
                if (!temporal.variable) {
                    const variables = Object.keys(item.properties["cube:variables"]);
                    if (variables.length === 1) {
                        temporal.variable = variables[0];
                        this.configureTemporalVariable(draft);
                    }
                }
            }
            const variable = temporal.item.properties["cube:variables"][temporal.variable];
            if (!variable) { temporal.choices = null; return; }
            try {
                const choices = await this.loadTemporalTimes(temporal.item, temporal.variable, month, abort.signal);
                if (isCurrent()) temporal.choices = choices;
            } catch (error) {
                if (isCurrent() && !abort.signal.aborted) {
                    temporal.choices = null;
                    temporal.datesError = `Available dates could not be loaded: ${error.message} You can still enter a period.`;
                }
            }
        } catch (error) {
            if (isCurrent()) temporal.error = `Dataset could not be loaded: ${error.message} Refresh to try again.`;
        } finally { if (isCurrent()) { temporal.loading = false; this.render(); } }
    }

    /** Replace the period only after the user explicitly chooses the displayed month.
     * Missing dates within that calendar month remain valid; the calculation uses available observations.
     * @return {void}
     */
    useTemporalMonth() {
        const temporal = this.state.draft?.temporal;
        if (!temporal?.choices || this.state.submitting) return;
        Object.assign(temporal, {periodMode: "month", ...getTemporalMonthBoundaries(temporal.choices.month)});
        this.editDraft({});
    }

    /** Choose a map area, individual layer, polygon group or captured area for one input.
     * @param {string} name Input name declared by the recipe.
     * @param {string} mode Area mode, `drawn:` layer choice or `polygonGroup:` group choice.
     * @return {void}
     */
    chooseArea(name, mode) {
        const draft = this.state.draft; if (!draft || this.state.submitting) return;
        const input = draft.inputs[name];
        if (input.filterEditing) this.closeVectorFilter();
        this.vectorSelectionRequests.get(name)?.abort(); this.vectorSelectionRequests.delete(name); input.selecting = false;
        const drawn = mode.startsWith("drawn:");
        const group = mode.startsWith("polygonGroup:");
        input.areaMode = drawn ? "drawnPolygons" : group ? "polygonGroup" : mode;
        input.drawnPolygonKey = drawn ? mode.slice("drawn:".length) : "";
        input.vectorInfo = null; input.vectorKey = ""; input.selectionError = ""; this.state.error = "";
        if (group) {
            input.polygonGroupId = mode.slice("polygonGroup:".length);
            updateClipPolygonGroup(input);
        } else if (mode === "whole") input.area = {kind: "wholeRaster"};
        else if (mode === "captured") input.area = structuredClone(input.capturedArea);
        else if (["viewport", "samplingArea", "mapPolygons"].includes(mode)) { this.refreshMapArea(); return; }
        else input.area = null;
        this.#refreshEditedInputs();
    }

    /** Refresh a map-linked setup from composition's latest area and viewport.
     * Called after map changes and immediately before Run. Pending submissions,
     * duplicated fixed areas and explicitly selected vector views remain unchanged.
     * @return {void}
     */
    refreshMapArea() {
        const draft = this.state.draft;
        if (!draft || this.destroyed || this.state.page !== "setup" || this.state.submitting || this.state.pending) return;
        const context = this.getContext();
        for (const input of Object.values(draft.inputs)) {
            if (!["viewport", "samplingArea", "mapPolygons"].includes(input.areaMode)) continue;
            input.area = null; input.selectionError = "";
            try {
                if (input.areaMode === "viewport") {
                    input.area = modelViewportArea(context.viewportBounds);
                    input.areaDescription = "Visible map area";
                } else {
                    const kinds = input.areaMode === "samplingArea" ? ["selectedArea", "samplingBox"] : ["polygonArea"];
                    if (!kinds.includes(context.area?.kind)) throw new Error(input.areaMode === "samplingArea"
                        ? "Click the map to choose a sampling box for this analysis."
                        : "Select polygons on the map to choose an area for this analysis.");
                    input.area = modelAreaInput(context.area);
                    input.areaDescription = input.areaMode === "samplingArea" ? "Sampling box" : "Polygons selected on map";
                }
            } catch (error) { input.selectionError = error.message; }
        }
        this.render();
    }

    /** Read a vector view's current filter and show any feature-selection failure in setup.
     * @param {string} name Input name declared by the recipe.
     * @param {string} key Choice-list identity, or empty to clear the choice.
     * @return {Promise<void>}
     */
    async chooseVector(name, key) {
        try { await this.selectVectorFeatures(name, key); }
        catch { /* The selection owner has already put the failure in setup. */ }
    }

    /** Read matching features and commit their predicate only after a successful selection.
     * Failed candidate edits preserve the previous selection while its calculated
     * fields still match. Changed view filters or formulas invalidate the old area
     * until its replacement has been read successfully.
     * @param {string} name Input name declared by the recipe.
     * @param {string} key Map view identity from the vector choice list.
     * @param {Object|null} [filter=null] Candidate edited filter, otherwise the view's current filter.
     * @return {Promise<Object|null>} Reviewed selection, or null for a cleared or superseded request.
     * @throws {Error} If reading or validating the selected features fails.
     */
    async selectVectorFeatures(name, key, filter = null) {
        const draft = this.state.draft;
        if (!draft) return null;
        const input = draft.inputs[name];
        const source = input.vectors.find(value => value.key === key);
        if (input.vectorKey !== key) { if (input.filterEditing) this.closeVectorFilter(); input.mapFilterMessage = ""; }
        this.vectorSelectionRequests.get(name)?.abort(); this.vectorSelectionRequests.delete(name);
        const sameCalculatedFields = JSON.stringify(input.area?.selection?.calculatedFields ?? []) ===
            JSON.stringify(source?.calculatedFields ?? []);
        const previous = input.vectorKey === key &&
            (filter !== null ? sameCalculatedFields : vectorAreaInputsEqual(input.area?.selection, source))
            ? {area: input.area, info: input.vectorInfo} : {area: null, info: null};
        input.vectorKey = source ? key : ""; input.area = source ? previous.area : null; input.vectorInfo = source ? previous.info : null; input.selectionError = "";
        if (!source) { input.selecting = false; this.render(); return null; }
        const abort = new AbortController(); this.vectorSelectionRequests.set(name, abort);
        const isCurrent = () => this.vectorSelectionRequests.get(name) === abort && this.state.draft === draft;
        input.selecting = true; this.render();
        try {
            const area = await this.prepareVector({...structuredClone(source), filter: structuredClone(filter ?? source.filter)}, abort.signal);
            if (!isCurrent()) return null;
            if (abort.signal.aborted) {
                input.area = previous.area; input.vectorInfo = previous.info; return null;
            }
            input.area = modelAreaInput({kind: "catalogSelection", catalogSelection: area.selection});
            input.vectorInfo = {label: source.label, matched: area.matched, total: area.total};
            if (filter !== null) void this.updateMapFilter(source, area, draft, name, abort);
            else input.mapFilterMessage = "";
            return area;
        } catch (error) {
            if (!isCurrent()) return null;
            input.area = previous.area; input.vectorInfo = previous.info;
            if (abort.signal.aborted) return null;
            input.selectionError = `${error.message}${previous.area ? " The previous selection is unchanged." : ""}`;
            throw error;
        } finally { if (isCurrent()) { input.selecting = false; this.render(); } }
    }

    /** Share a checked selection with its vector view and report rendering separately.
     * @param {Object} source Chosen vector view and its Catalog or uploaded source identity.
     * @param {Object} area Checked source predicate and exact feature counts.
     * @param {Object} draft Setup that requested this change.
     * @param {string} name Input whose selected filter changed.
     * @param {AbortController} request Selection request, used to ignore obsolete display feedback.
     * @return {Promise<void>}
     */
    async updateMapFilter(source, area, draft, name, request) {
        const input = draft.inputs[name];
        input.mapFilterMessage = "Updating the map filter…"; this.render();
        let message;
        try {
            const applied = await this.applyMapFilter(structuredClone(source), structuredClone(area));
            if (!applied) this.refreshMapLayers();
            message = applied ? "Filter applied to the map layer." : "The map filter changed before this update finished.";
        } catch (error) { message = `Features selected for this tool. Could not update the map filter: ${error.message}`; }
        if (this.state.draft === draft && this.vectorSelectionRequests.get(name) === request) {
            input.mapFilterMessage = message; this.render();
        }
    }

    /** Open the rule editor inside model setup, using fields already supplied by Map contents.
     * Editing is available while the initial geometry check runs. Applying rules
     * checks the selection, then updates the map separately without submitting a run.
     * @param {string} name Input whose vector filter will be edited.
     * @return {Promise<void>}
     */
    async openVectorFilter(name) {
        const draft = this.state.draft;
        if (!draft) return;
        const input = draft.inputs[name];
        const source = input.vectors.find(value => value.key === input.vectorKey);
        if (!source || input.filterEditing || this.state.submitting) return;
        this.closeVectorFilter();
        const key = input.vectorKey, openingRequest = this.vectorSelectionRequests.get(name);
        const isCurrent = () => !this.destroyed && this.state.draft === draft && this.state.page === "setup" &&
            input.areaMode === "vector" && input.vectorKey === key && !this.state.submitting;
        input.filterOpening = true; input.filterEditing = true; this.state.error = ""; this.render();
        try {
            await this.editVectorFilter({key: `model:${draft.id}:${name}:${key}`, host: this.view.getVectorFilterHost(name), source: structuredClone(source),
                filter: structuredClone(input.area?.selection?.filter ?? source.filter), isCurrent: () => isCurrent() && this.state.active,
                apply: candidate => {
                    if (!isCurrent()) throw new Error("This tool setup changed. Open its filter again.");
                    return this.selectVectorFeatures(name, key, candidate);
                },
                complete: () => { if (isCurrent()) { input.filterEditing = false; this.render(); } },
                cancel: () => {
                    if (!isCurrent()) return;
                    if (this.vectorSelectionRequests.get(name) !== openingRequest) this.vectorSelectionRequests.get(name)?.abort();
                },
                close: () => {
                    if (!isCurrent()) return;
                    if (this.vectorSelectionRequests.get(name) !== openingRequest) this.vectorSelectionRequests.get(name)?.abort();
                    input.filterEditing = false; this.render();
                },
            });
        } catch (error) {
            if (isCurrent()) { input.filterEditing = false; this.state.error = `Could not open the vector filter: ${error.message}`; }
        } finally { input.filterOpening = false; this.render(); }
    }

    /** Combine map inputs with this session's published raster results.
     * Request committed drawn layers for recipes that support them.
     * @param {Object} model Recipe whose input contract controls eligible choices.
     * @return {Object} Existing map context with available completed-run inputs.
     */
    inputContext(model) {
        const context = this.getContext({includeDrawnPolygons: modelSupportsDrawnAreas(model)});
        const acceptsResults = Object.values(model.inputs).some(input => ["raster", "optional_raster", "habitat_references", "habitat_stack", "raster_formula"].includes(input.type));
        const choices = [...(context.rasters ?? []).filter(source => acceptsResults || source.kind !== "runArtifact"),
            ...(acceptsResults ? modelResultSources([...this.runSnapshots.values()]) : [])];
        return {...context, rasters: [...new Map(choices.map(source => [modelSourceKey(source), source])).values()]};
    }

    /** Refresh map choices and recheck live vector inputs when their filter or formulas change.
     * Drawn layer choices read the latest committed shapes matching the layer filter.
     * A live Raster clip group resolves its member views and their current selections.
     * Captured run areas and accepted submissions retain their original filters and formulas.
     * Removed live inputs must be added to the map again or replaced before a new run.
     * @return {void}
     */
    refreshMapLayers() {
        const draft = this.state.draft;
        if (!draft || this.destroyed || this.state.submitting || this.state.pending) return;
        const context = this.inputContext(draft.model);
        draft.drawnPolygonLayers = modelSupportsDrawnAreas(draft.model) ? context.drawnPolygonLayers ?? [] : [];
        if (draft.temporal) {
            draft.temporal.datasets = structuredClone(context.temporalDatasets ?? []);
            if (draft.temporal.datasetKey && !draft.temporal.datasets.some(source => modelSourceKey(source) === draft.temporal.datasetKey)) {
                this.temporalAbort?.abort(); this.temporalRevision += 1;
                Object.assign(draft.temporal, {datasetKey: "", item: null, choices: null, loading: false,
                    error: "Add the temporal dataset to Map contents, or choose another dataset."});
            }
        }
        draft.sources = structuredClone(context.rasters ?? []);
        for (const {state, field, optional} of getModelRasterFields(draft)) {
            const selected = state[field];
            state[field] = draft.sources.find(source => selected && modelSourceKey(source) === modelSourceKey(selected)) ?? null;
            if (!state[field] && selected && (optional || selected.kind === "runArtifact" || selected.kind === "uploadedRaster")) {
                state[field] = {...selected, available: false,
                    label: selected.label ?? (selected.kind === "uploadedRaster" ? "Uploaded raster" : selected.kind === "runArtifact" ? "Raster from original run" : `${selected.collectionId} / ${selected.itemId}`)};
                draft.sources.push(state[field]);
            }
        }
        for (const [name, input] of Object.entries(draft.inputs)) {
            const definition = draft.model.inputs[name], type = definition.type;
            const handler = getModelInputHandler(type);
            if (handler) { handler.refresh(input, definition, context); continue; }
            if (!isModelSpatialInput(type)) continue;
            const previous = input.vectors.find(source => source.key === input.vectorKey);
            input.vectors = structuredClone(context.vectors ?? []);
            if (type === "clip_area") {
                input.polygonGroups = context.polygonGroups ?? [];
                if (input.areaMode === "polygonGroup") updateClipPolygonGroup(input);
            }
            const selected = input.vectors.find(source => source.key === input.vectorKey);
            if (input.vectorKey && !selected) {
                if (input.filterEditing) this.closeVectorFilter();
                this.vectorSelectionRequests.get(name)?.abort(); this.vectorSelectionRequests.delete(name);
                input.vectorKey = ""; input.area = null; input.vectorInfo = null; input.selecting = false;
                input.selectionError = "Add the vector dataset to Map contents, or choose another dataset.";
            } else if (input.areaMode === "vector" && selected &&
                !vectorAreaInputsEqual(previous, selected) &&
                !vectorAreaInputsEqual(input.area?.selection, selected)) {
                void this.chooseVector(name, selected.key);
            }
        }
        this.render();
    }

    /** Start an allowed model or retry its unconfirmed request with the original ID and inputs.
     * Upload drawn polygons only after capturing the whole setup. Release temporary
     * inputs when preparation fails or admission is rejected. Accepted and uncertain
     * requests keep their references for the input store's ordinary lifetime.
     * @param {boolean} [retry=false] Retry the saved immutable request.
     * @return {Promise<void>}
     */
    async submit(retry = false) {
        if (this.state.submitting || this.state.pending && !retry) return;
        const draft = this.state.draft; const revision = this.revision;
        const model = retry ? this.state.pending?.model : draft?.model;
        if (!model || !this.#allowsModel(model.id)) return;
        const recoveryKey = this.#recoveryKey(model.id);
        const uploadedPolygonAreaIds = [];
        this.state.error = "";
        try {
            if (!retry && Object.values(draft.inputs).some(input => input.filterEditing)) throw new Error("Apply or close the filter before running the tool.");
            if (!retry) { this.refreshMapLayers(); this.refreshMapArea(); }
            const submission = retry ? this.state.pending : captureModelSubmission(draft, this.newId());
            if (!submission) return;
            if (!this.storage) throw new Error("Enable session storage to submit a recoverable run.");
            if (!retry) {
                const drawn = Object.entries(submission.inputs).filter(([, value]) => value?.kind === "drawnPolygons");
                if (drawn.length) {
                    this.state.submitting = true; this.render();
                    const references = new Map();
                    for (const [name, layer] of drawn) {
                        let reference = references.get(layer.key);
                        if (!reference) {
                            // Let the reply settle so a superseded setup can release its input.
                            const area = await this.api.uploadPolygonArea(layer.polygons);
                            reference = area.polygonArea;
                            uploadedPolygonAreaIds.push(reference.id);
                            if (this.destroyed || revision !== this.revision || draft !== this.state.draft) return;
                            references.set(layer.key, reference);
                        }
                        submission.inputs[name] = {kind: "polygonArea", reference};
                    }
                }
            }
            const serialized = JSON.stringify(submission);
            if (new TextEncoder().encode(serialized).length > 16384) throw new Error("Tool inputs exceed the 16 KiB submission limit.");
            this.storage.setItem(recoveryKey, serialized);
            if (uploadedPolygonAreaIds.length) this.pendingPolygonAreas.set(recoveryKey, uploadedPolygonAreaIds.splice(0));
            this.state.pending = submission; this.state.submitting = true; this.render();
            const job = await this.api.submitModelRun(submission);
            this.pendingPolygonAreas.delete(recoveryKey);
            this.#finishRecovery(recoveryKey);
            this.rememberRun(job); this.jobs.accept(job);
            if (revision === this.revision) await this.showRun(job.jobId);
        } catch (error) {
            // A definite rejection allows editing. Transport/5xx failures retain
            // the exact request because the server may already have accepted it.
            if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500) {
                this.discardPolygonAreas(this.pendingPolygonAreas.get(recoveryKey) ?? []);
                this.pendingPolygonAreas.delete(recoveryKey);
                this.#finishRecovery(recoveryKey);
            }
            if (revision === this.revision && !this.destroyed)
                this.state.error = error.message;
        } finally {
            this.discardPolygonAreas(uploadedPolygonAreaIds);
            this.state.submitting = false; this.render();
        }
    }

    /** Remove a settled retry and offer the next permitted request, if any.
     * @param {string} key Tab storage slot of the completed or definitely rejected request.
     * @return {void}
     */
    #finishRecovery(key) {
        try { this.storage?.removeItem(key); } catch { /* Retrying the same request ID is idempotent. */ }
        this.#restorePendingSubmission(key);
    }

    /** Release polygon uploads made by this tab after an abandoned or rejected submission.
     * The ordinary input expiry also removes references when a release cannot reach the server.
     * @param {string[]} ids Private input IDs created by this controller.
     * @return {void}
     */
    discardPolygonAreas(ids) {
        for (const id of ids) void this.api.discardPolygonArea(id).catch(() => {});
    }

    /** Observe active jobs and the runs shown in the current detail or setup form.
     * A status response updates one job. A view or input change reconciles previously
     * tracked jobs with the new selection and reschedules the shared observer.
     * @param {string|null} [changedJobId=null] Run whose status just arrived, or null after a UI change.
     * @return {void}
     */
    #updateRunTracking(changedJobId = null) {
        const {active, page, draft, selectedRun} = this.state;
        const visibleRunIds = new Set();
        if (active && page === "run" && selectedRun) visibleRunIds.add(selectedRun);
        if (active && page === "setup" && draft) {
            for (const {jobId: id} of getModelRasterSources(draft)) {
                if (this.runSnapshots.has(id)) visibleRunIds.add(id);
            }
        }
        const affectedIds = changedJobId === null ? new Set([...this.tracked, ...visibleRunIds]) : [changedJobId];
        for (const id of affectedIds) {
            if (visibleRunIds.has(id) || ACTIVE_JOB_STATES.has(this.runSnapshots.get(id)?.status)) {
                this.jobs.tracked.add(id); this.tracked.add(id);
            } else {
                this.jobs.tracked.delete(id); this.tracked.delete(id);
            }
        }
        if (changedJobId === null) this.jobs.schedule();
    }

    /** Retain an authoritative run, notify map output consumers and order the visible history.
     * @param {Object} job Authoritative run status.
     * @return {void}
     */
    rememberRun(job) {
        if (job.operation !== "model.run.v1") return;
        const previous = this.runSnapshots.get(job.jobId);
        if (previous && (previous.updatedAt > job.updatedAt || previous.status === "deleted" && job.status !== "deleted" && previous.updatedAt === job.updatedAt)) return;
        this.runSnapshots.set(job.jobId, job);
        this.rememberDeletion(job);
        this.onRunChange(job);
        if (job.status === "deleted" && this.state.selectedRun === job.jobId) {
            this.revision += 1;
            this.state.selectedRun = null; this.state.invocation = null; this.state.invocationError = "";
            this.state.yaml = null; this.state.deleteConfirmation = null;
            if (this.state.page === "run") { this.state.page = "runs"; this.view.focusPage("runs"); }
        }
        this.#updateRunTracking(job.jobId);
        this.state.runs = [...this.runSnapshots.values()].filter(value => value.status !== "deleted")
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
    }

    /** Apply observed progress without editing the current setup.
     * @return {void}
     */
    observeJobs() {
        for (const job of this.jobs.jobs) if (job.operation === "model.run.v1") this.rememberRun(job);
        this.refreshMapLayers();
        this.state.observationError = this.jobs.error; this.render();
    }

    /** Load recoverable run history with explicit pagination.
     * @param {boolean} [more=false] Append the next page instead of refreshing the first.
     * @return {Promise<void>}
     */
    async loadRuns(more = false) {
        if (this.state.historyLoading) return;
        const revision = ++this.historyRevision;
        this.state.historyLoading = true; this.state.historyError = ""; this.render();
        try {
            const page = await this.api.listModelRuns(more ? this.state.nextCursor : null);
            if (revision !== this.historyRevision || this.destroyed) return;
            for (const job of page.jobs) {
                const current = this.runSnapshots.get(job.jobId);
                if (!current || current.updatedAt <= job.updatedAt) this.rememberRun(job);
            }
            this.state.nextCursor = page.nextCursor; this.jobs.schedule();
        } catch (error) { this.state.historyError = `Data tool runs unavailable: ${error.message}`; }
        finally { this.state.historyLoading = false; this.refreshMapLayers(); this.render(); }
    }

    /** Open one run and read its saved setup, discarding late navigation replies.
     * @param {string} id Model run identity.
     * @return {Promise<void>}
     */
    async showRun(id) {
        if (this.runSnapshots.get(id)?.status === "deleted") { this.navigate("runs"); return; }
        this.closeVectorFilter();
        const revision = ++this.revision;
        const previous = this.state.selectedRun;
        if (previous && !ACTIVE_JOB_STATES.has(this.runSnapshots.get(previous)?.status)) {
            this.jobs.tracked.delete(previous); this.tracked.delete(previous);
        }
        this.state.selectedRun = id; this.state.page = "run"; this.state.invocation = null; this.state.invocationError = "";
        this.state.deleteConfirmation = null; this.state.actionMessage = "";
        this.state.error = ""; this.state.yaml = null; this.jobs.tracked.add(id); this.tracked.add(id); this.jobs.schedule();
        this.render(); this.view.focusPage();
        try {
            const [job, invocation] = await Promise.all([this.api.getJob(id), this.api.readModelInvocation(id).catch(error => ({readError: error.message}))]);
            if (revision !== this.revision || this.destroyed) return;
            this.rememberRun(job);
            if (this.runSnapshots.get(id)?.status === "deleted") this.state.invocation = null;
            else if (invocation.readError) this.state.invocationError = invocation.readError;
            else this.state.invocation = invocation;
        } catch (error) { if (revision === this.revision) this.state.invocationError = `This run is unavailable: ${error.message}`; }
        this.render();
        void this.loadRunDatasetLabels(revision);
    }

    /** Add optional display names after the saved run's exact inputs are visible.
     * Successful labels are reused for this controller's lifetime; they never
     * determine a historical run's membership. Failed reads leave saved IDs visible.
     * @param {number} revision Navigation revision that opened the run.
     * @return {Promise<void>} Completion after current labels render or an obsolete/failed read is ignored.
     */
    async loadRunDatasetLabels(revision) {
        const invocation = this.state.invocation;
        if (revision !== this.revision || this.destroyed || !invocation || this.state.habitatDatasetLabels !== null) return;
        const usesEarthEngine = Object.entries(invocation.model.definition.inputs).some(([name, input]) =>
            input.type === "habitat_stack" && invocation.inputs[name].kind === "earthEngine");
        if (!usesEarthEngine) return;
        try {
            const options = await this.api.getHabitatEarthEngineOptions();
            if (revision !== this.revision || this.destroyed) return;
            this.state.habitatDatasetLabels = new Map(options.datasets.map(dataset => [dataset.id, dataset.label]));
            this.render();
        } catch {
            // Display names are optional; the saved dataset IDs already identify the inputs.
        }
    }

    /** Cancel only the run whose Cancel button the user selected.
     * @return {Promise<void>}
     */
    async cancelRun() {
        const id = this.state.selectedRun; if (!id || this.state.actionBusy) return;
        this.state.actionBusy = true; this.render();
        try { const job = await this.jobs.action(id, "cancel"); if (job) this.rememberRun(job); }
        catch (error) { this.state.error = `Cancellation could not be confirmed: ${error.message}`; }
        finally { this.state.actionBusy = false; this.render(); }
    }

    /** Ask for confirmation before deleting the selected run and every output.
     * @return {void}
     */
    requestRunDeletion() {
        const job = this.runSnapshots.get(this.state.selectedRun);
        if (!job || this.state.actionBusy || ACTIVE_JOB_STATES.has(job.status) || job.status === "deleted") return;
        this.state.deleteConfirmation = job.jobId; this.state.actionMessage = ""; this.render();
        this.view.focusDeleteConfirmation?.();
    }

    /** Renew the selected run without changing another run if navigation changes.
     * @return {Promise<void>} Completion after renewal or visible failure.
     */
    async renewRun() {
        const id = this.state.selectedRun;
        if (!id || this.state.actionBusy) return;
        this.state.actionBusy = true; this.state.actionMessage = ""; this.state.error = ""; this.render();
        try {
            const job = await this.api.renewModelRun(id);
            this.jobs.accept(job); this.rememberRun(job); this.refreshMapLayers();
            if (this.state.selectedRun === id) this.state.actionMessage = `Results kept until ${new Date(job.expiresAt).toLocaleString()}.`;
        } catch (error) { this.state.error = `Could not extend this run: ${error.message}`; }
        finally { this.state.actionBusy = false; this.render(); }
    }

    /** Rename the selected run and refresh its existing output labels through composition.
     * @param {string} label New user-entered name without the creation timestamp.
     * @return {Promise<boolean>} Whether renaming succeeded, allowing the view to close its editor.
     */
    async renameRun(label) {
        const id = this.state.selectedRun;
        if (!id || this.state.actionBusy) return false;
        this.state.actionBusy = true; this.state.renamingRun = id; this.state.actionMessage = ""; this.state.error = ""; this.render();
        try {
            if (!label.trim() || [...label.trim()].length > 80) throw new Error("Name this run using 1–80 characters.");
            const job = await this.api.renameModelRun(id, label.trim());
            this.jobs.accept(job); this.rememberRun(job); this.refreshMapLayers();
            if (this.state.selectedRun === id) {
                const current = this.runSnapshots.get(id);
                if (this.state.invocation) this.state.invocation = {...this.state.invocation, label: current.name};
                this.state.actionMessage = "Run renamed.";
            }
            return true;
        } catch (error) {
            if (this.state.selectedRun === id) this.state.error = `Could not rename this run: ${error.message}`;
            return false;
        } finally { this.state.actionBusy = false; this.state.renamingRun = null; this.render(); }
    }

    /** Delete the confirmed run and offer server-backed Undo for thirty seconds.
     * @return {Promise<void>} Completion after deletion or visible failure.
     */
    async deleteRun() {
        const id = this.state.deleteConfirmation;
        if (!id || id !== this.state.selectedRun || this.state.actionBusy) return;
        this.state.actionBusy = true; this.state.error = ""; this.render();
        try {
            const layers = this.captureRunLayers(id);
            const job = await this.api.deleteModelRun(id);
            this.jobs.accept(job); this.rememberRun(job);
            const notice = this.deletions.get(id);
            if (notice) notice.layers = layers;
            this.refreshMapLayers();
        } catch (error) { this.state.error = `Deletion could not be confirmed: ${error.message}`; }
        finally { this.state.actionBusy = false; this.render(); }
    }

    /** Keep one Undo notice per deletion, using only the server's original deadline.
     * @param {Object} job Authoritative model run, possibly deleted.
     * @return {void}
     */
    rememberDeletion(job) {
        const offer = job.status === "deleted" ? job.deletionUndo : null;
        if (offer && Date.parse(offer.expiresAt) > Date.now()) {
            const previous = this.deletions.get(job.jobId);
            if (previous?.deletionId !== offer.deletionId) this.deletions.set(job.jobId,
                {jobId: job.jobId, label: job.label, ...offer, busy: false, layers: []});
        } else this.deletions.delete(job.jobId);
        this.scheduleDeletions();
    }

    /** Remove expired notices and save only identities needed to recover offers after reload.
     * Server cleanup owns the deadline; browser timers never extend file lifetime.
     * @return {void}
     */
    scheduleDeletions() {
        this.clock.clearTimeout(this.deletionTimer);
        for (const [id, notice] of this.deletions) {
            if (Date.parse(notice.expiresAt) <= Date.now()) this.deletions.delete(id);
        }
        try {
            if (this.deletions.size) this.storage?.setItem(DELETIONS_KEY, JSON.stringify([...this.deletions.values()]
                .map(({jobId, expiresAt}) => ({jobId, expiresAt}))));
            else this.storage?.removeItem(DELETIONS_KEY);
        } catch { /* The current notice still works when tab storage is unavailable. */ }
        if (this.deletions.size && !this.destroyed) this.deletionTimer = this.clock.setTimeout(() => {
            this.scheduleDeletions(); this.render();
        }, Math.max(1, Math.min(...[...this.deletions.values()].map(value => Date.parse(value.expiresAt))) - Date.now()));
    }

    /** Recover unexpired Undo offers from the server after this tab reloads.
     * Saved identifiers do not grant access; the normal session check still applies.
     * @return {Promise<void>} Completion after recovery or a visible retry message.
     */
    async recoverDeletions() {
        try {
            const saved = JSON.parse(this.storage?.getItem(DELETIONS_KEY) ?? "[]");
            if (!Array.isArray(saved)) return;
            const ids = saved.filter(value => /^[A-Za-z0-9_-]{16,80}$/.test(value?.jobId) && Date.parse(value.expiresAt) > Date.now())
                .map(value => value.jobId);
            for (let offset = 0; offset < ids.length; offset += 100) {
                const result = await this.api.readJobStatuses(ids.slice(offset, offset + 100));
                if (this.destroyed) return;
                for (const job of result.jobs) this.rememberRun(job);
            }
            this.scheduleDeletions();
        } catch { this.state.error = "Could not recover deletion Undo. Reload to retry before its 30 seconds end."; }
        this.render();
    }

    /** Undo or dismiss one exact deletion without changing another run or its expiry.
     * @param {string} id Run identified by the notice.
     * @param {boolean} restore Whether to restore instead of dismissing Undo.
     * @return {Promise<void>} Completion after the server action and optional display restoration.
     */
    async resolveDeletion(id, restore) {
        const notice = this.deletions.get(id);
        if (!notice || notice.busy) return;
        notice.busy = true; this.state.error = ""; this.render();
        try {
            const job = restore ? await this.api.undoModelDeletion(id, notice.deletionId)
                : await this.api.dismissModelDeletion(id, notice.deletionId);
            this.jobs.accept(job); this.rememberRun(job); this.refreshMapLayers();
            const isCurrent = () => !this.destroyed && this.runSnapshots.get(id)?.status === "ready" &&
                this.runSnapshots.get(id)?.updatedAt === job.updatedAt;
            if (restore && isCurrent()) {
                try { await this.restoreRunLayers(notice.layers, isCurrent); }
                catch (error) { this.state.error = `Run restored. Some map items could not be restored: ${error.message} Open the run to show them again.`; }
            }
        } catch (error) { this.state.error = `${restore ? "Could not undo deletion" : "Could not dismiss Undo"}: ${error.message}`; }
        finally { notice.busy = false; this.scheduleDeletions(); this.render(); }
    }

    /** Copy a permitted run's inputs into editable setup, including dataset and polygon choices.
     * The map must offer the recipe ID and its exact version and checksum must be installed.
     * Choosing a vector view explicitly
     * switches a captured area to that view's current filter. Registered setup
     * integrations restore their own values before asynchronous choices reload.
     * @return {Promise<void>} Completion after the copied setup loads its current source choices.
     */
    async duplicateRun() {
        const saved = this.state.invocation;
        if (!saved || this.state.loading || this.state.libraryError || !this.#allowsModel(saved.model.id)) return;
        const model = this.#findSetupVersion(saved.model);
        if (!model) { this.state.error = "This tool version is not available in setup. Its YAML remains available until metadata expires."; this.render(); return; }
        this.revision += 1;
        this.#discardSetup();
        const draft = createModelDraft(model, this.inputContext(model), this.newId(), this.getSetupIntegration(model));
        this.state.draft = draft; this.state.page = "setup"; this.state.error = ""; this.state.yaml = null;
        draft.label = this.runSnapshots.get(this.state.selectedRun)?.name ?? saved.label; draft.parameters = structuredClone(saved.parameters);
        for (const [name, definition] of Object.entries(model.inputs)) {
            const input = draft.inputs[name];
            const handler = getModelInputHandler(definition.type);
            if (draft.integration?.restoreInput(draft, name, saved.inputs[name])) continue;
            if (handler) handler.restore(input, saved.inputs[name], definition);
            else if (["raster", "catalog_raster", "optional_raster"].includes(definition.type)) {
                input.raster = structuredClone(saved.inputs[name]);
                input.copiedFromRun = true;
            } else if (definition.type === "temporal_interval") {
                const value = saved.inputs[name];
                Object.assign(draft.temporal, {datasetKey: modelSourceKey(value), variable: value.variable,
                    periodMode: "times", startTime: new Date(value.startTime).toISOString().slice(0, -1), endTime: new Date(value.endTime).toISOString().slice(0, -1)});
            } else if (definition.type === "temporal_reduction") {
                draft.reduction = {...draft.reduction, ...saved.inputs[name]};
            } else if (definition.type === "area_statistic") {
                draft.reduction.reducer = saved.inputs[name];
            } else if (definition.type === "mask_source" && saved.inputs[name].kind === "catalogRaster" ||
                definition.type === "habitat_references" && saved.inputs[name].kind === "raster") {
                input.area = null; input.areaMode = "raster";
                input.maskRaster = structuredClone(saved.inputs[name].source);
            } else if (isModelSpatialInput(definition.type)) {
                const value = saved.inputs[name];
                input.area = definition.type === "habitat_references" && value.kind === "vector"
                    ? {kind: "catalogSelection", selection: structuredClone(value.selection)} : structuredClone(value);
                input.capturedArea = structuredClone(input.area); input.areaMode = input.area.kind === "wholeRaster" ? "whole" : "captured"; input.areaOrigin = "run";
                input.areaDescription = input.area.kind === "polygonArea" ? "Exact polygons from the original run." : "Exact area and filter copied from the original run.";
            }
        }
        draft.integration?.restoreState(draft, saved.inputs);
        this.#updateRunTracking();
        this.refreshMapLayers();
        this.render(); this.view.focusPage();
        this.bindModelSetup(draft);
        await this.setupSession?.start();
        if (draft.temporal?.datasetKey) await this.loadTemporalDates(undefined, true);
    }

    /** Show the reusable YAML for the current draft or accepted run.
     * @return {Promise<void>}
     */
    async showYaml() {
        const revision = this.revision;
        const run = this.state.page === "run" ? this.runSnapshots.get(this.state.selectedRun) : null;
        const model = run?.model ?? this.state.draft?.model; if (!model) return;
        try { const yaml = await this.api.readModelYaml(model, run?.jobId ?? null); if (revision === this.revision) this.state.yaml = yaml; }
        catch (error) { if (revision === this.revision) this.state.error = error.message; }
        this.render();
    }

    /** Present the map's allowed setup recipes alongside the browser's session-owned runs.
     * @return {void}
     */
    render() {
        if (this.destroyed) return;
        const job = this.runSnapshots.get(this.state.selectedRun);
        this.onViewLabel({
            library: "Choose a tool", setup: this.state.draft?.model.title ?? "Setup",
            runs: "Runs", run: job?.label ?? "Data tool run",
        }[this.state.page]);
        this.view.render({...this.state, noModelsSelected: this.allowedModelIds?.size === 0,
            duplicateRestricted: !this.#allowsModel(this.state.invocation?.model.id ?? job?.model.id),
            deletions: [...this.deletions.values()], outputPreviews: Object.fromEntries((job?.artifacts?.files ?? [])
            .map(file => [file.artifactId, this.outputState(job.jobId, file.artifactId, file)]))});
    }

    /** Release UI observation only; accepted jobs continue until explicit cancellation.
     * @return {void}
     */
    destroy() {
        this.setupSession?.dispose();
        this.closeVectorFilter();
        this.destroyed = true; this.revision += 1; this.cancelVectorSelections();
        this.temporalAbort?.abort(); this.temporalRevision += 1;
        this.clock.clearTimeout(this.deletionTimer);
        this.unsubscribe(); for (const id of this.tracked) this.jobs.tracked.delete(id); this.view.destroy();
    }
}
