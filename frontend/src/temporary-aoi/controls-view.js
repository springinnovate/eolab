/**
 * Semantic DOM adapter for temporary-AOI upload and overlay controls.
 */

/**
 * Format a nonnegative byte count for compact upload progress text.
 *
 * @param {number} byteCount Finite nonnegative byte count.
 * @return {string} Human-readable bytes using binary units.
 * @throws {RangeError} If the byte count is invalid.
 */
function formatUploadByteCount(byteCount) {
    if (!Number.isFinite(byteCount) || byteCount < 0) {
        throw new RangeError("Upload byte count must be finite and nonnegative.");
    }
    const units = ["B", "KiB", "MiB", "GiB"];
    let value = byteCount;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const precision = unitIndex === 0 || value >= 10 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

/**
 * @typedef {Object} TemporaryAoiControlHandlers
 * @property {(event: Event) => void} onUpload Submit the selected upload.
 * @property {(event: Event) => void} onSelectDataset Submit a dataset choice.
 * @property {(event: Event) => void} onCancelSelection Cancel a pending upload.
 * @property {(event: Event) => void} onToggleVisibility Show or hide the AOI.
 * @property {(event: Event) => void} onZoom Zoom to the AOI.
 * @property {(event: Event) => void} onRemove Remove the AOI.
 */

/** Present and read the fixed temporary-AOI controls in the application DOM. */
export class TemporaryAoiControlsView {
    /**
     * Find and validate all required temporary-AOI control elements.
     *
     * @param {Document} [documentContext=document] Document containing controls.
     * @throws {Error} If any required semantic control is missing.
     */
    constructor(documentContext = document) {
        this.documentContext = documentContext;
        const selectors = {
            form: "#temporary-aoi-upload-form",
            fileInput: "#temporary-aoi-file",
            uploadButton: "#upload-temporary-aoi",
            progressContainer: "#temporary-aoi-upload-progress-container",
            progress: "#temporary-aoi-upload-progress",
            progressDetail: "#temporary-aoi-upload-progress-detail",
            selectionForm: "#temporary-aoi-selection-form",
            selectionSelect: "#temporary-aoi-dataset",
            selectionFilename: "#temporary-aoi-selection-filename",
            cancelSelectionButton: "#cancel-temporary-aoi-selection",
            details: "#temporary-aoi-details",
            filename: "#temporary-aoi-filename",
            dataset: "#temporary-aoi-layer",
            expiration: "#temporary-aoi-expiration",
            actions: "#temporary-aoi-actions",
            toggleButton: "#toggle-temporary-aoi",
            zoomButton: "#zoom-temporary-aoi",
            removeButton: "#remove-temporary-aoi",
            status: "#temporary-aoi-status",
            error: "#temporary-aoi-error",
            region: "#temporary-aoi",
        };
        for (const [name, selector] of Object.entries(selectors)) {
            this[name] = documentContext.querySelector(selector);
            if (this[name] === null) {
                throw new Error(`Temporary AOI control is required: ${selector}`);
            }
        }
        this.handlers = null;
    }

    /**
     * Attach one controller-owned handler to each interactive control.
     *
     * @param {TemporaryAoiControlHandlers} handlers Controller event handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.form.addEventListener("submit", handlers.onUpload);
        this.selectionForm.addEventListener("submit", handlers.onSelectDataset);
        this.cancelSelectionButton.addEventListener(
            "click",
            handlers.onCancelSelection
        );
        this.toggleButton.addEventListener("click", handlers.onToggleVisibility);
        this.zoomButton.addEventListener("click", handlers.onZoom);
        this.removeButton.addEventListener("click", handlers.onRemove);
    }

    /**
     * Detach the currently bound controller handlers.
     *
     * @return {void}
     */
    unbind() {
        if (this.handlers === null) {
            return;
        }
        this.form.removeEventListener("submit", this.handlers.onUpload);
        this.selectionForm.removeEventListener(
            "submit",
            this.handlers.onSelectDataset
        );
        this.cancelSelectionButton.removeEventListener(
            "click",
            this.handlers.onCancelSelection
        );
        this.toggleButton.removeEventListener(
            "click",
            this.handlers.onToggleVisibility
        );
        this.zoomButton.removeEventListener("click", this.handlers.onZoom);
        this.removeButton.removeEventListener("click", this.handlers.onRemove);
        this.handlers = null;
    }

    /**
     * Return the first file selected in the bounded upload input.
     *
     * @return {File|null} Selected file or null when the input is empty.
     */
    readFile() {
        return this.fileInput.files?.[0] ?? null;
    }

    /**
     * Return the currently selected opaque dataset choice identifier.
     *
     * @return {string} Selected choice identifier.
     */
    readChoiceId() {
        return this.selectionSelect.value;
    }

    /**
     * Present the initial no-upload state.
     *
     * @param {string} [statusMessage=""] Optional accessible status text.
     * @return {void}
     */
    renderIdle(statusMessage = "") {
        this.setBusy(false);
        this.hideUploadProgress();
        this.fileInput.value = "";
        this.fileInput.disabled = false;
        this.uploadButton.disabled = false;
        this.uploadButton.textContent = "Upload AOI";
        this.selectionForm.hidden = true;
        this.details.hidden = true;
        this.actions.hidden = true;
        this.error.textContent = "";
        this.status.textContent = statusMessage;
    }

    /**
     * Present a pending upload, selection, cancellation, or removal operation.
     *
     * @param {string} message Accessible progress message.
     * @return {void}
     */
    renderBusy(message) {
        this.setBusy(true);
        this.hideUploadProgress();
        this.fileInput.disabled = true;
        this.uploadButton.disabled = true;
        this.selectionSelect.disabled = true;
        this.cancelSelectionButton.disabled = true;
        this.toggleButton.disabled = true;
        this.zoomButton.disabled = true;
        this.removeButton.disabled = true;
        this.error.textContent = "";
        this.status.textContent = message;
    }

    /**
     * Present observable transfer bytes and capped approximate total progress.
     *
     * @param {Object} progress Current browser-owned progress presentation.
     * @param {number} progress.loadedBytes Approximate transferred file bytes.
     * @param {number} progress.totalBytes Selected file size in bytes.
     * @param {number} progress.transferPercent Transfer percentage from 0 to 100.
     * @param {number} progress.approximatePercent Approximate overall percentage.
     * @param {string} progress.stageMessage Accurate current stage statement.
     * @return {void}
     * @throws {RangeError|TypeError} If progress violates the view contract.
     */
    renderUploadProgress({
        loadedBytes,
        totalBytes,
        transferPercent,
        approximatePercent,
        stageMessage,
    }) {
        if (typeof stageMessage !== "string" || stageMessage.trim() === "") {
            throw new TypeError("Temporary AOI upload stage is invalid.");
        }
        if (
            !Number.isFinite(transferPercent) ||
            transferPercent < 0 ||
            transferPercent > 100 ||
            !Number.isFinite(approximatePercent) ||
            approximatePercent < 0 ||
            approximatePercent > 99
        ) {
            throw new RangeError("Temporary AOI upload progress is invalid.");
        }
        const boundedLoadedBytes = Math.min(loadedBytes, totalBytes);
        const byteDetail =
            `${formatUploadByteCount(boundedLoadedBytes)} of ` +
            `${formatUploadByteCount(totalBytes)} uploaded`;
        this.setBusy(true);
        this.progressContainer.hidden = false;
        this.progress.max = 100;
        this.progress.value = approximatePercent;
        this.progress.setAttribute(
            "aria-valuetext",
            `${stageMessage} Approximately ${approximatePercent}% complete.`
        );
        this.progressDetail.textContent =
            `${byteDetail} (${Math.round(transferPercent)}% transfer). ` +
            `Approximately ${Math.round(approximatePercent)}% overall.`;
        if (this.status.textContent !== stageMessage) {
            this.status.textContent = stageMessage;
        }
    }

    /**
     * Hide and reset upload-only progress without changing other AOI state.
     *
     * @return {void}
     */
    hideUploadProgress() {
        this.progressContainer.hidden = true;
        this.progress.value = 0;
        this.progress.setAttribute("aria-valuetext", "");
        this.progressDetail.textContent = "";
    }

    /**
     * Present the explicit choice step for a multi-dataset upload.
     *
     * @param {{filename: string, choices: Array<{id: string, label: string}>}}
     * pendingUpload Validated selection-required response.
     * @return {void}
     */
    renderSelection(pendingUpload) {
        this.setBusy(false);
        this.hideUploadProgress();
        this.fileInput.disabled = true;
        this.uploadButton.disabled = true;
        this.selectionSelect.replaceChildren();
        for (const choice of pendingUpload.choices) {
            const option = this.documentContext.createElement("option");
            option.value = choice.id;
            option.textContent = choice.label;
            this.selectionSelect.append(option);
        }
        this.selectionSelect.disabled = false;
        this.cancelSelectionButton.disabled = false;
        this.selectionFilename.textContent = pendingUpload.filename;
        this.selectionForm.hidden = false;
        this.error.textContent = "";
        this.status.textContent =
            "Choose the spatial dataset to display from this upload.";
        this.selectionSelect.focus();
    }

    /**
     * Present ready AOI metadata and map actions.
     *
     * @param {{filename: string, selectedDataset: string, expiresAt: string}}
     * temporaryAoi Validated ready response.
     * @param {boolean} isVisible Whether the AOI is displayed on the map.
     * @param {string} [statusMessage="Temporary AOI displayed on the map."]
     * Accessible status text.
     * @return {void}
     */
    renderReady(
        temporaryAoi,
        isVisible,
        statusMessage = "Temporary AOI displayed on the map."
    ) {
        this.setBusy(false);
        this.hideUploadProgress();
        this.fileInput.value = "";
        this.fileInput.disabled = false;
        this.uploadButton.disabled = false;
        this.uploadButton.textContent = "Replace AOI";
        this.selectionForm.hidden = true;
        this.filename.textContent = temporaryAoi.filename;
        this.dataset.textContent = temporaryAoi.selectedDataset;
        this.expiration.dateTime = temporaryAoi.expiresAt;
        this.expiration.textContent = new Date(
            temporaryAoi.expiresAt
        ).toLocaleString();
        this.details.hidden = false;
        this.actions.hidden = false;
        this.selectionSelect.disabled = false;
        this.cancelSelectionButton.disabled = false;
        this.toggleButton.disabled = false;
        this.zoomButton.disabled = false;
        this.removeButton.disabled = false;
        this.renderVisibility(isVisible);
        this.error.textContent = "";
        this.status.textContent = statusMessage;
    }

    /**
     * Synchronize the show/hide control with current Leaflet visibility.
     *
     * @param {boolean} isVisible Whether the AOI is displayed on the map.
     * @return {void}
     */
    renderVisibility(isVisible) {
        this.toggleButton.setAttribute("aria-pressed", String(isVisible));
        this.toggleButton.textContent = isVisible ? "Hide" : "Show";
    }

    /**
     * Present a non-error update in the polite AOI status region.
     *
     * @param {string} message Accessible status message.
     * @return {void}
     */
    renderStatus(message) {
        this.error.textContent = "";
        this.status.textContent = message;
    }

    /**
     * Present an adjacent actionable error without discarding current controls.
     *
     * @param {Error} error User-safe operation error.
     * @param {string} recoveryAction Concise next action available to the user.
     * @return {void}
     */
    renderError(error, recoveryAction) {
        this.setBusy(false);
        this.hideUploadProgress();
        this.error.textContent = `${error.message} ${recoveryAction}`;
        this.status.textContent = "";
    }

    /**
     * Focus the file picker when replacement is the next recovery action.
     *
     * @return {void}
     */
    focusFile() {
        this.fileInput.focus();
    }

    /**
     * Set the AOI region's busy state for assistive technology.
     *
     * @param {boolean} isBusy Whether an AOI request is pending.
     * @return {void}
     */
    setBusy(isBusy) {
        this.region.setAttribute("aria-busy", String(isBusy));
    }
}
