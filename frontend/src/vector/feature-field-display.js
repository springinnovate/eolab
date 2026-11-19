/** Download, preview and apply a vector view's field formatting CSV. */

import { makeFieldFormatTemplate, MAX_FIELD_FORMAT_CSV_BYTES, parseFieldFormatCsv } from "./field-format-csv.js";

/** @typedef {import("../feature-field-formats.js").FeatureFieldFormats} FeatureFieldFormats */

/**
 * Editable display settings for one inspected layer view.
 * @typedef {Object} FeatureFieldDisplay
 * @property {readonly string[]} fields Exact numeric field names.
 * @property {FeatureFieldFormats} formats Current field display settings.
 * @property {(formats:FeatureFieldFormats)=>boolean} apply Store the settings if this view is still current.
 */

/** @typedef {FeatureFieldDisplay & {sourceId:string,properties:Object<string,unknown>}} FieldDisplaySelection */

/** Own the inspector's field display controls and the pending CSV preview. */
export class VectorFeatureFieldDisplay {
    /**
     * Bind field display controls to the inspector's selected feature.
     * @param {Document} documentContext Document containing the Feature inspector.
     * @param {(value:unknown,format?:import("../feature-field-formats.js").FeatureFieldFormat)=>string} formatValue
     * Inspector value formatter used for the preview.
     * @param {()=>void} refreshAttributes Redisplay the feature using the layer's latest fields and formats.
     */
    constructor(documentContext, formatValue, refreshAttributes) {
        this.document = documentContext;
        this.formatValue = formatValue;
        this.refreshAttributes = refreshAttributes;
        this.root = documentContext.querySelector("#vector-feature-field-display");
        this.download = documentContext.querySelector("#download-vector-field-template");
        this.file = documentContext.querySelector("#import-vector-field-formats");
        this.status = documentContext.querySelector("#vector-field-format-status");
        this.preview = documentContext.querySelector("#vector-field-format-preview");
        this.rows = documentContext.querySelector("#vector-field-format-rows");
        this.actions = documentContext.querySelector("#vector-field-format-actions");
        this.apply = documentContext.querySelector("#apply-vector-field-formats");
        this.cancel = documentContext.querySelector("#cancel-vector-field-formats");
        this.selection = null;
        this.previewFormats = null;
        this.generation = 0;
        /** Download the template for the current layer view. @return {void} */
        this.onDownload = () => this.#downloadTemplate();
        /** Read and preview the selected CSV file. @return {void} */
        this.onFile = () => { void this.#previewImport(); };
        /** Apply the displayed preview and refresh the inspector. @return {void} */
        this.onApply = () => this.#applyPreview();
        /** Discard the preview and return focus to the file input. @return {void} */
        this.onCancel = () => { this.#resetImport(); this.file.focus(); };
        this.download.addEventListener("click", this.onDownload);
        this.file.addEventListener("change", this.onFile);
        this.apply.addEventListener("click", this.onApply);
        this.cancel.addEventListener("click", this.onCancel);
    }

    /**
     * Show the inspected feature's layer settings and discard previews on selection changes.
     * @param {FieldDisplaySelection|null} selection Current feature, or null when none is selected.
     * @return {void}
     */
    show(selection) {
        const next = selection?.fields.length ? selection : null;
        const previous = this.selection;
        this.selection = next;
        this.root.hidden = next === null;
        if (next?.sourceId !== previous?.sourceId) this.root.open = false;
        if (next?.sourceId !== previous?.sourceId || next?.properties !== previous?.properties ||
            next?.fields.length !== previous?.fields.length ||
            next?.fields.some((name, index) => name !== previous.fields[index])) {
            this.#resetImport();
        }
    }

    /** Download the current layer's prefilled spreadsheet template. @return {void} */
    #downloadTemplate() {
        if (!this.selection) return;
        const csv = makeFieldFormatTemplate(this.selection.fields, this.selection.formats);
        const url = URL.createObjectURL(new Blob([csv], {type: "text/csv;charset=utf-8"}));
        const link = this.document.createElement("a");
        link.href = url;
        link.download = "vector-field-display.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Clear the pending file, preview and any obsolete read. @return {void} */
    #resetImport() {
        this.generation += 1;
        this.previewFormats = null;
        this.file.value = "";
        this.status.textContent = "";
        this.preview.hidden = true;
        this.rows.replaceChildren();
        this.actions.hidden = true;
    }

    /**
     * Validate the entire CSV and preview against the selected feature's actual values.
     * @return {Promise<void>} Completion after preview, validation error or supersession.
     */
    async #previewImport() {
        const file = this.file.files?.[0];
        this.#resetImport();
        if (!file || !this.selection) return;
        const generation = this.generation;
        const {fields, formats, properties} = this.selection;
        this.status.textContent = "Reading field formats…";
        try {
            if (file.size > MAX_FIELD_FORMAT_CSV_BYTES) {
                throw new Error("Choose a CSV file no larger than 512 KiB.");
            }
            const bytes = await file.arrayBuffer();
            if (generation !== this.generation) return;
            let text;
            try { text = new TextDecoder("utf-8", {fatal: true}).decode(bytes); }
            catch { throw new Error("Save the spreadsheet as CSV UTF-8, then try importing it again."); }
            const proposed = parseFieldFormatCsv(text, fields);
            for (const name of fields) {
                const current = Object.hasOwn(formats, name) ? formats[name] : undefined;
                const replacement = Object.hasOwn(proposed, name) ? proposed[name] : undefined;
                if (!current && !replacement) continue;
                const value = Object.hasOwn(properties, name) ? properties[name] : undefined;
                const row = this.document.createElement("tr");
                const heading = this.document.createElement("th");
                heading.setAttribute("scope", "row");
                heading.textContent = name;
                row.append(heading);
                for (const format of [current, replacement]) {
                    const cell = this.document.createElement("td");
                    cell.textContent = this.formatValue(value, format);
                    row.append(cell);
                }
                this.rows.append(row);
            }
            this.previewFormats = proposed;
            this.preview.hidden = this.rows.children.length === 0;
            this.actions.hidden = false;
            this.status.textContent = this.preview.hidden
                ? "All fields use the default display."
                : "Review the preview before applying the formats to this layer.";
            if (!this.preview.hidden && this.root.open) this.preview.focus();
        } catch (error) {
            if (generation === this.generation) this.status.textContent = error.message;
        }
    }

    /** Commit the displayed formats to the selected layer view. @return {void} */
    #applyPreview() {
        if (this.previewFormats === null) return;
        const applied = this.selection.apply(this.previewFormats);
        this.#resetImport();
        this.refreshAttributes();
        this.status.textContent = applied ? "Field formats applied." : "The layer changed. Download a fresh template and try again.";
        this.file.focus();
    }

    /** Release file and button listeners and invalidate any pending read. @return {void} */
    destroy() {
        this.show(null);
        this.download.removeEventListener("click", this.onDownload);
        this.file.removeEventListener("change", this.onFile);
        this.apply.removeEventListener("click", this.onApply);
        this.cancel.removeEventListener("click", this.onCancel);
    }
}
