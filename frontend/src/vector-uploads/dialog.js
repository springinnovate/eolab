/** Upload polygon files and reopen or delete this browser's existing uploads. */
import { deleteUpload, listUploads, uploadPolygons } from "./api.js";

/** Manage private polygon files independently of whether their layers are on the map. */
export class UploadPolygonsDialog {
    /**
     * Connect the Map layers upload action to its file form and composition-owned map action.
     * @param {Object} options Browser document and upload/map operations.
     * @param {Document} options.document Browser document.
     * @param {(upload:import('./api.js').VectorUpload)=>Promise<void>} options.addToMap Add the admitted layer through ordinary vector rendering.
     * @param {(uploadId:string)=>boolean} options.isOnMap Whether an upload already has a map layer.
     * @param {(uploadId:string)=>void} options.onDeleted Remove deleted upload references from the map and its Undo.
     * @param {typeof uploadPolygons} [options.upload=uploadPolygons] Upload transport.
     * @param {typeof listUploads} [options.list=listUploads] Browser-owned upload listing.
     * @param {typeof deleteUpload} [options.deleteFile=deleteUpload] Server-side deletion transport.
     */
    constructor({ document, addToMap, isOnMap, onDeleted, upload = uploadPolygons, list = listUploads, deleteFile = deleteUpload }) {
        this.document = document;
        this.addToMap = addToMap;
        this.isOnMap = isOnMap;
        this.onDeleted = onDeleted;
        this.upload = upload;
        this.list = list;
        this.deleteFile = deleteFile;
        this.uploads = [];
        this.rows = [];
        this.confirming = null;
        this.uploaded = null;
        this.pending = false;
        this.trigger = document.querySelector("#upload-polygons");
        this.dialog = document.createElement("dialog");
        this.dialog.className = "upload-polygons-dialog";
        this.dialog.setAttribute("aria-labelledby", "upload-polygons-heading");
        const heading = document.createElement("h2");
        heading.id = "upload-polygons-heading";
        heading.textContent = "Polygon uploads";
        const privacy = document.createElement("p");
        privacy.textContent = "Stored on this server and available only to this browser. A saved map link does not share these files with other browsers.";
        const existingHeading = document.createElement("h3");
        existingHeading.textContent = "Your uploads";
        const removalHelp = document.createElement("p");
        removalHelp.textContent = "Remove from map keeps the uploaded file here so you can add it again.";
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
        this.file.accept = ".gpkg";
        this.file.required = true;
        this.file.setAttribute("aria-describedby", "upload-polygons-file-help");
        fileLabel.append(this.file);
        const fileHelp = document.createElement("p");
        fileHelp.id = "upload-polygons-file-help";
        fileHelp.textContent = "GeoPackage containing one polygon layer";
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
        this.form.append(newHeading, fileLabel, fileHelp, nameLabel, actions);
        this.dialog.append(heading, privacy, existingHeading, removalHelp, this.uploadList, this.empty,
            this.retry, this.confirmation, this.form, this.progress, this.status);
        document.body.append(this.dialog);
        this.trigger.addEventListener("click", () => void this.open());
        this.file.addEventListener("change", () => {
            const selected = this.file.files[0];
            this.name.value = selected ? selected.name.replace(/\.gpkg$/i, "").slice(0, 200) : "";
        });
        this.form.addEventListener("submit", event => {
            event.preventDefault();
            void this.uploadAndAdd();
        });
        this.cancel.addEventListener("click", () => this.dialog.close());
        this.dialog.addEventListener("cancel", event => { if (this.pending) event.preventDefault(); });
        this.dialog.addEventListener("close", () => this.trigger.focus());
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
        await this.loadUploads();
        (this.rows.find(row => !row.add.disabled)?.add ?? this.file).focus();
    }

    /** Refresh the upload list without changing files or existing map layers. @return {Promise<void>} Completion with list errors available for retry. */
    async loadUploads() {
        this.retry.hidden = true;
        this.empty.hidden = true;
        this.setBusy(true);
        this.message("Loading your uploads…");
        try {
            this.uploads = await this.list();
            this.renderUploads();
            this.message("");
        } catch (error) {
            this.message(error.message, true);
            this.retry.hidden = false;
        } finally {
            this.setBusy(false);
        }
    }

    /** Render stored uploads with separate map and file actions. @return {void} */
    renderUploads() {
        this.uploadList.replaceChildren();
        this.rows = this.uploads.map(upload => {
            const row = this.document.createElement("li");
            const name = this.document.createElement("strong");
            name.textContent = upload.name;
            const actions = this.document.createElement("div");
            actions.className = "upload-polygons-actions";
            const add = this.document.createElement("button");
            add.type = "button";
            add.textContent = this.isOnMap(upload.id) ? "On map" : "Add to map";
            add.setAttribute("aria-label", `${add.textContent}: ${upload.name}`);
            add.addEventListener("click", () => void this.addExistingUpload(upload));
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
            row.append(name, actions);
            this.uploadList.append(row);
            return { upload, add, remove };
        });
        this.empty.hidden = this.uploads.length !== 0;
    }

    /**
     * Reopen an existing upload through the ordinary map action without sending its file again.
     * @param {import('./api.js').VectorUpload} upload Metadata listed for this browser.
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
        const upload = this.confirming;
        this.setBusy(true);
        this.message(`Deleting ${upload.name}…`);
        try {
            await this.deleteFile(upload.id);
            this.onDeleted(upload.id);
            this.uploads = this.uploads.filter(candidate => candidate.id !== upload.id);
            this.confirming = null;
            this.confirmation.hidden = true;
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
        this.setBusy(true);
        try {
            if (this.uploaded === null) {
                this.message("Uploading polygons…");
                this.uploaded = await this.upload(this.file.files[0], this.name.value.trim());
            }
            this.message("Adding layer to map…");
            await this.addToMap(this.uploaded);
            this.dialog.close();
        } catch (error) {
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
     * Prevent conflicting file actions while a request or deletion confirmation is pending.
     * @param {boolean} busy Whether an operation is pending.
     * @return {void}
     */
    setBusy(busy) {
        this.pending = busy;
        const blocked = busy || this.confirming !== null;
        this.file.disabled = this.name.disabled = blocked || this.uploaded !== null;
        this.submit.disabled = blocked;
        this.cancel.disabled = busy;
        this.retry.disabled = blocked;
        this.confirmDelete.disabled = this.keep.disabled = busy;
        for (const row of this.rows) {
            row.add.disabled = blocked || this.isOnMap(row.upload.id);
            row.remove.disabled = blocked;
        }
        this.progress.hidden = !busy;
        this.dialog.setAttribute("aria-busy", String(busy));
        this.submit.textContent = this.uploaded === null ? "Upload and add to map" : "Retry add to map";
    }
}
