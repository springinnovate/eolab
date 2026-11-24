/** Save, share and restore map layers, styles and viewport settings. */
import { viewFilter, waitingForPolygonLayer } from "../selected-area.js";

import {
    createSavedMapView,
    parseSavedMapView,
    serializeSavedMapView,
    IncompatibleSavedMap,
} from "./model.js";

const RESTORE_CONCURRENCY = 4;
const REMEMBER_DEBOUNCE_MILLISECONDS = 350;

/** Save map settings and restore portable layers through their source owners. */
export class SavedMapViewController {
    /**
     * Connect map save, share and restore controls to layer owners and browser services.
     *
     * @param {Object} configuration Map adapters, controls and browser services.
     * @param {Object} configuration.view Saved-map DOM adapter.
     * @param {Object} configuration.viewport Neutral viewport adapter.
     * @param {Object} configuration.mapLayers Neutral retained-layer owner.
     * @param {Object} configuration.catalogVisualization Format-neutral
     * preparation, publication, and clearing coordinator.
     * @param {Object} configuration.catalogItems Exact Catalog Item client.
     * @param {string} configuration.viewerVersion Running application version.
     * @param {string} configuration.viewerOrigin Running application origin.
     * @param {Object|null} [configuration.storage] Opaque serialized-view
     * persistence adapter exposing read, write, and clear operations.
     * @param {Object|null} [configuration.initialViewport] Configured canonical
     * viewport used by Reset view.
     * @param {boolean} [configuration.restoreSharedMap=false] Reset to the opening
     * named map and keep personal map storage private to the authoring viewer.
     * @param {(isCurrent:()=>boolean)=>void|Promise<void>} [configuration.beforeRestore] Composition-owned
     * readiness and cleanup before restoring layers. Private startup appearance
     * does not wait for this callback; explicit map actions commit appearance later.
     * Check isCurrent after awaiting readiness before changing retained layers.
     * @param {(record:Object)=>Object|null} [configuration.exportAnnotation] Export a live layer reference through composition.
     * @param {(layer:Object,isCurrent:()=>boolean)=>Promise<string|null>} [configuration.restoreAnnotation] Restore a live layer and return its map key.
     * @param {(record:Object)=>Object|null} [configuration.exportDrawing] Export a linked drawing reference and view, or null for another layer kind.
     * @param {(layer:Object,isCurrent:()=>boolean)=>Promise<{key:string,record:Object,layer:Object}|null>} [configuration.stageDrawing] Prepare a detached drawing through its source owner for the ordinary staged commit, or null after supersession.
     * @param {(record:Object)=>Object|null} configuration.exportUpload Export an upload identifier and map appearance, or null for another layer kind.
     * @param {(layer:Object,isCurrent:()=>boolean)=>Promise<string|null>} configuration.restoreUpload Open this browser's upload with its saved appearance and return its map key, or null after supersession.
     * @param {(record:Object)=>Object|null} [configuration.exportArtifact] Export a private vector result reference and view definitions.
     * @param {(layer:Object,isCurrent:()=>boolean)=>Promise<string|null>} [configuration.restoreArtifact] Reauthorize and restore a private vector result through its run owner.
     * @param {(record:Object)=>Object|null} configuration.exportTemporal Export a temporal selection and raster appearance, or null for another layer kind.
     * @param {(layer:Object,isCurrent:()=>boolean)=>Promise<string|null>} configuration.restoreTemporal Retain an independent temporal row with saved appearance; return its key, including unavailable observations shown with a row error, or null after supersession.
     * @param {Object|null} [configuration.publicationApi] Same-site named-map API client.
     * @param {string|null} [configuration.namedMapSlug] Published map name for a viewer or editor URL.
     * @param {boolean} [configuration.editPublishedMap=false] Load an authenticated draft and save explicitly at its fixed URL.
     * @param {boolean} [configuration.allowPublishing=false] Offer publishing in the authoring app.
     * @param {{title:string,subtitle:string}} [configuration.publicationDefaults] Initial publication labels.
     * @param {()=>Promise<Array<{id:string,title:string}>>} [configuration.listPublisherModels]
     * Discover the recipes visitors can set up, for the publish and edit forms.
     * @param {(title:string,subtitle:string)=>void} [configuration.applyMapHeading] Display a loaded map's identity.
     * @param {(settings:import("../visitor-controls.js").VisitorControls|undefined)=>void}
     * [configuration.applyVisitorControls] Apply a validated public map's choices before restoring its layers.
     * @param {{snapshot:()=>string,restore:(id:string)=>Promise<string|null>}} [configuration.basemap] Public basemap interface.
     * @param {{snapshot:()=>{visible:boolean,collapsed:boolean},restore:(state:Object)=>void}|null} [configuration.mapLegend] Map legend presentation preferences.
     * @param {()=>Date} [configuration.clock] Creation-time provider.
     * @param {(handler:()=>void,delay:number)=>unknown} [configuration.setTimer]
     * Debounce timer provider.
     * @param {(timer:unknown)=>void} [configuration.clearTimer] Timer clearer.
     */
    constructor({
        view,
        viewport,
        mapLayers,
        catalogVisualization,
        catalogItems,
        viewerVersion,
        viewerOrigin,
        storage = null,
        initialViewport = null,
        restoreSharedMap = false,
        beforeRestore = () => {},
        exportAnnotation = () => null,
        restoreAnnotation = async () => { throw new Error("Shared layers are unavailable."); },
        exportDrawing = () => null,
        stageDrawing = async () => { throw new Error("Saved drawings are unavailable."); },
        exportUpload,
        restoreUpload,
        exportArtifact = () => null,
        restoreArtifact = async () => { throw new Error("Run-result layers are unavailable."); },
        exportTemporal,
        restoreTemporal,
        publicationApi = null,
        namedMapSlug = null,
        editPublishedMap = false,
        allowPublishing = false,
        publicationDefaults = { title: "", subtitle: "" },
        listPublisherModels = async () => [],
        applyMapHeading = () => {},
        applyVisitorControls = () => {},
        basemap = { snapshot: () => "detailed", restore: async () => null },
        mapLegend = null,
        clock = () => new Date(),
        setTimer = (handler, delay) => globalThis.setTimeout(handler, delay),
        clearTimer = (timer) => globalThis.clearTimeout(timer),
    }) {
        if (
            storage !== null &&
            (
                typeof storage.read !== "function" ||
                typeof storage.write !== "function" ||
                typeof storage.clear !== "function"
            )
        ) {
            throw new TypeError(
                "Saved-map storage must expose read, write, and clear operations"
            );
        }
        this.view = view;
        this.viewport = viewport;
        this.mapLayers = mapLayers;
        this.catalogVisualization = catalogVisualization;
        this.catalogItems = catalogItems;
        this.viewerVersion = viewerVersion;
        this.viewerOrigin = viewerOrigin;
        this.storage = restoreSharedMap || editPublishedMap ? null : storage;
        this.restoreSharedMap = restoreSharedMap;
        this.beforeRestore = beforeRestore;
        this.exportAnnotation = exportAnnotation;
        this.restoreAnnotation = restoreAnnotation;
        this.exportDrawing = exportDrawing;
        this.stageDrawing = stageDrawing;
        this.exportUpload = exportUpload;
        this.restoreUpload = restoreUpload;
        this.exportArtifact = exportArtifact;
        this.restoreArtifact = restoreArtifact;
        /** @type {Array<{index:number,layer:Object,origin:string}>} Unavailable calculated, result and drawing views retained for the next save or retry. */
        this.unavailableLayers = [];
        this.exportTemporal = exportTemporal;
        this.restoreTemporal = restoreTemporal;
        this.publicationApi = publicationApi;
        this.namedMapSlug = namedMapSlug;
        this.editPublishedMap = editPublishedMap;
        this.editRevision = null;
        this.allowPublishing = allowPublishing;
        this.publicationDefaults = publicationDefaults;
        this.listPublisherModels = listPublisherModels;
        this.editorModelRequest = null;
        this.applyMapHeading = applyMapHeading;
        this.applyVisitorControls = applyVisitorControls;
        this.basemap = basemap;
        this.mapLegend = mapLegend;
        this.publishingView = null;
        this.clock = clock;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.busy = false;
        this.restoreGeneration = 0;
        this.rememberGeneration = 0;
        this.rememberTimer = null;
        this.rememberPending = false;
        this.keepUnsupportedMap = false;
        this.undoView = null;
        this.destroyed = false;
        this.initialView = initialViewport === null
            ? null
            : createSavedMapView({
                viewer: {
                    version: this.viewerVersion,
                    origin: this.viewerOrigin,
                },
                createdAt: this.clock().toISOString(),
                viewport: initialViewport,
                layers: [],
            });
        this.view.bind({
            onCopy: () => void (this.allowPublishing ? this.openPublicationDialog() : this.copyMapLink()),
            onPublish: fields => void this.publishMap(fields),
            onReset: () => void this.resetView(),
            onUndo: () => void this.undoReset(),
            onSavePublishedMap: fields => void this.savePublishedMapChanges(fields),
            onShowUnavailableLayers: () => this.showUnavailableLayers(),
            onRemoveUnavailableLayer: index => this.removeUnavailableLayer(index),
        });
    }

    /**
     * Copy the original published map URL so recipients see the author’s starting view.
     *
     * @return {Promise<void>} Completion after copy or fallback presentation.
     */
    async copyMapLink() {
        if (this.busy || this.destroyed || this.namedMapSlug === null) return;
        this.#setBusy(true);
        try {
            const result = await this.view.copyNamedMapLink(this.namedMapSlug);
            if (result.copied) this.view.showCopied();
            else this.view.showCopyFallback(result.url);
        } catch (error) {
            this.view.showError(asError(error), "copy");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Capture the current map once and offer the creator visitor controls and model choices.
     * @return {Promise<void>} Completion after the open form receives its model choices.
     */
    async openPublicationDialog() {
        if (this.busy || this.destroyed) return;
        this.#setBusy(true);
        try {
            this.publishingView = this.#snapshotCurrentView();
            return this.view.showPublicationForm(this.publicationDefaults, this.#loadPublisherModels());
        } catch (error) {
            this.view.showError(asError(error), "copy");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Read recipe choices for an author form, allowing other settings to be
     * edited and existing selections to be retained when discovery fails.
     * @return {Promise<Array<{id:string,title:string}>|null>} Setup recipes or null on failure.
     */
    async #loadPublisherModels() {
        try { return await this.listPublisherModels(); }
        catch { return null; }
    }

    /**
     * Publish the captured view without replacing an existing named map.
     * A rejected name leaves the form and captured view available for correction.
     * @param {{title:string,subtitle:string,slug:string,visitorControls:import("../visitor-controls.js").VisitorControls}} fields
     * Creator's publication labels and visitor choices.
     * @return {Promise<void>} Completion after success or an actionable form error.
     */
    async publishMap({ visitorControls, ...fields }) {
        if (this.busy || this.destroyed || this.publishingView === null) return;
        this.#setBusy(true);
        this.view.setPublicationBusy(true);
        try {
            const view = { ...this.publishingView, visitorControls };
            const saved = await this.publicationApi.create({ ...fields, view });
            this.publishingView = null;
            this.view.showPublishedMap(saved.slug, saved.editToken);
        } catch (error) {
            this.view.showPublicationError(asError(error).message);
        } finally {
            this.view.setPublicationBusy(false);
            this.#setBusy(false);
        }
    }

    /**
     * Load the named record, then restore it through the ordinary layer owners.
     * A missing record is reported to the visitor without reading personal storage.
     * @return {Promise<void>} Completion after restoring the map or reporting its failure.
     */
    async openNamedMap() {
        if (this.busy || this.destroyed) return;
        this.editRevision = null;
        this.#cancelScheduledRemember();
        const generation = ++this.restoreGeneration;
        this.#setBusy(true);
        this.view.showLoading(0);
        try {
            const saved = await (this.editPublishedMap
                ? this.publicationApi.getForEditing(this.namedMapSlug)
                : this.publicationApi.get(this.namedMapSlug));
            if (this.destroyed || generation !== this.restoreGeneration) return;
            if (!this.editPublishedMap) this.applyVisitorControls(saved.view.visitorControls);
            this.applyMapHeading(saved.title, saved.subtitle);
            this.view.showLoading(saved.view.layers.length);
            const report = await this.#restore(saved.view, generation);
            if (report === null || this.destroyed || generation !== this.restoreGeneration) return;
            this.view.showResults(report);
            if (this.editPublishedMap) {
                const complete = report.loaded === report.total && report.details.length === 0;
                this.editorModelRequest = this.#loadPublisherModels();
                this.editRevision = saved.revision;
                this.view.showPublishedMapEditor(saved, complete, this.editorModelRequest);
            }
        } catch (error) {
            this.view.showError(asError(error), "open");
            if (this.editPublishedMap) this.view.showPublishedMapEditStatus(asError(error).message);
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Capture current map settings and save the draft at its existing published URL.
     * Failures preserve the draft and revision; no shared polygon writes are performed.
     * @param {{title:string,subtitle:string,visitorControls:import("../visitor-controls.js").VisitorControls}} fields
     * Editor's updated headings and visitor choices.
     * @return {Promise<void>} Completion after saved confirmation or an actionable error.
     */
    async savePublishedMapChanges({ visitorControls, ...fields }) {
        if (!this.editPublishedMap || this.editRevision === null || this.busy || this.destroyed) return;
        this.#setBusy(true);
        this.view.setPublishedMapSaving(true);
        try {
            const view = { ...this.#snapshotCurrentView(), visitorControls };
            const saved = await this.publicationApi.update(this.namedMapSlug, {
                ...fields, view, revision: this.editRevision,
            });
            this.editRevision = saved.revision;
            this.applyMapHeading(saved.title, saved.subtitle);
            this.view.showPublishedMapEditor(saved, true, this.editorModelRequest);
            this.view.showPublishedMapEditStatus("Saved. Visitors will see these changes when they open or reload the map.");
        } catch (error) {
            this.view.showPublishedMapEditStatus(asError(error).message);
        } finally {
            this.view.setPublishedMapSaving(false);
            this.#setBusy(false);
        }
    }

    /**
     * Restore the published map named in the URL or the author's private remembered view.
     * A read-only visitor without a map name sees a missing-link error. Private
     * startup applies appearance before loading layers so later edits survive.
     *
     * @return {Promise<void>} Completion after named or private restoration.
     */
    async restoreStartupView() {
        if (this.namedMapSlug !== null) {
            await this.openNamedMap();
            return;
        }
        if (this.restoreSharedMap) {
            this.view.showError(new Error("This link has no map name. Ask the author for the published map link."), "open");
            return;
        }
        if (this.busy || this.destroyed || this.storage === null) return;
        const serialized = this.storage.read();
        if (serialized === null) return;
        let savedMapView;
        try {
            savedMapView = parseSavedMapView(serialized);
        } catch (error) {
            if (error instanceof IncompatibleSavedMap) {
                this.#cancelScheduledRemember();
                this.keepUnsupportedMap = true;
                this.view.showError(new Error("Your remembered map has settings this site cannot open. Choose Reset view to replace the copy in this browser."), "open");
                return;
            }
            this.storage.clear();
            return;
        }
        this.#cancelScheduledRemember();
        const restoreGeneration = this.restoreGeneration + 1;
        this.restoreGeneration = restoreGeneration;
        this.#setBusy(true);
        try {
            const report = await this.#restore(savedMapView, restoreGeneration, {
                restoreAppearanceEarly: true,
            });
            if (report !== null) {
                if (report.loaded !== report.total || report.details.length > 0) this.view.showResults(report);
                this.rememberPending = true;
            }
        } catch {
            this.storage.clear();
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Coalesce persistence after a composition-owned layer or viewport change.
     *
     * The current complete view is validated immediately before storage. A
     * newer change or restore invalidates any older scheduled snapshot.
     *
     * @return {void}
     */
    scheduleRemember() {
        if (this.destroyed || this.storage === null) return;
        if (this.busy) {
            this.rememberPending = true;
            return;
        }
        this.#queueRemember();
    }

    /** Preserve a result view's calculated definitions before its source owner removes it.
     * The source remains inaccessible; only its identity, expressions and presentation are saved.
     * @param {string} key Retained view about to be removed because its source is unavailable.
     * @return {void}
     */
    retainUnavailableLayer(key) {
        const records = this.mapLayers.retainedRecords;
        const index = records.findIndex(record => record.entry.key === key);
        if (index < 0) return;
        const record = records[index];
        const layer = this.exportArtifact(record);
        if (!layer?.calculatedFields?.length) return;
        let savedIndex = index;
        for (const entry of this.unavailableLayers) if (entry.index <= savedIndex) savedIndex += 1;
        this.unavailableLayers.push({index: savedIndex, origin: this.viewerOrigin, layer: {...structuredClone(layer),
            isCustom: record.entry.isCustom, ...(record.entry.legendIncluded === false ? {legendIncluded: false} : {})}});
        this.unavailableLayers.sort((left, right) => left.index - right.index);
        this.view.setUnavailableLayerCount(this.unavailableLayers.length);
        this.view.showResults({loaded: records.length - 1, total: records.length,
            details: [`${record.entry.label} is unavailable. Its calculated fields remain saved.`]});
        this.scheduleRemember();
    }

    /** Present saved unavailable layers without attempting to read their sources.
     * @return {void}
     */
    showUnavailableLayers() {
        if (this.busy || this.destroyed) return;
        this.view.showUnavailableLayers(this.unavailableLayers.map(({index, layer, origin}) => ({index,
            label: layer.customName ?? layer.catalogItem?.id ?? (layer.drawingLayerId ? "Saved drawing" : layer.uploadId ? "Private uploaded layer" : "Private run result"),
            sourceSite: origin === this.viewerOrigin ? null : origin,
            fields: (layer.calculatedFields ?? []).map(field => field.name)})));
    }

    /** Discard one unavailable view's saved settings after an explicit remove action.
     * @param {number} index Saved drawing position supplied by the current unavailable-layer list.
     * @return {void}
     */
    removeUnavailableLayer(index) {
        if (this.busy || this.destroyed) return;
        if (!this.unavailableLayers.some(entry => entry.index === index)) return;
        this.unavailableLayers = this.unavailableLayers.filter(entry => entry.index !== index);
        for (const entry of this.unavailableLayers) if (entry.index > index) entry.index -= 1;
        this.view.setUnavailableLayerCount(this.unavailableLayers.length);
        this.showUnavailableLayers();
        this.scheduleRemember();
    }

    /**
     * Restore the opening shared map, or reset the authoring map with one-step undo.
     *
     * @return {Promise<void>} Completion after the atomic restore transaction.
     */
    async resetView() {
        if (this.restoreSharedMap) {
            await this.restoreStartupView();
            return;
        }
        if (this.busy || this.destroyed || this.initialView === null) return;
        this.#cancelScheduledRemember();
        const restoreGeneration = this.restoreGeneration + 1;
        this.restoreGeneration = restoreGeneration;
        this.#setBusy(true);
        try {
            const previousView = this.#snapshotCurrentView();
            const report = await this.#restore(
                this.initialView,
                restoreGeneration
            );
            if (report === null) return;
            this.undoView = previousView;
            this.keepUnsupportedMap = false;
            this.storage?.write(serializeSavedMapView(this.initialView));
            this.view.showUndoReset();
            this.rememberPending = true;
        } catch (error) {
            this.view.showError(asError(error), "reset");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Restore and consume the validated view captured immediately before reset.
     * Report any layers that can no longer be opened, including deleted uploads.
     * Local persistence failures do not interrupt the restored map or its controls.
     *
     * @return {Promise<void>} Completion after the atomic restore transaction.
     */
    async undoReset() {
        if (this.busy || this.destroyed || this.undoView === null) return;
        this.#cancelScheduledRemember();
        const savedMapView = this.undoView;
        const restoreGeneration = this.restoreGeneration + 1;
        this.restoreGeneration = restoreGeneration;
        this.#setBusy(true);
        try {
            const report = await this.#restore(savedMapView, restoreGeneration);
            if (report === null) return;
            this.undoView = null;
            try {
                this.storage?.write(serializeSavedMapView(savedMapView));
            } catch {
                // A live map can exceed the save limit and still be restored by undo.
            }
            this.view.hideUndoReset();
            if (report.loaded !== report.total || report.details.length > 0) this.view.showResults(report);
            this.rememberPending = true;
        } catch (error) {
            this.view.showError(asError(error), "undo");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Detach UI events owned by this coordinator.
     *
     * @return {void}
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.restoreGeneration += 1;
        this.#cancelScheduledRemember();
        this.view.unbind();
    }

    /** Export one retained layer through its ordinary portable definition.
     * Runtime map keys are omitted; independent callers retain their own bindings.
     * @param {string} key Retained map view key.
     * @return {Object} Detached source identity, filter, fields and appearance.
     * @throws {Error} If the view is missing or its source owner cannot export it.
     */
    exportLayer(key) {
        const record = this.mapLayers.retainedRecords.find(value => value.entry.key === key);
        const layer = record ? this.#exportRetainedLayer(record) : null;
        if (!layer) throw new Error("Choose an available layer to save.");
        return structuredClone(layer);
    }

    /** Add portable Catalog and drawing views without replacing the map or changing its viewport.
     * All views remain detached until every source is ready. Failure or cancellation
     * discards this addition while preserving existing map layers and edits.
     * Other source kinds may reuse existing views and are not accepted by this atomic addition.
     * @param {Object[]} definitions Ordinary portable Catalog or drawing layer definitions.
     * @param {()=>boolean} isCurrent Whether the caller still wants this addition.
     * @return {Promise<Array<{key:string|null,error:string|null}>>} Results in input order.
     * @throws {Error} If the portable document is invalid or contains another source kind.
     */
    async restoreLayers(definitions, isCurrent) {
        const document = createSavedMapView({viewer: {version: this.viewerVersion, origin: this.viewerOrigin},
            createdAt: this.clock().toISOString(), viewport: {center: {latitude: 0, longitude: 0}, zoom: 0}, layers: definitions});
        if (document.layers.some(layer => !layer.catalogItem && !layer.drawingLayerId)) {
            throw new Error("Only Catalog layers and saved drawings can be added here.");
        }
        const generation = this.restoreGeneration;
        /** @type {()=>boolean} Whether the caller and map still own this addition. */
        const stillCurrent = () => !this.destroyed && generation === this.restoreGeneration && isCurrent();
        const prepared = new Array(document.layers.length);
        const attached = new Set();
        try {
            for (const [index, layer] of document.layers.entries()) {
                if (!layer.catalogItem) continue;
                if (!stillCurrent()) throw new Error("Layer restoration was cancelled.");
                const result = await this.#restoreLayer(layer, document.viewer.origin, stillCurrent, {strictStyle: true});
                if (!result.staged) throw new Error(result.detail);
                prepared[index] = result;
            }
            for (const [index, layer] of document.layers.entries()) {
                if (!layer.drawingLayerId) continue;
                if (!stillCurrent()) throw new Error("Layer restoration was cancelled.");
                const result = await this.#restoreLayer(layer, document.viewer.origin, stillCurrent);
                if (!result.staged) throw new Error(result.detail ?? "Layer restoration was cancelled.");
                prepared[index] = result;
            }
            if (!stillCurrent()) throw new Error("Layer restoration was cancelled.");
            for (const [index, result] of prepared.entries()) {
                this.mapLayers.restoreStagedLayer(result.staged, index);
                attached.add(result.staged.key);
                this.mapLayers.setLegendIncluded(result.staged.key, document.layers[index].legendIncluded !== false);
            }
            const keys = prepared.map(result => result.staged.key);
            return keys.map(key => ({key, error: null}));
        } catch (error) {
            for (const result of prepared) {
                if (!result) continue;
                const key = result.staged.key;
                if (attached.has(key)) this.mapLayers.removeKey(key);
                else { result.staged.record.adapter.discardStaged?.(result.staged.record); result.staged.layer?.remove?.(); }
            }
            return definitions.map(() => ({key: null, error: asError(error).message}));
        }
    }

    /** Export a retained record with its source reference and map-specific presentation.
     * @param {Object} record Neutral retained-layer record.
     * @return {Object|null} Portable view, or null for an unsaved local source.
     * @throws {Error} If the source owner's saved state cannot be exported.
     */
    #exportRetainedLayer(record) {
        const layer = this.exportTemporal(record) ?? (record.entry.item === null
            ? this.exportUpload(record) ?? this.exportArtifact(record) ?? this.exportDrawing(record) ?? this.exportAnnotation(record)
            : this.#exportCatalogLayer(record));
        if (layer === null) return null;
        const filter = record.requestedSpatialFilter ?? layer.filter;
        return {...layer, isCustom: record.entry.isCustom,
            ...(record.filterViewId ? {filterViewId: record.filterViewId} : {}),
            ...(record.fieldFormats && Object.keys(record.fieldFormats).length ? {fieldFormats: record.fieldFormats} : {}),
            ...(filter?.rules?.some(rule => rule.operator === "intersects") ? {filter: viewFilter(filter)} : {}),
            ...(record.entry.legendIncluded === false ? {legendIncluded: false} : {})};
    }

    /**
     * Capture layer identifiers and map appearance in drawing order.
     * Every exported layer records whether its card is Catalog or Custom.
     * Upload references grant no access; GeoPackage contents and browser credentials are excluded.
     *
     * @return {Readonly<Object>} Validated portable map document.
     * @throws {Error} If a layer cannot be exported or the saved document is invalid.
     */
    #snapshotCurrentView() {
        const records = this.mapLayers.retainedRecords;
        const viewport = this.viewport.snapshot();
        const layers = records.map(record => this.#exportRetainedLayer(record));
        const retainedLayers = layers.filter(layer => layer !== null);
        const sourceOrigins = new Set(retainedLayers.some(layer => layer.uploadId || layer.runArtifact || layer.sharedAnnotation || layer.drawingLayerId) ? [this.viewerOrigin] : []);
        for (const entry of this.unavailableLayers) {
            if (entry.layer.uploadId || entry.layer.runArtifact || entry.layer.drawingLayerId) sourceOrigins.add(entry.origin);
        }
        if (sourceOrigins.size > 1) throw new Error("This map includes layers linked to different EOLab sites. Open Unavailable layers and remove those saved layers, or remove this site's linked layers before saving.");
        for (const entry of this.unavailableLayers) retainedLayers.splice(Math.min(entry.index, retainedLayers.length), 0, structuredClone(entry.layer));
        return createSavedMapView({
            viewer: {
                version: this.viewerVersion,
                origin: sourceOrigins.values().next().value ?? this.viewerOrigin,
            },
            createdAt: this.clock().toISOString(),
            viewport,
            basemap: this.basemap.snapshot(),
            ...(this.mapLegend ? { mapLegend: this.mapLegend.snapshot() } : {}),
            layers: retainedLayers,
        });
    }

    /**
     * Export one layer through its feature-owned portable-style hook.
     *
     * @param {Object} record Neutral retained-layer record.
     * @return {Object} Portable identity and presentation.
     * @throws {Error} If the adapter cannot export the layer's saved state.
     */
    #exportCatalogLayer(record) {
        if (typeof record.adapter.exportSavedState !== "function") {
            throw new Error(
                `${record.entry.label} cannot yet be saved as a portable layer.`
            );
        }
        return {
            catalogItem: {
                collection: record.entry.item.collection,
                id: record.entry.item.id,
            },
            visible: record.entry.visible,
            opacity: record.entry.opacity,
            ...(record.entry.customName ? { customName: record.entry.customName } : {}),
            style: record.adapter.exportSavedState(record),
            ...(record.adapter.exportFilterState ? { filter: record.adapter.exportFilterState(record) } : {}),
            ...(record.adapter.exportCalculatedFields ? {calculatedFields: record.adapter.exportCalculatedFields(record)} : {}),
        };
    }

    /**
     * Restore saved layers through their owners and apply the saved drawing order.
     * Saved Custom presentation overrides the source owner's admission default.
     * Private uploads, saved drawings and shared layers must belong to this deployment; their
     * owners enforce browser access before returning a map key.
     * Layers removed while other sources are loading stay out of the final order.
     *
     * @param {Object} savedMapView Validated saved-map document.
     * @param {number} restoreGeneration Current restoration generation.
     * @param {Object} [options] Restoration timing.
     * @param {boolean} [options.restoreAppearanceEarly=false] Apply private startup
     * appearance before preparing layers; explicit map actions apply it at commit.
     * @return {Promise<{loaded:number,total:number,details:string[]}|null>}
     * Per-layer restoration report, or null after supersession.
     */
    async #restore(savedMapView, restoreGeneration, { restoreAppearanceEarly = false } = {}) {
        const restoreReady = this.beforeRestore(() => !this.destroyed && restoreGeneration === this.restoreGeneration);
        this.catalogVisualization.clear();
        const initialAppearance = restoreAppearanceEarly
            ? this.#restoreViewportAndBasemap(savedMapView) : null;
        if (restoreAppearanceEarly) {
            this.mapLegend?.restore(savedMapView.mapLegend ?? { visible: true, collapsed: false });
        }
        const preparingLayers = Promise.resolve(restoreReady).then(() => {
            if (this.destroyed || restoreGeneration !== this.restoreGeneration) return null;
            return mapWithConcurrencyLimit(
                savedMapView.layers,
                RESTORE_CONCURRENCY,
                layer => this.#restoreLayer(layer, savedMapView.viewer.origin,
                    () => !this.destroyed && restoreGeneration === this.restoreGeneration)
            );
        });
        const [preparations, initialBasemapWarning] = await Promise.all([
            preparingLayers, initialAppearance,
        ]);
        if (preparations === null) return null;
        const stagedLayers = preparations
            .filter(({ staged }) => staged !== null)
            .map(({ staged }) => staged);
        if (this.destroyed || restoreGeneration !== this.restoreGeneration) {
            this.#discardLayers(stagedLayers);
            return null;
        }
        const basemapWarning = restoreAppearanceEarly ? initialBasemapWarning
            : await this.#restoreViewportAndBasemap(savedMapView);
        if (this.destroyed || restoreGeneration !== this.restoreGeneration) {
            this.#discardLayers(stagedLayers);
            return null;
        }
        try {
            this.mapLayers.commitStaged(stagedLayers, { fitToBounds: false });
        } catch (error) {
            this.#discardLayers(stagedLayers);
            throw error;
        }
        const retainedKeys = new Set(this.mapLayers.retainedRecords.map(record => record.entry.key));
        for (const [index, result] of preparations.entries()) {
            if (result.key && !retainedKeys.has(result.key)) {
                result.key = null;
                result.removed = true;
                result.detail = `${savedMapView.layers[index].customName ?? "A saved layer"} was removed from the map while it was opening.`;
            }
            const key = result.key ?? result.staged?.record.entry.key;
            if (key) this.mapLayers.setLegendIncluded(key, savedMapView.layers[index].legendIncluded !== false);
            if (result.key && Object.hasOwn(savedMapView.layers[index], "isCustom")) {
                this.mapLayers.setCustomLayer(result.key, savedMapView.layers[index].isCustom);
            }
        }
        if (!restoreAppearanceEarly) {
            this.mapLegend?.restore(savedMapView.mapLegend ?? { visible: true, collapsed: false });
        }
        const keys = preparations.map(result => result.key ?? result.staged?.record.entry.key).filter(Boolean);
        this.unavailableLayers = preparations.flatMap((result, index) => {
            const layer = savedMapView.layers[index];
            return !result.key && !result.staged && !result.removed && (layer.calculatedFields?.length || layer.runArtifact || layer.drawingLayerId)
                ? [{index, layer: structuredClone(layer), origin: savedMapView.viewer.origin}] : [];
        });
        this.view.setUnavailableLayerCount(this.unavailableLayers.length);
        // Older callers may expose only catalog staging; mixed maps require explicit ordering.
        if (preparations.some(result => result.key)) {
            const otherKeys = this.mapLayers.retainedRecords.map(record => record.entry.key).filter(key => !keys.includes(key));
            this.mapLayers.restoreOrder([...keys, ...otherKeys]);
        }
        return {
            loaded: stagedLayers.length + preparations.filter(result => result.key).length,
            total: savedMapView.layers.length,
            details: [...(basemapWarning ? [basemapWarning] : []),
                ...(this.unavailableLayers.length ? ["Unavailable layers remain saved. Use Unavailable layers to review or remove them, or reopen this map to retry."] : []), ...preparations
                .map(({ detail }) => detail)
                .filter((detail) => detail !== null)],
        };
    }

    /**
     * Apply the saved viewport and start loading its basemap through their owners.
     * @param {Object} savedMapView Validated saved-map document.
     * @return {Promise<string|null>} Warning if the saved basemap is unavailable.
     */
    async #restoreViewportAndBasemap(savedMapView) {
        this.viewport.restore(savedMapView.viewport);
        return savedMapView.basemap === undefined ? null : this.basemap.restore(savedMapView.basemap);
    }

    /** Release detached layers after cancellation or a failed synchronous batch commit.
     * @param {Array<{record:Object,layer:Object}>} stagedLayers Prepared layers that did not complete attachment.
     * @return {void}
     */
    #discardLayers(stagedLayers) {
        for (const staged of stagedLayers) {
            staged.record.adapter.discardStaged?.(staged.record);
            staged.layer?.remove?.();
        }
    }

    /** Restore one portable view through its source owner, staging Catalog and drawing views until commit.
     * Instance-local identifiers never reach a source owner on a different EOLab site.
     * @param {Object} layer Validated portable layer definition.
     * @param {string} origin Original EOLab site for instance-local sources.
     * @param {()=>boolean} isCurrent Whether the restore still owns its result.
     * @param {{strictStyle?:boolean}} [options] Require exact Catalog appearance for atomic additions.
     * @return {Promise<{key?:string|null,staged:Object|null,detail:string|null}>} Detached view, attached source-owned key or failure detail.
     */
    async #restoreLayer(savedLayer, origin, isCurrent, {strictStyle = false} = {}) {
        const spatial = savedLayer.filter?.rules?.some(rule => rule.operator === "intersects");
        const layer = spatial ? {...savedLayer, filter: waitingForPolygonLayer(savedLayer.filter)} : savedLayer;
        const result = await this.#openLayer(layer, origin, isCurrent, {strictStyle});
        if (!savedLayer.filterViewId && !spatial && !savedLayer.fieldFormats) return result;
        const record = result.staged?.record ?? (result.key ? this.mapLayers.getRecord(result.key) : null);
        if (record && savedLayer.filterViewId) record.filterViewId = savedLayer.filterViewId;
        if (record && spatial && savedLayer.filter.enabled) record.requestedSpatialFilter = savedLayer.filter;
        if (record && savedLayer.fieldFormats) record.fieldFormats = savedLayer.fieldFormats;
        return result;
    }

    /** Open one source's saved presentation through its ordinary catalog, upload or drawing owner.
     * @param {Object} layer Source and presentation ready to stage.
     * @param {string} origin Original EOLab site.
     * @param {()=>boolean} isCurrent Whether the caller still owns this restore.
     * @param {{strictStyle:boolean}} options Whether a failed style prevents attachment.
     * @return {Promise<Object>} Staged or attached view, or the owner's error.
     */
    async #openLayer(layer, origin, isCurrent, {strictStyle}) {
        if (layer.catalogItem) return this.#prepareLayer(layer, {strictStyle});
        let restore, label, sourceLabel;
        if (layer.drawingLayerId) {
            restore = this.stageDrawing;
            label = layer.customName ?? "Saved drawing";
            sourceLabel = "Saved drawings";
        } else if (layer.runArtifact) {
            restore = this.restoreArtifact;
            label = layer.customName ?? "Private run result";
            sourceLabel = "Private run results";
        } else if (layer.temporalSource) {
            restore = this.restoreTemporal;
            label = layer.customName ?? layer.temporalSource.variable;
        } else if (layer.uploadId) {
            restore = this.restoreUpload;
            label = layer.customName ?? "Private uploaded layer";
            sourceLabel = "Private uploaded layers";
        } else {
            restore = this.restoreAnnotation;
            label = `Shared layer ${layer.sharedAnnotation.id}`;
            sourceLabel = "Shared layers";
        }
        try {
            if (sourceLabel && origin !== this.viewerOrigin) {
                throw new Error(`${sourceLabel} can only be opened on their original EOLab site.`);
            }
            const restored = await restore(layer, isCurrent);
            return layer.drawingLayerId ? {staged: restored, detail: null} : {key: restored, staged: null, detail: null};
        } catch (error) {
            return {staged: null, detail: `${label}: ${asError(error).message}`};
        }
    }

    /**
     * Resolve, validate, publish, and style one detached saved Catalog source.
     * Restore its exact appearance when the adapter distinguishes restoration from style paste.
     * Retain its explicit Catalog or Custom card presentation independently of its row key.
     *
     * @param {Object} layer Validated saved-layer document.
     * @param {{strictStyle?:boolean}} [options] Reject a failed style instead of restoring with a warning.
     * @return {Promise<{staged:Object|null,detail:string|null}>} Detached layer and
     * ordered user-facing outcome, or a failure detail without a layer.
     */
    async #prepareLayer(layer, {strictStyle = false} = {}) {
        const identityLabel =
            `${layer.catalogItem.collection}/${layer.catalogItem.id}`;
        let staged = null;
        try {
            const catalogItem = await this.catalogItems.get(
                layer.catalogItem
            );
            const preparedItem = await this.catalogVisualization.prepare(
                catalogItem
            );
            staged = await this.catalogVisualization.stage(
                preparedItem,
                { key: `local:view:${globalThis.crypto.randomUUID()}`, visible: layer.visible, opacity: layer.opacity,
                    isCustom: layer.isCustom ?? false,
                    ...(layer.customName ? { customName: layer.customName } : {}) }
            );
            const record = staged.record;
            if (typeof record.adapter.applySavedState !== "function") {
                throw new Error("Layer style restoration is unavailable.");
            }
            let styleWarning = null;
            if (layer.calculatedFields?.length) await record.adapter.restoreCalculatedFields(record, layer.calculatedFields);
            try {
                if (record.adapter.restoreSavedState) await record.adapter.restoreSavedState(record, layer.style);
                else await record.adapter.applySavedState(record, layer.style);
            } catch (error) {
                if (strictStyle || layer.calculatedFields?.length) throw error;
                styleWarning = asError(error).message;
            }
            // A failed filter must never restore an unexpectedly unfiltered layer.
            if (Object.hasOwn(layer, "filter")) {
                if (typeof record.adapter.applyFilterState !== "function") {
                    throw new Error("This layer does not support saved filters.");
                }
                await record.adapter.applyFilterState(record, layer.filter);
            }
            const detail = styleWarning === null
                ? null
                : `${record.entry.label}: saved style was not applied: ${styleWarning}.`;
            return { staged, detail };
        } catch (error) {
            if (staged) { staged.record.adapter.discardStaged?.(staged.record); staged.layer?.remove?.(); }
            return {
                staged: null,
                detail: `${identityLabel}: ${asError(error).message}`,
            };
        }
    }

    /**
     * Update controller and view busy state together.
     *
     * @param {boolean} busy Whether a bounded operation is active.
     * @return {void}
     */
    #setBusy(busy) {
        this.busy = busy;
        this.view.setBusy(busy);
        if (!busy && this.rememberPending) {
            this.rememberPending = false;
            this.#queueRemember();
        }
    }

    /**
     * Debounce one validated local snapshot.
     *
     * @return {void}
     */
    #queueRemember() {
        if (this.storage === null || this.destroyed || this.keepUnsupportedMap) return;
        this.rememberGeneration += 1;
        const generation = this.rememberGeneration;
        if (this.rememberTimer !== null) {
            this.clearTimer(this.rememberTimer);
        }
        this.rememberTimer = this.setTimer(() => {
            this.rememberTimer = null;
            this.#remember(generation);
        }, REMEMBER_DEBOUNCE_MILLISECONDS);
    }

    /**
     * Persist only a still-current validated complete-view snapshot.
     *
     * Storage failures are deliberately private and non-blocking.
     *
     * @param {number} generation Scheduled persistence generation.
     * @return {void}
     */
    #remember(generation) {
        try {
            const savedMapView = this.#snapshotCurrentView();
            if (
                this.destroyed ||
                this.busy ||
                generation !== this.rememberGeneration
            ) {
                return;
            }
            this.storage.write(serializeSavedMapView(savedMapView));
        } catch {
            // Local persistence must never interrupt the active map.
        }
    }

    /** Invalidate scheduled or in-flight local snapshots. @return {void} */
    #cancelScheduledRemember() {
        this.rememberGeneration += 1;
        this.rememberPending = false;
        if (this.rememberTimer !== null) {
            this.clearTimer(this.rememberTimer);
            this.rememberTimer = null;
        }
    }
}

/**
 * Transform inputs concurrently while preserving order and limiting active promises.
 *
 * @template Input, Output
 * @param {Input[]} inputs Ordered input values.
 * @param {number} concurrency Positive maximum number of active workers.
 * @param {(input:Input,index:number)=>Promise<Output>} transform Async mapper.
 * @return {Promise<Output[]>} Results in the same order as inputs.
 * @throws {TypeError} If concurrency is not a positive integer.
 * @throws {Error} If any transformation fails.
 */
async function mapWithConcurrencyLimit(inputs, concurrency, transform) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new TypeError("Restore concurrency must be a positive integer.");
    }
    const results = new Array(inputs.length);
    let nextIndex = 0;
    /** Transform the next unclaimed input until all inputs have been assigned.
     * @return {Promise<void>} Completion after this worker's transformations finish.
     * @throws {Error} If a transformation fails.
     */
    async function transformQueuedInputs() {
        while (nextIndex < inputs.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await transform(inputs[index], index);
        }
    }
    const workerCount = Math.min(concurrency, inputs.length);
    await Promise.all(Array.from({ length: workerCount }, transformQueuedInputs));
    return results;
}

/**
 * Convert thrown values to ordinary Error instances for presentation.
 *
 * @param {unknown} candidate Thrown value.
 * @return {Error} Safe ordinary Error instance.
 */
function asError(candidate) {
    return candidate instanceof Error
        ? candidate
        : new Error("Saved map operation failed.");
}
