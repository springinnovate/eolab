/** Neutral bounded syntax for category-table CSV input. */

/** Maximum UTF-8 file size shared by category-table input boundaries. */
export const MAX_CATEGORY_CSV_BYTES = 131072;

/**
 * @typedef {Object} CategoryCsvRecord
 * @property {string[]} fields Decoded CSV cells in source order.
 * @property {number} row One-based physical line where the record starts.
 */

/**
 * Parse comma-separated records with strict quoting and bounded row storage.
 * Empty physical records are ignored. Quoted empty cells and comma-only rows
 * remain records, allowing the table boundary to report their missing fields.
 * Quoted line breaks normalize to LF, matching HTML textarea value semantics.
 *
 * @param {string} text Byte-bounded CSV text without its optional initial BOM.
 * @param {number} maximumCategories Owning table limit.
 * @return {CategoryCsvRecord[]} Decoded records including the header.
 * @throws {Error} If quoting, line endings, or the category row limit is invalid.
 */
function readCategoryCsvRecords(text, maximumCategories) {
    const records = [];
    let fields = [];
    let field = "";
    let state = "unquoted";
    let line = 1;
    let recordRow = 1;
    let hasContent = false;

    /**
     * Finish one physical record without retaining empty lines.
     * @return {void}
     * @throws {Error} If another category would exceed the table limit.
     */
    function finishRecord() {
        if (hasContent) {
            if (records.length >= maximumCategories + 1) {
                throw new Error(`CSV row ${recordRow}: import at most ${maximumCategories} category rows.`);
            }
            fields.push(field);
            records.push({ fields, row: recordRow });
        }
        fields = [];
        field = "";
        state = "unquoted";
        hasContent = false;
    }

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === "\r" && text[index + 1] !== "\n") {
            throw new Error(`CSV row ${line}, column ${fields.length + 1}: use LF or CRLF line endings, not a bare carriage return.`);
        }
        if (state === "quoted") {
            if (character === '"') {
                if (text[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else {
                    state = "closed";
                }
            } else if (character === "\r" || character === "\n") {
                field += "\n";
                if (character === "\r") index += 1;
                line += 1;
            } else {
                field += character;
            }
            continue;
        }
        if (character === "\r" || character === "\n") {
            finishRecord();
            if (character === "\r") index += 1;
            line += 1;
            recordRow = line;
            continue;
        }
        hasContent = true;
        if (character === ",") {
            fields.push(field);
            field = "";
            state = "unquoted";
        } else if (state === "closed") {
            throw new Error(`CSV row ${line}, column ${fields.length + 1}: only a comma or newline may follow a closing quote.`);
        } else if (character === '"') {
            if (field !== "") {
                throw new Error(`CSV row ${line}, column ${fields.length + 1}: quote the entire field and double any quotes inside it.`);
            }
            state = "quoted";
        } else {
            field += character;
        }
    }
    if (state === "quoted") {
        throw new Error(`CSV row ${recordRow}, column ${fields.length + 1}: quoted field is missing its closing quote.`);
    }
    finishRecord();
    return records;
}

/**
 * Resolve the supported header names without silently ignoring extra columns.
 * @param {CategoryCsvRecord} header First nonempty record.
 * @return {string[]} Trimmed lowercase column names in CSV order.
 * @throws {Error} If a name is unknown, duplicated, or required but missing.
 */
function categoryCsvColumns(header) {
    const allowed = ["value", "label", "color", "opacity"];
    const columns = header.fields.map(field => field.trim().toLowerCase());
    const seen = new Set();
    for (const [index, column] of columns.entries()) {
        if (!allowed.includes(column)) {
            throw new Error(`CSV row ${header.row}, column ${index + 1}: unknown column "${header.fields[index]}"; use value, label, color, and optional opacity.`);
        }
        if (seen.has(column)) {
            throw new Error(`CSV row ${header.row}, column ${index + 1}: duplicate column "${column}".`);
        }
        seen.add(column);
    }
    for (const required of allowed.slice(0, 3)) {
        if (!seen.has(required)) {
            throw new Error(`CSV row ${header.row}: missing required column "${required}".`);
        }
    }
    return columns;
}

/**
 * Read a complete category CSV table without interpreting feature values.
 * Both style owners use the same headers, quoting, UTF-8 byte bound and
 * row-width errors; each supplies its established category-count limit.
 * Values remain literal text for the owning typed contract to interpret.
 *
 * @param {string} text UTF-8 decoded file contents, with an optional BOM.
 * @param {number} maximumCategories Established positive owning table limit.
 * @return {{columns:string[],data:CategoryCsvRecord[]}} Complete bounded table.
 * @throws {TypeError} If input is not text.
 * @throws {Error} If syntax, headers or resource limits are invalid.
 */
export function readCategoryCsvTable(text, maximumCategories) {
    if (typeof text !== "string") throw new TypeError("Categorical CSV input must be text.");
    if (text.length > MAX_CATEGORY_CSV_BYTES ||
        new TextEncoder().encode(text).byteLength > MAX_CATEGORY_CSV_BYTES) {
        throw new Error(`CSV file exceeds ${MAX_CATEGORY_CSV_BYTES} UTF-8 bytes (128 KiB).`);
    }
    const records = readCategoryCsvRecords(text.startsWith("\ufeff") ? text.slice(1) : text, maximumCategories);
    if (records.length === 0) {
        throw new Error("CSV row 1: add a header with value, label, and color columns.");
    }
    const columns = categoryCsvColumns(records[0]);
    const data = records.slice(1);
    return { columns, data };
}

/**
 * Validate one record's width and bind literal cells to the shared headers.
 * Callers interpret each row in order, preserving local error precedence.
 * @param {CategoryCsvRecord} record Current bounded record.
 * @param {string[]} columns Validated table header.
 * @return {Object<string,string>} Literal cells keyed by supported header.
 * @throws {Error} If row width differs from the header.
 */
export function categoryCsvCells(record, columns) {
    if (record.fields.length !== columns.length) {
        const column = Math.min(record.fields.length, columns.length) + 1;
        throw new Error(`CSV row ${record.row}, column ${column}: expected ${columns.length} fields to match the header; found ${record.fields.length}.`);
    }
    return Object.fromEntries(columns.map((column, index) => [column, record.fields[index]]));
}
