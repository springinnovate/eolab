/** Own model setup and run navigation while accepted work remains on the server. */
import { ACTIVE_JOB_STATES } from "../processing/jobs.js";
import { ProcessingRequestError } from "../processing/api.js";
import { createModelDraft, captureModelSubmission, modelSourceKey, modelAreaInput, modelViewportArea } from "./inputs.js";

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
     * @param {(request:{key:string,source:Object,filter:Object,isCurrent:()=>boolean,apply:(filter:Object)=>Promise<Object|null>,complete:()=>void,cancel:()=>void})=>Promise<void>|void} dependencies.editVectorFilter Open the composed filter editor for this draft only.
     * @param {Storage|null} [dependencies.storage=null] Per-tab submission recovery storage.
     * @param {()=>void} dependencies.onOpen Open the composed Analysis panel.
     * @param {()=>void} dependencies.onClose Hide the panel without cancelling jobs.
     * @param {()=>string} [dependencies.newId] Generate draft and request identities.
     */
    constructor({api, jobs, view, getContext, prepareVector, editVectorFilter, storage = null, onOpen, onClose,
        newId = () => globalThis.crypto.randomUUID().replaceAll("-", "")}) {
        Object.assign(this, {api, jobs, view, getContext, prepareVector, editVectorFilter, storage, onOpen, onClose, newId});
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
            onSubmit: () => void this.submit(), onRetry: () => void this.submit(true), onRefresh: () => void this.loadLibrary(),
            onRefreshRuns: () => void this.loadRuns(), onMore: () => void this.loadRuns(true), onRun: id => void this.showRun(id),
            onCancel: () => void this.cancelRun(), onDuplicate: () => void this.duplicateRun(), onYaml: () => void this.showYaml()});
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
    navigate(page) { this.revision += 1; this.state.page = page; this.state.error = ""; if (page === "setup") this.refreshMapArea(); this.render(); if (page === "runs") void this.loadRuns(); }

    /** Create a fresh draft from the current source suggestions.
     * @param {Object} model Installed recipe chosen by the user.
     * @return {void}
     */
    chooseModel(model) {
        this.selectionAbort?.abort(); this.selectionRevision += 1; this.revision += 1;
        this.state.draft = createModelDraft(model, this.getContext(), this.newId());
        this.state.page = "setup"; this.state.error = ""; this.state.yaml = null; this.render(); this.view.focusHeading();
        const draft = this.state.draft;
        if (draft.area?.kind === "catalogSelection") {
            const selection = draft.area.selection;
            const source = {collectionId: selection.collectionId, itemId: selection.itemId, label: selection.layerName, filter: selection.filter};
            draft.areaMode = "vector";
            if (draft.vectors.some(value => modelSourceKey(value) === modelSourceKey(source))) void this.chooseVector(modelSourceKey(source));
            else { draft.area = null; draft.selectionError = "Choose a vector layer from Map layers."; this.render(); }
        }
    }

    /** Update draft fields without changing a pending or accepted submission.
     * @param {Object} change Edited label, raster or parameters.
     * @return {void}
     */
    editDraft(change) {
        if (!this.state.draft || this.state.submitting) return;
        Object.assign(this.state.draft, change);
        this.state.error = "";
    }

    /** Choose whether setup uses the live map area, vector features or a fixed area.
     * @param {string} mode Whole raster, viewport, mapBox, mapPolygons, vector or captured run area.
     * @return {void}
     */
    chooseArea(mode) {
        const draft = this.state.draft; if (!draft || this.state.submitting) return;
        this.selectionAbort?.abort(); this.selectionRevision += 1; draft.selecting = false;
        draft.areaMode = mode; draft.vectorInfo = null; draft.vectorKey = ""; draft.selectionError = ""; this.state.error = "";
        if (mode === "whole") draft.area = {kind: "wholeRaster"};
        else if (mode === "captured") draft.area = structuredClone(draft.capturedArea);
        else if (["viewport", "mapBox", "mapPolygons"].includes(mode)) { this.refreshMapArea(); return; }
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
            !["viewport", "mapBox", "mapPolygons"].includes(draft.areaMode)) return;
        const context = this.getContext();
        draft.area = null; draft.selectionError = "";
        try {
            if (draft.areaMode === "viewport") {
                draft.area = modelViewportArea(context.viewportBounds);
                draft.areaDescription = "Visible map area";
            } else {
                const kind = draft.areaMode === "mapBox" ? "selectedArea" : "polygonArea";
                if (context.area?.kind !== kind) throw new Error(draft.areaMode === "mapBox"
                    ? "Click the map to choose a box for this analysis."
                    : "Select polygons on the map to choose an area for this analysis.");
                draft.area = modelAreaInput(context.area);
                draft.areaDescription = draft.areaMode === "mapBox" ? "Box around map location" : "Polygons selected on map";
            }
        } catch (error) { draft.selectionError = error.message; }
        this.render();
    }

    /** Select a vector's draft filter and show any feature-selection failure in setup.
     * @param {string} key Choice-list identity, or empty to clear the choice.
     * @return {Promise<void>}
     */
    async chooseVector(key) {
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
            return area;
        } catch (error) {
            if (revision !== this.selectionRevision || this.state.draft !== draft) return null;
            draft.area = previous.area; draft.vectorInfo = previous.info;
            if (abort.signal.aborted) return null;
            draft.selectionError = `${error.message}${previous.area ? " The previous selection is unchanged." : ""}`;
            throw error;
        } finally { if (revision === this.selectionRevision) { draft.selecting = false; this.render(); } }
    }

    /** Open the existing field/condition editor for this model's vector input.
     * Applying a filter updates only this draft; it never changes a map layer or submits a run.
     * @return {Promise<void>}
     */
    async openVectorFilter() {
        const draft = this.state.draft;
        const source = draft?.vectors.find(value => modelSourceKey(value) === draft.vectorKey);
        if (!source || draft.filterOpening || draft.selecting || this.state.submitting) return;
        const key = draft.vectorKey;
        const isCurrent = () => !this.destroyed && this.state.draft === draft && this.state.page === "setup" &&
            draft.areaMode === "vector" && draft.vectorKey === key && !this.state.submitting;
        draft.filterOpening = true; this.state.error = ""; this.render();
        try {
            await this.editVectorFilter({key: `model:${draft.id}:${key}`, source: structuredClone(source),
                filter: structuredClone(draft.area?.selection?.filter ?? source.filter), isCurrent: () => isCurrent() && this.state.active,
                apply: candidate => {
                    if (!isCurrent()) throw new Error("This model setup changed. Return to Models and open its filter again.");
                    return this.selectVectorFeatures(key, candidate);
                },
                complete: () => { if (isCurrent()) this.onOpen(); },
                cancel: () => { if (isCurrent()) this.selectionAbort?.abort(); },
            });
        } catch (error) { if (isCurrent()) this.state.error = `Could not open the vector filter: ${error.message}`; }
        finally { draft.filterOpening = false; this.render(); }
    }

    /** Refresh choices from Map layers without changing accepted runs or chosen filters.
     * Removed inputs must be added to the map again or replaced before a new run.
     * @return {void}
     */
    refreshMapLayers() {
        const draft = this.state.draft;
        if (!draft || this.destroyed || this.state.submitting || this.state.pending) return;
        const context = this.getContext();
        draft.sources = structuredClone(context.rasters ?? []);
        draft.raster = draft.sources.find(source => draft.raster && modelSourceKey(source) === modelSourceKey(draft.raster)) ?? null;
        const previous = new Map(draft.vectors.map(source => [modelSourceKey(source), source]));
        draft.vectors = (context.vectors ?? []).map(source => ({...structuredClone(source),
            filter: structuredClone(previous.get(modelSourceKey(source))?.filter ?? source.filter)}));
        draft.sourceReason = draft.sources.length ? "Choose a raster from Map layers." : "Add a raster to Map layers to use this model.";
        if (draft.vectorKey && !draft.vectors.some(source => modelSourceKey(source) === draft.vectorKey)) {
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
        if (ACTIVE_JOB_STATES.has(job.status) || this.state.active && this.state.page === "run" && this.state.selectedRun === job.jobId) {
            this.jobs.tracked.add(job.jobId); this.tracked.add(job.jobId);
        } else { this.jobs.tracked.delete(job.jobId); this.tracked.delete(job.jobId); }
        this.state.runs = [...this.runSnapshots.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
    }

    /** Apply observed progress without editing the current setup.
     * @return {void}
     */
    observeJobs() {
        for (const job of this.jobs.jobs) if (job.operation === "model.run.v1") this.rememberRun(job);
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
        finally { this.state.historyLoading = false; this.render(); }
    }

    /** Open one run and read its saved setup, discarding late navigation replies.
     * @param {string} id Model run identity.
     * @return {Promise<void>}
     */
    async showRun(id) {
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
        const model = this.state.library.find(value => value.id === saved.model.id && value.version === saved.model.version &&
            value.definitionSha256 === saved.model.definitionSha256);
        if (!model) { this.state.error = "This exact model version is no longer installed. Its YAML remains available until metadata expires."; this.render(); return; }
        this.selectionAbort?.abort(); this.selectionRevision += 1; this.revision += 1;
        const draft = createModelDraft(model, this.getContext(), this.newId());
        this.state.draft = draft; this.state.page = "setup"; this.state.error = ""; this.state.yaml = null;
        draft.label = saved.label; draft.parameters = structuredClone(saved.parameters);
        for (const [name, input] of Object.entries(model.inputs)) {
            if (input.type === "catalog_raster") {
                const value = saved.inputs[name];
                draft.raster = draft.sources.find(source => modelSourceKey(source) === modelSourceKey(value)) ?? {...value, label: value.itemId};
                if (!draft.sources.some(source => modelSourceKey(source) === modelSourceKey(value))) draft.raster = null;
                draft.sourceReason = "Copied from the original run; choose another raster to change it.";
            } else if (input.type === "summary_area") {
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
        this.render(); this.view.focusHeading();
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
    render() { if (!this.destroyed) this.view.render(this.state); }

    /** Release UI observation only; accepted jobs continue until explicit cancellation.
     * @return {void}
     */
    destroy() {
        this.destroyed = true; this.revision += 1; this.selectionRevision += 1; this.selectionAbort?.abort();
        this.unsubscribe(); for (const id of this.tracked) this.jobs.tracked.delete(id); this.view.destroy();
    }
}
