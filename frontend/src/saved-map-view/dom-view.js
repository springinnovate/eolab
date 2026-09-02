/** DOM presentation and browser-link interaction for portable saved maps. */

/** Present shared-map actions without owning restoration or validation. */
export class SavedMapViewDomView {
    /**
     * Bind the fixed saved-map controls and browser capabilities.
     *
     * @param {Document} documentContext Application document.
     * @param {Object} [browserContext] Injected browser interfaces.
     * @param {{href:string}} [browserContext.locationContext] Current location.
     * @param {{writeText:(value:string)=>Promise<void>}} [browserContext.clipboard]
     * Clipboard writer, when browser permissions permit it.
     * @param {(handler:()=>void,delay:number)=>unknown} [browserContext.setTimer]
     * Timer used to restore the copy-button label.
     * @param {(timer:unknown)=>void} [browserContext.clearTimer] Timer clearer.
     */
    constructor(
        documentContext = globalThis.document,
        {
            locationContext = globalThis.location,
            clipboard = globalThis.navigator?.clipboard,
            setTimer = globalThis.setTimeout,
            clearTimer = globalThis.clearTimeout,
        } = {}
    ) {
        this.document = documentContext;
        this.location = locationContext;
        this.clipboard = clipboard;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.copyButton = documentContext.querySelector("#copy-map-link");
        this.copyButtonLabel = documentContext.querySelector(
            "#copy-map-link-label"
        );
        this.dialog = documentContext.querySelector("#saved-map-view-dialog");
        this.dialogTitle = documentContext.querySelector(
            "#saved-map-view-dialog-title"
        );
        this.dialogSummary = documentContext.querySelector(
            "#saved-map-view-dialog-summary"
        );
        this.dialogUrl = documentContext.querySelector(
            "#saved-map-view-dialog-url"
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
        this.handlers = null;
        this.copiedTimer = null;
        this.blockCancel = (event) => event.preventDefault();
    }

    /**
     * Connect the copy action to controller-owned orchestration.
     *
     * @param {Object} handlers Saved-map action callbacks.
     * @param {()=>void} handlers.onCopy Copy the current shared map link.
     * @return {void}
     */
    bind({ onCopy }) {
        this.unbind();
        this.handlers = { copy: () => onCopy() };
        this.copyButton.addEventListener("click", this.handlers.copy);
    }

    /**
     * Copy a fragment on the current viewer URL when Clipboard API access works.
     *
     * @param {string} fragment Validated complete `#view=` fragment.
     * @return {Promise<{copied:boolean,url:string}>} Copy result and share URL.
     */
    async copyLink(fragment) {
        const url = createSavedMapViewUrl(this.location.href, fragment);
        if (typeof this.clipboard?.writeText !== "function") {
            return { copied: false, url };
        }
        try {
            await this.clipboard.writeText(url);
            return { copied: true, url };
        } catch {
            return { copied: false, url };
        }
    }

    /**
     * Temporarily acknowledge a successful clipboard write on the action itself.
     *
     * @return {void}
     */
    showCopied() {
        if (this.copiedTimer !== null) this.clearTimer(this.copiedTimer);
        this.copyButtonLabel.textContent = "Map link copied";
        this.copiedTimer = this.setTimer(() => {
            this.copyButtonLabel.textContent = "Copy map link";
            this.copiedTimer = null;
        }, 2200);
    }

    /**
     * Present a selectable link when automatic clipboard access is unavailable.
     *
     * @param {string} url Complete share URL.
     * @return {void}
     */
    showCopyFallback(url) {
        this.#setCancelBlocked(false);
        this.#prepareDialog(
            "Copy map link",
            "Your browser could not copy automatically. Copy this link:",
            []
        );
        this.dialogUrl.hidden = false;
        this.dialogUrl.value = url;
        this.cancelButton.textContent = "Close";
        this.cancelButton.value = "close";
        this.confirmButton.hidden = true;
        this.dialog.showModal();
        this.dialogUrl.focus();
        this.dialogUrl.select();
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
            "Open shared map view?",
            `Replace ${formatCount(currentLayerCount, "current layer")} with ` +
                `${formatCount(savedMapView.layers.length, "shared layer")} ` +
                "and move the map to its shared position.",
            compatibilityDetails(savedMapView, currentVersion, currentOrigin)
        );
        this.cancelButton.textContent = "Cancel";
        this.cancelButton.value = "cancel";
        this.confirmButton.hidden = false;
        this.confirmButton.disabled = false;
        this.confirmButton.textContent = "Open shared view";
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
                ? "Shared map view opened"
                : "Shared map view partially opened",
            `${formatCount(report.loaded, "layer")} loaded from ` +
                `${formatCount(report.total, "shared layer")}.`,
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
     * @param {number} layerCount Number of shared layers to restore.
     * @return {void}
     */
    showLoading(layerCount) {
        this.#prepareDialog(
            "Opening shared map view…",
            `Resolving and validating ${formatCount(layerCount, "shared layer")}.`,
            ["The current Catalog and rendering policies remain authoritative."]
        );
        this.cancelButton.hidden = true;
        this.confirmButton.hidden = true;
        this.dialog.setAttribute("aria-busy", "true");
        this.#setCancelBlocked(true);
        this.dialog.showModal();
    }

    /**
     * Present a link creation or validation error without changing map state.
     *
     * @param {Error} error User-facing failure.
     * @param {"copy"|"open"} operation Failed operation.
     * @return {void}
     */
    showError(error, operation) {
        this.#setCancelBlocked(false);
        this.#prepareDialog(
            operation === "copy"
                ? "Map link could not be created"
                : "Shared map view could not be opened",
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
     * Enable or disable the entry action during bounded async work.
     *
     * @param {boolean} busy Whether a copy or open action is running.
     * @return {void}
     */
    setBusy(busy) {
        this.copyButton.disabled = busy;
        this.copyButton.setAttribute("aria-busy", String(busy));
    }

    /**
     * Detach every registered user event and pending presentation timer.
     *
     * @return {void}
     */
    unbind() {
        this.#setCancelBlocked(false);
        if (this.handlers !== null) {
            this.copyButton.removeEventListener("click", this.handlers.copy);
            this.handlers = null;
        }
        if (this.copiedTimer !== null) {
            this.clearTimer(this.copiedTimer);
            this.copiedTimer = null;
            this.copyButtonLabel.textContent = "Copy map link";
        }
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
        this.dialogUrl.hidden = true;
        this.dialogUrl.value = "";
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
        if (blocked) this.dialog.addEventListener("cancel", this.blockCancel);
    }
}

/**
 * Place a validated saved-map fragment on the current viewer URL.
 *
 * @param {string} currentHref Current complete viewer URL.
 * @param {string} fragment Complete validated fragment including `#`.
 * @return {string} Complete share URL.
 */
export function createSavedMapViewUrl(currentHref, fragment) {
    if (typeof fragment !== "string" || !fragment.startsWith("#view=")) {
        throw new TypeError("A complete saved-map fragment is required.");
    }
    const url = new URL(currentHref);
    url.hash = fragment.slice(1);
    return url.href;
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
            `Shared by ${savedMapView.viewer.origin}; Catalog identities will ` +
            "be resolved against this deployment."
        );
    }
    return details;
}
