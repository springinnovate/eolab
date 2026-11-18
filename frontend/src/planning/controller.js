/** Own planning-tool drafts, saved-tool navigation and their live custom-layer bindings. */

/**
 * @typedef {{collectionId:string,itemId:string}|{localLayerId:string,drawingLayerId?:string}} PlanningLayerSource
 * @typedef {{key:string,label:string,source:PlanningLayerSource,idFields:Array<{name:string,type:string}>,filterSummary:string,builtInId?:"id",featureCount?:number}} PlanningLayerChoice
 * @typedef {{id:string|null,revision:number|null,title:string,aoiKey:string,parcelKey:string,parcelIdField:string,interventions:import("./api.js").PlanningIntervention[]}} PlanningDraft
 * @typedef {{page:"library"|"editor",active:boolean,library:import("./api.js").PlanningSummary[],choices:PlanningLayerChoice[],draft:PlanningDraft|null,loading:boolean,saving:boolean,error:string,message:string,idCheck:{phase:"idle"|"checking"|"valid"|"error",message:string},dirty:boolean}} PlanningState
 */

/** Compare saved Planning JSON independently of object-key order from database serialization.
 * Array order remains meaningful for layers, filters and interventions.
 * @param {import("./api.js").PlanningDocument} document Complete authoring document.
 * @return {string} Deterministic JSON for dirty-state comparisons.
 */
function documentFingerprint(document) {
    return JSON.stringify(document, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

/** Coordinate author choices with injected map capabilities and the Planning API. */
export class PlanningController {
    /** Connect the authoring feature without importing sibling implementations.
     * @param {Object} dependencies Composition-supplied capabilities.
     * @param {import("./api.js").PlanningApiClient} dependencies.api Planning persistence and ID validation.
     * @param {import("./view.js").PlanningView} dependencies.view Authoring controls.
     * @param {()=>PlanningLayerChoice[]} dependencies.getLayerChoices Current eligible custom polygon views.
     * @param {(key:string)=>Object} dependencies.exportLayer Export the current ordinary portable layer definition.
     * @param {(keys:string[])=>Promise<void>} [dependencies.prepareLayers] Save selected drawing sources before exporting their references; Catalog views need no preparation.
     * @param {(layers:import("./api.js").PlanningLayer[],isCurrent:()=>boolean)=>Promise<Array<{id:string,key:string|null,error:string|null}>>} dependencies.restoreLayers Restore definitions once and return fresh runtime bindings.
     * @param {(key:string)=>void} dependencies.editLayerFilter Open that view's ordinary filter editor.
     * @param {()=>void} dependencies.onOpen Show the Planning panel.
     * @param {()=>void} dependencies.onClose Hide the panel without discarding its draft.
     * @param {()=>string} [dependencies.newId] Generate durable layer/intervention UUIDs.
     */
    constructor({api, view, getLayerChoices, exportLayer, restoreLayers, editLayerFilter, onOpen, onClose,
        prepareLayers = async () => {}, newId = () => globalThis.crypto.randomUUID()}) {
        Object.assign(this, {api, view, getLayerChoices, exportLayer, prepareLayers, restoreLayers, editLayerFilter, onOpen, onClose, newId});
        /** @type {PlanningState} Author state; map filters remain owned by the selected live views. */
        this.state = {page: "library", active: false, library: [], choices: [], draft: null,
            loading: false, saving: false, error: "", message: "", idCheck: {phase: "idle", message: ""}, dirty: false};
        this.bindings = new Map(); this.savedLayers = new Map(); this.savedFingerprint = null;
        this.generation = 0; this.libraryGeneration = 0; this.checkGeneration = 0; this.destroyed = false;
        this.checkIdentity = null; this.validationAbort = null; this.loadAbort = null; this.libraryAbort = null;
        view.bind({onOpen: () => this.open(), onClose, onNew: () => this.newTool(), onLibrary: () => this.showLibrary(),
            onRefresh: () => this.loadLibrary(), onLoad: id => this.loadTool(id), onSave: () => this.save(),
            onTitle: title => this.editTitle(title), onLayer: (role, key) => this.chooseLayer(role, key),
            onIdField: field => this.chooseIdField(field), onCheckIds: () => this.checkIds(),
            onFilter: role => this.openFilter(role), onAddIntervention: () => this.addIntervention(),
            onIntervention: (id, label) => this.editIntervention(id, label), onRemoveIntervention: id => this.removeIntervention(id),
            onResume: () => { this.state.page = "editor"; this.refreshMapLayers(); }});
        this.refreshMapLayers();
    }

    /** Show the retained page and refresh this browser's saved-tool list. @return {void} */
    open() { this.onOpen(); this.refreshMapLayers(); void this.loadLibrary(); }

    /** Refresh live choices when the panel becomes active, retaining pending saves.
     * @param {boolean} active Whether Planning is foreground. @return {void}
     */
    setActive(active) { this.state.active = active; if (active) this.refreshMapLayers(); }

    /** Refresh layer descriptors without copying filters into a second editable store.
     * Removed selections stay selected as unavailable; another layer is never substituted.
     * @return {void}
     */
    refreshMapLayers() {
        if (this.destroyed) return;
        this.state.choices = this.getLayerChoices();
        const parcels = this.state.choices.find(choice => choice.key === this.state.draft?.parcelKey);
        if (parcels?.builtInId) this.state.draft.parcelIdField = parcels.builtInId;
        const identity = this.validationIdentity();
        if (identity !== this.checkIdentity) { this.cancelIdCheck(); this.checkIdentity = identity; }
        this.render();
    }

    /** Load the private library without replacing the current editor.
     * @return {Promise<void>} Completion after accepting or ignoring the response.
     */
    async loadLibrary() {
        const generation = ++this.libraryGeneration;
        this.libraryAbort?.abort(); this.libraryAbort = new AbortController();
        try {
            const library = await this.api.list(this.libraryAbort.signal);
            if (!this.destroyed && generation === this.libraryGeneration) this.state.library = library;
        } catch (error) {
            if (!this.destroyed && generation === this.libraryGeneration && error.name !== "AbortError") this.state.error = error.message;
        } finally { if (!this.destroyed && generation === this.libraryGeneration) this.render(); }
    }

    /** Return to saved tools while retaining an unfinished editor for Resume. @return {void} */
    showLibrary() {
        if (this.state.saving) return;
        ++this.generation; this.loadAbort?.abort(); this.cancelIdCheck();
        this.state.loading = false; this.state.page = "library"; this.render(); void this.loadLibrary();
    }

    /** Replace the current editor with an empty configuration and no scientific presets.
     * @return {void}
     */
    newTool() {
        if (this.state.saving) return;
        ++this.generation; this.loadAbort?.abort(); this.cancelIdCheck();
        this.bindings.clear(); this.savedLayers.clear(); this.savedFingerprint = null;
        this.state.draft = {id: null, revision: null, title: "", aoiKey: "", parcelKey: "", parcelIdField: "", interventions: []};
        this.state.page = "editor"; this.state.loading = false; this.state.error = ""; this.state.message = "";
        this.refreshMapLayers(); this.view.focusTitle();
    }

    /** Load a saved tool and restore its distinct ordinary custom layers exactly once.
     * @param {string} id Saved tool UUID. @return {Promise<void>} Restoration or actionable failure.
     */
    async loadTool(id) {
        if (this.state.saving) return;
        const generation = ++this.generation;
        this.loadAbort?.abort(); this.loadAbort = new AbortController(); this.cancelIdCheck();
        this.state.loading = true; this.state.error = ""; this.state.message = ""; this.render();
        const isCurrent = () => !this.destroyed && generation === this.generation;
        try {
            const record = await this.api.get(id, this.loadAbort.signal);
            if (!isCurrent()) return;
            this.bindings.clear(); this.savedLayers = new Map(record.layers.map(layer => [layer.id, layer.definition]));
            this.state.draft = {id: record.id, revision: record.revision, title: record.title,
                aoiKey: `missing:${record.aoiLayerId}`, parcelKey: `missing:${record.parcelLayerId}`,
                parcelIdField: record.parcelIdField, interventions: structuredClone(record.interventions)};
            this.state.page = "editor";
            const results = await this.restoreLayers(record.layers, isCurrent);
            if (!isCurrent()) return;
            for (const result of results) {
                if (!result.key) continue;
                this.bindings.set(result.key, result.id);
                if (record.aoiLayerId === result.id) this.state.draft.aoiKey = result.key;
                if (record.parcelLayerId === result.id) this.state.draft.parcelKey = result.key;
            }
            this.savedFingerprint = documentFingerprint(this.documentFromRecord(record));
            this.state.error = [...new Set(results.map(result => result.error).filter(Boolean))].join(" ");
        } catch (error) { if (isCurrent() && error.name !== "AbortError") this.state.error = error.message; }
        finally { if (isCurrent()) { this.state.loading = false; this.refreshMapLayers(); } }
    }

    /** Remove server metadata from a record when comparing saved author choices.
     * @param {import("./api.js").PlanningRecord} record Saved tool.
     * @return {import("./api.js").PlanningDocument} Its persisted authoring document.
     */
    documentFromRecord(record) {
        const {title, layers, aoiLayerId, parcelLayerId, parcelIdField, interventions} = record;
        return {title, layers, aoiLayerId, parcelLayerId, parcelIdField, interventions};
    }

    /** Change the tool title while retaining all layer bindings.
     * @param {string} title Author text. @return {void}
     */
    editTitle(title) { if (this.state.saving || !this.state.draft) return; this.state.draft.title = title; this.state.message = ""; this.render(); }

    /** Bind an AOI or parcel role to a live custom view.
     * @param {"aoi"|"parcels"} role Edited role. @param {string} key Runtime view key or empty choice. @return {void}
     */
    chooseLayer(role, key) {
        if (this.state.saving || !this.state.draft) return;
        const field = role === "aoi" ? "aoiKey" : "parcelKey";
        if (this.state.draft[field] === key) return;
        this.state.draft[field] = key;
        if (key && !this.bindings.has(key)) this.bindings.set(key, this.newId());
        if (role === "parcels") this.state.draft.parcelIdField = "";
        this.state.message = ""; this.refreshMapLayers();
    }

    /** Choose one original parcel ID field without initiating a whole-source scan.
     * @param {string} field Selected field name. @return {void}
     */
    chooseIdField(field) { if (this.state.saving || !this.state.draft) return; this.state.draft.parcelIdField = field; this.refreshMapLayers(); }

    /** Open the existing filter editor for the selected live role.
     * @param {"aoi"|"parcels"} role Role to edit. @return {void}
     */
    openFilter(role) {
        const key = this.state.draft?.[role === "aoi" ? "aoiKey" : "parcelKey"];
        if (this.state.choices.some(choice => choice.key === key)) this.editLayerFilter(key);
    }

    /** Append a named intervention with a stable identity independent of its label. @return {void} */
    addIntervention() {
        if (this.state.saving || !this.state.draft || this.state.draft.interventions.length >= 64) return;
        this.state.draft.interventions.push({id: this.newId(), label: ""}); this.render(); this.view.focusLastIntervention();
    }

    /** Rename an intervention without changing its persistent identity.
     * @param {string} id Intervention UUID. @param {string} label Author label. @return {void}
     */
    editIntervention(id, label) { if (this.state.saving) return; const item = this.state.draft?.interventions.find(value => value.id === id); if (item) { item.label = label; this.render(); } }

    /** Remove a configured intervention from this draft.
     * @param {string} id Intervention UUID. @return {void}
     */
    removeIntervention(id) { if (this.state.saving || !this.state.draft) return; this.state.draft.interventions = this.state.draft.interventions.filter(item => item.id !== id); this.render(); }

    /** Identify whole-source validation independently of view filters and visibility.
     * @return {string|null} Source and field identity, or null for incomplete choices.
     */
    validationIdentity() {
        const draft = this.state.draft, choice = this.state.choices.find(value => value.key === draft?.parcelKey);
        if (!choice || !draft.parcelIdField) return null;
        const source = choice.source;
        return JSON.stringify(choice.builtInId
            ? ["drawing", source.drawingLayerId ?? source.localLayerId, draft.parcelIdField]
            : ["catalog", source.collectionId, source.itemId, draft.parcelIdField]);
    }

    /** Cancel only the obsolete parcel ID check and clear its feedback. @return {void} */
    cancelIdCheck() { ++this.checkGeneration; this.validationAbort?.abort(); this.validationAbort = null; this.state.idCheck = {phase: "idle", message: ""}; }

    /** Check the chosen original ID field; ignored late responses cannot certify another source.
     * @return {Promise<void>} Complete feedback or cancellation.
     */
    async checkIds() {
        this.refreshMapLayers();
        const draft = this.state.draft, choice = this.state.choices.find(value => value.key === draft?.parcelKey);
        if (!choice || choice.builtInId || !draft.parcelIdField || this.state.saving) return;
        this.cancelIdCheck(); const generation = this.checkGeneration;
        this.validationAbort = new AbortController(); this.state.idCheck = {phase: "checking", message: "Checking every parcel ID in the original layer…"}; this.render();
        try {
            const result = await this.api.validateIds(choice.source, draft.parcelIdField, this.validationAbort.signal);
            if (!this.destroyed && generation === this.checkGeneration) this.state.idCheck = {phase: "valid", message: `${result.featureCount.toLocaleString()} original parcel IDs are unique and present.`};
        } catch (error) {
            if (!this.destroyed && generation === this.checkGeneration && error.name !== "AbortError") this.state.idCheck = {phase: "error", message: error.message};
        } finally { if (!this.destroyed && generation === this.checkGeneration) this.render(); }
    }

    /** Validate author choices without exporting or saving any drawing source.
     * @return {{keys:string[],interventions:import("./api.js").PlanningIntervention[]}} Distinct selected views and trimmed intervention names.
     * @throws {Error} If required choices are missing or a chosen view is unavailable.
     */
    readDraftChoices() {
        const draft = this.state.draft;
        if (!draft?.title.trim()) throw new Error("Enter a name for this planning tool.");
        const aoi = this.state.choices.find(choice => choice.key === draft.aoiKey);
        const parcels = this.state.choices.find(choice => choice.key === draft.parcelKey);
        if (!aoi || !parcels) throw new Error("Choose available custom layers for the area and parcels.");
        if (parcels.builtInId ? draft.parcelIdField !== parcels.builtInId : !parcels.idFields.some(field => field.name === draft.parcelIdField)) {
            throw new Error("Choose an original integer or text field for parcel IDs.");
        }
        const interventions = draft.interventions.map(item => ({id: item.id, label: item.label.trim()}));
        if (!interventions.length || interventions.some(item => !item.label)) throw new Error("Add at least one intervention and name every intervention.");
        return {keys: [...new Set([draft.aoiKey, draft.parcelKey])], interventions};
    }

    /** Export current layer settings without creating sources or changing the map.
     * Drawing references must already exist; saving prepares them before this call.
     * @return {import("./api.js").PlanningDocument} Path-free tool document with durable role IDs.
     * @throws {Error} If required choices or a reusable drawing reference are unavailable.
     */
    buildDocument() {
        const {keys, interventions} = this.readDraftChoices(), draft = this.state.draft;
        const layers = keys.map(key => ({id: this.bindings.get(key), definition: this.exportLayer(key)}));
        return {title: draft.title.trim(), layers, aoiLayerId: this.bindings.get(draft.aoiKey), parcelLayerId: this.bindings.get(draft.parcelKey),
            parcelIdField: draft.parcelIdField, interventions};
    }

    /** Persist current live settings; retain failed/conflicting drafts for correction.
     * @return {Promise<void>} Saved revision or user-facing failure.
     */
    async save() {
        if (this.state.saving || this.state.loading || !this.state.draft) return;
        this.refreshMapLayers(); let keys;
        try { ({keys} = this.readDraftChoices()); } catch (error) { this.state.error = error.message; this.render(); return; }
        const draft = this.state.draft, generation = this.generation;
        this.state.saving = true; this.state.error = ""; this.state.message = "Saving and validating parcel IDs…"; this.render();
        let submittingTool = false;
        try {
            const drawings = keys.filter(key => this.state.choices.find(choice => choice.key === key).builtInId);
            if (drawings.length) {
                await this.prepareLayers(drawings);
                if (this.destroyed || generation !== this.generation) return;
                this.refreshMapLayers();
            }
            const document = this.buildDocument();
            submittingTool = true;
            const record = draft.id ? await this.api.update(draft.id, draft.revision, document) : await this.api.create(document);
            if (this.destroyed || generation !== this.generation) return;
            draft.id = record.id; draft.revision = record.revision; draft.title = record.title;
            draft.interventions = structuredClone(record.interventions);
            this.savedLayers = new Map(record.layers.map(layer => [layer.id, layer.definition]));
            this.savedFingerprint = documentFingerprint(this.documentFromRecord(record));
            this.state.message = "Planning tool saved for this browser."; void this.loadLibrary();
        } catch (error) {
            if (!this.destroyed && generation === this.generation) {
                this.state.message = "";
                this.state.error = submittingTool && error.status === 409 ? `${error.message} Your changes remain here; reopen the saved tool to review its current version.` : error.message;
            }
        } finally { if (!this.destroyed && generation === this.generation) { this.state.saving = false; this.refreshMapLayers(); } }
    }

    /** Render author-owned state, keeping ordinary map settings authoritative. @return {void} */
    render() {
        if (this.destroyed) return;
        try { this.state.dirty = documentFingerprint(this.buildDocument()) !== this.savedFingerprint; }
        catch { this.state.dirty = this.state.draft !== null; }
        this.view.render(this.state, this.savedLayers);
    }

    /** Stop obsolete read requests; an already submitted save keeps server ownership. @return {void} */
    destroy() {
        this.destroyed = true; ++this.generation; ++this.libraryGeneration; this.cancelIdCheck();
        this.loadAbort?.abort(); this.libraryAbort?.abort(); this.view.destroy();
    }
}
