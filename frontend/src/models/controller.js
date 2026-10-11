/** Own model setup and run navigation while accepted work remains on the server. */
import { ACTIVE_JOB_STATES } from "../processing/jobs.js";
import { ProcessingRequestError } from "../processing/api.js";
import { createModelDraft, captureModelSubmission, modelSourceKey, modelAreaInput, modelViewportArea, modelResultSources, modelHasInput } from "./inputs.js";
import { hydrologyKey, hydrologyReference } from "../processing/hydrology.js";

const RECOVERY_KEY = "eolab.models.pending.v1";

/** Keep editable model drafts separate from accepted, session-owned runs. */
export class ModelsController {
    /** Connect the Models view to API transport and composed catalog inputs.
     * @param {Object} dependencies Component dependencies.
     * @param {Object} dependencies.api Processing API client.
     * @param {Object} dependencies.jobs Existing shared Processing job observer.
     * @param {Object} dependencies.view Models view.
     * @param {()=>Object} dependencies.getContext Catalog/map suggestions and plain viewport bounds, independent of rendering.
     * @param {(source:Object,signal:AbortSignal)=>Promise<Object>} dependencies.prepareVector Read a captured vector predicate and counts.
     * @param {(request:{key:string,host:HTMLElement,source:Object,filter:Object,isCurrent:()=>boolean,apply:(filter:Object)=>Promise<Object|null>,complete:()=>void,cancel:()=>void,close:()=>void})=>Promise<void>|void} dependencies.editVectorFilter Open the composed filter editor inside model setup.
     * @param {()=>void} dependencies.closeVectorFilter Close the composed inline editor.
     * @param {(source:Object,filter:Object)=>Promise<Object|null>} dependencies.applyMapFilter Apply the selected rules to the map layer; failure must not block analysis.
     * @param {Storage|null} [dependencies.storage=null] Per-tab submission recovery storage.
     * @param {()=>void} dependencies.onOpen Open the composed Analysis panel.
     * @param {()=>void} dependencies.onClose Hide the panel without cancelling jobs.
     * @param {(job:Object,file:Object)=>Promise<void>} [dependencies.showOutput] Show one chosen file through composition.
     * @param {(jobId:string,artifactId:string,file:Object)=>Object} [dependencies.outputState] Display-only map capability, inclusion and feedback.
     * @param {()=>string} [dependencies.newId] Generate draft and request identities.
     */
    constructor({api, jobs, view, getContext, prepareVector, editVectorFilter, closeVectorFilter, applyMapFilter, storage = null, onOpen, onClose,
        showOutput = async () => {}, outputState = () => ({}),
        newId = () => globalThis.crypto.randomUUID().replaceAll("-", "")}) {
        Object.assign(this, {api, jobs, view, getContext, prepareVector, editVectorFilter, closeVectorFilter, applyMapFilter, storage, onOpen, onClose, newId});
        this.outputState = outputState;
        this.state = {page: "library", active: false, library: [], loading: false, error: "", query: "", draft: null,
            runs: [], nextCursor: null, historyLoading: false, selectedRun: null, invocation: null, invocationError: "", yaml: null,
            pending: null, submitting: false, actionBusy: false};
        this.runSnapshots = new Map(); this.revision = 0; this.historyRevision = 0; this.selectionRevision = 0;
        this.tracked = new Set(); this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.observeJobs());
        view.bind({onOpen: () => this.open(), onClose, onPage: page => this.navigate(page),
            onQuery: query => { this.state.query = query; this.render(); }, onChoose: model => this.chooseModel(model),
            onEdit: change => this.editDraft(change), onArea: mode => this.chooseArea(mode),
            onVector: key => void this.chooseVector(key), onEditFilter: () => void this.openVectorFilter(),
            onHydrology: key => void this.chooseHydrology(key), onRefreshHydrology: () => void this.loadHydrology(),
            onSubmit: () => void this.submit(), onRetry: () => void this.submit(true), onRefresh: () => void this.loadLibrary(),
            onRefreshRuns: () => void this.loadRuns(), onMore: () => void this.loadRuns(true), onRun: id => void this.showRun(id),
            onCancel: () => void this.cancelRun(), onDuplicate: () => void this.duplicateRun(), onYaml: () => void this.showYaml(),
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
        try {
            const value = JSON.parse(this.storage?.getItem(RECOVERY_KEY) ?? "null");
            if (value && typeof value.requestId === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(value.requestId) && value.model && value.inputs && value.parameters) {
                this.state.pending = value;
                this.state.error = "A previous submission needs recovery. Retry with its original inputs to find or create the same run.";
            }
        } catch { this.state.error = "The previous submission could not be read from this tab's storage."; }
        this.render();
    }

    /** Open the retained Models page and refresh its library and history.
     * @return {void}
     */
    open() { this.onOpen(); void this.loadLibrary(); void this.loadRuns(); }

    /** Change visibility and refresh a map-linked setup without changing server work.
     * @param {boolean} active Whether Models is the visible Analysis tool.
     * @return {void}
     */
    setActive(active) {
        this.state.active = active;
        if (!active) this.closeVectorFilter();
        if (active) { this.refreshMapLayers(); this.refreshMapArea(); }
        for (const job of this.runSnapshots.values()) this.rememberRun(job);
        this.jobs.schedule(); this.render();
    }

    /** Read installed recipes without letting an old response replace a newer load.
     * @return {Promise<void>}
     */
    async loadLibrary() {
        if (this.state.loading) return;
        this.state.loading = true; this.render();
        try { this.state.library = await this.api.discoverModels(); }
        catch (error) { this.state.error = `Model library unavailable: ${error.message}`; }
        finally { this.state.loading = false; this.render(); }
    }

    /** Switch pages without discarding setup or cancelling accepted work.
     * @param {string} page Library, setup, runs or run.
     * @return {void}
     */
    navigate(page) { if (page !== "setup") this.closeVectorFilter(); this.revision += 1; this.state.page = page; this.state.error = ""; if (page === "setup") this.refreshMapArea(); this.render(); if (page === "runs") void this.loadRuns(); }

    /** Create a fresh draft from the current source suggestions.
     * @param {Object} model Installed recipe chosen by the user.
     * @return {void}
     */
    chooseModel(model) {
        this.closeVectorFilter();
        this.hydrologyAbort?.abort();
        this.selectionAbort?.abort(); this.selectionRevision += 1; this.revision += 1;
        this.state.draft = createModelDraft(model, this.inputContext(model), this.newId());
        this.state.page = "setup"; this.state.error = ""; this.state.yaml = null; this.render(); this.view.focusHeading();
        const draft = this.state.draft;
        if (modelHasInput(model, "prepared_hydrology")) void this.loadHydrology();
        if (draft.area?.kind === "catalogSelection") {
            const selection = draft.area.selection;
            const source = {collectionId: selection.collectionId, itemId: selection.itemId, label: selection.layerName, filter: selection.filter};
            draft.areaMode = "vector";
            if (draft.vectors.some(value => modelSourceKey(value) === modelSourceKey(source))) void this.chooseVector(modelSourceKey(source));
            else { draft.area = null; draft.selectionError = "Choose a vector layer from Map layers."; this.render(); }
        }
    }

    /** Update draft fields without changing a pending or accepted submission.
     * @param {Object} change Edited label, values raster, starting raster or parameters.
     * @return {void}
     */
    editDraft(change) {
        if (!this.state.draft || this.state.submitting) return;
        if (Object.hasOwn(change, "raster")) this.state.draft.rasterChosen = true;
        Object.assign(this.state.draft, change);
        this.refreshMapLayers();
        for (const job of this.runSnapshots.values()) this.rememberRun(job);
        this.jobs.schedule();
        this.state.error = ""; this.render();
    }

    /** Choose whether setup uses the live map area, vector features or a fixed area.
     * @param {string} mode Whole raster, viewport, samplingArea, mapPolygons, vector, starting raster or captured run area.
     * @return {void}
     */
    chooseArea(mode) {
        const draft = this.state.draft; if (!draft || this.state.submitting) return;
        this.closeVectorFilter();
        this.selectionAbort?.abort(); this.selectionRevision += 1; draft.selecting = false;
        draft.areaMode = mode; draft.vectorInfo = null; draft.vectorKey = ""; draft.selectionError = ""; this.state.error = "";
        draft.maskChosen = true;
        if (mode === "whole") draft.area = {kind: "wholeRaster"};
        else if (mode === "captured") draft.area = structuredClone(draft.capturedArea);
        else if (["viewport", "samplingArea", "mapPolygons"].includes(mode)) { this.refreshMapArea(); return; }
        else draft.area = null;
        this.render();
    }

    /** Refresh a map-linked setup from composition's latest area and viewport.
     * Called after map changes and immediately before Run. Pending submissions,
     * duplicated fixed areas and model-specific vector filters remain unchanged.
     * @return {void}
     */
    refreshMapArea() {
        const draft = this.state.draft;
        if (!draft || this.destroyed || this.state.page !== "setup" || this.state.submitting || this.state.pending ||
            !["viewport", "samplingArea", "mapPolygons"].includes(draft.areaMode)) return;
        const context = this.getContext();
        draft.area = null; draft.selectionError = "";
        try {
            if (draft.areaMode === "viewport") {
                draft.area = modelViewportArea(context.viewportBounds);
                draft.areaDescription = "Visible map area";
            } else {
                const kind = draft.areaMode === "samplingArea" ? "selectedArea" : "polygonArea";
                if (context.area?.kind !== kind) throw new Error(draft.areaMode === "samplingArea"
                    ? "Click the map to choose a sampling area for this analysis."
                    : "Select polygons on the map to choose an area for this analysis.");
                draft.area = modelAreaInput(context.area);
                draft.areaDescription = draft.areaMode === "samplingArea" ? "Sampling area" : "Polygons selected on map";
            }
        } catch (error) { draft.selectionError = error.message; }
        this.render();
    }

    /** Select a vector's draft filter and show any feature-selection failure in setup.
     * @param {string} key Choice-list identity, or empty to clear the choice.
     * @param {string} [reason=""] Explanation for an automatic starting-vector suggestion.
     * @return {Promise<void>}
     */
    async chooseVector(key, reason = "") {
        if (this.state.draft) { this.state.draft.maskChosen = true; this.state.draft.maskSuggestion = reason; }
        try { await this.selectVectorFeatures(key); }
        catch { /* The selection owner has already put the failure in setup. */ }
    }

    /** Read matching features and commit their predicate only after a successful selection.
     * Failed filter edits preserve the previous selection for the same vector.
     * @param {string} key Catalog choice-list identity.
     * @param {Object|null} [filter=null] Explicit edited filter, otherwise this draft's saved filter.
     * @return {Promise<Object|null>} Reviewed selection, or null for a cleared or superseded request.
     * @throws {Error} If reading or validating the selected features fails.
     */
    async selectVectorFeatures(key, filter = null) {
        const draft = this.state.draft;
        const source = draft?.vectors.find(value => modelSourceKey(value) === key);
        if (draft?.vectorKey !== key) { this.closeVectorFilter(); if (draft) draft.mapFilterMessage = ""; }
        this.selectionAbort?.abort(); const revision = ++this.selectionRevision;
        if (!draft) return null;
        const previous = draft.vectorKey === key ? {area: draft.area, info: draft.vectorInfo} : {area: null, info: null};
        draft.vectorKey = source ? key : ""; draft.area = source ? previous.area : null; draft.vectorInfo = source ? previous.info : null; draft.selectionError = "";
        if (!source) { draft.selecting = false; this.render(); return null; }
        const abort = new AbortController(); this.selectionAbort = abort;
        draft.selecting = true; this.render();
        try {
            const area = await this.prepareVector({...structuredClone(source), filter: structuredClone(filter ?? source.filter)}, abort.signal);
            if (revision !== this.selectionRevision || this.state.draft !== draft) return null;
            if (abort.signal.aborted) {
                draft.area = previous.area; draft.vectorInfo = previous.info; return null;
            }
            draft.area = modelAreaInput({kind: "catalogSelection", catalogSelection: area.selection});
            draft.vectorInfo = {label: source.label, matched: area.matched, total: area.total, bbox: area.bbox};
            draft.vectors = draft.vectors.map(value => modelSourceKey(value) === key ? {...value, filter: structuredClone(area.selection.filter)} : value);
            if (filter !== null) void this.updateMapFilter(source, area.selection.filter, draft, revision);
            else draft.mapFilterMessage = "";
            return area;
        } catch (error) {
            if (revision !== this.selectionRevision || this.state.draft !== draft) return null;
            draft.area = previous.area; draft.vectorInfo = previous.info;
            if (abort.signal.aborted) return null;
            draft.selectionError = `${error.message}${previous.area ? " The previous selection is unchanged." : ""}`;
            throw error;
        } finally { if (revision === this.selectionRevision) { draft.selecting = false; this.render(); } }
    }

    /** Apply a reviewed model filter to its map layer without gating analysis on rendering.
     * @param {Object} source Catalog identity of the chosen map layer.
     * @param {Object} filter Successfully checked attribute rules.
     * @param {Object} draft Setup that requested this change.
     * @param {number} revision Selection revision, used to ignore obsolete display feedback.
     * @return {Promise<void>}
     */
    async updateMapFilter(source, filter, draft, revision) {
        draft.mapFilterMessage = "Updating the map filter…"; this.render();
        let message;
        try {
            const applied = await this.applyMapFilter(structuredClone(source), structuredClone(filter));
            message = applied ? "Filter applied to the map layer." : "The map filter changed before this update finished.";
        } catch (error) { message = `Features selected for this model. Could not update the map filter: ${error.message}`; }
        if (this.state.draft === draft && this.selectionRevision === revision) {
            draft.mapFilterMessage = message; this.render();
        }
    }

    /** Open the rule editor inside model setup, using fields already supplied by Map layers.
     * Editing is available while the initial geometry check runs. Applying rules
     * checks the selection, then updates the map separately without submitting a run.
     * @return {Promise<void>}
     */
    async openVectorFilter() {
        const draft = this.state.draft;
        const source = draft?.vectors.find(value => modelSourceKey(value) === draft.vectorKey);
        if (!source || draft.filterEditing || this.state.submitting) return;
        const key = draft.vectorKey, openingRevision = this.selectionRevision;
        const isCurrent = () => !this.destroyed && this.state.draft === draft && this.state.page === "setup" &&
            draft.areaMode === "vector" && draft.vectorKey === key && !this.state.submitting;
        draft.filterOpening = true; draft.filterEditing = true; this.state.error = ""; this.render();
        try {
            await this.editVectorFilter({key: `model:${draft.id}:${key}`, host: this.view.getVectorFilterHost(), source: structuredClone(source),
                filter: structuredClone(draft.area?.selection?.filter ?? source.filter), isCurrent: () => isCurrent() && this.state.active,
                apply: candidate => {
                    if (!isCurrent()) throw new Error("This model setup changed. Open its filter again.");
                    return this.selectVectorFeatures(key, candidate);
                },
                complete: () => { if (isCurrent()) { draft.filterEditing = false; this.render(); } },
                cancel: () => {
                    if (!isCurrent()) return;
                    if (this.selectionRevision > openingRevision) this.selectionAbort?.abort();
                },
                close: () => {
                    if (!isCurrent()) return;
                    if (this.selectionRevision > openingRevision) this.selectionAbort?.abort();
                    draft.filterEditing = false; this.render();
                },
            });
        } catch (error) {
            if (isCurrent()) { draft.filterEditing = false; this.state.error = `Could not open the vector filter: ${error.message}`; }
        } finally { draft.filterOpening = false; this.render(); }
    }

    /** Combine map inputs with this session's published raster results.
     * @param {Object} model Recipe whose input contract controls eligible choices.
     * @return {Object} Existing map context with available completed-run inputs.
     */
    inputContext(model) {
        const context = this.getContext();
        const acceptsResults = Object.values(model.inputs).some(input => input.type === "raster");
        const choices = [...(context.rasters ?? []).filter(source => acceptsResults || source.kind !== "runArtifact"),
            ...(acceptsResults ? modelResultSources([...this.runSnapshots.values()]) : [])];
        return {...context, rasters: [...new Map(choices.map(source => [modelSourceKey(source), source])).values()]};
    }

    /** Load installed hydrology choices and suggest only an unambiguous dataset.
     * Existing choices and duplicated runs require the exact saved revision.
     * @param {Object|null} [reference=null] Original run's exact dataset, when duplicating.
     * @return {Promise<void>}
     */
    async loadHydrology(reference = null) {
        const draft = this.state.draft;
        if (!draft || !modelHasInput(draft.model, "prepared_hydrology") || this.state.submitting) return;
        const requested = reference ?? draft.hydrologySelection ?? null;
        draft.hydrologySelection = requested;
        this.hydrologyAbort?.abort();
        const abort = new AbortController(); this.hydrologyAbort = abort;
        draft.hydrology = null; draft.hydrologyLoading = true; draft.hydrologyChecking = false; draft.hydrologyError = ""; this.render();
        try {
            const choices = await this.api.discoverPreparedHydrology(abort.signal);
            if (abort.signal.aborted || this.destroyed || this.state.draft !== draft) return;
            draft.hydrologyChoices = choices;
            let selected = requested ? choices.find(value => hydrologyKey(hydrologyReference(value)) === hydrologyKey(requested)) : null;
            let reason = requested ? "Using the exact dataset revision previously selected." : "Choose the prepared dataset for your starting area.";
            if (requested && !selected) {
                reason = "";
                draft.hydrologyError = "The original hydrology dataset revision is unavailable. Choose a replacement explicitly.";
            }
            if (!requested) {
                const sources = [...draft.sources, ...draft.vectors];
                const matches = choices.filter(value => [value.definition.dem, value.definition.watersheds].every(source =>
                    sources.some(candidate => modelSourceKey(candidate) === modelSourceKey(source))));
                if (matches.length === 1) { selected = matches[0]; reason = "Suggested because its elevation and watershed layers are in Map layers."; }
                else if (choices.length === 1) { selected = choices[0]; reason = "The only prepared dataset available. Check that it covers your starting area."; }
            }
            draft.hydrologyLoading = false; draft.hydrologyReason = reason;
            if (selected) await this.chooseHydrology(hydrologyKey(hydrologyReference(selected)), reason);
            else { draft.hydrologyKey = ""; this.render(); }
        } catch (error) {
            if (!abort.signal.aborted && this.state.draft === draft) draft.hydrologyError = `Could not load prepared datasets: ${error.message}`;
        } finally { if (!abort.signal.aborted && this.state.draft === draft) { draft.hydrologyLoading = false; this.render(); } }
    }

    /** Check the selected hydrology sources before enabling Run.
     * @param {string} key Choice-list identity, or empty to clear the choice.
     * @param {string} [reason=""] Explanation for an automatic suggestion.
     * @return {Promise<void>}
     */
    async chooseHydrology(key, reason = "") {
        const draft = this.state.draft;
        if (!draft || this.state.submitting) return;
        this.hydrologyAbort?.abort();
        const abort = new AbortController(); this.hydrologyAbort = abort;
        const selected = draft.hydrologyChoices.find(value => hydrologyKey(hydrologyReference(value)) === key);
        draft.hydrologySelection = selected ? hydrologyReference(selected) : null;
        draft.hydrologyKey = selected ? key : ""; draft.hydrology = null; draft.hydrologyLoading = false;
        draft.hydrologyError = ""; draft.hydrologyReason = reason; draft.hydrologyChecking = Boolean(selected); this.render();
        if (!selected) return;
        try {
            const snapshot = await this.api.resolvePreparedHydrology(hydrologyReference(selected), abort.signal);
            if (abort.signal.aborted || this.destroyed || this.state.draft !== draft) return;
            draft.hydrology = snapshot;
            if (!draft.rasterChosen && !draft.raster) {
                const candidates = draft.sources.filter(source => source.kind !== "runArtifact" && source.visible !== false &&
                    modelSourceKey(source) !== modelSourceKey(snapshot.definition.dem) &&
                    (!draft.maskRaster || modelSourceKey(source) !== modelSourceKey(draft.maskRaster)));
                if (candidates.length === 1) {
                    draft.raster = structuredClone(candidates[0]);
                    draft.rasterSuggestion = {key: modelSourceKey(draft.raster), reason: "Suggested as the only visible raster other than the prepared elevation and chosen starting raster. Review this choice before running."};
                    draft.sourceReason = draft.rasterSuggestion.reason;
                }
            }
            if (modelHasInput(draft.model, "mask_source") && !draft.maskChosen && draft.areaMode === "vector") {
                const candidates = draft.vectors.filter(source => modelSourceKey(source) !== modelSourceKey(snapshot.definition.watersheds));
                if (candidates.length === 1) {
                    void this.chooseVector(modelSourceKey(candidates[0]), "Suggested as the only vector layer other than the prepared watershed network. Review the selected features before running.");
                }
            }
        } catch (error) {
            if (!abort.signal.aborted && this.state.draft === draft) draft.hydrologyError = `This prepared dataset cannot be used: ${error.message} Refresh datasets or choose another.`;
        } finally { if (!abort.signal.aborted && this.state.draft === draft) { draft.hydrologyChecking = false; this.render(); } }
    }

    /** Refresh map and result choices without changing accepted runs or chosen filters.
     * Removed inputs must be added to the map again or replaced before a new run.
     * @return {void}
     */
    refreshMapLayers() {
        const draft = this.state.draft;
        if (!draft || this.destroyed || this.state.submitting || this.state.pending) return;
        const context = this.inputContext(draft.model);
        draft.sources = structuredClone(context.rasters ?? []);
        const selected = draft.raster;
        draft.raster = draft.sources.find(source => selected && modelSourceKey(source) === modelSourceKey(selected)) ?? null;
        if (!draft.raster && selected?.kind === "runArtifact") {
            draft.raster = {...selected, available: false}; draft.sources.push(draft.raster);
        }
        if (draft.maskRaster) draft.maskRaster = draft.sources.find(source => source.kind !== "runArtifact" && modelSourceKey(source) === modelSourceKey(draft.maskRaster)) ?? null;
        const previous = new Map(draft.vectors.map(source => [modelSourceKey(source), source]));
        draft.vectors = (context.vectors ?? []).map(source => ({...structuredClone(source),
            filter: structuredClone(previous.get(modelSourceKey(source))?.filter ?? source.filter)}));
        draft.sourceReason = draft.sources.length ? "Choose a raster from Map layers." : "Add a raster to Map layers to use this model.";
        if (Object.values(draft.model.inputs).some(input => input.type === "raster")) draft.sourceReason = "Choose a raster from Map layers or a completed run. Results do not need to be shown on the map.";
        if (!draft.rasterChosen && draft.raster && draft.rasterSuggestion?.key === modelSourceKey(draft.raster)) draft.sourceReason = draft.rasterSuggestion.reason;
        if (draft.raster?.available === false) draft.sourceReason = "This raster result is no longer available. Choose another input.";
        if (draft.vectorKey && !draft.vectors.some(source => modelSourceKey(source) === draft.vectorKey)) {
            this.closeVectorFilter();
            this.selectionAbort?.abort(); this.selectionRevision++;
            draft.vectorKey = ""; draft.area = null; draft.vectorInfo = null; draft.selecting = false;
            draft.selectionError = "Add the vector layer to Map layers, or choose another layer.";
        }
        this.render();
    }

    /** Submit once, or recover an uncertain response using its original request ID.
     * @param {boolean} [retry=false] Retry the saved immutable request.
     * @return {Promise<void>}
     */
    async submit(retry = false) {
        if (this.state.submitting || this.state.pending && !retry) return;
        const draft = this.state.draft; const revision = this.revision;
        this.state.error = "";
        try {
            if (!retry && draft?.filterEditing) throw new Error("Apply or close the filter before running the model.");
            if (!retry) { this.refreshMapLayers(); this.refreshMapArea(); }
            const submission = retry ? this.state.pending : captureModelSubmission(draft, this.newId());
            if (!submission) return;
            if (!this.storage) throw new Error("Enable session storage to submit a recoverable model run.");
            const serialized = JSON.stringify(submission);
            if (new TextEncoder().encode(serialized).length > 16384) throw new Error("Model inputs exceed the 16 KiB submission limit.");
            this.storage.setItem(RECOVERY_KEY, serialized);
            this.state.pending = submission; this.state.submitting = true; this.render();
            const job = await this.api.submitModelRun(submission);
            this.state.pending = null;
            try { this.storage.removeItem(RECOVERY_KEY); } catch { /* The saved ID still safely recovers this same accepted run. */ }
            this.rememberRun(job); this.jobs.accept(job);
            if (revision === this.revision) await this.showRun(job.jobId);
        } catch (error) {
            // A definite rejection allows editing. Transport/5xx failures retain
            // the exact request because the server may already have accepted it.
            if (error instanceof ProcessingRequestError && error.status >= 400 && error.status < 500) {
                this.state.pending = null; try { this.storage?.removeItem(RECOVERY_KEY); } catch { /* Retry identity remains harmless. */ }
            }
            this.state.error = `${error.message}${this.state.pending ? " Use Recover submission to retry the same request." : ""}`;
        } finally { this.state.submitting = false; this.render(); }
    }

    /** Retain a run independently of the shared recent-history window.
     * @param {Object} job Authoritative run status.
     * @return {void}
     */
    rememberRun(job) {
        if (job.operation !== "model.run.v1") return;
        this.runSnapshots.set(job.jobId, job);
        if (ACTIVE_JOB_STATES.has(job.status) || this.state.active && (this.state.page === "run" && this.state.selectedRun === job.jobId || this.state.page === "setup" && this.state.draft?.raster?.jobId === job.jobId)) {
            this.jobs.tracked.add(job.jobId); this.tracked.add(job.jobId);
        } else { this.jobs.tracked.delete(job.jobId); this.tracked.delete(job.jobId); }
        this.state.runs = [...this.runSnapshots.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
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
        this.state.historyLoading = true; this.render();
        try {
            const page = await this.api.listModelRuns(more ? this.state.nextCursor : null);
            if (revision !== this.historyRevision || this.destroyed) return;
            for (const job of page.jobs) {
                const current = this.runSnapshots.get(job.jobId);
                if (!current || current.updatedAt <= job.updatedAt) this.rememberRun(job);
            }
            this.state.nextCursor = page.nextCursor; this.jobs.schedule();
        } catch (error) { this.state.error = `Model runs unavailable: ${error.message}`; }
        finally { this.state.historyLoading = false; this.refreshMapLayers(); this.render(); }
    }

    /** Open one run and read its saved setup, discarding late navigation replies.
     * @param {string} id Model run identity.
     * @return {Promise<void>}
     */
    async showRun(id) {
        this.closeVectorFilter();
        const revision = ++this.revision;
        const previous = this.state.selectedRun;
        if (previous && !ACTIVE_JOB_STATES.has(this.runSnapshots.get(previous)?.status)) {
            this.jobs.tracked.delete(previous); this.tracked.delete(previous);
        }
        this.state.selectedRun = id; this.state.page = "run"; this.state.invocation = null; this.state.invocationError = "";
        this.state.error = ""; this.state.yaml = null; this.jobs.tracked.add(id); this.tracked.add(id); this.jobs.schedule();
        this.render(); this.view.focusHeading();
        try {
            const [job, invocation] = await Promise.all([this.api.getJob(id), this.api.readModelInvocation(id).catch(error => ({readError: error.message}))]);
            if (revision !== this.revision || this.destroyed) return;
            this.rememberRun(job);
            if (invocation.readError) this.state.invocationError = invocation.readError;
            else this.state.invocation = invocation;
        } catch (error) { if (revision === this.revision) this.state.invocationError = `This run is unavailable: ${error.message}`; }
        this.render();
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

    /** Copy saved inputs to a new draft only when its exact recipe is still installed.
     * @return {Promise<void>}
     */
    async duplicateRun() {
        const saved = this.state.invocation; if (!saved) return;
        this.closeVectorFilter();
        this.hydrologyAbort?.abort();
        const model = this.state.library.find(value => value.id === saved.model.id && value.version === saved.model.version &&
            value.definitionSha256 === saved.model.definitionSha256);
        if (!model) { this.state.error = "This exact model version is no longer installed. Its YAML remains available until metadata expires."; this.render(); return; }
        this.selectionAbort?.abort(); this.selectionRevision += 1; this.revision += 1;
        const draft = createModelDraft(model, this.inputContext(model), this.newId());
        this.state.draft = draft; this.state.page = "setup"; this.state.error = ""; this.state.yaml = null;
        draft.label = saved.label; draft.parameters = structuredClone(saved.parameters);
        draft.rasterChosen = true; draft.maskChosen = true;
        let savedHydrology = null;
        for (const [name, input] of Object.entries(model.inputs)) {
            if (["raster", "catalog_raster"].includes(input.type)) {
                const value = saved.inputs[name];
                draft.raster = draft.sources.find(source => modelSourceKey(source) === modelSourceKey(value)) ?? {...value, label: value.itemId};
                if (!draft.sources.some(source => modelSourceKey(source) === modelSourceKey(value))) draft.raster = value.kind === "runArtifact" ? {...value, label: "Raster from original run", available: false} : null;
                draft.sourceReason = "Copied from the original run; choose another raster to change it.";
            } else if (input.type === "prepared_hydrology") savedHydrology = saved.inputs[name];
            else if (input.type === "mask_source" && saved.inputs[name].kind === "catalogRaster") {
                draft.area = null; draft.areaMode = "raster";
                draft.maskRaster = draft.sources.find(source => source.kind !== "runArtifact" && modelSourceKey(source) === modelSourceKey(saved.inputs[name].source)) ?? null;
            } else if (["summary_area", "clip_area", "mask_source"].includes(input.type)) {
                draft.area = structuredClone(saved.inputs[name]); draft.capturedArea = structuredClone(draft.area); draft.areaMode = draft.area.kind === "wholeRaster" ? "whole" : "captured"; draft.areaOrigin = "run";
                draft.areaDescription = "Exact area and filter copied from the original run.";
                if (draft.area.kind === "catalogSelection") {
                    const selection = draft.area.selection;
                    const key = modelSourceKey(selection);
                    const source = {...draft.vectors.find(value => modelSourceKey(value) === key),
                        collectionId: selection.collectionId, itemId: selection.itemId, label: selection.layerName, filter: structuredClone(selection.filter)};
                    draft.vectorKey = key; draft.areaMode = "vector";
                    if (draft.vectors.some(value => modelSourceKey(value) === key)) {
                        draft.vectors = draft.vectors.map(value => modelSourceKey(value) === key ? source : value);
                    } else {
                        draft.vectorKey = ""; draft.area = null;
                        draft.selectionError = "Add the original vector layer to Map layers, or choose another layer.";
                    }
                }
            }
        }
        this.refreshMapLayers();
        this.render(); this.view.focusHeading();
        if (savedHydrology) await this.loadHydrology(savedHydrology);
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

    /** Present state without allowing a disposed component to update the page.
     * @return {void}
     */
    render() {
        if (this.destroyed) return;
        const job = this.runSnapshots.get(this.state.selectedRun);
        this.view.render({...this.state, outputPreviews: Object.fromEntries((job?.artifacts?.files ?? [])
            .map(file => [file.artifactId, this.outputState(job.jobId, file.artifactId, file)]))});
    }

    /** Release UI observation only; accepted jobs continue until explicit cancellation.
     * @return {void}
     */
    destroy() {
        this.closeVectorFilter();
        this.destroyed = true; this.revision += 1; this.selectionRevision += 1; this.selectionAbort?.abort();
        this.hydrologyAbort?.abort();
        this.unsubscribe(); for (const id of this.tracked) this.jobs.tracked.delete(id); this.view.destroy();
    }
}
