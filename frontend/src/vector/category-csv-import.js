/** Vector-owned file reading, preview and explicit category replacement. */
import { MAX_CATEGORY_CSV_BYTES, parseCategoricalVectorCsv } from "./categorical-csv.js";

/** Own a transient import without knowing map, raster or rendering state. */
export class VectorCategoryCsvImport {
    /** @param {Document} documentContext Owning style-editor document. */
    constructor(documentContext) {
        this.document = documentContext;
        this.controls = Object.fromEntries(["root", "file", "status", "preview", "summary", "table", "rows", "apply", "cancel"]
            .map(name => [name, documentContext.querySelector(`#vector-category-csv-${name}`)]));
        this.generation = 0;
        this.table = null;
        this.field = null;
        this.enabled = false;
        this.replace = null;
        /** Read the selected bounded file. @return {void} */
        this.onFile = () => { void this.#read(); };
        /** Replace the complete preview through the vector owner. @return {void} */
        this.onApply = () => {
            if (!this.enabled || this.table === null || this.controls.apply.disabled) return;
            this.replace(this.table);
            this.cancel();
        };
        /** Discard pending work and restore file-control focus. @return {void} */
        this.onCancel = () => { this.cancel(); this.controls.file.focus(); };
        this.controls.file.addEventListener("change", this.onFile);
        this.controls.apply.addEventListener("click", this.onApply);
        this.controls.cancel.addEventListener("click", this.onCancel);
        this.cancel();
    }

    /**
     * Bind current attribute and replacement callback without reading sources.
     * Changing field or disabling invalidates pending reads and previews.
     * @param {{name:string,type:string}|null} field Current authoritative field.
     * @param {{otherColor:string|null,missingColor:string|null}} fallback Current fallback colors.
     * @param {boolean} enabled Whether the editor owns an active Categories target.
     * @param {(table:Readonly<import("./style.js").VectorCategoricalStyle>)=>void} replace Atomic draft replacement.
     * @return {void}
     */
    configure(field, fallback, enabled, replace) {
        if (!enabled || this.field?.name !== field?.name || this.field?.type !== field?.type) this.cancel();
        this.field = field;
        this.fallback = fallback;
        this.enabled = enabled;
        this.replace = replace;
        this.controls.file.disabled = !enabled;
    }

    /** Invalidate a preview/read while preserving the owner's style. @return {void} */
    cancel() {
        this.generation += 1;
        this.table = null;
        this.controls.file.value = "";
        this.controls.status.textContent = "";
        this.controls.summary.textContent = "";
        this.controls.rows.replaceChildren();
        this.controls.preview.hidden = true;
        this.controls.table.hidden = true;
        this.controls.apply.disabled = true;
        this.controls.cancel.disabled = true;
        this.controls.root.setAttribute("aria-busy", "false");
    }

    /** Detach the input's owned listeners and invalidate reads. @return {void} */
    destroy() {
        this.cancel();
        this.controls.file.removeEventListener("change", this.onFile);
        this.controls.apply.removeEventListener("click", this.onApply);
        this.controls.cancel.removeEventListener("click", this.onCancel);
    }

    /**
     * Preview a fully validated UTF-8 file, suppressing stale completions.
     * Reading and errors never emit style changes.
     * @return {Promise<void>} Completes after a preview or local error.
     */
    async #read() {
        const file = this.controls.file.files?.[0];
        this.cancel();
        if (!file || !this.enabled || this.field === null) return;
        const generation = this.generation;
        const field = this.field;
        this.controls.preview.hidden = false;
        this.controls.cancel.disabled = false;
        try {
            if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_CATEGORY_CSV_BYTES) {
                throw new Error(`CSV file must be no larger than ${MAX_CATEGORY_CSV_BYTES} bytes (128 KiB).`);
            }
            this.controls.root.setAttribute("aria-busy", "true");
            this.controls.status.textContent = `Reading ${file.name}…`;
            const buffer = await file.arrayBuffer();
            if (generation !== this.generation) return;
            let text;
            try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
            catch { throw new Error("CSV file must contain valid UTF-8 text."); }
            this.table = parseCategoricalVectorCsv(text, field, this.fallback);
            this.controls.summary.textContent = `${file.name}: ${this.table.rules.length} categories will replace the table for ${field.name}.`;
            this.controls.rows.replaceChildren(...this.table.rules.map((rule, index) => {
                const row = this.document.createElement("tr");
                for (const value of [index + 1, rule.value.value, rule.label, rule.color, rule.opacity]) {
                    const cell = this.document.createElement("td"); cell.textContent = String(value); row.append(cell);
                }
                return row;
            }));
            this.controls.table.hidden = false;
            this.controls.status.textContent = "Preview ready. Replace categories to apply; Other and No value colors are preserved.";
            this.controls.apply.disabled = false;
        } catch (error) {
            if (generation !== this.generation) return;
            this.table = null;
            this.controls.apply.disabled = true;
            this.controls.status.textContent = error instanceof Error ? error.message : "The CSV file could not be read.";
        } finally {
            if (generation === this.generation) {
                this.controls.root.setAttribute("aria-busy", "false"); this.controls.preview.focus();
            }
        }
    }
}
