/** Let people choose a filename before downloading saved polygons. */
import { normalizeAnnotationDownloadFilename } from "./download-filename.js";

/** Own the filename form and resolve each choice after its native dialog closes. */
export class AnnotationDownloadDialog {
    /**
     * Build the annotation download form with native focus and Escape handling.
     * @param {Document} document Browser document that owns the dialog.
     */
    constructor(document) {
        this.dialog = document.createElement("dialog");
        this.dialog.className = "annotation-download-dialog";
        this.dialog.setAttribute("aria-labelledby", "annotation-download-heading");
        const heading = document.createElement("h2");
        heading.id = "annotation-download-heading";
        heading.textContent = "Download polygons";
        this.description = document.createElement("p");
        const form = document.createElement("form");
        const label = document.createElement("label");
        label.textContent = "Filename";
        this.input = document.createElement("input");
        this.input.type = "text";
        this.input.required = true;
        this.input.autocomplete = "off";
        this.input.spellcheck = false;
        this.input.setAttribute("aria-describedby", "annotation-download-help annotation-download-error");
        label.append(this.input);
        const help = document.createElement("p");
        help.id = "annotation-download-help";
        help.textContent = "The .geojson extension is added if you leave it off.";
        this.error = document.createElement("p");
        this.error.id = "annotation-download-error";
        this.error.setAttribute("role", "alert");
        this.error.hidden = true;
        const actions = document.createElement("div");
        actions.className = "annotation-download-actions";
        const download = document.createElement("button");
        download.type = "submit";
        download.textContent = "Download";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "secondary-button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => this.dialog.close());
        actions.append(download, cancel);
        form.append(label, help, this.error, actions);
        form.addEventListener("submit", event => {
            event.preventDefault();
            try {
                this.result = normalizeAnnotationDownloadFilename(this.input.value);
                this.dialog.close();
            } catch (error) {
                this.error.textContent = error.message;
                this.error.hidden = false;
                this.input.setAttribute("aria-invalid", "true");
                this.input.focus();
            }
        });
        this.input.addEventListener("input", () => {
            this.error.hidden = true;
            this.error.textContent = "";
            this.input.removeAttribute("aria-invalid");
        });
        /** @type {string|null} Confirmed filename, or null for cancellation. */
        this.result = null;
        /** @type {((filename:string|null)=>void)|null} Pending choice resolved by the close event. */
        this.resolveChoice = null;
        this.dialog.addEventListener("close", () => {
            this.resolveChoice?.(this.result);
            this.resolveChoice = null;
        });
        this.dialog.append(heading, this.description, form);
        document.body.append(this.dialog);
    }

    /**
     * Ask for one filename, prefilled with a fresh default for this export.
     * The annotation owner keeps at most one choice pending. Native dialog close
     * restores focus to the invoking control, including when Escape is pressed.
     * @param {string} defaultFilename Generated safe filename, including .geojson.
     * @param {string} layerName Display name identifying the polygons to download.
     * @return {Promise<string|null>} Valid filename on Download, or null on Cancel/Escape.
     */
    choose(defaultFilename, layerName) {
        this.result = null;
        this.description.textContent = `Download all saved polygons from “${layerName}”.`;
        this.input.value = defaultFilename;
        this.input.removeAttribute("aria-invalid");
        this.error.textContent = "";
        this.error.hidden = true;
        const choice = new Promise(resolve => { this.resolveChoice = resolve; });
        this.dialog.showModal();
        this.input.focus();
        this.input.select();
        this.input.scrollLeft = 0;
        return choice;
    }
}
