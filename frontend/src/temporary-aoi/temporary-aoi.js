/**
 * Coordinator for the temporary-AOI upload, selection, map, and cleanup flow.
 */
import { TemporaryAoiApiClient } from "./api.js";
import { TemporaryAoiControlsView } from "./controls-view.js";
import { TemporaryAoiLayerController } from "./leaflet.js";

const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const UPLOAD_TRANSFER_PROGRESS_CEILING = 70;
const UPLOAD_SERVER_RECEIVED_PERCENT = 75;
const UPLOAD_VALIDATION_PERCENT = 85;
const UPLOAD_GEOMETRY_PERCENT = 92;
const UPLOAD_VALIDATION_STAGE_DELAY_MILLISECONDS = 600;
const UPLOAD_GEOMETRY_STAGE_DELAY_MILLISECONDS = 1_800;

/**
 * Copy lifecycle, display identity, and a canonical presentation anchor across
 * the histogram integration.
 *
 * Browser GeoJSON remains private to the temporary-AOI controller. The frozen
 * bounding box lets a map presentation point to the sampled area, while the
 * raster statistics API continues to receive only the opaque server reference.
 *
 * @param {Object} readyAoi Validated ready temporary-AOI response.
 * @return {Readonly<Object>} Immutable public sampling-area snapshot.
 */
function temporaryAoiSamplingSnapshot(readyAoi) {
    const [west, south, east, north] = readyAoi.bbox;
    return Object.freeze({
        id: readyAoi.id,
        filename: readyAoi.filename,
        selectedDataset: readyAoi.selectedDataset,
        expiresAt: readyAoi.expiresAt,
        bounds: Object.freeze({ west, south, east, north }),
    });
}

/**
 * @typedef {Object} TemporaryAoiCoordinatorDependencies
 * @property {TemporaryAoiApiClient} [apiClient=new TemporaryAoiApiClient()]
 * Temporary-AOI API client.
 * @property {TemporaryAoiControlsView} [controlsView=new TemporaryAoiControlsView()]
 * Semantic DOM adapter.
 * @property {TemporaryAoiLayerController} [layerController] Leaflet lifecycle.
 * @property {{setTimeout: (callback: () => void, delay: number) => *,
 * clearTimeout: (identifier: *) => void}} [clock=globalThis] Timer implementation.
 * @property {() => number} [now=Date.now] Current epoch milliseconds provider.
 */

/** Coordinate one browser-session-only temporary AOI from upload to expiry. */
export class TemporaryAoiCoordinator {
    /**
     * Create and bind the temporary-AOI feature boundary.
     *
     * @param {Object} leafletMap Leaflet-compatible application map.
     * @param {Object} leaflet Leaflet namespace used to construct AOI geometry.
     * @param {TemporaryAoiCoordinatorDependencies} [dependencies={}] Injectable
     * API, view, map-layer, and clock collaborators.
     */
    constructor(
        leafletMap,
        leaflet,
        {
            apiClient = new TemporaryAoiApiClient(),
            controlsView = new TemporaryAoiControlsView(),
            layerController = new TemporaryAoiLayerController(
                leafletMap,
                leaflet
            ),
            clock = globalThis,
            now = Date.now,
        } = {}
    ) {
        this.apiClient = apiClient;
        this.controlsView = controlsView;
        this.layerController = layerController;
        this.clock = clock;
        this.now = now;
        this.activeAoi = null;
        this.pendingUpload = null;
        this.activeExpirationTimer = null;
        this.pendingExpirationTimer = null;
        this.uploadProgressTimers = new Set();
        this.operationSequence = 0;
        this.destroyed = false;
        this.samplingAreaListeners = new Set();

        this.handlers = {
            onUpload: this.handleUpload.bind(this),
            onSelectDataset: this.handleDatasetSelection.bind(this),
            onCancelSelection: this.handleCancelSelection.bind(this),
            onToggleVisibility: this.handleToggleVisibility.bind(this),
            onZoom: this.handleZoom.bind(this),
            onRemove: this.handleRemove.bind(this),
        };
        controlsView.bind(this.handlers);
        controlsView.renderIdle();
    }

    /**
     * Upload the selected file while retaining an active AOI until replacement
     * succeeds.
     *
     * @param {Event} event Upload form submit event.
     * @return {Promise<void>} Resolves after upload state is presented.
     */
    async handleUpload(event) {
        event.preventDefault();
        const file = this.controlsView.readFile();
        if (file === null) {
            this.controlsView.renderError(
                new Error("Choose a GeoPackage or zipped Shapefile."),
                "Select a .gpkg or .zip file, then try again."
            );
            this.controlsView.focusFile();
            return;
        }
        const operationSequence = ++this.operationSequence;
        this.clearUploadProgressTimers();
        const filename = file.name ?? "selected AOI file";
        this.controlsView.renderBusy(
            this.activeAoi === null
                ? "Starting the temporary AOI upload…"
                : "Starting the replacement AOI upload…"
        );
        this.controlsView.renderUploadProgress({
            loadedBytes: 0,
            totalBytes: file.size,
            transferPercent: 0,
            approximatePercent: 0,
            stageMessage: `Uploading ${filename}…`,
        });
        try {
            const response = await this.apiClient.upload(
                file,
                this.activeAoi?.id ?? null,
                (progress) => this.handleUploadProgress(
                    operationSequence,
                    filename,
                    progress
                )
            );
            if (!this.isCurrentOperation(operationSequence)) {
                await this.removeStaleResponse(response);
                return;
            }
            this.clearUploadProgressTimers();
            if (response.state === "selectionRequired") {
                this.setPendingUpload(response);
                this.controlsView.renderSelection(response);
                return;
            }
            this.activateReadyAoi(response);
        } catch (error) {
            if (this.isCurrentOperation(operationSequence)) {
                this.clearUploadProgressTimers();
                this.restoreCurrentPresentation();
                this.controlsView.renderError(
                    error,
                    "Choose a supported file and try again."
                );
            }
        }
    }

    /**
     * Convert observable transfer bytes to capped approximate total progress.
     *
     * Transfer bytes are browser measured. Percentages after upload completion
     * are deliberately approximate because the synchronous server operation
     * exposes no internal progress endpoint.
     *
     * @param {number} operationSequence Upload operation owning the progress.
     * @param {string} filename Display-only selected filename.
     * @param {{loadedBytes:number,totalBytes:number,uploadComplete:boolean}}
     * progress Observable upload transfer state.
     * @return {void}
     */
    handleUploadProgress(operationSequence, filename, progress) {
        if (!this.isCurrentOperation(operationSequence)) {
            return;
        }
        const transferPercent = progress.totalBytes > 0
            ? Math.min(100, progress.loadedBytes / progress.totalBytes * 100)
            : progress.uploadComplete ? 100 : 0;
        if (!progress.uploadComplete) {
            this.controlsView.renderUploadProgress({
                loadedBytes: progress.loadedBytes,
                totalBytes: progress.totalBytes,
                transferPercent,
                approximatePercent: Math.round(
                    transferPercent / 100 * UPLOAD_TRANSFER_PROGRESS_CEILING
                ),
                stageMessage: `Uploading ${filename}…`,
            });
            return;
        }
        this.controlsView.renderUploadProgress({
            loadedBytes: progress.totalBytes,
            totalBytes: progress.totalBytes,
            transferPercent: 100,
            approximatePercent: UPLOAD_SERVER_RECEIVED_PERCENT,
            stageMessage:
                "Upload complete. Server is checking the file structure…",
        });
        this.scheduleUploadProcessingStages(
            operationSequence,
            progress.totalBytes
        );
    }

    /**
     * Schedule honest time-based estimates for synchronous server processing.
     *
     * The estimates stop below completion and are canceled as soon as the
     * authoritative response arrives.
     *
     * @param {number} operationSequence Upload operation owning the stages.
     * @param {number} totalBytes Fully transferred selected file size.
     * @return {void}
     */
    scheduleUploadProcessingStages(operationSequence, totalBytes) {
        this.clearUploadProgressTimers();
        const stages = [
            {
                delay: UPLOAD_VALIDATION_STAGE_DELAY_MILLISECONDS,
                approximatePercent: UPLOAD_VALIDATION_PERCENT,
                stageMessage:
                    "Estimated stage: validating spatial datasets and coordinate metadata…",
            },
            {
                delay: UPLOAD_GEOMETRY_STAGE_DELAY_MILLISECONDS,
                approximatePercent: UPLOAD_GEOMETRY_PERCENT,
                stageMessage:
                    "Estimated stage: preparing bounded WGS 84 map geometry…",
            },
        ];
        for (const stage of stages) {
            let timerIdentifier;
            timerIdentifier = this.clock.setTimeout(() => {
                this.uploadProgressTimers.delete(timerIdentifier);
                if (!this.isCurrentOperation(operationSequence)) {
                    return;
                }
                this.controlsView.renderUploadProgress({
                    loadedBytes: totalBytes,
                    totalBytes,
                    transferPercent: 100,
                    approximatePercent: stage.approximatePercent,
                    stageMessage: stage.stageMessage,
                });
            }, stage.delay);
            this.uploadProgressTimers.add(timerIdentifier);
        }
    }

    /**
     * Cancel all pending approximate upload-processing stage updates.
     *
     * @return {void}
     */
    clearUploadProgressTimers() {
        for (const timerIdentifier of this.uploadProgressTimers) {
            this.clock.clearTimeout(timerIdentifier);
        }
        this.uploadProgressTimers.clear();
    }

    /**
     * Complete a pending multi-dataset upload using its explicit choice.
     *
     * @param {Event} event Dataset-selection form submit event.
     * @return {Promise<void>} Resolves after selection state is presented.
     */
    async handleDatasetSelection(event) {
        event.preventDefault();
        if (this.pendingUpload === null) {
            return;
        }
        const pendingUpload = this.pendingUpload;
        const operationSequence = ++this.operationSequence;
        this.clearUploadProgressTimers();
        this.controlsView.renderBusy("Preparing the selected spatial dataset…");
        try {
            const readyAoi = await this.apiClient.selectDataset(
                pendingUpload.id,
                this.controlsView.readChoiceId()
            );
            if (!this.isCurrentOperation(operationSequence)) {
                await this.removeStaleResponse(readyAoi);
                return;
            }
            this.activateReadyAoi(readyAoi);
        } catch (error) {
            if (!this.isCurrentOperation(operationSequence)) {
                return;
            }
            this.clearPendingUpload();
            this.restoreCurrentPresentation();
            this.controlsView.renderError(
                error,
                "Upload the file again and choose a dataset."
            );
        }
    }

    /**
     * Cancel and remove a pending multi-dataset upload.
     *
     * @param {Event} event Cancel-selection button event.
     * @return {Promise<void>} Resolves after pending storage is removed.
     */
    async handleCancelSelection(event) {
        event.preventDefault();
        if (this.pendingUpload === null) {
            return;
        }
        const pendingUpload = this.pendingUpload;
        const operationSequence = ++this.operationSequence;
        this.controlsView.renderBusy("Canceling the pending upload…");
        try {
            await this.apiClient.remove(pendingUpload.id);
            if (!this.isCurrentOperation(operationSequence)) {
                return;
            }
            this.clearPendingUpload();
            this.restoreCurrentPresentation("Pending upload canceled.");
        } catch (error) {
            if (this.isCurrentOperation(operationSequence)) {
                this.controlsView.renderSelection(pendingUpload);
                this.controlsView.renderError(
                    error,
                    "Try canceling again before uploading another file."
                );
            }
        }
    }

    /**
     * Toggle retained AOI geometry without changing server storage.
     *
     * @param {Event} event Show/hide button event.
     * @return {void}
     */
    handleToggleVisibility(event) {
        event.preventDefault();
        if (this.activeAoi === null) {
            return;
        }
        if (this.layerController.isVisible) {
            this.layerController.hide();
            this.controlsView.renderVisibility(false);
            this.controlsView.renderStatus(
                "Temporary AOI hidden. Raster histogram selection is " +
                "unchanged."
            );
        } else {
            this.layerController.show();
            this.controlsView.renderVisibility(true);
            this.controlsView.renderStatus(
                "Temporary AOI shown. Raster histogram selection is " +
                "unchanged."
            );
        }
    }

    /**
     * Zoom the map to the retained AOI bounds.
     *
     * @param {Event} event Zoom button event.
     * @return {void}
     */
    handleZoom(event) {
        event.preventDefault();
        if (this.layerController.zoom()) {
            this.controlsView.renderStatus("Map zoomed to the temporary AOI.");
        }
    }

    /**
     * Remove the active AOI from server storage and the map.
     *
     * @param {Event} event Remove button event.
     * @return {Promise<void>} Resolves after removal state is presented.
     */
    async handleRemove(event) {
        event.preventDefault();
        if (this.activeAoi === null) {
            return;
        }
        const activeAoi = this.activeAoi;
        const operationSequence = ++this.operationSequence;
        this.controlsView.renderBusy("Removing the temporary AOI…");
        try {
            await this.apiClient.remove(activeAoi.id);
            if (!this.isCurrentOperation(operationSequence)) {
                return;
            }
            this.clearActiveAoi();
            this.controlsView.renderIdle("Temporary AOI removed.");
            this.controlsView.focusFile();
        } catch (error) {
            if (this.isCurrentOperation(operationSequence)) {
                this.controlsView.renderReady(
                    activeAoi,
                    this.layerController.isVisible,
                    ""
                );
                this.controlsView.renderError(
                    error,
                    "Try removing it again."
                );
            }
        }
    }

    /**
     * Apply one ready response atomically to browser state and map geometry.
     *
     * @param {Object} readyAoi Validated ready response.
     * @return {void}
     */
    activateReadyAoi(readyAoi) {
        this.clearPendingUpload();
        this.clearActiveExpirationTimer();
        this.activeAoi = readyAoi;
        this.layerController.load(readyAoi);
        this.scheduleActiveExpiration(readyAoi);
        this.controlsView.renderReady(readyAoi, true);
        this.notifySamplingAreaChange();
    }

    /**
     * Retain one selection-required upload and schedule its browser expiry.
     *
     * @param {Object} pendingUpload Validated selection-required response.
     * @return {void}
     */
    setPendingUpload(pendingUpload) {
        this.clearPendingUpload();
        this.pendingUpload = pendingUpload;
        const delay = this.expirationDelay(pendingUpload.expiresAt);
        this.pendingExpirationTimer = this.clock.setTimeout(
            this.expirePendingUpload.bind(this, pendingUpload.id),
            delay
        );
    }

    /**
     * Schedule clearing of visible browser geometry at server expiration.
     *
     * @param {Object} readyAoi Validated ready response.
     * @return {void}
     */
    scheduleActiveExpiration(readyAoi) {
        const delay = this.expirationDelay(readyAoi.expiresAt);
        this.activeExpirationTimer = this.clock.setTimeout(
            this.expireActiveAoi.bind(this, readyAoi.id),
            delay
        );
    }

    /**
     * Calculate a safe JavaScript timer delay for one expiration timestamp.
     *
     * @param {string} expiresAt Validated ISO expiration timestamp.
     * @return {number} Nonnegative timer delay bounded to platform limits.
     */
    expirationDelay(expiresAt) {
        return Math.min(
            Math.max(Date.parse(expiresAt) - this.now(), 0),
            MAX_TIMER_DELAY_MILLISECONDS
        );
    }

    /**
     * Expire active geometry only if it still belongs to the scheduled AOI.
     *
     * @param {string} temporaryAoiId Scheduled opaque AOI identifier.
     * @return {void}
     */
    expireActiveAoi(temporaryAoiId) {
        if (this.activeAoi?.id !== temporaryAoiId) {
            return;
        }
        this.clearActiveAoi();
        if (this.pendingUpload !== null) {
            const pendingUpload = this.pendingUpload;
            this.controlsView.renderIdle();
            this.controlsView.renderSelection(pendingUpload);
            return;
        }
        this.controlsView.renderIdle(
            "Temporary AOI expired and was removed from the map."
        );
    }

    /**
     * Expire a pending choice only if it still owns the selection controls.
     *
     * @param {string} temporaryAoiId Scheduled opaque AOI identifier.
     * @return {void}
     */
    expirePendingUpload(temporaryAoiId) {
        if (this.pendingUpload?.id !== temporaryAoiId) {
            return;
        }
        this.clearPendingUpload();
        this.restoreCurrentPresentation(
            "Pending upload expired before a dataset was selected."
        );
    }

    /**
     * Remove retained active geometry and cancel its expiration timer.
     *
     * @return {void}
     */
    clearActiveAoi() {
        const hadActiveAoi = this.activeAoi !== null;
        this.clearActiveExpirationTimer();
        this.activeAoi = null;
        this.layerController.clear();
        if (hadActiveAoi) {
            this.notifySamplingAreaChange();
        }
    }

    /**
     * Subscribe to ready AOI lifecycle changes through the public boundary.
     *
     * Removal or expiration publishes null. Overlay visibility is independent
     * presentation state and never changes the sampleable lifecycle.
     *
     * @param {(temporaryAoi: Readonly<Object>|null) => void} listener Receives
     * lifecycle/display snapshots with a frozen presentation bounding box and
     * unavailable state as null. GeoJSON remains private.
     * @return {() => void} Idempotent function that removes the subscription.
     */
    subscribeSamplingArea(listener) {
        if (typeof listener !== "function") {
            throw new TypeError("Temporary AOI sampling listener is required.");
        }
        this.samplingAreaListeners.add(listener);
        listener(this.activeAoi === null
            ? null
            : temporaryAoiSamplingSnapshot(this.activeAoi));
        return () => {
            this.samplingAreaListeners.delete(listener);
        };
    }

    /**
     * Publish the current ready lifecycle without exposing overlay geometry.
     *
     * @return {void}
     */
    notifySamplingAreaChange() {
        const snapshot =
            this.activeAoi === null
                ? null
                : temporaryAoiSamplingSnapshot(this.activeAoi);
        for (const listener of this.samplingAreaListeners) {
            listener(snapshot);
        }
    }

    /**
     * Clear one pending selection and its browser expiration timer.
     *
     * @return {void}
     */
    clearPendingUpload() {
        if (this.pendingExpirationTimer !== null) {
            this.clock.clearTimeout(this.pendingExpirationTimer);
            this.pendingExpirationTimer = null;
        }
        this.pendingUpload = null;
    }

    /**
     * Cancel the active browser expiration timer, if present.
     *
     * @return {void}
     */
    clearActiveExpirationTimer() {
        if (this.activeExpirationTimer !== null) {
            this.clock.clearTimeout(this.activeExpirationTimer);
            this.activeExpirationTimer = null;
        }
    }

    /**
     * Restore ready or idle controls after a recoverable operation.
     *
     * @param {string} [statusMessage=""] Optional accessible status message.
     * @return {void}
     */
    restoreCurrentPresentation(statusMessage = "") {
        if (this.activeAoi === null) {
            this.controlsView.renderIdle(statusMessage);
            return;
        }
        this.controlsView.renderReady(
            this.activeAoi,
            this.layerController.isVisible,
            statusMessage
        );
    }

    /**
     * Test whether an async result still owns coordinator presentation state.
     *
     * @param {number} operationSequence Sequence captured before awaiting.
     * @return {boolean} Whether the result is current and coordinator is alive.
     */
    isCurrentOperation(operationSequence) {
        return !this.destroyed && operationSequence === this.operationSequence;
    }

    /**
     * Remove storage created by a successful response that lost async ownership.
     *
     * @param {Object} response Validated stale upload or selection response.
     * @return {Promise<void>} Resolves after best-effort stale cleanup.
     */
    async removeStaleResponse(response) {
        try {
            await this.apiClient.remove(response.id);
        } catch {
            // Server expiration remains the final cleanup boundary if a stale
            // best-effort browser deletion cannot be completed.
        }
    }

    /**
     * Detach UI handlers and clear browser-only presentation state permanently.
     * Server resources remain bounded by their authoritative expiration.
     *
     * @return {void}
     */
    destroy() {
        this.destroyed = true;
        this.operationSequence += 1;
        this.clearUploadProgressTimers();
        this.clearPendingUpload();
        this.clearActiveAoi();
        this.samplingAreaListeners.clear();
        this.controlsView.unbind();
    }
}

/**
 * Initialize temporary AOI controls against the shared application map.
 *
 * @param {Object} leafletMap Initialized Leaflet-compatible application map.
 * @param {Object} leaflet Leaflet namespace used to render AOI geometry.
 * @return {TemporaryAoiCoordinator} Bound temporary-AOI feature boundary.
 */
export function initializeTemporaryAoi(leafletMap, leaflet) {
    return new TemporaryAoiCoordinator(leafletMap, leaflet);
}
