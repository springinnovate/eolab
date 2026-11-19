/** Connect polygon drawing, editing and local storage to the map's layer list. */
import { ANNOTATION_FIELDS, annotationFilterRules, annotationSummaryTarget } from "./summary-area.js";
import { exportAnnotationGeoJSON, readAnnotationCollection } from "./geojson.js";
import { AnnotationModel, matchingAnnotationPolygons, readAnnotationLayers, validateAnnotationStyle } from "./model.js";
import { AnnotationStorage } from "./storage.js";
import { AnnotationMapEditor } from "./map-editor.js";
import { AnnotationLayerControls } from "./layer-controls.js";
import { createAnnotationLeafletLayer } from "./leaflet-layer.js";
import { PolygonLabelLayout } from "./polygon-label-layout.js";
import { createAnnotationDownloadFilename } from "./download-filename.js";
import { AnnotationDownloadDialog } from "./download-dialog.js";
import { exportDrawingCollection, serializeDrawingContent, readDrawingView } from "./source-document.js";

/** Own local and linked drawing views, isolated polygon drafts and serialized saves. */
export class AnnotationController {
    /**
     * Connect annotations to map presentation and explicit interaction-mode callbacks.
     * @param {Object} options Feature dependencies.
     * @param {Object} options.leaflet Leaflet namespace.
     * @param {Object} options.map Leaflet map.
     * @param {Object} options.mapLayers Neutral layer controller.
     * @param {import("./panel-view.js").AnnotationPanelView} options.panel Annotation editor presentation.
     * @param {(editing:boolean)=>void} options.onEditingChange Composition-owned mode change.
     * @param {()=>void} [options.onHoverInvalidated] Clear composed hover after polygon changes.
     * @param {Document} [options.document=globalThis.document] Application document.
     * @param {AnnotationStorage} [options.storage] Device persistence provider.
     * @param {import("./source-api.js").DrawingSourceApi|null} [options.sourceApi=null] Optional reusable drawing-source persistence.
     * @param {(id:string)=>void} [options.onShare] Composition-owned sharing request.
     * @param {(id:string,color:string)=>void} [options.onColor] Save this contributor's shared polygon color through composition.
     * @param {(id:string)=>void} [options.onRenameContributor] Open contributor-name editing through composition.
     * @param {(key:string)=>void} [options.onFilter] Open the composed field/condition editor.
     * @param {(id:string)=>boolean} [options.requestEditing] Permit editing or open the owning membership prompt.
     * @param {()=>void} [options.onCommittedChange] Notifies composition after successful device persistence.
     * @param {string|null} [options.mapSlug=null] Published-map URL name supplied by composition for download filenames.
     */
    constructor({ leaflet, map, mapLayers, panel, onEditingChange, onHoverInvalidated = () => {}, document = globalThis.document, storage = new AnnotationStorage(), sourceApi = null, onShare = () => {}, onColor = () => {}, onRenameContributor = () => {}, onCommittedChange = () => {}, onFilter = () => {}, requestEditing = () => true, mapSlug = null }) {
        this.leaflet = leaflet;
        this.map = map;
        this.mapLayers = mapLayers;
        this.document = document;
        this.storage = storage;
        this.sourceApi = sourceApi;
        this.savedDrawingContents = new Map();
        this.creatingDrawingSources = new Map();
        this.unavailableDrawingSources = new Set();
        /** @type {Map<string,string>} Save errors belonging to individual local drawing views. */
        this.drawingSaveErrors = new Map();
        /** @type {Error|null} Failed persistence of the shared device document. */
        this.deviceSaveError = null;
        this.onShare = onShare;
        this.onColor = onColor;
        this.onRenameContributor = onRenameContributor;
        this.onCommittedChange = onCommittedChange;
        this.onFilter = onFilter;
        this.requestEditing = requestEditing;
        this.mapSlug = mapSlug;
        this.downloadDialog = new AnnotationDownloadDialog(document);
        this.exportInProgress = false;
        this.onEditingChange = onEditingChange;
        this.model = new AnnotationModel();
        this.shared = new Map();
        this.controls = new Map();
        this.layers = new Map();
        this.inspectionMatches = [];
        this.inspectedPolygon = null;
        this.onHoverInvalidated = onHoverInvalidated;
        this.loaded = false;
        this.clearedFilterLayerIds = new Set();
        this.savedSharingLayers = [];
        this.orderRestored = false;
        this.dirty = false;
        this.saving = false;
        this.savePromise = null;
        this.restoredLayers = new WeakMap();
        this.pendingSave = false;
        this.panel = panel;
        this.status = document.querySelector("#annotation-save-status");
        this.storageStatus = document.querySelector("#annotation-storage-status");
        this.undoButton = document.querySelector("#undo-annotation-delete");
        this.retryButton = document.querySelector("#retry-annotation-save");
        this.drawButton = document.querySelector("#draw-private-polygon");
        this.fileStatus = document.querySelector("#annotation-file-status");
        this.drawButton.addEventListener("click", () => this.drawPrivatePolygon());
        this.undoButton.addEventListener("click", () => this.perform(() => this.undoPolygonDeletion()));
        this.retryButton.addEventListener("click", () => this.retrySaving());
        this.beforeUnload = event => { if (this.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; } };
        globalThis.addEventListener?.("beforeunload", this.beforeUnload);
        this.labelLayout = new PolygonLabelLayout(map);
        this.editor = new AnnotationMapEditor({ leaflet, map, labelLayout: this.labelLayout,
            onAdd: point => this.perform(() => { this.model.addVertex(point); this.renderEditor(); }),
            onInsert: (index, point) => this.perform(() => {
                this.model.addVertex(point, index);
                this.renderEditor();
                this.editor.vertexMarkers[index].getElement().focus({ preventScroll: true });
            }),
            onMove: (index, point) => this.perform(() => {
                this.model.draft.polygon.vertices[index] = point;
                this.renderEditor();
            }),
            onDelete: index => this.perform(() => {
                const draft = this.model.draft;
                if (index === 0) this.deletePolygon(draft.layerId, draft.polygon.id);
                else { draft.polygon.vertices.splice(index, 1); this.renderEditor(); }
            }),
            onSave: drawAnother => this.perform(() => this.finishPolygon(drawAnother)),
            onCloseOutline: () => this.perform(() => {
                this.model.closePolygonOutline();
                this.renderEditor();
                this.editor.save.focus({ preventScroll: true });
            }),
            onCancel: () => { this.model.cancelPolygon(); this.updateEditor(); },
            onTextChange: (name, note) => this.perform(() => {
                this.model.updateDraftText(name, note);
                this.editor.refreshDraftLabels();
            }),
        });
    }

    /**
     * Restore saved polygons without opening their editor or moving focus.
     * Load errors appear beside the disabled drawing controls and in the polygon editor.
     * Opening an unsupported document leaves its stored drawings intact.
     * Recovered filters are identified on their layers until the user applies a filter or reloads.
     * Drawing stays disabled until loading succeeds.
     * Linked sources refresh clean views; pending local edits retain their original revision.
     * @param {Object} [options] Startup presentation policy.
     * @param {boolean} [options.attachSavedLayers=true] Display private saved layers; false keeps them off the shared map.
     * @param {string[]} [options.sharedLayerIds=[]] Bookmarked shared layers whose inclusion comes from the remembered map, not polygon storage.
     * @return {Promise<void>} Completion with failed loads retained in the editor's status.
     */
    async load({ attachSavedLayers = true, sharedLayerIds = [] } = {}) {
        try {
            this.model.layers = await this.storage.load(id => this.clearedFilterLayerIds.add(id));
            if (this.sourceApi) await this.refreshDrawingSources();
            this.savedSharingLayers = this.model.layers.map(layer => ({ id: layer.id, collection: exportAnnotationGeoJSON(layer) }));
            const shared = new Set(sharedLayerIds);
            if (attachSavedLayers) for (const layer of [...this.model.layers].reverse()) {
                if (!shared.has(layer.id)) this.attachLayer(layer);
            }
            this.loaded = true;
            this.storageStatus.hidden = true;
            this.drawButton.disabled = false;
            this.dirty = this.model.layers.some(layer => layer.drawingSource?.pending);
            this.status.textContent = this.model.layers.map(layer => this.drawingSaveProblem(layer)).filter(Boolean).join(" ");
            this.retryButton.hidden = !this.status.textContent;
        } catch (error) {
            this.status.textContent = `Cannot open saved polygons: ${error.message}`;
            this.storageStatus.textContent = this.status.textContent;
            this.storageStatus.hidden = false;
        }
    }

    /**
     * Add a private layer and start its first polygon using the ordinary map editor.
     * Save the empty layer on this device; its unfinished polygon stays outside storage
     * until Save. Loading, editing and capacity errors use the existing editor status.
     * @param {((key:string|null)=>void)|null} [onFinish=null] Receive the saved drawing key, or null on cancellation.
     * @return {void}
     */
    drawPrivatePolygon(onFinish = null) {
        let started = false;
        this.perform(() => {
            if (!this.loaded) throw new Error(this.status.textContent || "Wait for saved polygons to open before drawing.");
            if (this.model.draft) throw new Error("Save or cancel the current polygon before creating another layer.");
            const layer = this.model.createLayer();
            this.attachLayer(layer);
            this.panel.showLayer(`local:annotation:${layer.id}`);
            void this.save();
            this.beginPolygon(layer.id);
            if (onFinish && this.model.draft?.layerId === layer.id) {
                this.filterDrawing = {id: layer.id, onFinish};
                started = true;
            }
        });
        if (onFinish && !started) onFinish(null);
    }

    /** Restore your server contribution as a local editable layer after joining.
     * Report a failed device-storage load before changing local polygons.
     * @param {string} name Shared layer name.
     * @param {Object} collection Server-validated GeoJSON belonging to this contributor.
     * @param {Object} [options] Existing contribution restoration options.
     * @param {string|null} [options.localId=null] Reuse this device layer when present.
     * @param {boolean} [options.replacePolygons=false] Replace a visitor's empty collection after authenticated joining.
     * @return {Promise<string>} Local layer ID after successful device persistence.
     * @throws {Error} If geometry, capacity or device persistence prevents restoration.
     */
    async restoreSharedContribution(name, collection, { localId = null, replacePolygons = false } = {}) {
        if (!this.loaded) throw new Error(this.status.textContent);
        const { polygons } = readAnnotationCollection(collection);
        const existing = this.model.layers.find(layer => layer.id === localId);
        const layer = existing ?? this.model.addLayerFromPolygons({ name, polygons });
        if (existing && replacePolygons) layer.polygons = polygons;
        layer.name = name;
        if (!this.layers.has(layer.id)) this.attachLayer(layer);
        else this.refreshLayer(layer.id);
        await this.save();
        if (this.deviceSaveError) throw this.deviceSaveError;
        return layer.id;
    }

    /**
     * Finish device persistence before creating or joining a shared layer.
     * Reuse an in-flight save; unrelated drawing-source failures do not block sharing.
     * @return {Promise<void>} Completion once local layers are loaded and saved.
     * @throws {Error} If loading is incomplete or a local save fails.
     */
    async saveForSharing() {
        if (!this.loaded) throw new Error(this.status.textContent);
        if (this.dirty) await (this.savePromise ?? this.save());
        if (this.deviceSaveError) throw this.deviceSaveError;
    }

    /** Apply a saved map's local appearance without changing polygons or shared colors.
     * @param {string} id Local annotation layer identifier.
     * @param {Object} savedLayer Validated portable visibility, opacity and appearance.
     * @return {string} Retained map-layer key.
     */
    restoreMapAppearance(id, savedLayer) {
        const layer = this.model.layers.find(layer => layer.id === id);
        layer.style = validateAnnotationStyle({ ...layer.style, ...savedLayer.appearance });
        const key = `local:annotation:${id}`;
        this.mapLayers.setVisible(key, savedLayer.visible);
        this.mapLayers.setOpacity(key, savedLayer.opacity);
        this.refreshLayer(id);
        void this.save();
        return key;
    }

    /** Combine committed polygons and apply the shared colors without changing ownership.
     * @param {import("./model.js").AnnotationLayer} layer Local editable data.
     * @return {Object} Layer snapshot containing everyone's committed polygons.
     */
    displayLayer(layer) {
        const sharing = this.shared.get(layer.id);
        if (!sharing) return layer;
        const own = sharing.contributors.find(person => person.own);
        return { ...layer, polygons: [
            ...layer.polygons.map(polygon => ({ ...polygon, contributor: own?.name, contributorColor: own?.color ?? layer.style.color })),
            ...sharing.polygons.map(polygon => ({ ...polygon,
                contributorColor: sharing.contributors.find(person => person.id === polygon.contributorId)?.color ?? layer.style.color })),
        ] };
    }

    /** Refresh shared polygons and contributor details without replacing local edits.
     * @param {string} id Local editable layer identity.
     * @param {Object} data Session-owned contributor metadata, GeoJSON and save status.
     * @param {string} data.sessionId Public shared-layer UUID, independent of this browser's local layer ID.
     * @return {boolean} Whether the available summary geometry changed.
     * @throws {Error} If received polygon geometry is unsupported.
     */
    updateSharedLayer(id, data) {
        const layer = this.model.layers.find(candidate => candidate.id === id);
        if (!layer) return false;
        const previous = this.shared.get(id);
        const renamed = data.name && data.name !== layer.name;
        if (renamed) layer.name = data.name;
        const signature = JSON.stringify(data.collections);
        const changed = signature !== previous?.signature;
        const polygons = changed ? data.collections.flatMap(collection => {
            const { polygons } = readAnnotationCollection(collection);
            return polygons.map((polygon, index) => ({ ...polygon, id: collection.features[index].id,
                contributor: collection.features[index].properties.contributor,
                contributorId: collection.features[index].properties.contributorId }));
        }) : previous.polygons;
        this.shared.set(id, { ...data, signature, polygons });
        const own = data.contributors.find(person => person.own);
        const previousOwn = previous?.contributors.find(person => person.own);
        const color = own?.color;
        if (color) layer.style.color = color;
        this.controls.get(id).setCollaboration(data, polygons);
        if (renamed) this.refreshLayer(id, false);
        const colorsChanged = JSON.stringify(data.contributors) !== JSON.stringify(previous?.contributors);
        if (changed || colorsChanged) { this.layers.get(id).refresh(); this.mapLayers.render(); }
        if ((own?.name !== previousOwn?.name || own?.color !== previousOwn?.color) && this.model.draft?.layerId === id) this.renderEditor();
        // Peer IDs currently describe positions within a contribution. A replacement
        // collection must not silently select the polygon that took a deleted one's place.
        if (changed && this.inspectedPolygon?.layerId === id
            && !layer.polygons.some(polygon => polygon.id === this.inspectedPolygon.polygonId)) this.clearInspection();
        if (changed || colorsChanged || renamed || data.canContribute !== previous?.canContribute) this.refreshInspection();
        return changed;
    }

    /**
     * Fit the map to one contributor's saved polygons in this shared layer.
     * Uses current local polygons for you and loaded shared polygons for others,
     * including polygons hidden by filters. Unfinished edits are excluded.
     * Missing contributors or empty/unavailable geometry leave the map unchanged.
     * @param {string} layerId Local shared-layer identifier.
     * @param {string} contributorId Contributor whose polygons should fit in view.
     * @return {void}
     */
    zoomToContributorPolygons(layerId, contributorId) {
        const layer = this.model.layers.find(candidate => candidate.id === layerId);
        const sharing = this.shared.get(layerId);
        const contributor = sharing?.contributors.find(person => person.id === contributorId);
        if (!layer || !contributor) return;
        const polygons = contributor.own ? layer.polygons
            : sharing.polygons.filter(polygon => polygon.contributorId === contributorId);
        const bounds = this.leaflet.latLngBounds([]);
        for (const polygon of polygons) {
            for (const [longitude, latitude] of polygon.vertices) bounds.extend([latitude, longitude]);
        }
        if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    }

    /**
     * Offer a filename for a snapshot of committed polygons, then download on confirmation.
     * The default includes the published map (if any), layer identity and UTC time.
     * Cancelling leaves the layer and browser downloads unchanged.
     * @param {string} layerId Annotation layer to export, including filtered-out polygons.
     * @return {Promise<void>} Completes after cancellation, download, or a visible export error.
     */
    async exportGeoJSONFile(layerId) {
        if (this.exportInProgress) return;
        this.exportInProgress = true;
        let url;
        let link;
        this.fileStatus.classList.remove("is-error");
        try {
            const layer = this.model.layer(layerId);
            const collection = exportAnnotationGeoJSON(this.displayLayer(layer), true);
            const text = JSON.stringify(collection);
            const defaultFilename = createAnnotationDownloadFilename({ name: layer.name,
                layerId: this.shared.get(layerId)?.sessionId ?? layer.id, mapSlug: this.mapSlug });
            const filename = await this.downloadDialog.choose(defaultFilename, layer.name);
            if (filename === null) return;
            url = URL.createObjectURL(new Blob([text], { type: "application/geo+json" }));
            link = this.document.createElement("a");
            link.href = url;
            link.download = filename;
            this.document.body.append(link);
            link.click();
            this.fileStatus.textContent = `GeoJSON download started for “${collection.name}”. All saved polygons are included; unfinished edits are excluded.`;
        } catch (error) {
            this.fileStatus.textContent = `Cannot export GeoJSON: ${error.message}`;
            this.fileStatus.classList.add("is-error");
            this.panel.show();
        } finally {
            this.exportInProgress = false;
            link?.remove();
            // Allow the browser to consume the download URL before releasing it.
            if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    /**
     * Run an editing action, showing errors in the map editor or annotation panel without losing data.
     * @param {()=>void} action User-requested action.
     * @return {void}
     */
    perform(action) {
        try { action(); }
        catch (error) {
            if (this.model.draft) this.renderEditor(error.message);
            else {
                this.status.textContent = error.message;
                this.panel.show();
            }
        }
    }

    /**
     * Add a local or shared annotation layer and its retained controls to the map and editor.
     * @param {import("./model.js").AnnotationLayer} layer Validated annotation data.
     * @return {void}
     */
    attachLayer(layer) {
        const {source, adapter} = this.createLayerAttachment(layer);
        adapter.added();
        this.mapLayers.addLocal(source, adapter);
    }

    /** Construct detached annotation rendering and controls for immediate attachment or staged restoration.
     * @param {import("./model.js").AnnotationLayer} layer Validated annotation data.
     * @return {{source:Object,adapter:Object}} Local map source and adapter; added registers controls, discardStaged releases them.
     */
    createLayerAttachment(layer) {
        const key = `local:annotation:${layer.id}`;
        const controls = new AnnotationLayerControls(this.document, layer, {
            open: () => this.openControls(key, "info"),
            filter: () => this.onFilter(key),
            add: () => this.beginPolygon(layer.id),
            share: () => this.onShare(layer.id),
            color: color => this.onColor(layer.id, color),
            renameContributor: () => this.onRenameContributor(layer.id),
            zoomToContributor: id => this.zoomToContributorPolygons(layer.id, id),
            exportGeoJSON: () => void this.exportGeoJSONFile(layer.id),
            edit: (id, field) => this.beginPolygon(layer.id, id, field),
            removePolygon: id => this.perform(() => this.deletePolygon(layer.id, id)),
            change: (rebuild = true) => this.perform(() => {
                validateAnnotationStyle(layer.style);
                this.refreshLayer(layer.id, rebuild);
                this.save();
            }),
            opacity: opacity => this.mapLayers.setOpacity(key, opacity),
        });
        const displayLayer = Object.create(layer);
        Object.defineProperty(displayLayer, "polygons", { get: () => this.displayLayer(layer).polygons });
        const rendering = createAnnotationLeafletLayer(this.leaflet, this.map, displayLayer, this.labelLayout);
        const adapter = {
            added: () => {
                this.controls.set(layer.id, controls);
                this.layers.set(layer.id, rendering);
                this.panel.registerLayerControls(key, layer.name, controls.root);
            },
            discardStaged: () => {
                rendering.release();
                this.layers.delete(layer.id);
                this.controls.delete(layer.id);
                this.panel.removeLayer(key);
            },
            createState: () => layer,
            createLayer: () => rendering,
            snapshot: () => ({ datasetKind: "annotation", typeLabel: this.shared.has(layer.id) ? "Shared layer" : layer.drawingSource ? "Saved drawing" : "Local layer",
                legend: this.layerLegend(layer),
                canFilter: true, detailsControl: controls.edit, primaryControl: controls.cardActions, stylePanelId: "annotations-panel",
                filterActive: layer.filter.enabled && !!layer.filter.rules.length,
                filterStatus: this.clearedFilterLayerIds.has(layer.id) ? "Saved filter cleared—all polygons included" : (layer.filter.enabled && layer.filter.rules.length)
                    ? `${matchingAnnotationPolygons(this.displayLayer(layer)).length} of ${this.displayLayer(layer).polygons.length} polygons match` : null }),
            zoom: () => {
                const bounds = rendering.getBounds();
                if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
                else {
                    this.status.textContent = "Add a polygon, or clear the filter, before zooming to this layer.";
                    this.panel.show();
                }
            },
            info: () => this.openControls(key, "info"),
            exportSavedState: () => ({ kind: "annotation", style: { ...layer.style } }),
            checkSavedStateCompatibility: (_record, saved) => {
                if (saved?.kind !== "annotation") return "Copy a style from a shared layer first.";
                validateAnnotationStyle(saved.style);
                return null;
            },
            applySavedState: (_record, saved) => {
                if (saved?.kind !== "annotation") throw new Error("This style is not a shared layer style.");
                const ownColor = layer.style.color;
                layer.style = validateAnnotationStyle(saved.style);
                if (this.shared.has(layer.id)) layer.style.color = ownColor;
                this.refreshLayer(layer.id);
                this.save();
            },
            visibilityChanged: (_record, visible) => {
                layer.visible = visible;
                this.refreshInspection();
                this.save();
            },
            opacityChanged: (_record, opacity) => { layer.opacity = opacity; controls.opacity.value = opacity; this.refreshInspection(); this.save(); },
            copyLayerForUndo: () => {
                if (this.model.draft?.layerId === layer.id) throw new Error("Save or cancel the current polygon before removing this layer.");
                const snapshot = structuredClone(layer);
                if (snapshot.drawingSource) snapshot.drawingSource.pending = this.drawingHasLocalChanges(layer);
                return snapshot;
            },
            removed: () => {
                this.clearInspection();
                if (this.model.draft?.layerId === layer.id) { this.model.cancelPolygon(); this.updateEditor(); }
                if (this.model.deleted?.layerId === layer.id) this.model.deleted = null;
                this.model.layers = this.model.layers.filter(candidate => candidate.id !== layer.id);
                rendering.release();
                this.layers.delete(layer.id);
                this.controls.delete(layer.id);
                this.savedDrawingContents.delete(layer.id);
                this.unavailableDrawingSources.delete(layer.id);
                this.drawingSaveErrors.delete(layer.id);
                this.panel.removeLayer(key);
                this.undoButton.hidden = !this.model.deleted;
                this.save();
            },
        };
        if (layer.drawingSource) controls.setDrawingSource(layer.drawingSource.canEdit);
        return {source: {key, label: layer.name, isCustom: true, visible: layer.visible, opacity: layer.opacity}, adapter};
    }

    /** Describe the layer's polygon colors for the neutral Map layers legend.
     * @param {import("./model.js").AnnotationLayer} layer Local display settings.
     * @return {Object} Contributor entries for shared layers and imported color metadata, or one fixed local symbol.
     */
    layerLegend(layer) {
        const symbol = { shape: "polygon", fill: layer.style.color, fillOpacity: layer.style.fillOpacity,
            stroke: layer.style.outline, strokeOpacity: 1, strokeWidth: layer.style.weight };
        const sharing = this.shared.get(layer.id);
        if (sharing) return { kind: "categories", label: "Contributors", entries: sharing.contributors.map(person => ({
            label: `${person.name}${person.own ? " (you)" : ""}`, symbol: { ...symbol, fill: person.color ?? layer.style.color },
        })) };
        if (layer.polygons.some(polygon => polygon.contributorColor)) {
            const entries = new Map();
            for (const polygon of layer.polygons) {
                const label = polygon.contributor ?? "Imported polygons";
                const fill = polygon.contributorColor ?? layer.style.color;
                entries.set(JSON.stringify([label, fill]), { label, symbol: { ...symbol, fill } });
            }
            return { kind: "categories", label: "Contributors in file", entries: [...entries.values()] };
        }
        return { kind: "fixed", label: "Polygon", symbol };
    }

    /**
     * Restore a removed view and drawing position, refreshing clean linked sources first.
     * After a storage failure, retry saving the same restored object without overwriting edits or a separately re-added layer.
     * @param {import("../map-layers/controller.js").RemovedMapLayer} snapshot Neutral removal record containing committed annotation data.
     * @param {()=>boolean} isCurrent Whether the user still wants this Undo attempt.
     * @return {Promise<void>} Completion after all pending annotation writes settle.
     * @throws {Error} If Undo is obsolete, capacity/identity conflicts prevent restoration, or saving fails.
     */
    async restoreRemovedLayer(snapshot, isCurrent) {
        if (!isCurrent()) throw new Error("Layer restoration was superseded.");
        if (snapshot.local.drawingSource && this.savePromise) {
            await this.savePromise;
            if (!isCurrent()) throw new Error("Layer restoration was superseded.");
        }
        const existing = this.model.layers.find(layer => layer.id === snapshot.local.id);
        if (existing) {
            if (existing !== this.restoredLayers.get(snapshot)) throw new Error("This shared layer is already on the map.");
        } else {
            const contents = structuredClone(snapshot.local);
            let sourceRecord;
            if (contents.drawingSource && !contents.drawingSource.pending) {
                sourceRecord = await this.sourceApi.get(contents.drawingSource.id);
                if (!isCurrent()) throw new Error("Layer restoration was superseded.");
                const refreshed = readDrawingView(sourceRecord, contents.id);
                contents.polygons = refreshed.polygons;
                contents.drawingSource = refreshed.drawingSource;
                this.acceptDrawingSource(sourceRecord);
            }
            const layer = this.model.restoreRemovedLayer(contents);
            if (sourceRecord) this.savedDrawingContents.set(layer.id, serializeDrawingContent(sourceRecord.collection));
            try {
                this.attachLayer(layer);
            } catch (error) {
                this.model.layers = this.model.layers.filter(candidate => candidate !== layer);
                this.layers.get(layer.id)?.release();
                this.layers.delete(layer.id);
                this.controls.delete(layer.id);
                throw error;
            }
            this.restoredLayers.set(snapshot, layer);
            this.mapLayers.reorder(snapshot.key, Math.min(snapshot.index, this.mapLayers.snapshots().length - 1));
        }
        await this.save();
        this.requireSavedDrawing(this.model.layer(snapshot.local.id));
    }

    /**
     * Read committed polygons for raster summaries; unfinished editing drafts are excluded.
     * @return {Object[]} Layer identities, fields and polygon snapshots.
     */
    summaryTargets() {
        return this.model.layers.filter(layer => this.layers.has(layer.id)).map(layer => annotationSummaryTarget(
            `local:annotation:${layer.id}`, this.displayLayer(layer), this.shared.has(layer.id) ? null : layer.drawingSource));
    }

    /** Return annotation fields and callbacks for the existing filter dialog.
     * @param {string} key Map-layer identity.
     * @return {Object|null} Field editor target, or null for a different owner.
     */
    filterTarget(key) {
        const layer = this.model.layers.find(layer => `local:annotation:${layer.id}` === key);
        if (!layer) return null;
        return { key, label: layer.name, fields: ANNOTATION_FIELDS, filter: annotationFilterRules(layer.filter),
            status: `${matchingAnnotationPolygons(this.displayLayer(layer)).length} of ${this.displayLayer(layer).polygons.length} polygons match`,
            apply: candidate => {
                layer.filter = annotationFilterRules(candidate);
                this.clearedFilterLayerIds.delete(layer.id);
                this.refreshLayer(layer.id);
                this.save();
            },
            cancelPending: () => {} };
    }

    /** Export the most recently device-saved GeoJSON for sharing.
     * @return {{id:string,collection:Object}[]} Independent saved layer snapshots.
     */
    sharableLayers() {
        const linked = new Set(this.model.layers.filter(layer => layer.drawingSource).map(layer => layer.id));
        return this.savedSharingLayers.filter(layer => !linked.has(layer.id));
    }

    /** Check map inclusion independently of stored polygons or server membership.
     * @param {string} id Local annotation layer identifier.
     * @return {boolean} Whether the layer is currently attached, including hidden layers.
     */
    isLayerOnMap(id) { return this.layers.has(id); }

    /** Focus a local layer's drawing action in Map layers without entering editing mode.
     * Composition reveals Map layers before calling this method.
     * @param {string} id Local annotation layer identifier. @return {void}
     */
    revealDrawing(id) {
        this.controls.get(id)?.revealDrawing();
    }

    /**
     * Edit a polygon shape, name and notes in one draft; saved polygons stay unchanged until Save.
     * @param {string} layerId Annotation layer identifier.
     * @param {string|null} [polygonId=null] Existing polygon or new drawing.
     * @param {"name"|"note"|null} [field=null] Focus the requested text field; otherwise focus Name on entry.
     * @return {void}
     */
    beginPolygon(layerId, polygonId = null, field = null) {
        if (this.model.layer(layerId).drawingSource?.canEdit === false) {
            this.perform(() => { throw new Error("This drawing is read-only. Its owner can edit polygons."); });
            return;
        }
        if (this.requestEditing && !this.requestEditing(layerId)) return;
        this.perform(() => {
            if (polygonId && this.model.draft?.layerId === layerId && this.model.draft.polygon.id === polygonId) {
                this.editor.focusTextField(field ?? "name", false);
                return;
            }
            this.model.beginPolygon(layerId, polygonId);
            this.mapLayers.setVisible(`local:annotation:${layerId}`, true);
            this.updateEditor();
            if (field) this.editor.focusTextField(field);
        });
    }

    /**
     * Delete one polygon, leave editing mode and show the panel with its single Undo action.
     * @param {string} layerId Owning layer.
     * @param {string} polygonId Polygon identifier.
     * @return {void}
     * @throws {Error} If the source is read-only or the polygon cannot be deleted.
     */
    deletePolygon(layerId, polygonId) {
        if (this.model.layer(layerId).drawingSource?.canEdit === false) throw new Error("This drawing is read-only. Its owner can edit polygons.");
        this.model.deletePolygon(layerId, polygonId);
        this.updateEditor();
        this.panel.show();
        this.refreshLayer(layerId);
        this.save();
    }

    /** Restore the last deleted polygon only while this browser can edit its source.
     * @return {void}
     * @throws {Error} If the drawing is now read-only or an unfinished edit prevents Undo.
     */
    undoPolygonDeletion() {
        const layerId = this.model.deleted?.layerId;
        if (layerId && this.model.layer(layerId).drawingSource?.canEdit === false) throw new Error("This drawing is read-only. Its owner can edit polygons.");
        if (!this.model.undoDeletion()) return;
        this.refreshLayer(layerId);
        this.updateEditor();
        this.save();
    }

    /** Synchronize map editing presentation and notify composition of the mode. @return {void} */
    updateEditor() {
        if (this.filterDrawing && this.model.draft?.layerId !== this.filterDrawing.id) {
            const {onFinish} = this.filterDrawing;
            this.filterDrawing = null;
            onFinish(null);
        }
        this.clearInspection();
        this.onEditingChange(!!this.model.draft);
        for (const [layerId, rendering] of this.layers) {
            rendering.setEditingPolygon(this.model.draft?.layerId === layerId ? this.model.draft.polygon.id : null);
        }
        this.renderEditor();
        this.undoButton.hidden = !this.model.deleted;
        this.undoButton.disabled = !!this.model.draft;
    }

    /**
     * Show the draft with its contributor name, local label visibility and any validation message.
     * @param {string} [message=""] Error shown next to the editing controls.
     * @return {void}
     */
    renderEditor(message = "") {
        const draft = this.model.draft;
        const layer = draft ? this.model.layer(draft.layerId) : null;
        const contributor = this.shared.get(layer?.id)?.contributors.find(person => person.own)?.name;
        this.editor.render(draft, message, layer?.style ?? null, layer?.name ?? "", contributor ?? null);
    }

    /**
     * Save the draft's shape, name and notes together and optionally start another polygon.
     * Validation failures keep the complete draft open for correction; no draft is a no-op.
     * @param {boolean} [drawAnother=false] Start a new draft in the same layer after saving.
     * @return {void}
     * @throws {Error} If the draft is invalid or this contributor can no longer edit it.
     */
    finishPolygon(drawAnother = false) {
        if (!this.model.draft) return;
        const { layerId } = this.model.draft;
        if (this.model.layer(layerId).drawingSource?.canEdit === false) throw new Error("This drawing is read-only. Your unfinished changes have not been saved.");
        if (this.shared.get(layerId)?.canContribute === false) throw new Error("Join this layer before saving your polygon.");
        const polygon = this.model.savePolygon();
        const onFinish = this.filterDrawing?.id === layerId ? this.filterDrawing.onFinish : null;
        if (onFinish) this.filterDrawing = null;
        this.updateEditor();
        this.refreshLayer(layerId, true, polygon.id);
        void this.save().then(() => onFinish?.(this.deviceSaveError ? null : `local:annotation:${layerId}`));
        if (drawAnother) this.beginPolygon(layerId);
    }

    /** Whether leaving would lose an unfinished polygon or failed/pending save. @return {boolean} */
    hasUnsavedChanges() {
        return !!(this.dirty || this.model.draft);
    }

    /**
     * Refresh annotation shapes and controls; text edits keep existing stack rows in place.
     * @param {string} id Annotation layer identifier.
     * @param {boolean} [rebuild=true] Whether to rebuild name/note controls.
     * @param {string|null} [focusPolygon=null] Saved polygon to focus.
     * @return {void}
     */
    refreshLayer(id, rebuild = true, focusPolygon = null) {
        const layer = this.model.layer(id);
        const record = this.mapLayers.getRecord(`local:annotation:${id}`);
        const labelChanged = record.entry.label !== layer.name;
        record.entry.label = layer.name;
        this.panel.renameLayer(`local:annotation:${id}`, layer.name);
        this.layers.get(id).refresh();
        if (rebuild) this.controls.get(id).refresh(focusPolygon);
        // Polygon text changes do not alter stack controls unless a filter is active.
        if (rebuild || labelChanged || (layer.filter.enabled && layer.filter.rules.length)) this.mapLayers.render();
        this.refreshInspection();
    }

    /**
     * Find visible annotation polygons at a map location without intercepting map events.
     * @param {{lat:number,lng:number}} position Pointer location.
     * @return {{layerId:string,layerName:string,polygon:import("./model.js").AnnotationPolygon,canEdit:boolean}[]} Top-first hits with local edit permission.
     */
    polygonsAt(position) {
        if (this.model.draft) return [];
        return [...this.model.layers].sort((a, b) => a.position - b.position).flatMap(layer => {
            if (!layer.visible || layer.opacity === 0) return [];
            return (this.layers.get(layer.id)?.polygonsAt(position) ?? []).map(polygon => ({
                layerId: layer.id, layerName: layer.name, polygon,
                canEdit: layer.drawingSource?.canEdit !== false && this.shared.get(layer.id)?.canContribute !== false && layer.polygons.some(own => own.id === polygon.id),
            }));
        });
    }

    /**
     * Open annotation details for a map click; composition still handles raster and catalog-vector sampling.
     * @param {{lat:number,lng:number}} position Click location.
     * @return {boolean} Whether a visible annotation polygon was selected.
     */
    inspectAt(position) {
        this.clearInspection();
        this.inspectionMatches = this.polygonsAt(position);
        if (!this.inspectionMatches.length) return false;
        this.selectInspectionMatch(0);
        return true;
    }

    /**
     * Highlight an overlap choice and reveal its owner-supplied controls in the existing panel.
     * @param {number} index Index in the current click's polygon matches.
     * @return {void}
     */
    selectInspectionMatch(index) {
        const hit = this.inspectionMatches[index];
        if (!hit) return;
        for (const controls of this.controls.values()) controls.clearPolygonInspection();
        for (const [id, rendering] of this.layers) rendering.setInspectedPolygon(id === hit.layerId ? hit.polygon.id : null);
        this.inspectedPolygon = { layerId: hit.layerId, polygonId: hit.polygon.id };
        this.controls.get(hit.layerId).showPolygonInspection(hit, this.inspectionMatches, choice => this.selectInspectionMatch(choice), true);
        this.panel.showLayer(`local:annotation:${hit.layerId}`);
        this.controls.get(hit.layerId).inspection.scrollIntoView({ block: "nearest" });
    }

    /** Clear temporary hover, highlight and details without deleting any polygon. @return {void} */
    clearInspection() {
        this.onHoverInvalidated();
        for (const controls of this.controls.values()) controls.clearPolygonInspection();
        for (const rendering of this.layers.values()) rendering.setInspectedPolygon(null);
        this.inspectionMatches = [];
        this.inspectedPolygon = null;
    }

    /**
     * Refresh clicked details after edits or collaboration updates; discard unavailable selections.
     * Never reopen the panel or move focus while background data changes.
     * @return {void}
     */
    refreshInspection() {
        this.onHoverInvalidated();
        if (!this.inspectedPolygon) return;
        this.inspectionMatches = this.inspectionMatches.flatMap(hit => {
            const layer = this.model.layers.find(item => item.id === hit.layerId);
            if (!layer?.visible || layer.opacity === 0 || !this.layers.has(layer.id)) return [];
            const polygon = matchingAnnotationPolygons(this.displayLayer(layer)).find(item => item.id === hit.polygon.id);
            return polygon ? [{ layerId: layer.id, layerName: layer.name, polygon,
                canEdit: layer.drawingSource?.canEdit !== false && this.shared.get(layer.id)?.canContribute !== false && layer.polygons.some(own => own.id === polygon.id) }] : [];
        });
        const hit = this.inspectionMatches.find(item => item.layerId === this.inspectedPolygon.layerId && item.polygon.id === this.inspectedPolygon.polygonId);
        if (!hit) { this.clearInspection(); return; }
        this.controls.get(hit.layerId).showPolygonInspection(hit, this.inspectionMatches, choice => this.selectInspectionMatch(choice));
    }

    /**
     * Open an annotation's panel at its Style, Filter or Info controls if it owns the key.
     * @param {string} key Retained map-layer key.
     * @param {"style"|"filter"|"info"} action Requested control.
     * @return {boolean} Whether annotations handled this intent.
     */
    openControls(key, action) {
        const record = this.mapLayers.getRecord(key);
        if (record?.entry.item !== null) return false;
        const controls = this.controls.get(record?.state?.id);
        if (!controls) return false;
        this.clearInspection();
        this.panel.showLayer(key);
        controls.open(action);
        return true;
    }

    /**
     * Restore each annotation's saved position among all loaded layers without changing Catalog order.
     * Composition calls this after both independent startup loads settle. Missing Catalog layers
     * shorten the stack; annotation positions then stop at its end, retaining their relative order.
     * @param {Object} [options] Startup order policy.
     * @param {boolean} [options.useSavedPositions=true] Restore device positions; false retains the portable map's order.
     * @param {string[]} [options.mapOrderedLayerIds=[]] Layers already ordered by the saved map; only insert other private layers around them.
     * @return {void}
     */
    restoreLayerOrder({ useSavedPositions = true, mapOrderedLayerIds = [] } = {}) {
        if (!this.loaded || this.orderRestored) return;
        if (!useSavedPositions) {
            this.orderRestored = true;
            this.observeLayerOrder(this.mapLayers.snapshots());
            return;
        }
        const mapOrdered = new Set(mapOrderedLayerIds);
        const attached = this.model.layers.filter(layer => this.layers.has(layer.id) && !mapOrdered.has(layer.id));
        const annotationKeys = new Set(attached.map(layer => `local:annotation:${layer.id}`));
        const keys = this.mapLayers.snapshots().map(layer => layer.key).filter(key => !annotationKeys.has(key));
        let nextIndex = 0;
        for (const layer of [...attached].sort((a, b) => a.position - b.position)) {
            const index = Math.min(keys.length, Math.max(nextIndex, layer.position));
            keys.splice(index, 0, `local:annotation:${layer.id}`);
            nextIndex = index + 1;
        }
        this.mapLayers.restoreOrder(keys);
        this.orderRestored = true;
        this.observeLayerOrder(this.mapLayers.snapshots());
    }

    /**
     * Remember annotation positions in the full stack, including hidden Catalog layers.
     * Startup insertion events must not overwrite saved positions; an explicit reorder may.
     * @param {Object[]} snapshots Complete top-first map-layer snapshots.
     * @param {boolean} [explicitReorder=false] Whether the user requested a reorder while loading.
     * @return {void}
     */
    observeLayerOrder(snapshots, explicitReorder = false) {
        if (!this.loaded || (!this.orderRestored && !explicitReorder)) return;
        const positions = new Map(snapshots.map((layer, index) => [layer.key, index]));
        const order = [...this.model.layers].sort((a, b) => (positions.get(`local:annotation:${a.id}`) ?? a.position) - (positions.get(`local:annotation:${b.id}`) ?? b.position));
        let changed = order.some((layer, index) => layer !== this.model.layers[index]);
        for (const layer of order) {
            const position = positions.get(`local:annotation:${layer.id}`);
            if (position === undefined) continue;
            if (position !== layer.position) { layer.position = position; changed = true; }
        }
        if (changed) {
            this.model.layers = order;
            this.save();
        }
    }

    /** Describe attached local drawings without exposing drafts or shared contributions.
     * @return {Object[]} Reusable drawing identities, source references, counts and ordinary filters.
     */
    drawingLayers() {
        return this.model.layers.filter(layer => this.layers.has(layer.id) && !this.shared.has(layer.id)).map(layer => ({
            key: `local:annotation:${layer.id}`, localLayerId: layer.id, label: layer.name,
            drawingLayerId: layer.drawingSource?.id, polygonCount: layer.polygons.length,
            filter: annotationFilterRules(layer.filter),
        }));
    }

    /** Save the chosen drawing's committed polygons before another capability retains its source reference.
     * @param {string} key Attached local drawing key.
     * @return {Promise<string>} Reusable drawing-source UUID after pending changes are saved.
     * @throws {Error} If a draft, conflict, failed save or unavailable drawing prevents linking.
     */
    async ensureDrawingSource(key) {
        const layer = this.model.layers.find(candidate => `local:annotation:${candidate.id}` === key);
        if (!layer || !this.layers.has(layer.id) || this.shared.has(layer.id)) throw new Error("Choose an available local drawing.");
        if (!this.sourceApi) throw new Error("Saving reusable drawings is unavailable.");
        if (this.model.draft?.layerId === layer.id) throw new Error("Save or cancel the unfinished polygon before using this drawing.");
        if (!layer.drawingSource) {
            let pending = this.creatingDrawingSources.get(layer.id);
            if (!pending) {
                pending = this.createDrawingSource(layer);
                this.creatingDrawingSources.set(layer.id, pending);
            }
            try { await pending; }
            finally { if (this.creatingDrawingSources.get(layer.id) === pending) this.creatingDrawingSources.delete(layer.id); }
        }
        await this.save();
        if (!this.model.layers.includes(layer) || !this.layers.has(layer.id)) throw new Error("This drawing was removed. Choose an available drawing before saving.");
        if (this.model.draft?.layerId === layer.id) throw new Error("Save or cancel the unfinished polygon before using this drawing.");
        this.requireSavedDrawing(layer);
        return layer.drawingSource.id;
    }

    /** Create a durable source from a captured committed drawing while retaining later local edits.
     * @param {import("./model.js").AnnotationLayer} layer Original local drawing.
     * @return {Promise<void>} Completion after its reference is attached in memory.
     * @throws {Error} If creation or idempotent retry does not match the captured original contents.
     */
    async createDrawingSource(layer) {
        await this.saveForSharing();
        if (this.model.draft?.layerId === layer.id) throw new Error("Save or cancel the unfinished polygon before using this drawing.");
        const collection = exportDrawingCollection(layer);
        const record = await this.sourceApi.create(layer.id, collection);
        const restored = readDrawingView(record, layer.id);
        if (serializeDrawingContent(record.collection) !== serializeDrawingContent(collection)) throw new Error("This drawing changed in another tab. Download your local polygons before removing this view and reopening the saved drawing.");
        layer.drawingSource = restored.drawingSource;
        this.savedDrawingContents.set(layer.id, serializeDrawingContent(record.collection));
        this.controls.get(layer.id)?.setDrawingSource(record.canEdit);
    }

    /** Export a linked drawing's current view settings without its polygon geometry.
     * @param {string} key Local drawing view key.
     * Unlinked device-only drawings stay outside portable map documents.
     * @return {Object|null} Portable source reference and appearance, or null for an unlinked or unrelated layer.
     */
    exportDrawingLayer(key) {
        const layer = this.model.layers.find(candidate => `local:annotation:${candidate.id}` === key);
        if (!layer?.drawingSource) return null;
        const record = this.mapLayers.getRecord(key);
        return {drawingLayerId: layer.drawingSource.id, isCustom: true, customName: layer.name,
            visible: layer.visible, opacity: layer.opacity, legendIncluded: record.entry.legendIncluded !== false,
            appearance: {...layer.style}, filter: annotationFilterRules(layer.filter)};
    }

    /** Remove clean cached drawing views before a complete map restores its saved views.
     * Portable maps own linked view settings; device storage still protects pending edits and drafts.
     * Unlinked drawings and shared-session contributions keep their existing device lifecycle.
     * @param {()=>boolean} isCurrent Whether the requesting full-map restoration is still active.
     * @return {Promise<void>} Completion after obsolete clean views are removed from map and device storage.
     */
    async prepareDrawingMapRestore(isCurrent) {
        if (this.savePromise) await this.savePromise;
        if (!isCurrent()) return;
        const replaced = this.model.layers.filter(layer => layer.drawingSource && !this.drawingHasLocalChanges(layer));
        if (!replaced.length) return;
        for (const layer of replaced) {
            const key = `local:annotation:${layer.id}`;
            if (this.layers.has(layer.id)) this.mapLayers.removeKey(key);
            else {
                this.model.layers = this.model.layers.filter(candidate => candidate !== layer);
                this.savedDrawingContents.delete(layer.id);
                this.unavailableDrawingSources.delete(layer.id);
                this.drawingSaveErrors.delete(layer.id);
            }
        }
        await this.save();
    }

    /** Prepare a detached view of the latest linked drawing, preserving original polygon IDs.
     * @param {Object} definition Portable drawing reference and local appearance/filter.
     * @param {()=>boolean} isCurrent Whether the requesting workflow still wants this view.
     * @return {Promise<{key:string,record:Object,layer:Object}|null>} Ordinary staged layer, or null after cancellation.
     * @throws {Error} If reading, validation or local edits prevent restoration; commit rechecks edits and revisions.
     */
    async stageDrawingLayer(definition, isCurrent) {
        if (!this.loaded) throw new Error("Wait for your saved drawings to open.");
        if (this.savePromise) await this.savePromise;
        const peers = this.model.layers.filter(layer => layer.drawingSource?.id === definition.drawingLayerId);
        if (peers.some(layer => this.drawingHasLocalChanges(layer))) throw new Error("This drawing has local changes. Save or cancel its unfinished polygon; if saving conflicts, download your polygons before removing this view and reopening the saved drawing.");
        const record = await this.sourceApi.get(definition.drawingLayerId);
        if (!isCurrent()) return null;
        if (this.model.layers.some(layer => layer.drawingSource?.id === record.id && this.drawingHasLocalChanges(layer))) throw new Error("This drawing has local changes. Save or cancel its unfinished polygon; if saving conflicts, download your polygons before removing this view and reopening the saved drawing.");
        const layer = readDrawingView(record, this.model.newId());
        layer.name = definition.customName ?? layer.name;
        layer.visible = definition.visible;
        layer.opacity = definition.opacity;
        layer.style = validateAnnotationStyle(definition.appearance);
        layer.filter = annotationFilterRules(definition.filter ?? layer.filter);
        readAnnotationLayers({version: 1, layers: [...this.model.layers, layer]});
        const {source, adapter} = this.createLayerAttachment(layer);
        const register = adapter.added, discard = adapter.discardStaged;
        adapter.added = () => {
            if (this.model.layers.some(peer => peer.drawingSource?.id === record.id && this.drawingHasLocalChanges(peer))) {
                throw new Error("This drawing has local changes. Save or cancel its unfinished polygon before reopening it.");
            }
            readAnnotationLayers({version: 1, layers: [...this.model.layers, layer]});
            this.acceptDrawingSource(record);
            this.model.layers.unshift(layer);
            this.savedDrawingContents.set(layer.id, serializeDrawingContent(record.collection));
            register();
            void this.save();
        };
        adapter.discardStaged = () => {
            discard();
            if (this.model.layers.includes(layer)) {
                this.model.layers = this.model.layers.filter(candidate => candidate !== layer);
                this.savedDrawingContents.delete(layer.id);
                void this.save();
            }
        };
        return this.mapLayers.stageLocal(source, adapter);
    }

    /** Refresh clean cached views while preserving pending local edits and unfinished drafts.
     * @return {Promise<void>} Completion with unavailable sources retained as read-only cached views.
     */
    async refreshDrawingSources() {
        const sources = new Set(this.model.layers.flatMap(layer => layer.drawingSource ? [layer.drawingSource.id] : []));
        for (const id of sources) {
            try {
                const record = await this.sourceApi.get(id);
                this.acceptDrawingSource(record);
                for (const layer of this.model.layers.filter(candidate => candidate.drawingSource?.id === id)) {
                    layer.drawingSource.canEdit = record.canEdit;
                    this.unavailableDrawingSources.delete(layer.id);
                    this.controls.get(layer.id)?.setDrawingSource(record.canEdit);
                }
            } catch {
                for (const layer of this.model.layers.filter(candidate => candidate.drawingSource?.id === id)) {
                    layer.drawingSource.canEdit = false;
                    this.unavailableDrawingSources.add(layer.id);
                    this.controls.get(layer.id)?.setDrawingSource(false);
                }
            }
        }
    }

    /** Apply an acknowledged source to its clean views without replacing newer revisions or pending edits.
     * @param {Object} record Server-validated source response.
     * @param {string|null} [savedViewId=null] View whose submitted contents were just acknowledged.
     * @return {void}
     * @throws {Error} If a delayed response is older than an already acknowledged source revision.
     */
    acceptDrawingSource(record, savedViewId = null) {
        const peers = this.model.layers.filter(layer => layer.drawingSource?.id === record.id);
        if (peers.some(layer => layer.drawingSource.revision > record.revision)) {
            throw new Error("This drawing changed while it was opening. Reopen the map or tool, or retry saving, to read its latest polygons.");
        }
        const contents = serializeDrawingContent(record.collection);
        for (const layer of peers) {
            const saved = layer.id === savedViewId;
            if (!saved && this.drawingHasLocalChanges(layer)) continue;
            const restored = readDrawingView(record, layer.id);
            if (!saved) layer.polygons = restored.polygons;
            layer.drawingSource = restored.drawingSource;
            if (saved) layer.drawingSource.pending = serializeDrawingContent(exportDrawingCollection(layer)) !== contents;
            this.savedDrawingContents.set(layer.id, contents);
            this.unavailableDrawingSources.delete(layer.id);
            this.drawingSaveErrors.delete(layer.id);
            if (this.layers.has(layer.id)) this.refreshLayer(layer.id);
            this.controls.get(layer.id)?.setDrawingSource(record.canEdit);
        }
    }

    /** Check whether refreshing a linked view would discard committed edits or a draft.
     * @param {import("./model.js").AnnotationLayer} layer Linked local view.
     * @return {boolean} Whether local data differs from the last acknowledged source.
     */
    drawingHasLocalChanges(layer) {
        const acknowledged = this.savedDrawingContents.get(layer.id);
        return layer.drawingSource.pending || this.model.draft?.layerId === layer.id
            || (acknowledged !== undefined && serializeDrawingContent(exportDrawingCollection(layer)) !== acknowledged);
    }

    /** Retry source refresh failures and the existing serialized local/source save loop.
     * @return {Promise<void>} Completion with success or actionable retained error feedback.
     */
    async retrySaving() {
        if (this.sourceApi && this.unavailableDrawingSources.size) await this.refreshDrawingSources();
        await this.save();
    }

    /** Mark committed changes before persisting their local copy or sending them to the source.
     * @return {void}
     */
    markDrawingChangesPending() {
        for (const layer of this.model.layers) {
            if (layer.drawingSource?.canEdit) layer.drawingSource.pending = layer.drawingSource.pending
                || serializeDrawingContent(exportDrawingCollection(layer)) !== this.savedDrawingContents.get(layer.id);
        }
    }

    /** Describe a drawing's retained save or refresh problem without referring to other sources.
     * @param {import("./model.js").AnnotationLayer} layer Local drawing view.
     * @return {string} Named problem and next action, or an empty string when this view is saved and available.
     */
    drawingSaveProblem(layer) {
        const error = this.drawingSaveErrors.get(layer.id);
        if (error) return `“${layer.name}”: ${error}`;
        if (this.unavailableDrawingSources.has(layer.id)) return `“${layer.name}” could not be refreshed. Its cached polygons are read-only; retry to reconnect.`;
        if (layer.drawingSource?.pending) return `“${layer.name}”: changes are saved only on this device. Retry saving, or download your local polygons to keep a separate copy.`;
        return "";
    }

    /** Require device persistence and saved, available views of this drawing's source.
     * Other sources' pending edits and refresh failures do not affect this drawing.
     * @param {import("./model.js").AnnotationLayer} layer Drawing being used or restored.
     * @return {void}
     * @throws {Error} If device persistence failed or a view of this same source has unsaved or unavailable content.
     */
    requireSavedDrawing(layer) {
        if (this.deviceSaveError) throw this.deviceSaveError;
        if (!layer.drawingSource) return;
        for (const peer of this.model.layers.filter(candidate => candidate.drawingSource?.id === layer.drawingSource.id)) {
            if (peer.drawingSource.pending || this.unavailableDrawingSources.has(peer.id)) throw new Error(this.drawingSaveProblem(peer));
        }
    }

    /**
     * Serialize device and linked-source writes, coalescing changes into the latest committed document.
     * Failed source saves retain local edits and named feedback without blocking unrelated sources.
     * @return {Promise<void>} Completion after pending writes settle.
     */
    async save() {
        if (!this.loaded) return;
        this.dirty = true;
        this.pendingSave = true;
        if (this.savePromise) return this.savePromise;
        this.savePromise = this.writePendingSaves();
        try { await this.savePromise; }
        finally { this.savePromise = null; }
    }

    /**
     * Save locally before updating linked sources, continuing past individual source failures.
     * Failed sources are attempted once per drain; later edits still reach device storage.
     * Device-write failures stop remote writes and remain a shared persistence failure.
     * @return {Promise<void>} Completion after writes settle with retained feedback for any failures.
     */
    async writePendingSaves() {
        this.saving = true;
        const previousProblems = new Set(this.model.layers.map(layer => this.drawingSaveProblem(layer)).filter(Boolean));
        this.status.textContent = "Saving on this device…";
        this.retryButton.hidden = true;
        const failedSources = new Set();
        try {
            while (this.pendingSave) {
                this.pendingSave = false;
                if (this.sourceApi) this.markDrawingChangesPending();
                const document = this.model.document();
                await this.storage.save(document);
                this.deviceSaveError = null;
                this.savedSharingLayers = document.layers.map(layer => ({ id: layer.id, collection: exportAnnotationGeoJSON(layer) }));
                if (this.sourceApi) {
                    for (const layer of document.layers.filter(candidate => candidate.drawingSource?.pending && candidate.drawingSource.canEdit)) {
                        if (failedSources.has(layer.drawingSource.id) || !this.model.layers.some(candidate => candidate.id === layer.id)) continue;
                        const collection = exportDrawingCollection(layer);
                        try {
                            const record = await this.sourceApi.update(layer.drawingSource.id, layer.drawingSource.revision, collection);
                            this.acceptDrawingSource(record, layer.id);
                            this.pendingSave = true;
                        }
                        catch (error) {
                            failedSources.add(layer.drawingSource.id);
                            if (this.model.layers.some(candidate => candidate.id === layer.id)) this.drawingSaveErrors.set(layer.id, error.status === 409
                                ? "this drawing changed in another tab. Download your local polygons before removing this view and reopening the saved drawing."
                                : `Could not save changes to the saved drawing: ${error.message} Retry saving; your local polygons are preserved on this device.`);
                        }
                    }
                }
            }
            this.dirty = this.model.layers.some(layer => layer.drawingSource?.pending);
            const problems = this.model.layers.map(layer => this.drawingSaveProblem(layer)).filter(Boolean);
            this.status.textContent = problems.join(" ");
            this.retryButton.hidden = !this.status.textContent;
            if (problems.some(problem => !previousProblems.has(problem))) this.panel.show();
        } catch (error) {
            this.deviceSaveError = error;
            this.status.textContent = `Not saved: ${error.message} Keep this tab open.`;
            this.retryButton.hidden = false;
            this.panel.show();
        } finally { this.saving = false; }
        if (!this.deviceSaveError) this.onCommittedChange?.();
    }
}
