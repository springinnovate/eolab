/** Manage this browser's uploaded files and their independent map layers. */
import { deleteUploadedFile, getUploadStorageSummary, uploadFile } from "./api.js";

/** Present stored uploads, their shared allowance and ordinary map actions. */
export class UploadsDialog {
    /**
     * Connect the Map layers upload action to its file form and composition-owned map action.
     * @param {Object} options Browser document and upload/map operations.
     * @param {Document} options.document Browser document.
     * @param {string} options.appTitle Configured application name used in the upload policy.
     * @param {(upload:import('./api.js').UploadSummary)=>Promise<void>} options.addToMap Add an authorized upload through ordinary rendering.
     * @param {(uploadId:string)=>boolean} options.isOnMap Whether an upload already has a map layer.
     * @param {(uploadId:string)=>void} options.removeFromMap Remove map views while keeping the uploaded file.
     * @param {(uploadId:string)=>void} options.onDeleted Remove deleted upload references from the map and its Undo.
     * @param {typeof uploadFile} [options.upload=uploadFile] Upload transport.
     * @param {typeof getUploadStorageSummary} [options.list=getUploadStorageSummary] Browser-owned files and shared allowance.
     * @param {typeof deleteUploadedFile} [options.deleteFile=deleteUploadedFile] Server-side deletion transport.
     */
    constructor({ document, appTitle, addToMap, isOnMap, removeFromMap, onDeleted,
        upload = uploadFile, list = getUploadStorageSummary, deleteFile = deleteUploadedFile }) {
        this.document = document;
        this.addToMap = addToMap;
        this.isOnMap = isOnMap;
        this.removeFromMap = removeFromMap;
        this.onDeleted = onDeleted;
        this.upload = upload;
        this.list = list;
        this.deleteFile = deleteFile;
        this.uploads = [];
        this.rows = [];
        this.confirming = null;
        this.uploaded = null;
        this.pending = false;
        /** @type {import('./api.js').UploadStorageSummary|null} Last authoritative storage allowance. */
        this.summary = null;
        /** @type {symbol|null} Latest background toolbar-usage request. */
        this.usageRequest = null;
        /** @type {symbol|null} Identity of the list request allowed to update this dialog. */
        this.listRequest = null;
        this.trigger = document.querySelector("#upload-polygons");
        this.dialog = document.createElement("dialog");
        this.dialog.className = "upload-polygons-dialog";
        this.dialog.setAttribute("aria-labelledby", "upload-polygons-heading");
        const heading = document.createElement("h2");
        heading.id = "upload-polygons-heading";
        heading.textContent = "Your uploads";
        const privacy = document.createElement("p");
        privacy.textContent = `Other users cannot access your uploads. ${appTitle} stores and processes them on its servers. Files are deleted after 7 days, or when you delete them. Files in use are kept until the calculation stops.`;
        this.usage = document.createElement("p");
        this.usage.className = "upload-storage-usage";
        this.retention = document.createElement("p");
        this.retention.hidden = true;
        const removalHelp = document.createElement("p");
        removalHelp.textContent = "Available only in this browser. Removing a layer from the map keeps its uploaded file.";
        this.uploadList = document.createElement("ul");
        this.uploadList.className = "upload-polygons-list";
        this.empty = document.createElement("p");
        this.empty.textContent = "No uploaded files yet.";
        this.retry = document.createElement("button");
        this.retry.type = "button";
        this.retry.textContent = "Retry loading uploads";
        this.retry.hidden = true;
        this.retry.addEventListener("click", () => void this.loadUploads());
        this.confirmation = document.createElement("div");
        this.confirmation.className = "upload-polygons-confirmation";
        this.confirmation.hidden = true;
        this.confirmationText = document.createElement("p");
        this.confirmationText.id = "upload-polygons-delete-help";
        this.confirmDelete = document.createElement("button");
        this.confirmDelete.type = "button";
        this.confirmDelete.textContent = "Delete uploaded file";
        this.confirmDelete.setAttribute("aria-describedby", this.confirmationText.id);
        this.confirmDelete.addEventListener("click", () => void this.deleteSelectedUpload());
        this.keep = document.createElement("button");
        this.keep.type = "button";
        this.keep.textContent = "Keep file";
        this.keep.addEventListener("click", () => {
            const row = this.rows.find(row => row.upload.id === this.confirming.id);
            this.confirming = null;
            this.confirmation.hidden = true;
            this.setBusy(false);
            row.remove.focus();
        });
        this.confirmation.append(this.confirmationText, this.keep, this.confirmDelete);
        this.form = document.createElement("form");
        const newHeading = document.createElement("h3");
        newHeading.textContent = "Upload a new file";
        const fileLabel = document.createElement("label");
        fileLabel.textContent = "Choose file";
        this.file = document.createElement("input");
        this.file.type = "file";
        this.file.accept = ".gpkg,.geojson,.json,.tif,.tiff";
        this.file.required = true;
        this.file.setAttribute("aria-describedby", "upload-polygons-file-help");
        fileLabel.append(this.file);
        this.fileHelp = document.createElement("p");
        this.fileHelp.id = "upload-polygons-file-help";
        this.fileHelp.textContent = "Polygon GeoPackage (.gpkg) or GeoJSON (.geojson, .json), or single-band Byte GeoTIFF mask (.tif, .tiff): 1 marks reference sites, 0 excludes cells, and NoData is ignored.";
        this.quotaHelp = document.createElement("p");
        this.quotaHelp.textContent = "You've reached the upload limit. Delete an uploaded file to make room. Files still used by calculations keep their slots until those calculations stop.";
        this.quotaHelp.hidden = true;
        const nameLabel = document.createElement("label");
        nameLabel.textContent = "Layer name";
        this.name = document.createElement("input");
        this.name.type = "text";
        this.name.required = true;
        this.name.maxLength = 200;
        this.name.pattern = ".*\\S.*";
        nameLabel.append(this.name);
        this.progress = document.createElement("progress");
        this.progress.setAttribute("aria-label", "Working with uploaded files");
        this.progress.hidden = true;
        this.status = document.createElement("p");
        this.status.setAttribute("role", "status");
        this.status.setAttribute("aria-live", "polite");
        const actions = document.createElement("div");
        actions.className = "upload-polygons-actions";
        this.submit = document.createElement("button");
        this.submit.type = "submit";
        this.submit.textContent = "Upload and add to map";
        this.cancel = document.createElement("button");
        this.cancel.type = "button";
        this.cancel.className = "secondary-button";
        this.cancel.textContent = "Close";
        actions.append(this.submit, this.cancel);
        this.form.append(newHeading, fileLabel, this.fileHelp, nameLabel, this.quotaHelp, actions);
        this.dialog.append(heading, privacy, this.usage, this.retention, removalHelp, this.uploadList, this.empty,
            this.retry, this.confirmation, this.form, this.progress, this.status);
        document.body.append(this.dialog);
        this.trigger.addEventListener("click", () => void this.open());
        this.file.addEventListener("change", () => {
            const selected = this.file.files[0];
            this.name.value = selected ? selected.name.replace(/\.(gpkg|geojson|json|tiff?)$/i, "").slice(0, 200) : "";
        });
        this.form.addEventListener("submit", event => {
            event.preventDefault();
            void this.uploadAndAdd();
        });
        this.cancel.addEventListener("click", () => this.dialog.close());
        this.dialog.addEventListener("cancel", event => { if (this.pending) event.preventDefault(); });
        this.dialog.addEventListener("close", () => {
            // Native close events can arrive after the dialog has reopened.
            if (this.dialog.open) return;
            this.listRequest = null;
            this.trigger.focus();
        });
    }

    /** Open the file form and refresh this browser's stored uploads. @return {Promise<void>} Completion after listing or a visible error. */
    async open() {
        this.uploaded = null;
        this.confirming = null;
        this.confirmation.hidden = true;
        this.file.value = "";
        this.name.value = "";
        this.message("");
        this.setBusy(false);
        this.dialog.showModal();
        this.cancel.focus();
        await this.loadUploads();
    }

    /**
     * Refresh uploads while allowing dismissal; obsolete responses leave the dialog untouched.
     * @return {Promise<void>} Completion with current list errors available for retry.
     */
    async loadUploads() {
        this.usageRequest = null;
        const request = Symbol("upload-list");
        this.listRequest = request;
        this.retry.hidden = true;
        this.empty.hidden = true;
        this.setBusy(false);
        this.message("Loading your uploads…");
        try {
            const summary = await this.list();
            if (this.listRequest !== request || !this.dialog.open) return;
            this.applySummary(summary);
            this.renderUploads();
            this.message("");
        } catch (error) {
            if (this.listRequest !== request || !this.dialog.open) return;
            this.summary = null;
            this.trigger.textContent = "Your uploads";
            this.message(error.message, true);
            this.retry.hidden = false;
        } finally {
            if (this.listRequest === request && this.dialog.open) {
                this.listRequest = null;
                this.setBusy(false);
            }
        }
    }

    /**
     * Refresh the toolbar count without opening the manager or blocking map actions.
     * A newer manager request or mutation makes an older response irrelevant.
     * @return {Promise<boolean>} Whether the current server allowance was loaded.
     */
    async refreshUsage() {
        const request = Symbol("upload-usage");
        this.usageRequest = request;
        try {
            const summary = await this.list();
            if (this.usageRequest !== request) return false;
            this.applySummary(summary);
            return true;
        } catch {
            if (this.usageRequest !== request) return false;
            this.summary = null;
            this.trigger.textContent = "Your uploads";
            this.usage.textContent = "Storage usage is unavailable. Reopen Your uploads to refresh it.";
            return false;
        } finally {
            if (this.usageRequest === request) this.usageRequest = null;
        }
    }

    /**
     * Present server-owned counts, byte limits and files still needed by calculations.
     * @param {import('./api.js').UploadStorageSummary} summary Validated upload API response.
     * @return {void}
     */
    applySummary(summary) {
        this.summary = summary;
        this.uploads = summary.uploads;
        this.trigger.textContent = `Your uploads · ${summary.used_files} of ${summary.max_files}`;
        this.usage.textContent = `${summary.used_files} of ${summary.max_files} files used · ${formatUploadBytes(summary.used_bytes)} of ${formatUploadBytes(summary.max_bytes)}`;
        const pendingFiles = summary.used_files - summary.uploads.length - summary.retained_files;
        this.retention.hidden = summary.retained_files === 0 && pendingFiles === 0;
        this.retention.textContent = [
            ...(summary.retained_files ? [`${summary.retained_files} deleted or expired file${summary.retained_files === 1 ? " is" : "s are"} still used by calculations. Those slots become available when the calculations stop.`] : []),
            ...(pendingFiles ? [`${pendingFiles} file${pendingFiles === 1 ? " is" : "s are"} being uploaded or removed and still ${pendingFiles === 1 ? "uses a slot" : "use slots"}.`] : []),
        ].join(" ");
        this.fileHelp.textContent = `Polygon GeoPackage (.gpkg) or GeoJSON (.geojson, .json), or single-band Byte GeoTIFF mask (.tif, .tiff): 1 marks reference sites, 0 excludes cells, and NoData is ignored. Up to ${formatUploadBytes(summary.max_file_bytes)} per file.`;
    }

    /** Render stored uploads with separate map and file actions. @return {void} */
    renderUploads() {
        this.uploadList.replaceChildren();
        this.rows = this.uploads.map(upload => {
            const row = this.document.createElement("li");
            const name = this.document.createElement("strong");
            name.textContent = upload.name;
            const description = this.document.createElement("p");
            description.className = "upload-file-description";
            description.textContent = `${upload.kind === "raster" ? "Raster mask" : "Polygons"} · ${formatUploadBytes(upload.size_bytes)} · Expires ${new Date(upload.expires_at).toLocaleString()}`;
            const actions = this.document.createElement("div");
            actions.className = "upload-polygons-actions";
            const add = this.document.createElement("button");
            add.type = "button";
            add.textContent = this.isOnMap(upload.id) ? "Remove from map" : "Add to map";
            add.setAttribute("aria-label", `${add.textContent}: ${upload.name}`);
            add.addEventListener("click", () => {
                if (this.isOnMap(upload.id)) {
                    this.removeFromMap(upload.id);
                    this.renderUploads();
                    this.message(`${upload.name} was removed from the map. Its file still uses an upload slot.`);
                    this.rows.find(row => row.upload.id === upload.id).add.focus();
                } else void this.addExistingUpload(upload);
            });
            const remove = this.document.createElement("button");
            remove.type = "button";
            remove.textContent = "Delete uploaded file";
            remove.setAttribute("aria-label", `Delete uploaded file: ${upload.name}`);
            remove.addEventListener("click", () => {
                this.confirming = upload;
                this.confirmationText.textContent = `Delete “${upload.name}” from the server? It will be removed from this map and cannot be reopened from saved maps. Calculations already submitted can finish. This cannot be undone.`;
                this.confirmation.hidden = false;
                this.setBusy(false);
                this.keep.focus();
            });
            actions.append(add, remove);
            row.append(name, description, actions);
            this.uploadList.append(row);
            return { upload, add, remove };
        });
        this.empty.hidden = this.uploads.length !== 0;
    }

    /**
     * Reopen an existing upload through the ordinary map action without sending its file again.
     * @param {import('./api.js').UploadSummary} upload File listed for this browser.
     * @return {Promise<void>} Completion after adding the layer or displaying an error.
     */
    async addExistingUpload(upload) {
        this.setBusy(true);
        this.message("Adding layer to map…");
        try {
            await this.addToMap(upload);
            this.dialog.close();
        } catch (error) {
            this.message(error.message, true);
        } finally {
            this.setBusy(false);
        }
    }

    /** Delete the confirmed file, then remove its map references after server success. @return {Promise<void>} Completion with failure retaining the file's list row and map layer. */
    async deleteSelectedUpload() {
        this.usageRequest = null;
        const upload = this.confirming;
        this.setBusy(true);
        this.message(`Deleting ${upload.name}…`);
        try {
            await this.deleteFile(upload);
            this.onDeleted(upload.id);
            this.uploads = this.uploads.filter(candidate => candidate.id !== upload.id);
            this.confirming = null;
            this.confirmation.hidden = true;
            await this.refreshUsage();
            this.renderUploads();
            this.message(`${upload.name} was deleted from the server.`);
        } catch (error) {
            this.message(error.message, true);
        } finally {
            this.setBusy(false);
            if (this.confirming === null) (this.rows.find(row => !row.add.disabled)?.add ?? this.file).focus();
        }
    }

    /**
     * Upload the chosen file, then add it to the map; retry map failures with the same upload.
     * @return {Promise<void>} Completion, with failures displayed without discarding the entered file or admitted upload.
     */
    async uploadAndAdd() {
        this.usageRequest = null;
        this.setBusy(true);
        try {
            if (this.uploaded === null) {
                this.message("Uploading file…");
                this.uploaded = await this.upload(this.file.files[0], this.name.value.trim());
                await this.refreshUsage();
            }
            this.message("Adding layer to map…");
            await this.addToMap(this.uploaded);
            this.dialog.close();
        } catch (error) {
            if (this.uploaded === null) await this.refreshUsage();
            this.message(this.uploaded === null ? error.message
                : `Your file was uploaded, but could not be added to the map. ${error.message} Retry adding it, or close this dialog.`, true);
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * Show progress or an actionable failure inside the retained form.
     * @param {string} text User-facing message.
     * @param {boolean} [error=false] Whether to emphasize a failure.
     * @return {void}
     */
    message(text, error = false) {
        this.status.textContent = text;
        this.status.classList.toggle("is-error", error);
    }

    /**
     * Prevent conflicting file actions; only upload, deletion or map admission blocks dismissal.
     * @param {boolean} busy Whether an upload, deletion or map admission is pending.
     * @return {void}
     */
    setBusy(busy) {
        this.pending = busy;
        const working = busy || this.listRequest !== null;
        const blocked = working || this.confirming !== null;
        const full = this.summary !== null && this.summary.used_files >= this.summary.max_files;
        const unavailable = this.summary === null;
        this.quotaHelp.hidden = !full;
        this.file.disabled = this.name.disabled = blocked || this.uploaded !== null || full || unavailable;
        this.submit.disabled = blocked || this.uploaded === null && (full || unavailable);
        this.cancel.disabled = busy;
        this.retry.disabled = blocked;
        this.confirmDelete.disabled = this.keep.disabled = busy;
        for (const row of this.rows) {
            row.add.disabled = blocked;
            row.remove.disabled = blocked;
        }
        this.progress.hidden = !working;
        this.dialog.setAttribute("aria-busy", String(working));
        this.submit.textContent = this.uploaded === null ? "Upload and add to map" : "Retry add to map";
    }
}

/**
 * Format upload storage in binary units matching the server's configured limits.
 * @param {number} bytes File size or storage allowance.
 * @return {string} Readable byte, KiB or MiB quantity.
 */
function formatUploadBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString(undefined, {maximumFractionDigits: 1})} KiB`;
    return `${(bytes / (1024 * 1024)).toLocaleString(undefined, {maximumFractionDigits: 1})} MiB`;
}
