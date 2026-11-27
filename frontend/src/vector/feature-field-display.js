/** Download, preview and apply a vector view's field formatting CSV. */

import { makeFieldFormatTemplate, MAX_FIELD_FORMAT_CSV_BYTES, parseFieldFormatCsv } from "./field-format-csv.js";

/** @typedef {import("../feature-field-formats.js").FeatureFieldFormats} FeatureFieldFormats */

/**
 * Editable display settings for one retained vector layer view.
 * @typedef {Object} FeatureFieldDisplay
 * @property {string} label Layer name shown in the editor.
 * @property {readonly string[]} fields Exact non-geometry field names.
 * @property {readonly string[]} numericFields Field names that accept numeric formatting.
 * @property {FeatureFieldFormats} formats Current field display settings.
 * @property {(formats:FeatureFieldFormats)=>boolean} apply Store the settings if this view is still current.
 */

/** @typedef {FeatureFieldDisplay & {sourceId:string,properties:Object<string,unknown>|null}} FieldDisplaySelection */

/**
 * Describe the numeric settings in a preview that has no sample feature.
 * @param {import("../feature-field-formats.js").FeatureFieldFormat|undefined} settings Current or proposed field settings.
 * @return {string} Number format, precision and unit, or the default display.
 */
function describeNumberFormat(settings) {
    if (!settings?.format) return "Default";
    const parts = [settings.format === "currency" ? `Currency (${settings.currency})` : "Number"];
    if (settings.decimals !== undefined) {
        parts.push(`${settings.decimals} decimal place${settings.decimals === 1 ? "" : "s"}`);
    }
    if (settings.unit) parts.push(settings.unit);
    return parts.join(", ");
}

/** Edit one vector view's field names and units with an optional feature for the value preview. */
export class VectorFeatureFieldDisplay {
    /**
     * Bind the shared layer editor's download, preview and apply controls.
     * @param {Document} documentContext Document containing the Feature inspector.
     * @param {(value:unknown,format?:import("../feature-field-formats.js").FeatureFieldFormat)=>string} formatValue
     * Inspector value formatter used for the preview.
     * @param {()=>void} refreshAttributes Redisplay the feature using the layer's latest fields and formats.
     */
    constructor(documentContext, formatValue, refreshAttributes) {
        this.document = documentContext;
        this.formatValue = formatValue;
        this.refreshAttributes = refreshAttributes;
        this.root = documentContext.querySelector("#vector-field-editor");
        this.title = documentContext.querySelector("#vector-field-editor-title");
        this.currentHeading = documentContext.querySelector("#vector-format-current-heading");
        this.proposedHeading = documentContext.querySelector("#vector-format-proposed-heading");
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
        /** Invalidate pending file reads when the dialog is dismissed. @return {void} */
        this.onClose = () => {
            if (this.root.open) return;
            this.selection = null;
            this.#resetImport();
        };
        this.root.addEventListener("close", this.onClose);
        this.download.addEventListener("click", this.onDownload);
        this.file.addEventListener("change", this.onFile);
        this.apply.addEventListener("click", this.onApply);
        this.cancel.addEventListener("click", this.onCancel);
    }

    /**
     * Open this layer's editor. A feature supplies actual values for the preview when available.
     * @param {FieldDisplaySelection} selection Layer fields, settings and optional feature attributes.
     * @return {void}
     */
    open(selection) {
        this.#resetImport();
        this.selection = selection;
        this.title.textContent = `Edit units and field names for ${selection.label}`;
        this.currentHeading.textContent = selection.properties ? "Current value" : "Current format";
        this.proposedHeading.textContent = selection.properties ? "Proposed value" : "Proposed format";
        if (!this.root.open) this.root.showModal();
    }

    /**
     * Follow layer renames and dismiss a preview whose source fields have changed.
     * @param {(key:string)=>FeatureFieldDisplay|null} getLayer Read the current retained view by key.
     * @return {void}
     */
    refreshLayer(getLayer) {
        if (!this.selection) return;
        const {sourceId, fields, numericFields} = this.selection;
        const layer = getLayer(sourceId);
        if (!layer || layer.fields.length !== fields.length || layer.fields.some((name, i) => name !== fields[i]) ||
            layer.numericFields.length !== numericFields.length || layer.numericFields.some((name, i) => name !== numericFields[i])) {
            this.close();
            return;
        }
        this.title.textContent = `Edit units and field names for ${layer.label}`;
    }

    /** Close the editor and immediately invalidate pending previews. @return {void} */
    close() {
        if (this.root.open) this.root.close();
        this.selection = null;
        this.#resetImport();
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
     * Validate the CSV and preview field names alongside numeric settings or actual feature values.
     * @return {Promise<void>} Completion after preview, validation error or supersession.
     */
    async #previewImport() {
        const file = this.file.files?.[0];
        this.#resetImport();
        if (!file || !this.selection) return;
        const generation = this.generation;
        const {fields, numericFields, formats, properties} = this.selection;
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
            const proposed = parseFieldFormatCsv(text, fields, numericFields);
            for (const name of fields) {
                const current = Object.hasOwn(formats, name) ? formats[name] : undefined;
                const replacement = Object.hasOwn(proposed, name) ? proposed[name] : undefined;
                if (!current && !replacement) continue;
                const value = properties && Object.hasOwn(properties, name) ? properties[name] : undefined;
                const before = properties ? this.formatValue(value, current) : describeNumberFormat(current);
                const after = properties ? this.formatValue(value, replacement) : describeNumberFormat(replacement);
                const row = this.document.createElement("tr");
                const heading = this.document.createElement("th");
                heading.setAttribute("scope", "row");
                heading.textContent = name;
                row.append(heading);
                for (const text of [current?.displayName ?? name, replacement?.displayName ?? name,
                    before, after]) {
                    const cell = this.document.createElement("td");
                    cell.textContent = text;
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
        if (applied) this.selection.formats = this.previewFormats;
        this.#resetImport();
        if (applied) this.refreshAttributes();
        this.status.textContent = applied ? "Field formats applied." : "The layer changed. Download a fresh template and try again.";
        this.file.focus();
    }

    /** Release file and button listeners and invalidate any pending read. @return {void} */
    destroy() {
        this.close();
        this.root.removeEventListener("close", this.onClose);
        this.download.removeEventListener("click", this.onDownload);
        this.file.removeEventListener("change", this.onFile);
        this.apply.removeEventListener("click", this.onApply);
        this.cancel.removeEventListener("click", this.onCancel);
    }
}
