/** DOM presentation and browser-link interaction for portable saved maps. */
import { suggestMapLinkName } from "./api-client.js";

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
            setTimer = (handler, delay) =>
                globalThis.setTimeout(handler, delay),
            clearTimer = (timer) => globalThis.clearTimeout(timer),
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
        this.resetButton = documentContext.querySelector("#reset-map-view");
        this.undoButton = documentContext.querySelector(
            "#undo-reset-map-view"
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
        this.handlers = null;
        this.copiedTimer = null;
        this.blockCancel = (event) => event.preventDefault();
        this.publishDialog = documentContext.querySelector("#publish-map-dialog");
        this.publishForm = documentContext.querySelector("#publish-map-form");
        this.publishFields = documentContext.querySelector("#publish-map-fields");
        this.publishTitle = documentContext.querySelector("#publish-map-title");
        this.publishSubtitle = documentContext.querySelector("#publish-map-subtitle");
        this.publishSlug = documentContext.querySelector("#publish-map-slug");
        this.publishPreview = documentContext.querySelector("#publish-map-preview");
        this.publishStatus = documentContext.querySelector("#publish-map-status");
        this.publishSubmit = documentContext.querySelector("#publish-map-submit");
        this.publishClose = documentContext.querySelector("#publish-map-close");
        this.publishResult = documentContext.querySelector("#publish-map-result");
        this.publishUrl = documentContext.querySelector("#publish-map-url");
        this.publishOpen = documentContext.querySelector("#publish-map-open");
        this.publishCopy = documentContext.querySelector("#publish-map-copy");
        this.slugEdited = false;
    }

    /**
     * Connect complete-view actions to controller-owned orchestration.
     *
     * @param {Object} handlers Saved-map action callbacks.
     * @param {()=>void} handlers.onCopy Copy the current shared map link.
     * @param {()=>void} handlers.onReset Restore the configured initial view.
     * @param {()=>void} handlers.onUndo Restore the pre-reset view.
     * @param {(fields:Object)=>void} handlers.onPublish Save the captured map under the entered name.
     * @param {(fields:Object)=>void} [handlers.onSavePublishedMap] Save administrator changes at the existing URL.
     * @return {void}
     */
    bind({ onCopy, onReset, onUndo, onPublish, onSavePublishedMap }) {
        this.unbind();
        this.handlers = {
            copy: () => onCopy(),
            reset: () => onReset(),
            undo: () => onUndo(),
            savePublishedMap: event => {
                event.preventDefault();
                onSavePublishedMap({
                    title: this.document.querySelector("#published-map-edit-title").value,
                    subtitle: this.document.querySelector("#published-map-edit-subtitle").value,
                });
            },
            publish: event => {
                event.preventDefault();
                onPublish({ title: this.publishTitle.value, subtitle: this.publishSubtitle.value, slug: this.publishSlug.value });
            },
            title: () => {
                if (!this.slugEdited) this.publishSlug.value = suggestMapLinkName(this.publishTitle.value);
                this.updatePublicationPreview();
            },
            slug: () => { this.slugEdited = true; this.updatePublicationPreview(); },
            close: () => this.publishDialog.close(),
            copyPublished: async () => {
                const result = await this.copyUrl(this.publishUrl.value);
                this.publishStatus.textContent = result.copied ? "Link copied." : "Select and copy the link above.";
            },
        };
        this.copyButton.addEventListener("click", this.handlers.copy);
        this.resetButton.addEventListener("click", this.handlers.reset);
        this.undoButton.addEventListener("click", this.handlers.undo);
        this.publishForm.addEventListener("submit", this.handlers.publish);
        this.publishTitle.addEventListener("input", this.handlers.title);
        this.publishSlug.addEventListener("input", this.handlers.slug);
        this.publishClose.addEventListener("click", this.handlers.close);
        this.publishCopy.addEventListener("click", this.handlers.copyPublished);
        this.document.querySelector("#published-map-editor")?.addEventListener("submit", this.handlers.savePublishedMap);
    }

    /**
     * Display a loaded administrative draft and its fixed public URL.
     * @param {{slug:string,title:string,subtitle:string}} saved Loaded map labels.
     * @param {boolean} complete Whether every saved layer and style restored successfully.
     * @return {void}
     */
    showPublishedMapEditor(saved, complete) {
        this.document.querySelector("#published-map-editor").hidden = false;
        this.document.querySelector("#published-map-editor-heading").textContent = `Editing published map: ${saved.title}`;
        this.document.querySelector("#published-map-edit-title").value = saved.title;
        this.document.querySelector("#published-map-edit-subtitle").value = saved.subtitle;
        const link = this.document.querySelector("#published-map-edit-url");
        link.href = `/maps/${encodeURIComponent(saved.slug)}`;
        link.textContent = link.href;
        this.document.querySelector("#published-map-save").disabled = !complete;
        this.showPublishedMapEditStatus(complete ? "Ready to edit." : "Some layers or settings could not load. Reload before saving to avoid losing them.");
    }

    /**
     * Keep headings and navigation stable while a published-map save is pending.
     * @param {boolean} saving Whether the update is in flight.
     * @return {void}
     */
    setPublishedMapSaving(saving) {
        for (const id of ["published-map-save", "published-map-edit-title", "published-map-edit-subtitle"]) {
            this.document.querySelector(`#${id}`).disabled = saving;
        }
        this.document.querySelector("#published-map-cancel").hidden = saving;
        this.document.querySelector("#published-map-editor").setAttribute("aria-busy", String(saving));
        if (saving) this.showPublishedMapEditStatus("Saving changes for everyone…");
    }

    /**
     * Show save progress, confirmation or failure without replacing the draft.
     * @param {string} message User-facing status.
     * @return {void}
     */
    showPublishedMapEditStatus(message) {
        this.document.querySelector("#published-map-edit-status").textContent = message;
    }

    /**
     * Show a fresh publication form without modifying the map.
     * @param {{title:string,subtitle:string}} defaults Initial map labels.
     * @return {void}
     */
    showPublicationForm(defaults) {
        this.publishTitle.value = defaults.title;
        this.publishSubtitle.value = defaults.subtitle;
        this.publishSlug.value = suggestMapLinkName(defaults.title);
        this.slugEdited = false;
        this.publishStatus.textContent = "";
        this.publishFields.hidden = false;
        this.publishSubmit.hidden = false;
        this.publishResult.hidden = true;
        this.publishClose.textContent = "Cancel";
        this.updatePublicationPreview();
        this.publishDialog.showModal();
        this.publishTitle.focus();
        this.publishTitle.select();
    }

    /** Update the visible URL suggestion after title or link-name edits. @return {void} */
    updatePublicationPreview() {
        this.publishPreview.textContent = `${new URL(this.location.href).origin}/maps/${this.publishSlug.value || "your-link-name"}`;
    }

    /**
     * Prevent duplicate submission and dismissal while the create request is in flight.
     * @param {boolean} busy Whether publishing is in flight.
     * @return {void}
     */
    setPublicationBusy(busy) {
        this.publishFields.disabled = busy;
        this.publishSubmit.disabled = busy;
        this.publishClose.disabled = busy;
        this.publishForm.setAttribute("aria-busy", String(busy));
        this.publishDialog.removeEventListener("cancel", this.blockCancel);
        if (busy) {
            this.publishDialog.addEventListener("cancel", this.blockCancel);
            this.publishStatus.textContent = "Creating shared map…";
        }
    }

    /**
     * Keep entered labels visible after a publication error.
     * @param {string} message Actionable API or validation error.
     * @return {void}
     */
    showPublicationError(message) { this.publishStatus.textContent = message; }

    /**
     * Offer the published URL as plain text, an open link and a copy action.
     * @param {string} slug Validated stored URL name.
     * @return {void}
     */
    showPublishedMap(slug) {
        const url = new URL(`/maps/${encodeURIComponent(slug)}`, this.location.href).href;
        this.publishFields.hidden = true;
        this.publishSubmit.hidden = true;
        this.publishResult.hidden = false;
        this.publishUrl.value = url;
        this.publishOpen.href = url;
        this.publishClose.textContent = "Done";
        this.publishStatus.textContent = "Shared map created. Anyone with this link can open it.";
        this.publishUrl.focus();
        this.publishUrl.select();
    }

    /** Expose the one-step undo action after a completed reset. @return {void} */
    showUndoReset() {
        this.resetButton.hidden = true;
        this.undoButton.hidden = false;
    }

    /** Remove the undo action once it is used or superseded. @return {void} */
    hideUndoReset() {
        this.resetButton.hidden = false;
        this.undoButton.hidden = true;
    }

    /**
     * Copy a fragment on the current viewer URL when Clipboard API access works.
     *
     * @param {string} fragment Validated complete `#view=` fragment.
     * @return {Promise<{copied:boolean,url:string}>} Copy result and share URL.
     */
    async copyLink(fragment) {
        const url = createSavedMapViewUrl(this.location.href, fragment);
        return this.copyUrl(url);
    }

    /**
     * Copy the original named map, excluding private presentation changes and fragments.
     * @param {string} slug Named map's URL name.
     * @return {Promise<{copied:boolean,url:string}>} Copy result and canonical URL.
     */
    async copyNamedMapLink(slug) {
        return this.copyUrl(new URL(`/maps/${encodeURIComponent(slug)}`, this.location.href).href);
    }

    /**
     * Copy a complete link, returning it for a manual fallback when clipboard access fails.
     * @param {string} url Complete map URL.
     * @return {Promise<{copied:boolean,url:string}>} Clipboard outcome.
     */
    async copyUrl(url) {
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
        this.dialog.showModal();
        this.dialogUrl.focus();
        this.dialogUrl.select();
    }

    /**
     * Finish loading silently on success or show an actionable partial report.
     *
     * @param {{loaded:number,total:number,details:string[]}} report Outcome.
     * @return {void}
     */
    showResults(report) {
        this.#setCancelBlocked(false);
        if (report.loaded === report.total && report.details.length === 0) {
            this.dialog.removeAttribute("aria-busy");
            if (this.dialog.open) this.dialog.close("loaded");
            return;
        }
        const completedWithWarnings = report.loaded === report.total;
        this.#prepareDialog(
            completedWithWarnings
                ? "Shared map opened with warnings"
                : "Shared map view partially opened",
            `${formatCount(report.loaded, "layer")} loaded from ` +
                `${formatCount(report.total, "shared layer")}.`,
            report.details
        );
        this.cancelButton.textContent = "Close";
        this.cancelButton.value = "close";
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
            "Opening shared map…",
            `Loading ${formatCount(layerCount, "shared layer")}…`,
            []
        );
        this.cancelButton.hidden = true;
        this.dialog.setAttribute("aria-busy", "true");
        this.#setCancelBlocked(true);
        this.dialog.showModal();
    }

    /**
     * Present a link creation or validation error without changing map state.
     *
     * @param {Error} error User-facing failure.
     * @param {"copy"|"open"|"reset"|"undo"} operation Failed operation.
     * @return {void}
     */
    showError(error, operation) {
        this.#setCancelBlocked(false);
        const titles = {
            copy: "Map link could not be created",
            open: "Shared map view could not be opened",
            reset: "Map view could not be reset",
            undo: "Reset could not be undone",
        };
        this.#prepareDialog(
            titles[operation] ?? "Saved map operation failed",
            error.message,
            []
        );
        this.cancelButton.textContent = "Close";
        this.cancelButton.hidden = false;
        this.cancelButton.value = "close";
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
        this.resetButton.disabled = busy;
        this.undoButton.disabled = busy;
        this.copyButton.setAttribute("aria-busy", String(busy));
        this.resetButton.setAttribute("aria-busy", String(busy));
        this.undoButton.setAttribute("aria-busy", String(busy));
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
            this.resetButton.removeEventListener("click", this.handlers.reset);
            this.undoButton.removeEventListener("click", this.handlers.undo);
            this.publishForm.removeEventListener("submit", this.handlers.publish);
            this.publishTitle.removeEventListener("input", this.handlers.title);
            this.publishSlug.removeEventListener("input", this.handlers.slug);
            this.publishClose.removeEventListener("click", this.handlers.close);
            this.publishCopy.removeEventListener("click", this.handlers.copyPublished);
            this.publishDialog.removeEventListener("cancel", this.blockCancel);
            this.document.querySelector("#published-map-editor")?.removeEventListener("submit", this.handlers.savePublishedMap);
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
