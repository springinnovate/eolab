/** Manual category-table and CSV preview presentation for raster appearance. */
import {
    DEFAULT_UNMAPPED_RASTER_APPEARANCE,
    MAX_CATEGORICAL_RASTER_CATEGORIES,
    normalizeCategoricalRasterStyle,
} from "./categorical-style.js";
import { requireRasterControl } from "./required-control.js";
import {
    MAX_CATEGORICAL_RASTER_CSV_BYTES,
    parseCategoricalRasterCsv,
} from "./categorical-csv.js";

/**
 * @typedef {import("./categorical-style.js").CategoricalRasterStyle} CategoricalRasterStyle
 * @typedef {import("./categorical-style.js").RasterCategory} RasterCategory
 * @typedef {Object} CategoryEditorHandlers
 * @property {() => void} onCategoricalStyleInput Validate an in-progress edit.
 * @property {() => void} onCategoricalStyleChange Commit a completed edit.
 * @typedef {Object} CategoryRowControls
 * @property {HTMLFieldSetElement} root Row fieldset.
 * @property {HTMLLegendElement} legend Row position label.
 * @property {Object<string, HTMLInputElement|HTMLTextAreaElement>} inputs Value, label, color, and opacity fields.
 * @property {HTMLInputElement} swatch Native color selector.
 * @property {Object<string, HTMLButtonElement>} actions Reorder and remove buttons.
 * @property {Array<() => void>} dispose Direct-listener cleanup callbacks.
 */

/**
 * Retain editable category drafts without owning rendered or persisted styles.
 * The caller receives semantic edit notifications and reads a normalized style
 * only when the complete table passes the canonical appearance contract.
 */
export class CategoricalRasterEditorView {
    /**
     * Resolve the editor controls and display an initially empty category draft.
     * @param {Pick<Document,"querySelector"|"createElement">} [documentContext=globalThis.document]
     * Owning document or scoped DOM adapter for an independent appearance form.
     * @throws {Error} If required editor markup is absent.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.root = requireRasterControl(documentContext, "#raster-categorical-editor");
        this.rowsRoot = requireRasterControl(documentContext, "#raster-category-rows");
        this.addButton = requireRasterControl(documentContext, "#add-raster-category");
        this.count = requireRasterControl(documentContext, "#raster-category-count");
        this.error = requireRasterControl(documentContext, "#raster-category-error");
        this.unmappedColor = requireRasterControl(documentContext, "#raster-unmapped-color");
        this.unmappedSwatch = requireRasterControl(documentContext, "#raster-unmapped-swatch");
        this.unmappedOpacity = requireRasterControl(documentContext, "#raster-unmapped-opacity");
        this.csvRoot = requireRasterControl(documentContext, "#raster-category-csv-import");
        this.csvFile = requireRasterControl(documentContext, "#raster-category-csv-file");
        this.csvStatus = requireRasterControl(documentContext, "#raster-category-csv-status");
        this.csvPreview = requireRasterControl(documentContext, "#raster-category-csv-preview");
        this.csvSummary = requireRasterControl(documentContext, "#raster-category-csv-summary");
        this.csvTable = requireRasterControl(documentContext, "#raster-category-csv-table");
        this.csvRows = requireRasterControl(documentContext, "#raster-category-csv-rows");
        this.csvApply = requireRasterControl(documentContext, "#apply-raster-category-csv");
        this.csvCancel = requireRasterControl(documentContext, "#cancel-raster-category-csv");
        this.csvGeneration = 0;
        this.csvStyle = null;
        this.rows = [];
        this.handlers = null;
        this.enabled = true;
        this.boundAdd = () => this.#addRow();
        this.boundInput = () => {
            this.cancelCategoricalImport();
            this.handlers?.onCategoricalStyleInput?.();
        };
        this.boundChange = () => {
            this.cancelCategoricalImport();
            this.handlers?.onCategoricalStyleChange?.();
        };
        this.boundCsvFileChange = () => { void this.#previewCsvFile(); };
        this.boundCsvApply = () => this.#applyCsvPreview();
        this.boundCsvCancel = () => {
            this.cancelCategoricalImport();
            this.csvFile.focus();
        };
        this.boundUnmappedColor = () => {
            this.#syncSwatch(this.unmappedColor, this.unmappedSwatch);
            this.boundInput();
        };
        this.boundUnmappedSwatch = () => {
            this.unmappedColor.value = this.unmappedSwatch.value;
            this.boundInput();
        };
        this.setStyle(null);
    }

    /**
     * Attach semantic callbacks and direct listeners, including retained rows.
     * @param {CategoryEditorHandlers} handlers Appearance-owner callbacks.
     * @return {void}
     */
    bind(handlers) {
        this.unbind();
        this.handlers = handlers;
        this.addButton.addEventListener("click", this.boundAdd);
        this.csvFile.addEventListener("change", this.boundCsvFileChange);
        this.csvApply.addEventListener("click", this.boundCsvApply);
        this.csvCancel.addEventListener("click", this.boundCsvCancel);
        this.unmappedColor.addEventListener("input", this.boundUnmappedColor);
        this.unmappedSwatch.addEventListener("input", this.boundUnmappedSwatch);
        this.unmappedOpacity.addEventListener("input", this.boundInput);
        for (const input of [this.unmappedColor, this.unmappedSwatch, this.unmappedOpacity]) {
            input.addEventListener("change", this.boundChange);
        }
        for (const row of this.rows) this.#bindRow(row);
    }

    /**
     * Remove direct listeners and cancel transient imports, preserving manual drafts.
     * @return {void}
     */
    unbind() {
        this.cancelCategoricalImport();
        this.addButton.removeEventListener("click", this.boundAdd);
        this.csvFile.removeEventListener("change", this.boundCsvFileChange);
        this.csvApply.removeEventListener("click", this.boundCsvApply);
        this.csvCancel.removeEventListener("click", this.boundCsvCancel);
        this.unmappedColor.removeEventListener("input", this.boundUnmappedColor);
        this.unmappedSwatch.removeEventListener("input", this.boundUnmappedSwatch);
        this.unmappedOpacity.removeEventListener("input", this.boundInput);
        for (const input of [this.unmappedColor, this.unmappedSwatch, this.unmappedOpacity]) {
            input.removeEventListener("change", this.boundChange);
        }
        for (const row of this.rows) this.#unbindRow(row);
        this.handlers = null;
    }

    /**
     * Hydrate a committed appearance when changing targets or restoring a style.
     * Cancel any preview or pending CSV read belonging to the previous draft.
     * Ordinary typing must not call this method: incomplete drafts stay in DOM.
     * @param {Readonly<CategoricalRasterStyle>|null} style Valid retained style,
     * or null to show an empty starter row without inventing a raster category.
     * @return {void}
     */
    setStyle(style) {
        this.cancelCategoricalImport();
        for (const row of this.rows) this.#unbindRow(row);
        this.rows = (style?.categories ?? [null]).map(category => this.#createRow(category));
        this.rowsRoot.replaceChildren(...this.rows.map(row => row.root));
        const unmapped = style?.unmapped ?? DEFAULT_UNMAPPED_RASTER_APPEARANCE;
        this.unmappedColor.value = unmapped.color;
        this.unmappedSwatch.value = unmapped.color;
        this.unmappedOpacity.value = String(unmapped.opacity * 100);
        this.renderError();
        this.#updateRows();
    }

    /**
     * Normalize the complete draft at the user-input boundary.
     * Blank numeric fields stay invalid rather than being coerced to zero.
     * @return {Readonly<CategoricalRasterStyle>} Valid immutable appearance.
     * @throws {Error} If a row, unmapped setting, or resource limit is invalid.
     */
    readStyle() {
        return normalizeCategoricalRasterStyle({
            mode: "categorical",
            categories: this.rows.map(({ inputs }) => ({
                value: this.#number(inputs.value),
                label: inputs.label.value,
                color: inputs.color.value,
                opacity: this.#number(inputs.opacity) / 100,
            })),
            unmapped: this.#readUnmappedAppearance(),
        });
    }

    /**
     * Present canonical validation feedback and mark the relevant input.
     * @param {Error|null} [error=null] Validation error, or null to clear it.
     * @return {void}
     */
    renderError(error = null) {
        this.error.textContent = error?.message ?? "";
        for (const input of this.#allInputs()) input.removeAttribute("aria-invalid");
        if (!error) return;
        const category = /^Category (\d+) (value|label|color|opacity)\b/.exec(error.message);
        const unmapped = /^Unmapped (color|opacity)\b/.exec(error.message);
        if (category) {
            const row = this.rows[Number(category[1]) - 1];
            row?.inputs[category[2]].setAttribute("aria-invalid", "true");
        } else if (unmapped) {
            (unmapped[1] === "color" ? this.unmappedColor : this.unmappedOpacity)
                .setAttribute("aria-invalid", "true");
        }
    }

    /**
     * Set editor availability without discarding draft values.
     * Disabling also discards CSV previews and invalidates pending file reads.
     * @param {boolean} enabled Whether the appearance owner allows editing.
     * @return {void}
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) this.cancelCategoricalImport();
        this.csvFile.disabled = !enabled;
        for (const input of this.#allInputs()) input.disabled = !enabled;
        this.#updateRows();
    }

    /**
     * Discard an import preview and invalidate any outstanding file read.
     * Manual category drafts and committed appearance are never changed.
     * File reads may finish, but their obsolete generation cannot publish a preview.
     * @return {void}
     */
    cancelCategoricalImport() {
        this.csvGeneration += 1;
        this.csvStyle = null;
        this.csvFile.value = "";
        this.csvStatus.textContent = "";
        this.csvSummary.textContent = "";
        this.csvRows.replaceChildren();
        this.csvPreview.hidden = true;
        this.csvTable.hidden = true;
        this.csvApply.disabled = true;
        this.csvCancel.disabled = true;
        this.csvRoot.setAttribute("aria-busy", "false");
    }

    /**
     * Read a bounded local file and preview its fully validated category rows.
     * Selection, reading, decoding, and parse errors never emit style edits.
     * @return {Promise<void>} Completes after preview or local error presentation.
     */
    async #previewCsvFile() {
        const file = this.csvFile.files?.[0];
        this.cancelCategoricalImport();
        if (!file || !this.enabled || !this.handlers) return;
        const generation = this.csvGeneration;
        this.csvPreview.hidden = false;
        this.csvCancel.disabled = false;
        try {
            if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_CATEGORICAL_RASTER_CSV_BYTES) {
                throw new Error(`CSV file must be no larger than ${MAX_CATEGORICAL_RASTER_CSV_BYTES} bytes (128 KiB).`);
            }
            this.csvRoot.setAttribute("aria-busy", "true");
            this.csvStatus.textContent = `Reading ${file.name}…`;
            const buffer = await file.arrayBuffer();
            if (generation !== this.csvGeneration) return;
            let text;
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            } catch {
                throw new Error("CSV file must contain valid UTF-8 text.");
            }
            this.csvStyle = parseCategoricalRasterCsv(text);
            this.#renderCsvPreview(this.csvStyle, file.name);
            this.csvStatus.textContent = "Preview ready. Replace categories to apply the complete table; unmapped settings are preserved.";
            this.csvApply.disabled = false;
        } catch (error) {
            if (generation !== this.csvGeneration) return;
            this.csvStyle = null;
            this.csvRows.replaceChildren();
            this.csvTable.hidden = true;
            this.csvApply.disabled = true;
            this.csvStatus.textContent = error instanceof Error
                ? error.message : "The CSV file could not be read.";
        } finally {
            if (generation === this.csvGeneration) {
                this.csvRoot.setAttribute("aria-busy", "false");
                this.csvPreview.focus();
            }
        }
    }

    /**
     * Show every imported category in its supplied order using literal text.
     * @param {Readonly<CategoricalRasterStyle>} style Canonical imported table.
     * @param {string} filename User-selected file name.
     * @return {void}
     */
    #renderCsvPreview(style, filename) {
        this.csvSummary.textContent = `${filename}: ${style.categories.length} categories will replace the current table.`;
        const rows = style.categories.map((category, index) => {
            const row = this.documentContext.createElement("tr");
            for (const value of [index + 1, category.value, category.label, category.color, category.opacity]) {
                const cell = this.documentContext.createElement("td");
                cell.textContent = String(value);
                row.append(cell);
            }
            return row;
        });
        this.csvRows.replaceChildren(...rows);
        this.csvTable.hidden = false;
    }

    /**
     * Validate current unmapped fields before atomically replacing all categories.
     * Failures preserve both the previous category draft and the committed style.
     * @return {void}
     */
    #applyCsvPreview() {
        if (!this.enabled || this.csvApply.disabled || this.csvStyle === null || !this.handlers) return;
        let style;
        try {
            style = normalizeCategoricalRasterStyle({
                mode: "categorical",
                categories: this.csvStyle.categories,
                unmapped: this.#readUnmappedAppearance(),
            });
        } catch (error) {
            this.renderError(error);
            this.csvStatus.textContent = `Cannot replace categories: ${error.message}`;
            this.csvApply.disabled = true;
            return;
        }
        this.setStyle(style);
        this.boundChange();
        this.rows[0].inputs.value.focus();
    }

    /**
     * Read independent unmapped drafts for complete style-boundary validation.
     * @return {{color:string,opacity:number}} Candidate fallback appearance.
     */
    #readUnmappedAppearance() {
        return {
            color: this.unmappedColor.value,
            opacity: this.#number(this.unmappedOpacity) / 100,
        };
    }

    /**
     * Read one numeric form value while preserving an empty draft as invalid.
     * @param {HTMLInputElement} input Numeric input.
     * @return {number} Parsed number, or NaN for an empty field.
     */
    #number(input) {
        return String(input.value).trim() === "" ? Number.NaN : Number(input.value);
    }

    /**
     * Create an explicitly labelled field, retaining line breaks in category labels.
     * @param {string} title Visible field label.
     * @param {"number"|"text"|"textarea"} type Native input type or multiline text field.
     * @param {string} value Initial field value.
     * @return {{label: HTMLLabelElement, input: HTMLInputElement|HTMLTextAreaElement}} New field.
     */
    #field(title, type, value) {
        const label = this.documentContext.createElement("label");
        const text = this.documentContext.createElement("span");
        text.textContent = title;
        const input = this.documentContext.createElement(type === "textarea" ? "textarea" : "input");
        if (type === "textarea") input.rows = 2;
        else input.type = type;
        input.value = value;
        input.setAttribute("aria-describedby", "raster-category-error");
        label.append(text, input);
        return { label, input };
    }

    /**
     * Build a row whose text and color fields remain editable independently.
     * @param {Readonly<RasterCategory>|null} category Committed row or empty draft.
     * @return {CategoryRowControls} New controls and listener lifecycle.
     */
    #createRow(category) {
        const root = this.documentContext.createElement("fieldset");
        root.className = "raster-category-row";
        const legend = this.documentContext.createElement("legend");
        const fields = this.documentContext.createElement("div");
        fields.className = "raster-category-fields";
        const value = this.#field("Value", "number", category ? String(category.value) : "");
        value.input.step = "1";
        const label = this.#field("Label", "textarea", category?.label ?? "");
        const color = this.#field("Color (hex)", "text", category?.color ?? "#808080");
        color.input.spellcheck = false;
        color.input.maxLength = 7;
        const swatch = this.documentContext.createElement("input");
        swatch.type = "color";
        swatch.value = color.input.value;
        swatch.setAttribute("aria-describedby", "raster-category-error");
        const colorFields = this.documentContext.createElement("span");
        colorFields.className = "raster-category-color";
        colorFields.append(swatch, color.input);
        color.label.replaceChildren(color.label.children[0], colorFields);
        const opacity = this.#field("Opacity %", "number", String((category?.opacity ?? 1) * 100));
        opacity.input.min = "0";
        opacity.input.max = "100";
        opacity.input.step = "any";
        fields.append(value.label, label.label, color.label, opacity.label);
        const actionsRoot = this.documentContext.createElement("div");
        actionsRoot.className = "raster-category-actions";
        const actions = {};
        for (const [name, title] of [["up", "Move up"], ["down", "Move down"], ["remove", "Remove"]]) {
            const button = this.documentContext.createElement("button");
            button.type = "button";
            button.className = "secondary-button";
            button.textContent = title;
            actions[name] = button;
            actionsRoot.append(button);
        }
        root.append(legend, fields, actionsRoot);
        const row = {
            root, legend, swatch, actions,
            inputs: { value: value.input, label: label.input, color: color.input, opacity: opacity.input },
            dispose: [],
        };
        if (this.handlers) this.#bindRow(row);
        return row;
    }

    /**
     * Attach direct row listeners; native buttons provide keyboard interaction.
     * @param {CategoryRowControls} row Owned controls.
     * @return {void}
     */
    #bindRow(row) {
        /**
         * Retain cleanup for one row-owned event listener.
         * @param {HTMLElement} element Event target.
         * @param {string} type DOM event name.
         * @param {EventListener} listener Semantic edit listener.
         * @return {void}
         */
        const listen = (element, type, listener) => {
            element.addEventListener(type, listener);
            row.dispose.push(() => element.removeEventListener(type, listener));
        };
        for (const [name, input] of Object.entries(row.inputs)) {
            listen(input, "input", () => {
                if (name === "color") this.#syncSwatch(input, row.swatch);
                this.boundInput();
            });
            listen(input, "change", this.boundChange);
        }
        listen(row.swatch, "input", () => {
            row.inputs.color.value = row.swatch.value;
            this.boundInput();
        });
        listen(row.swatch, "change", this.boundChange);
        listen(row.actions.up, "click", () => this.#moveRow(row, -1));
        listen(row.actions.down, "click", () => this.#moveRow(row, 1));
        listen(row.actions.remove, "click", () => this.#removeRow(row));
    }

    /**
     * Release every direct listener belonging to a row.
     * @param {CategoryRowControls} row Owned controls.
     * @return {void}
     */
    #unbindRow(row) {
        for (const dispose of row.dispose) dispose();
        row.dispose = [];
    }

    /**
     * Reflect valid typed hex colors without coercing invalid text drafts.
     * @param {HTMLInputElement} input Editable hex field.
     * @param {HTMLInputElement} swatch Native color selector.
     * @return {void}
     */
    #syncSwatch(input, swatch) {
        if (/^#[0-9a-f]{6}$/i.test(input.value)) swatch.value = input.value;
    }

    /** Add a blank row within the shared category bound and focus it. @return {void} */
    #addRow() {
        if (!this.enabled || this.rows.length >= MAX_CATEGORICAL_RASTER_CATEGORIES) return;
        const row = this.#createRow(null);
        this.rows.push(row);
        this.rowsRoot.append(row.root);
        this.#updateRows();
        row.inputs.value.focus();
        this.boundChange();
    }

    /**
     * Move one row and keep focus on the moved row's action or value field.
     * @param {CategoryRowControls} row Row being moved.
     * @param {-1|1} direction Adjacent position.
     * @return {void}
     */
    #moveRow(row, direction) {
        const index = this.rows.indexOf(row);
        const next = index + direction;
        if (!this.enabled || next < 0 || next >= this.rows.length) return;
        [this.rows[index], this.rows[next]] = [this.rows[next], this.rows[index]];
        for (const current of this.rows) this.rowsRoot.append(current.root);
        this.#updateRows();
        const action = row.actions[direction === -1 ? "up" : "down"];
        (action.disabled ? row.inputs.value : action).focus();
        this.boundChange();
    }

    /**
     * Remove a row and give the following row, preceding row, or Add action focus.
     * @param {CategoryRowControls} row Row being removed.
     * @return {void}
     */
    #removeRow(row) {
        if (!this.enabled) return;
        const index = this.rows.indexOf(row);
        this.#unbindRow(row);
        this.rows.splice(index, 1);
        row.root.remove();
        this.#updateRows();
        (this.rows[Math.min(index, this.rows.length - 1)]?.inputs.value ?? this.addButton).focus();
        this.boundChange();
    }

    /** Refresh row positions, accessible names, and bounded action state. @return {void} */
    #updateRows() {
        this.count.textContent = `${this.rows.length} / ${MAX_CATEGORICAL_RASTER_CATEGORIES} categories`;
        this.addButton.disabled = !this.enabled || this.rows.length >= MAX_CATEGORICAL_RASTER_CATEGORIES;
        for (const [index, row] of this.rows.entries()) {
            row.legend.textContent = `Category ${index + 1}`;
            for (const [name, input] of Object.entries(row.inputs)) {
                input.setAttribute("aria-label", `Category ${index + 1} ${name === "opacity" ? "opacity (%)" : name}`);
                input.disabled = !this.enabled;
            }
            row.swatch.setAttribute("aria-label", `Choose category ${index + 1} color`);
            row.swatch.disabled = !this.enabled;
            row.actions.up.disabled = !this.enabled || index === 0;
            row.actions.down.disabled = !this.enabled || index === this.rows.length - 1;
            row.actions.remove.disabled = !this.enabled;
            for (const [name, action] of Object.entries(row.actions)) {
                action.setAttribute("aria-label", name === "remove"
                    ? `Remove category ${index + 1}` : `Move category ${index + 1} ${name}`);
            }
        }
    }

    /** Return all mutable category and unmapped fields. @return {Array<HTMLInputElement|HTMLTextAreaElement>} Fields. */
    #allInputs() {
        return [this.unmappedColor, this.unmappedSwatch, this.unmappedOpacity,
            ...this.rows.flatMap(row => [...Object.values(row.inputs), row.swatch])];
    }
}
