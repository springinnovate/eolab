/** Own model setup and run navigation while accepted work remains on the server. */
import { ACTIVE_JOB_STATES } from "../processing/jobs.js";
import { ProcessingRequestError } from "../processing/api.js";
import { createModelDraft, captureModelSubmission, modelSourceKey, modelAreaInput } from "./inputs.js";

const RECOVERY_KEY = "eolab.models.pending.v1";

/** Keep editable model drafts separate from accepted, session-owned runs. */
export class ModelsController {
    /** Connect the Models view to API transport and composed catalog inputs.
     * @param {Object} dependencies Component dependencies.
     * @param {Object} dependencies.api Processing API client.
     * @param {Object} dependencies.jobs Existing shared Processing job observer.
     * @param {Object} dependencies.view Models view.
     * @param {()=>Object} dependencies.getContext Catalog/map suggestions, independent of rendering.
     * @param {(kind:string,query:string,next:Object|null)=>Promise<Object>} dependencies.searchSources Catalog search with pagination.
     * @param {(source:Object,signal:AbortSignal)=>Promise<Object>} dependencies.prepareVector Read a captured vector predicate and counts.
     * @param {Storage|null} [dependencies.storage=null] Per-tab submission recovery storage.
     * @param {()=>void} dependencies.onOpen Open the composed Analysis panel.
     * @param {()=>void} dependencies.onClose Hide the panel without cancelling jobs.
     * @param {()=>string} [dependencies.newId] Generate draft and request identities.
     */
    constructor({api, jobs, view, getContext, searchSources, prepareVector, storage = null, onOpen, onClose,
        newId = () => globalThis.crypto.randomUUID().replaceAll("-", "")}) {
        Object.assign(this, {api, jobs, view, getContext, searchSources, prepareVector, storage, onOpen, onClose, newId});
        this.state = {page: "library", active: false, library: [], loading: false, error: "", query: "", draft: null,
            runs: [], nextCursor: null, historyLoading: false, selectedRun: null, invocation: null, invocationError: "", yaml: null,
            pending: null, submitting: false, actionBusy: false};
        this.runSnapshots = new Map(); this.revision = 0; this.historyRevision = 0; this.selectionRevision = 0; this.searchRevision = 0;
        this.tracked = new Set(); this.destroyed = false;
        this.unsubscribe = jobs.subscribe(() => this.observeJobs());
        view.bind({onOpen: () => this.open(), onClose, onPage: page => this.navigate(page),
            onQuery: query => { this.state.query = query; this.render(); }, onChoose: model => this.chooseModel(model),
            onEdit: change => this.editDraft(change), onArea: mode => this.chooseArea(mode),
            onVector: key => void this.chooseVector(key), onSearch: (kind, more) => void this.search(kind, more),
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

    /** Change presentation visibility without changing server work or draft inputs.
     * @param {boolean} active Whether Models is the visible Analysis tool.
     * @return {void}
     */
    setActive(active) {
        this.state.active = active;
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
    navigate(page) { this.revision += 1; this.state.page = page; this.state.error = ""; this.render(); if (page === "runs") void this.loadRuns(); }

    /** Create a fresh draft from the current source suggestions.
     * @param {Object} model Installed recipe chosen by the user.
     * @return {void}
     */
    chooseModel(model) {
        this.selectionAbort?.abort(); this.selectionRevision += 1; this.searchRevision += 1; this.revision += 1;
        this.state.draft = createModelDraft(model, this.getContext(), this.newId());
        this.state.page = "setup"; this.state.error = ""; this.state.yaml = null; this.render(); this.view.focusHeading();
        const draft = this.state.draft;
        if (draft.area?.kind === "catalogSelection") {
            const selection = draft.area.selection;
            const source = {collectionId: selection.collectionId, itemId: selection.itemId, label: selection.layerName, filter: selection.filter};
            draft.vectors = [source, ...draft.vectors.filter(value => modelSourceKey(value) !== modelSourceKey(source))];
            draft.areaMode = "vector";
            void this.chooseVector(modelSourceKey(source));
        }
    }

    /** Update draft fields without changing a pending or accepted submission.
     * @param {Object} change Edited label, raster, parameters, search text or bounds.
     * @return {void}
     */
    editDraft(change) {
        if (!this.state.draft || this.state.submitting) return;
        Object.assign(this.state.draft, change);
        if (change.bounds) {
            this.state.draft.area = {kind: "selectedArea", selectedBounds: {...change.bounds}};
        }
        this.state.error = "";
    }

    /** Choose an explicit area; later map changes never update it automatically.
     * @param {string} mode Whole raster, current map selection, custom bounds or vector.
     * @return {void}
     */
    chooseArea(mode) {
        const draft = this.state.draft; if (!draft) return;
        this.selectionAbort?.abort(); this.selectionRevision += 1; draft.selecting = false;
        draft.areaMode = mode; draft.vectorInfo = null; draft.vectorKey = ""; draft.selectionError = "";
        if (mode === "whole") draft.area = {kind: "wholeRaster"};
        else if (mode === "captured") draft.area = structuredClone(draft.capturedArea);
        else if (mode === "map") {
            const context = this.getContext();
            draft.area = context.area ? modelAreaInput(context.area) : null;
            draft.areaDescription = context.areaDescription ?? "Current map selection copied into this draft.";
            if (!draft.area) draft.selectionError = "Select a map sampling box or enter bounds below.";
        } else if (mode === "bounds") draft.area = {kind: "selectedArea", selectedBounds: {...draft.bounds}};
        else draft.area = null;
        this.render();
    }

    /** Read matching features for the chosen catalog vector and captured filter.
     * @param {string} key Choice-list identity.
     * @return {Promise<void>}
     */
    async chooseVector(key) {
        const draft = this.state.draft;
        const source = draft?.vectors.find(value => modelSourceKey(value) === key);
        this.selectionAbort?.abort(); const revision = ++this.selectionRevision;
        if (!draft || !source) return;
        this.selectionAbort = new AbortController(); draft.vectorKey = key; draft.area = null; draft.vectorInfo = null;
        draft.selecting = true; draft.selectionError = ""; this.render();
        try {
            const area = await this.prepareVector(structuredClone(source), this.selectionAbort.signal);
            if (revision !== this.selectionRevision || this.state.draft !== draft) return;
            draft.area = modelAreaInput({kind: "catalogSelection", catalogSelection: area.selection});
            draft.vectorInfo = {label: source.label, matched: area.matched, total: area.total, bbox: area.bbox};
        } catch (error) { if (revision === this.selectionRevision) draft.selectionError = error.message; }
        finally { if (revision === this.selectionRevision) { draft.selecting = false; this.render(); } }
    }

    /** Search catalog sources independently of map rendering or visibility.
     * @param {"raster"|"vector"} kind Input type to search.
     * @param {boolean} [more=false] Follow the previous page's continuation.
     * @return {Promise<void>}
     */
    async search(kind, more = false) {
        const draft = this.state.draft; if (!draft) return;
        const revision = ++this.searchRevision; draft.searching = true; draft.searchError = ""; this.render();
        const prefix = kind === "raster" ? "source" : "vector";
        try {
            const result = await this.searchSources(kind, draft[`${prefix}Query`], more ? draft[`${prefix}Next`] : null);
            if (!result || revision !== this.searchRevision || this.state.draft !== draft) return;
            const field = kind === "raster" ? "sources" : "vectors";
            draft[field] = [...new Map([...draft[field], ...result.sources].map(source => [modelSourceKey(source), source])).values()];
            draft[`${prefix}Next`] = result.next; draft.searchError = result.sources.length ? "" : "No matching catalog sources.";
        } catch (error) { if (revision === this.searchRevision) draft.searchError = error.message; }
        finally { if (revision === this.searchRevision) { draft.searching = false; this.render(); } }
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
        this.selectionAbort?.abort(); this.selectionRevision += 1; this.searchRevision += 1; this.revision += 1;
        const draft = createModelDraft(model, this.getContext(), this.newId());
        this.state.draft = draft; this.state.page = "setup"; this.state.error = ""; this.state.yaml = null;
        draft.label = saved.label; draft.parameters = structuredClone(saved.parameters);
        for (const [name, input] of Object.entries(model.inputs)) {
            if (input.type === "catalog_raster") {
                const value = saved.inputs[name];
                draft.raster = draft.sources.find(source => modelSourceKey(source) === modelSourceKey(value)) ?? {...value, label: value.itemId};
                if (!draft.sources.some(source => modelSourceKey(source) === modelSourceKey(value))) draft.sources.push(draft.raster);
                draft.sourceReason = "Copied from the original run; choose another raster to change it.";
            } else if (input.type === "summary_area") {
                draft.area = structuredClone(saved.inputs[name]); draft.capturedArea = structuredClone(draft.area); draft.areaMode = "captured";
                draft.areaDescription = "Exact area and filter copied from the original run.";
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
