/** DOM presentation and browser-link interaction for portable saved maps. */
import { suggestMapLinkName } from "./api-client.js";
import { VISITOR_CONTROLS_VERSION, visitorControlChoices, visitorInitialPanels } from "../visitor-controls.js";

/**
 * Read checked visitor choices including the stored values under a disabled parent.
 * @param {HTMLFieldSetElement} fields Visitor controls in one form.
 * @return {import("../visitor-controls.js").VisitorControls} Choices to send with the map document.
 */
function readVisitorControls(fields) {
    return {
        version: VISITOR_CONTROLS_VERSION,
        choices: Object.fromEntries([...fields.querySelectorAll("input[data-visitor-control]")]
            .map(input => [input.dataset.visitorControl, input.checked])),
        initialPanels: Object.fromEntries([...fields.querySelectorAll("input[data-visitor-panel-open]")]
            .map(input => [input.dataset.visitorPanelOpen, input.checked])),
    };
}

/**
 * Enable child inputs only while their parent and panel are available, retaining their values.
 * @param {HTMLFieldSetElement} fields Visitor controls in one form.
 * @return {void}
 */
function updateVisitorChoiceInputs(fields) {
    fields.querySelector("[data-visitor-inspection-children]").disabled =
        !fields.querySelector('[data-visitor-control="inspectAndSelect"]').checked;
    fields.querySelector("[data-visitor-workspace-children]").disabled =
        !fields.querySelector('[data-visitor-control="workspacePanels"]').checked;
    for (const input of fields.querySelectorAll("input[data-visitor-panel-open]")) {
        input.disabled = !fields.querySelector(`[data-visitor-control="${input.dataset.visitorPanelOpen}"]`).checked;
    }
}

/**
 * Populate a fresh visitor-controls form with saved or default choices.
 * @param {HTMLFieldSetElement} fields Visitor controls in one form.
 * @param {import("../visitor-controls.js").VisitorControls} [settings] Saved visitor settings.
 * @return {void}
 */
function showVisitorChoices(fields, settings) {
    const choices = visitorControlChoices(settings);
    for (const input of fields.querySelectorAll("input[data-visitor-control]")) {
        input.checked = choices[input.dataset.visitorControl];
    }
    const initialPanels = visitorInitialPanels(settings);
    for (const input of fields.querySelectorAll("input[data-visitor-panel-open]")) {
        input.checked = initialPanels[input.dataset.visitorPanelOpen];
    }
    updateVisitorChoiceInputs(fields);
}

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
        this.unavailableButton = documentContext.querySelector("#show-unavailable-map-layers");
        this.unavailableLabel = documentContext.querySelector("#unavailable-map-layers-label");
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
        this.publishEditLink = documentContext.querySelector("#publish-map-edit-link");
        this.publishOpenEditor = documentContext.querySelector("#publish-map-open-editor");
        this.publishCopyEditor = documentContext.querySelector("#publish-map-copy-editor");
        this.publishVisitorControls = documentContext.querySelector("#publish-map-visitor-controls");
        this.editVisitorControls = documentContext.querySelector("#published-map-visitor-controls");
        const visitorFields = documentContext.querySelector("#visitor-control-options");
        this.publishVisitorControls.append(visitorFields.content.cloneNode(true));
        this.editVisitorControls.append(visitorFields.content.cloneNode(true));
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
     * @param {(fields:Object)=>void} [handlers.onSavePublishedMap] Save editor changes at the existing URL.
     * @param {()=>void} handlers.onShowUnavailableLayers Review saved layers whose sources could not open.
     * @param {(index:number)=>void} handlers.onRemoveUnavailableLayer Discard one retained view's saved settings, without deleting its source.
     * @return {void}
     */
    bind({ onCopy, onReset, onUndo, onPublish, onSavePublishedMap, onShowUnavailableLayers, onRemoveUnavailableLayer }) {
        this.unbind();
        this.handlers = {
            copy: () => onCopy(),
            reset: () => onReset(),
            undo: () => onUndo(),
            showUnavailable: () => onShowUnavailableLayers(),
            removeUnavailable: index => onRemoveUnavailableLayer(index),
            savePublishedMap: event => {
                event.preventDefault();
                onSavePublishedMap({
                    title: this.document.querySelector("#published-map-edit-title").value,
                    subtitle: this.document.querySelector("#published-map-edit-subtitle").value,
                    visitorControls: readVisitorControls(this.editVisitorControls),
                });
            },
            publish: event => {
                event.preventDefault();
                onPublish({ title: this.publishTitle.value, subtitle: this.publishSubtitle.value,
                    slug: this.publishSlug.value, visitorControls: readVisitorControls(this.publishVisitorControls) });
            },
            visitorChoice: event => updateVisitorChoiceInputs(event.currentTarget),
            title: () => {
                if (!this.slugEdited) this.publishSlug.value = suggestMapLinkName(this.publishTitle.value);
                this.updatePublicationPreview();
            },
            slug: () => { this.slugEdited = true; this.updatePublicationPreview(); },
            close: () => this.publishDialog.close(),
            clearPrivateLink: () => {
                this.publishEditLink.value = "";
                this.publishOpenEditor.removeAttribute("href");
            },
            copyPublicationLink: async event => {
                const privateLink = event.currentTarget === this.publishCopyEditor;
                const input = privateLink ? this.publishEditLink : this.publishUrl;
                const result = await this.copyUrl(input.value);
                if (!result.copied) {
                    input.focus();
                    input.select();
                }
                const label = privateLink ? "Private edit link" : "Public map link";
                this.publishStatus.textContent = result.copied ? `${label} copied.` : "Copy the selected link.";
            },
        };
        this.copyButton.addEventListener("click", this.handlers.copy);
        this.resetButton.addEventListener("click", this.handlers.reset);
        this.undoButton.addEventListener("click", this.handlers.undo);
        this.unavailableButton.addEventListener("click", this.handlers.showUnavailable);
        this.publishForm.addEventListener("submit", this.handlers.publish);
        this.publishTitle.addEventListener("input", this.handlers.title);
        this.publishSlug.addEventListener("input", this.handlers.slug);
        this.publishClose.addEventListener("click", this.handlers.close);
        this.publishDialog.addEventListener("close", this.handlers.clearPrivateLink);
        this.publishCopy.addEventListener("click", this.handlers.copyPublicationLink);
        this.publishCopyEditor.addEventListener("click", this.handlers.copyPublicationLink);
        this.publishVisitorControls.addEventListener("change", this.handlers.visitorChoice);
        this.editVisitorControls.addEventListener("change", this.handlers.visitorChoice);
        this.document.querySelector("#published-map-editor")?.addEventListener("submit", this.handlers.savePublishedMap);
    }

    /**
     * Display a map draft, including any notice about omitted layers.
     * @param {{slug:string,title:string,subtitle:string,view:{visitorControls?:import("../visitor-controls.js").VisitorControls}}}
     * saved Loaded map labels and choices for the editor.
     * @param {boolean} complete Whether every saved layer and style restored successfully.
     * @return {void}
     */
    showPublishedMapEditor(saved, complete) {
        this.document.querySelector("#published-map-editor").hidden = false;
        this.document.querySelector("#published-map-editor-heading").textContent = `Editing published map: ${saved.title}`;
        this.document.querySelector("#published-map-edit-title").value = saved.title;
        this.document.querySelector("#published-map-edit-subtitle").value = saved.subtitle;
        showVisitorChoices(this.editVisitorControls, saved.view.visitorControls);
        this.editVisitorControls.disabled = false;
        const link = this.document.querySelector("#published-map-edit-url");
        link.href = `/maps/${encodeURIComponent(saved.slug)}`;
        link.textContent = link.href;
        this.document.querySelector("#published-map-save").disabled = false;
        this.showPublishedMapEditStatus(complete ? "Ready to edit." : "Some map contents or settings could not load. Review the map and any Unavailable layers before saving.");
    }

    /**
     * Keep form choices and navigation stable while a published-map save is pending.
     * @param {boolean} saving Whether the update is in flight.
     * @return {void}
     */
    setPublishedMapSaving(saving) {
        for (const id of ["published-map-save", "published-map-edit-title", "published-map-edit-subtitle"]) {
            this.document.querySelector(`#${id}`).disabled = saving;
        }
        this.editVisitorControls.disabled = saving;
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
     * Show a fresh publication form with the default visitor choices.
     * @param {{title:string,subtitle:string}} defaults Initial map labels.
     * @return {void}
     */
    showPublicationForm(defaults) {
        this.publishTitle.value = defaults.title;
        this.publishSubtitle.value = defaults.subtitle;
        this.publishSlug.value = suggestMapLinkName(defaults.title);
        showVisitorChoices(this.publishVisitorControls);
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
     * Show separate public and private links with their own open and copy actions.
     * @param {string} slug Validated stored URL name.
     * @param {string} editToken Credential issued with the new map.
     * @return {void}
     */
    showPublishedMap(slug, editToken) {
        const publicPath = `/maps/${encodeURIComponent(slug)}`;
        const publicUrl = new URL(publicPath, this.location.href).href;
        const editUrl = new URL(`${publicPath}/edit#${editToken}`, this.location.href).href;
        this.publishFields.hidden = true;
        this.publishSubmit.hidden = true;
        this.publishResult.hidden = false;
        this.publishUrl.value = publicUrl;
        this.publishOpen.href = publicUrl;
        this.publishEditLink.value = editUrl;
        this.publishOpenEditor.href = editUrl;
        this.publishClose.textContent = "Done";
        this.publishStatus.textContent = "Map published.";
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

    /** Keep unavailable saved layers reachable after a restore warning is dismissed.
     * @param {number} count Number of retained unavailable views.
     * @return {void}
     */
    setUnavailableLayerCount(count) {
        this.unavailableButton.hidden = count === 0;
        this.unavailableLabel.textContent = `Unavailable layers (${count})`;
    }

    /** Show retained layer settings with an explicit action to discard each view.
     * @param {Array<{index:number,label:string,sourceSite:string|null,fields:string[]}>} layers Saved order, layer name, foreign source site and calculated field names.
     * @return {void}
     */
    showUnavailableLayers(layers) {
        this.#setCancelBlocked(false);
        this.#prepareDialog("Unavailable saved layers", layers.length
            ? "Settings for these layers are still saved. Removing a saved layer does not delete its source data."
            : "No unavailable saved layers remain.", []);
        this.dialogDetails.hidden = layers.length === 0;
        for (const layer of layers) {
            const item = this.document.createElement("li");
            const label = this.document.createElement("p");
            label.textContent = layer.label;
            item.append(label);
            if (layer.sourceSite) {
                const site = this.document.createElement("p");
                site.textContent = `Site: ${layer.sourceSite}`;
                item.append(site);
            }
            if (layer.fields.length) {
                const fields = this.document.createElement("p");
                fields.textContent = `Calculated fields: ${layer.fields.join(", ")}`;
                item.append(fields);
            }
            const remove = this.document.createElement("button");
            remove.type = "button";
            remove.className = "secondary-button";
            remove.textContent = "Remove saved layer";
            remove.setAttribute("aria-label", `Remove saved layer ${layer.label}`);
            remove.addEventListener("click", () => this.handlers?.removeUnavailable(layer.index));
            item.append(remove);
            this.dialogDetails.append(item);
        }
        this.cancelButton.textContent = "Close";
        this.cancelButton.value = "close";
        this.dialog.showModal();
        this.cancelButton.focus();
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
                ? "Map opened with warnings"
                : "Map partially opened",
            `${formatCount(report.loaded, "item")} loaded from ` +
                `${formatCount(report.total, "saved item")}.`,
            report.details
        );
        this.cancelButton.textContent = "Close";
        this.cancelButton.value = "close";
        this.dialog.showModal();
    }

    /**
     * Show loading progress while restoring the saved map's layers.
     *
     * @param {number} layerCount Number of map layers to restore.
     * @return {void}
     */
    showLoading(layerCount) {
        this.#prepareDialog(
            "Opening map…",
            `Loading ${formatCount(layerCount, "map item")}…`,
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
        this.unavailableButton.disabled = busy;
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
            this.unavailableButton.removeEventListener("click", this.handlers.showUnavailable);
            this.publishForm.removeEventListener("submit", this.handlers.publish);
            this.publishTitle.removeEventListener("input", this.handlers.title);
            this.publishSlug.removeEventListener("input", this.handlers.slug);
            this.publishClose.removeEventListener("click", this.handlers.close);
            this.publishDialog.removeEventListener("close", this.handlers.clearPrivateLink);
            this.publishCopy.removeEventListener("click", this.handlers.copyPublicationLink);
            this.publishCopyEditor.removeEventListener("click", this.handlers.copyPublicationLink);
            this.publishVisitorControls.removeEventListener("change", this.handlers.visitorChoice);
            this.editVisitorControls.removeEventListener("change", this.handlers.visitorChoice);
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
 * Format a count with a singular or plural noun.
 *
 * @param {number} count Nonnegative item count.
 * @param {string} singular Singular noun phrase.
 * @return {string} Count and inflected noun.
 */
function formatCount(count, singular) {
    return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
