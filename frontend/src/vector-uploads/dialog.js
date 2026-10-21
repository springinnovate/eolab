/** Choose a polygon GeoPackage, upload it privately, and add its layer to the map. */
import { uploadPolygons } from "./api.js";

/** Present upload progress and retain an admitted upload when adding it to the map needs a retry. */
export class UploadPolygonsDialog {
    /**
     * Connect the Map layers upload action to its file form and composition-owned map action.
     * @param {Object} options Browser document and upload/map operations.
     * @param {Document} options.document Browser document.
     * @param {(upload:import('./api.js').VectorUpload)=>Promise<void>} options.addToMap Add the admitted layer through ordinary vector rendering.
     * @param {typeof uploadPolygons} [options.upload=uploadPolygons] Upload transport.
     */
    constructor({ document, addToMap, upload = uploadPolygons }) {
        this.addToMap = addToMap;
        this.upload = upload;
        this.uploaded = null;
        this.pending = false;
        this.trigger = document.querySelector("#upload-polygons");
        this.dialog = document.createElement("dialog");
        this.dialog.className = "upload-polygons-dialog";
        this.dialog.setAttribute("aria-labelledby", "upload-polygons-heading");
        const heading = document.createElement("h2");
        heading.id = "upload-polygons-heading";
        heading.textContent = "Upload polygons";
        this.form = document.createElement("form");
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
        const privacy = document.createElement("p");
        privacy.textContent = "Stored on this server and available only to this browser.";
        const persistence = document.createElement("p");
        persistence.textContent = "Uploaded layers are not restored after a reload or included in saved and shared maps yet.";
        this.progress = document.createElement("progress");
        this.progress.setAttribute("aria-label", "Upload and add to map");
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
        this.cancel.textContent = "Cancel";
        actions.append(this.submit, this.cancel);
        this.form.append(fileLabel, fileHelp, nameLabel, privacy, persistence, this.progress, this.status, actions);
        this.dialog.append(heading, this.form);
        document.body.append(this.dialog);
        this.trigger.addEventListener("click", () => this.open());
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

    /** Open a fresh upload form and focus its file chooser. @return {void} */
    open() {
        this.uploaded = null;
        this.file.value = "";
        this.name.value = "";
        this.message("");
        this.setBusy(false);
        this.dialog.showModal();
        this.file.focus();
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
     * Prevent duplicate submissions and dismissal while upload or map publication is pending.
     * @param {boolean} busy Whether an operation is pending.
     * @return {void}
     */
    setBusy(busy) {
        this.pending = busy;
        this.file.disabled = this.name.disabled = busy || this.uploaded !== null;
        this.submit.disabled = this.cancel.disabled = busy;
        this.progress.hidden = !busy;
        this.form.setAttribute("aria-busy", String(busy));
        this.submit.textContent = this.uploaded === null ? "Upload and add to map" : "Retry add to map";
        this.cancel.textContent = this.uploaded === null ? "Cancel" : "Close";
    }
}
