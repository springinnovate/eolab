/** DOM presentation and local-file interaction for portable saved maps. */

/** Present saved-map actions without owning restoration or validation. */
export class SavedMapViewDomView {
    /**
     * Bind the fixed saved-map controls and map drop target.
     *
     * @param {Document} documentContext Application document.
     * @param {URL} urlApi Browser object-URL implementation.
     */
    constructor(documentContext = globalThis.document, urlApi = globalThis.URL) {
        this.document = documentContext;
        this.urlApi = urlApi;
        this.saveButton = documentContext.querySelector("#save-map-view");
        this.openButton = documentContext.querySelector("#open-map-view");
        this.fileInput = documentContext.querySelector("#open-map-view-file");
        this.mapContainer = documentContext.querySelector("#map");
        this.dialog = documentContext.querySelector("#saved-map-view-dialog");
        this.dialogTitle = documentContext.querySelector(
            "#saved-map-view-dialog-title"
        );
        this.dialogSummary = documentContext.querySelector(
            "#saved-map-view-dialog-summary"
        );
        this.dialogDetails = documentContext.querySelector(
            "#saved-map-view-dialog-details"
        );
        this.cancelButton = documentContext.querySelector(
            "#cancel-open-map-view"
        );
        this.confirmButton = documentContext.querySelector(
            "#confirm-open-map-view"
        );
        this.dragDepth = 0;
        this.handlers = null;
        this.blockCancel = (event) => event.preventDefault();
    }

    /**
     * Connect user events to controller-owned actions.
     *
     * @param {Object} handlers Saved-map action callbacks.
     * @param {()=>void} handlers.onSave Download current map state.
     * @param {(file:File)=>void} handlers.onOpen Open a selected local file.
     * @return {void}
     */
    bind({ onSave, onOpen }) {
        this.unbind();
        this.handlers = {
            save: () => onSave(),
            choose: () => this.fileInput.click(),
            change: () => {
                const file = this.fileInput.files?.[0];
                this.fileInput.value = "";
                if (file !== undefined) onOpen(file);
            },
            dragenter: (event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                this.dragDepth += 1;
                this.mapContainer.classList.add(
                    "is-saved-map-view-drop-target"
                );
            },
            dragover: (event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
            },
            dragleave: (event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                this.dragDepth = Math.max(0, this.dragDepth - 1);
                if (this.dragDepth === 0) {
                    this.mapContainer.classList.remove(
                        "is-saved-map-view-drop-target"
                    );
                }
            },
            drop: (event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                this.dragDepth = 0;
                this.mapContainer.classList.remove(
                    "is-saved-map-view-drop-target"
                );
                const file = event.dataTransfer.files?.[0];
                if (file !== undefined) onOpen(file);
            },
        };
        this.saveButton.addEventListener("click", this.handlers.save);
        this.openButton.addEventListener("click", this.handlers.choose);
        this.fileInput.addEventListener("change", this.handlers.change);
        this.mapContainer.addEventListener("dragenter", this.handlers.dragenter);
        this.mapContainer.addEventListener("dragover", this.handlers.dragover);
        this.mapContainer.addEventListener("dragleave", this.handlers.dragleave);
        this.mapContainer.addEventListener("drop", this.handlers.drop);
    }

    /**
     * Ask permission before current layers and viewport are replaced.
     *
     * @param {Object} savedMapView Validated saved-map document.
     * @param {number} currentLayerCount Current retained-layer count.
     * @param {string} currentVersion Running application version.
     * @param {string} currentOrigin Running application origin.
     * @return {Promise<boolean>} Whether the user approved replacement.
     */
    confirmOpen(
        savedMapView,
        currentLayerCount,
        currentVersion,
        currentOrigin
    ) {
        this.#prepareDialog(
            "Open saved map view?",
            `Replace ${formatCount(currentLayerCount, "current layer")} with ` +
                `${formatCount(savedMapView.layers.length, "saved layer")} ` +
                "and move the map to its saved position.",
            compatibilityDetails(savedMapView, currentVersion, currentOrigin)
        );
        this.cancelButton.textContent = "Cancel";
        this.cancelButton.value = "cancel";
        this.confirmButton.hidden = false;
        this.confirmButton.disabled = false;
        this.confirmButton.textContent = "Replace current view";
        return new Promise((resolve) => {
            this.dialog.addEventListener(
                "close",
                () => resolve(this.dialog.returnValue === "open"),
                { once: true }
            );
            this.dialog.showModal();
        });
    }

    /**
     * Show one persistent per-layer restoration report.
     *
     * @param {{loaded:number,total:number,details:string[]}} report Outcome.
     * @return {void}
     */
    showResults(report) {
        this.#setCancelBlocked(false);
        this.#prepareDialog(
            report.loaded === report.total
                ? "Saved map view opened"
                : "Saved map view partially opened",
            `${formatCount(report.loaded, "layer")} loaded from ` +
                `${formatCount(report.total, "saved layer")}.`,
            report.details
        );
        this.cancelButton.textContent = "Close";
        this.cancelButton.value = "close";
        this.confirmButton.hidden = true;
        this.dialog.showModal();
    }

    /**
     * Keep the application stable while current Items are revalidated.
     *
     * @param {number} layerCount Number of saved layers to restore.
     * @return {void}
     */
    showLoading(layerCount) {
        this.#prepareDialog(
            "Opening saved map view…",
            `Resolving and validating ${formatCount(layerCount, "saved layer")}.`,
            ["The current Catalog and rendering policies remain authoritative."]
        );
        this.cancelButton.hidden = true;
        this.confirmButton.hidden = true;
        this.dialog.setAttribute("aria-busy", "true");
        this.#setCancelBlocked(true);
        this.dialog.showModal();
    }

    /**
     * Present a local-file or validation error without changing map state.
     *
     * @param {Error} error User-facing failure.
     * @return {void}
     */
    showError(error) {
        this.#setCancelBlocked(false);
        this.#prepareDialog(
            "Saved map view could not be opened",
            error.message,
            []
        );
        this.cancelButton.textContent = "Close";
        this.cancelButton.hidden = false;
        this.cancelButton.value = "close";
        this.confirmButton.hidden = true;
        this.dialog.showModal();
    }

    /**
     * Enable or disable both entry actions during bounded async work.
     *
     * @param {boolean} busy Whether an open or save action is running.
     * @return {void}
     */
    setBusy(busy) {
        this.saveButton.disabled = busy;
        this.openButton.disabled = busy;
        this.openButton.setAttribute("aria-busy", String(busy));
    }

    /**
     * Download one generated JSON document without sending it to a server.
     *
     * @param {string} content UTF-8 JSON content.
     * @param {string} filename Safe proposed filename.
     * @return {void}
     */
    download(content, filename) {
        const objectUrl = this.urlApi.createObjectURL(
            new Blob([content], { type: "application/json;charset=utf-8" })
        );
        const link = this.document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        link.click();
        this.urlApi.revokeObjectURL(objectUrl);
    }

    /**
     * Detach every registered user event.
     *
     * @return {void}
     */
    unbind() {
        this.#setCancelBlocked(false);
        if (this.handlers === null) return;
        this.saveButton.removeEventListener("click", this.handlers.save);
        this.openButton.removeEventListener("click", this.handlers.choose);
        this.fileInput.removeEventListener("change", this.handlers.change);
        this.mapContainer.removeEventListener("dragenter", this.handlers.dragenter);
        this.mapContainer.removeEventListener("dragover", this.handlers.dragover);
        this.mapContainer.removeEventListener("dragleave", this.handlers.dragleave);
        this.mapContainer.removeEventListener("drop", this.handlers.drop);
        this.handlers = null;
    }

    /**
     * Replace dialog content while safely closing a previous presentation.
     *
     * @param {string} title Dialog heading.
     * @param {string} summary Dialog summary.
     * @param {string[]} details Optional detail rows.
     * @return {void}
     */
    #prepareDialog(title, summary, details) {
        if (this.dialog.open) this.dialog.close("replaced");
        this.dialogTitle.textContent = title;
        this.dialogSummary.textContent = summary;
        this.dialogDetails.replaceChildren();
        this.dialog.removeAttribute("aria-busy");
        this.cancelButton.hidden = false;
        this.dialogDetails.hidden = details.length === 0;
        for (const detail of details) {
            const item = this.document.createElement("li");
            item.textContent = detail;
            this.dialogDetails.append(item);
        }
    }

    /**
     * Block or restore Escape cancellation during noninterruptible restoration.
     *
     * @param {boolean} blocked Whether the loading dialog must remain modal.
     * @return {void}
     */
    #setCancelBlocked(blocked) {
        this.dialog.removeEventListener("cancel", this.blockCancel);
        if (blocked) {
            this.dialog.addEventListener("cancel", this.blockCancel);
        }
    }
}

/**
 * Return whether a drag event contains local files.
 *
 * @param {DragEvent} event Candidate drag event.
 * @return {boolean} Whether files are present.
 */
function hasFiles(event) {
    return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

/**
 * Format a count with a singular or plural noun.
 *
 * @param {number} count Nonnegative item count.
 * @param {string} singular Singular noun phrase.
 * @return {string} Count and inflected noun.
 */
function formatCount(count, singular) {
    return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * Build compatibility notices shown before replacement.
 *
 * @param {Object} savedMapView Validated saved-map document.
 * @param {string} currentVersion Running viewer version.
 * @param {string} currentOrigin Running viewer origin.
 * @return {string[]} Creation provenance and mismatch notices.
 */
function compatibilityDetails(savedMapView, currentVersion, currentOrigin) {
    const details = [
        `Created ${new Date(savedMapView.createdAt).toLocaleString()} with ` +
            `EOLab ${savedMapView.viewer.version}.`,
    ];
    if (savedMapView.viewer.version !== currentVersion) {
        details.push(
            `Viewer version differs from this deployment (${currentVersion}); ` +
            "each layer will be revalidated."
        );
    }
    if (savedMapView.viewer.origin !== currentOrigin) {
        details.push(
            `Saved by ${savedMapView.viewer.origin}; Catalog identities will ` +
            "be resolved against this deployment."
        );
    }
    return details;
}
