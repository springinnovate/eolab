/** Portable saved-map orchestration over existing Catalog and map owners. */

import {
    decodeSavedMapViewFragment,
    encodeSavedMapViewFragment,
    isSavedMapViewFragment,
} from "./fragment-codec.js";
import {
    createSavedMapView,
    hashSavedMapSourceRevision,
    MAX_SAVED_MAP_VIEW_BYTES,
    parseSavedMapView,
    serializeSavedMapView,
} from "./model.js";

const RESTORE_CONCURRENCY = 4;
const REMEMBER_DEBOUNCE_MILLISECONDS = 350;

/** Coordinate shareable map views without becoming a rendering owner. */
export class SavedMapViewController {
    /**
     * Create and bind the portable saved-map coordinator.
     *
     * @param {Object} configuration Collaborating public boundaries.
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
     * shared fragment, ignore private autosave, and leave personal storage untouched.
     * @param {()=>void} [configuration.beforeRestore] Composition-owned cleanup
     * for transient map presentations excluded from the portable contract.
     * @param {(record:Object)=>Object|null} [configuration.exportAnnotation] Export a live layer reference through composition.
     * @param {(layer:Object,isCurrent:()=>boolean)=>Promise<string|null>} [configuration.restoreAnnotation] Restore a live layer and return its map key.
     * @param {Object|null} [configuration.publicationApi] Same-site named-map API client.
     * @param {string|null} [configuration.namedMapSlug] URL name to load instead of fragments or private autosave.
     * @param {boolean} [configuration.editPublishedMap=false] Load an authenticated draft and save explicitly at its fixed URL.
     * @param {boolean} [configuration.allowPublishing=false] Offer publishing in the authoring app.
     * @param {{title:string,subtitle:string}} [configuration.publicationDefaults] Initial publication labels.
     * @param {(title:string,subtitle:string)=>void} [configuration.applyMapHeading] Display a loaded map's identity.
     * @param {{snapshot:()=>string,restore:(id:string)=>Promise<string|null>}} [configuration.basemap] Public basemap interface.
     * @param {()=>Date} [configuration.clock] Creation-time provider.
     * @param {SubtleCrypto} [configuration.subtleCrypto] Revision hasher.
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
        publicationApi = null,
        namedMapSlug = null,
        editPublishedMap = false,
        allowPublishing = false,
        publicationDefaults = { title: "", subtitle: "" },
        applyMapHeading = () => {},
        basemap = { snapshot: () => "detailed", restore: async () => null },
        clock = () => new Date(),
        subtleCrypto = globalThis.crypto?.subtle,
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
        this.startingFragment = null;
        this.beforeRestore = beforeRestore;
        this.exportAnnotation = exportAnnotation;
        this.restoreAnnotation = restoreAnnotation;
        this.publicationApi = publicationApi;
        this.namedMapSlug = namedMapSlug;
        this.editPublishedMap = editPublishedMap;
        this.editRevision = null;
        this.allowPublishing = allowPublishing;
        this.publicationDefaults = publicationDefaults;
        this.applyMapHeading = applyMapHeading;
        this.basemap = basemap;
        this.publishingView = null;
        this.clock = clock;
        this.subtleCrypto = subtleCrypto;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.busy = false;
        this.restoreGeneration = 0;
        this.rememberGeneration = 0;
        this.rememberTimer = null;
        this.rememberPending = false;
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
        });
    }

    /**
     * Copy the original named URL, or a compressed link for an older fragment view.
     *
     * @return {Promise<void>} Completion after copy or fallback presentation.
     */
    async copyMapLink() {
        if (this.busy || this.destroyed) return;
        this.#setBusy(true);
        try {
            if (this.namedMapSlug !== null) {
                const result = await this.view.copyNamedMapLink(this.namedMapSlug);
                if (result.copied) this.view.showCopied();
                else this.view.showCopyFallback(result.url);
                return;
            }
            const savedMapView = await this.#snapshotCurrentView();
            const fragment = await encodeSavedMapViewFragment(
                serializeSavedMapView(savedMapView),
                { maximumInputBytes: MAX_SAVED_MAP_VIEW_BYTES }
            );
            const result = await this.view.copyLink(fragment);
            if (result.copied) this.view.showCopied();
            else this.view.showCopyFallback(result.url);
        } catch (error) {
            this.view.showError(asError(error), "copy");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Capture the current map once and ask the creator for publication labels.
     * @return {Promise<void>} Completion when the form or capture error is displayed.
     */
    async openPublicationDialog() {
        if (this.busy || this.destroyed) return;
        this.#setBusy(true);
        try {
            this.publishingView = await this.#snapshotCurrentView();
            this.view.showPublicationForm(this.publicationDefaults);
        } catch (error) {
            this.view.showError(asError(error), "copy");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Publish the captured view without replacing an existing named map.
     * A rejected name leaves the form and captured view available for correction.
     * @param {{title:string,subtitle:string,slug:string}} fields Creator's publication labels.
     * @return {Promise<void>} Completion after success or an actionable form error.
     */
    async publishMap(fields) {
        if (this.busy || this.destroyed || this.publishingView === null) return;
        this.#setBusy(true);
        this.view.setPublicationBusy(true);
        try {
            const saved = await this.publicationApi.create({ ...fields, view: this.publishingView });
            this.publishingView = null;
            this.view.showPublishedMap(saved.slug);
        } catch (error) {
            this.view.showPublicationError(asError(error).message);
        } finally {
            this.view.setPublicationBusy(false);
            this.#setBusy(false);
        }
    }

    /**
     * Load the named record, then restore it through the ordinary layer owners.
     * Never falls back to a fragment or private map when a record cannot be loaded.
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
            this.applyMapHeading(saved.title, saved.subtitle);
            this.view.showLoading(saved.view.layers.length);
            const report = await this.#restore(saved.view, generation);
            if (report !== null) this.view.showResults(report);
            if (this.editPublishedMap && report !== null) {
                const complete = report.loaded === report.total && report.details.length === 0;
                this.editRevision = complete ? saved.revision : null;
                this.view.showPublishedMapEditor(saved, complete);
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
     * @param {{title:string,subtitle:string}} fields Administrator's edited headings.
     * @return {Promise<void>} Completion after saved confirmation or an actionable error.
     */
    async savePublishedMapChanges(fields) {
        if (!this.editPublishedMap || this.editRevision === null || this.busy || this.destroyed) return;
        this.#setBusy(true);
        this.view.setPublishedMapSaving(true);
        try {
            const view = await this.#snapshotCurrentView();
            const saved = await this.publicationApi.update(this.namedMapSlug, {
                ...fields, view, revision: this.editRevision,
            });
            this.editRevision = saved.revision;
            this.applyMapHeading(saved.title, saved.subtitle);
            this.view.showPublishedMapEditor(saved, true);
            this.view.showPublishedMapEditStatus("Saved. Visitors will see these changes when they open or reload the map.");
        } catch (error) {
            this.view.showPublishedMapEditStatus(asError(error).message);
        } finally {
            this.view.setPublishedMapSaving(false);
            this.#setBusy(false);
        }
    }

    /**
     * Validate and restore one shared map fragment.
     *
     * Unrelated fragments are ignored so this component does not own other
     * application anchors.
     *
     * @param {string} fragment Current browser URL fragment.
     * @return {Promise<void>} Completion after restoration.
     */
    async openSharedFragment(fragment) {
        if (!isSavedMapViewFragment(fragment)) return;
        if (this.busy || this.destroyed) return;
        this.#cancelScheduledRemember();
        const restoreGeneration = this.restoreGeneration + 1;
        this.restoreGeneration = restoreGeneration;
        this.#setBusy(true);
        try {
            const serialized = await decodeSavedMapViewFragment(fragment, {
                maximumOutputBytes: MAX_SAVED_MAP_VIEW_BYTES,
            });
            const savedMapView = parseSavedMapView(serialized);
            this.view.showLoading(savedMapView.layers.length);
            const report = await this.#restore(
                savedMapView,
                restoreGeneration
            );
            if (report !== null) {
                this.view.showResults(report);
                this.rememberPending = true;
            }
        } catch (error) {
            this.view.showError(asError(error), "open");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Restore the authoritative startup source with shared-link precedence.
     *
     * A named URL takes precedence over fragments and private storage.
     * Otherwise an owned `#view=` fragment is attempted and never falls back to
     * private storage when malformed. Authoring mode can restore the last
     * validated origin-local document without a fragment; a shared viewer
     * requires a shared fragment and never restores private map storage.
     *
     * @param {string} fragment Current browser URL fragment.
     * @return {Promise<void>} Completion after shared or local restoration.
     */
    async restoreStartupView(fragment) {
        if (this.namedMapSlug !== null) {
            await this.openNamedMap();
            return;
        }
        if (this.restoreSharedMap) {
            this.startingFragment = fragment;
            if (!isSavedMapViewFragment(fragment)) {
                this.view.showError(new Error("This shared viewer needs a map link. Ask the map author for the complete link."), "open");
                return;
            }
        }
        if (isSavedMapViewFragment(fragment)) {
            await this.openSharedFragment(fragment);
            return;
        }
        if (this.busy || this.destroyed || this.storage === null) return;
        const serialized = this.storage.read();
        if (serialized === null) return;
        let savedMapView;
        try {
            savedMapView = parseSavedMapView(serialized);
        } catch {
            this.storage.clear();
            return;
        }
        this.#cancelScheduledRemember();
        const restoreGeneration = this.restoreGeneration + 1;
        this.restoreGeneration = restoreGeneration;
        this.#setBusy(true);
        try {
            const report = await this.#restore(savedMapView, restoreGeneration);
            if (report !== null) this.rememberPending = true;
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
     * newer change or restore invalidates any older asynchronous snapshot.
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

    /**
     * Restore the opening shared map, or reset the authoring map with one-step undo.
     *
     * @return {Promise<void>} Completion after the atomic restore transaction.
     */
    async resetView() {
        if (this.restoreSharedMap) {
            await this.restoreStartupView(this.startingFragment ?? "");
            return;
        }
        if (this.busy || this.destroyed || this.initialView === null) return;
        this.#cancelScheduledRemember();
        const restoreGeneration = this.restoreGeneration + 1;
        this.restoreGeneration = restoreGeneration;
        this.#setBusy(true);
        try {
            const previousView = await this.#snapshotCurrentView();
            const report = await this.#restore(
                this.initialView,
                restoreGeneration
            );
            if (report === null) return;
            this.undoView = previousView;
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
            this.storage?.write(serializeSavedMapView(savedMapView));
            this.view.hideUndoReset();
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

    /**
     * Capture catalog layers and portable live-annotation references in map order.
     * Annotation polygons and private membership credentials never enter this document.
     *
     * @return {Promise<Readonly<Object>>} Validated portable map document.
     */
    async #snapshotCurrentView() {
        const records = this.mapLayers.retainedRecords;
        const viewport = this.viewport.snapshot();
        const layers = await Promise.all(
            records.map(async (record) => record.entry.item === null
                ? this.exportAnnotation(record) : this.#exportLayer(record))
        );
        return createSavedMapView({
            viewer: {
                version: this.viewerVersion,
                origin: this.viewerOrigin,
            },
            createdAt: this.clock().toISOString(),
            viewport,
            basemap: this.basemap.snapshot(),
            layers: layers.filter(layer => layer !== null),
        });
    }

    /**
     * Export one layer through its feature-owned portable-style hook.
     *
     * @param {Object} record Neutral retained-layer record.
     * @return {Promise<Object>} Portable identity, revision, and presentation.
     */
    async #exportLayer(record) {
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
            sourceRevision: await hashSavedMapSourceRevision(
                this.catalogVisualization.sourceRevision(record.entry.item),
                this.subtleCrypto
            ),
            visible: record.entry.visible,
            opacity: record.entry.opacity,
            ...(record.entry.customName ? { customName: record.entry.customName } : {}),
            style: record.adapter.exportSavedState(record),
            ...(record.adapter.exportFilterState ? { filter: record.adapter.exportFilterState(record) } : {}),
        };
    }

    /**
     * Prepare saved layers concurrently, restore the viewport, then commit
     * them top-first.
     *
     * @param {Object} savedMapView Validated saved-map document.
     * @param {number} restoreGeneration Current restoration generation.
     * @return {Promise<{loaded:number,total:number,details:string[]}|null>}
     * Per-layer restoration report, or null after supersession.
     */
    async #restore(savedMapView, restoreGeneration) {
        this.beforeRestore();
        this.catalogVisualization.clear();
        const preparations = await mapBounded(
            savedMapView.layers,
            RESTORE_CONCURRENCY,
            async (layer) => {
                if (!layer.sharedAnnotation) return this.#prepareLayer(layer);
                try {
                    if (savedMapView.viewer.origin !== this.viewerOrigin) {
                        throw new Error("Shared layers can only be opened on their original EOLab site.");
                    }
                    const key = await this.restoreAnnotation(layer, () => !this.destroyed && restoreGeneration === this.restoreGeneration);
                    return { key, staged: null, detail: null };
                } catch (error) {
                    return { staged: null, detail: `Shared layer ${layer.sharedAnnotation.id}: ${asError(error).message}` };
                }
            }
        );
        const stagedLayers = preparations
            .filter(({ staged }) => staged !== null)
            .map(({ staged }) => staged);
        if (restoreGeneration !== this.restoreGeneration) {
            return null;
        }
        this.viewport.restore(savedMapView.viewport);
        const basemapWarning = savedMapView.basemap === undefined ? null : await this.basemap.restore(savedMapView.basemap);
        if (this.destroyed || restoreGeneration !== this.restoreGeneration) return null;
        this.mapLayers.commitStaged(stagedLayers, { fitToBounds: false });
        const keys = preparations.map(result => result.key ?? result.staged?.record.entry.key).filter(Boolean);
        // Older callers may expose only catalog staging; mixed maps require explicit ordering.
        if (preparations.some(result => result.key)) {
            const otherKeys = this.mapLayers.retainedRecords.map(record => record.entry.key).filter(key => !keys.includes(key));
            this.mapLayers.restoreOrder([...keys, ...otherKeys]);
        }
        return {
            loaded: stagedLayers.length + preparations.filter(result => result.key).length,
            total: savedMapView.layers.length,
            details: [...(basemapWarning ? [basemapWarning] : []), ...preparations
                .map(({ detail }) => detail)
                .filter((detail) => detail !== null)],
        };
    }

    /**
     * Resolve, validate, publish, and style one detached saved layer.
     *
     * @param {Object} layer Validated saved-layer document.
     * @return {Promise<{staged:Object|null,detail:string|null}>} Detached layer and
     * ordered user-facing outcome, or a failure detail without a layer.
     */
    async #prepareLayer(layer) {
        const identityLabel =
            `${layer.catalogItem.collection}/${layer.catalogItem.id}`;
        try {
            const catalogItem = await this.catalogItems.get(
                layer.catalogItem
            );
            const preparedItem = await this.catalogVisualization.prepare(
                catalogItem
            );
            const currentRevision = await hashSavedMapSourceRevision(
                this.catalogVisualization.sourceRevision(preparedItem),
                this.subtleCrypto
            );
            const changed = layer.sourceRevision !== null &&
                currentRevision !== null &&
                layer.sourceRevision !== currentRevision;
            const staged = await this.catalogVisualization.stage(
                preparedItem,
                { visible: layer.visible, opacity: layer.opacity,
                    ...(layer.customName ? { customName: layer.customName } : {}) }
            );
            const record = staged.record;
            if (typeof record.adapter.applySavedState !== "function") {
                throw new Error("Layer style restoration is unavailable.");
            }
            let styleWarning = null;
            try {
                await record.adapter.applySavedState(record, layer.style);
            } catch (error) {
                styleWarning = asError(error).message;
            }
            // A failed filter must never restore an unexpectedly unfiltered layer.
            if (Object.hasOwn(layer, "filter")) {
                if (typeof record.adapter.applyFilterState !== "function") {
                    throw new Error("This layer does not support saved filters.");
                }
                await record.adapter.applyFilterState(record, layer.filter);
            }
            const notices = [];
            if (changed) notices.push("source changed; current data was used");
            if (layer.sourceRevision !== null && currentRevision === null) {
                notices.push("current source revision was unavailable");
            }
            if (styleWarning !== null) {
                notices.push(`saved style was not applied: ${styleWarning}`);
            }
            const detail = notices.length === 0
                ? null
                : `${record.entry.label}: ${notices.join("; ")}.`;
            return { staged, detail };
        } catch (error) {
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
        if (this.storage === null || this.destroyed) return;
        this.rememberGeneration += 1;
        const generation = this.rememberGeneration;
        if (this.rememberTimer !== null) {
            this.clearTimer(this.rememberTimer);
        }
        this.rememberTimer = this.setTimer(() => {
            this.rememberTimer = null;
            void this.#remember(generation);
        }, REMEMBER_DEBOUNCE_MILLISECONDS);
    }

    /**
     * Persist only a still-current validated complete-view snapshot.
     *
     * Storage failures are deliberately private and non-blocking.
     *
     * @param {number} generation Scheduled persistence generation.
     * @return {Promise<void>} Completion after a write or stale rejection.
     */
    async #remember(generation) {
        try {
            const savedMapView = await this.#snapshotCurrentView();
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
 * Map inputs through a fixed-size worker pool while preserving input order.
 *
 * @template Input, Output
 * @param {Input[]} inputs Ordered input values.
 * @param {number} concurrency Positive maximum number of active workers.
 * @param {(input:Input,index:number)=>Promise<Output>} transform Async mapper.
 * @return {Promise<Output[]>} Results in the same order as inputs.
 */
async function mapBounded(inputs, concurrency, transform) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new TypeError("Restore concurrency must be a positive integer.");
    }
    const results = new Array(inputs.length);
    let nextIndex = 0;
    async function runWorker() {
        while (nextIndex < inputs.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await transform(inputs[index], index);
        }
    }
    const workerCount = Math.min(concurrency, inputs.length);
    await Promise.all(Array.from({ length: workerCount }, runWorker));
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
