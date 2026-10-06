/** Bounded CSV upload parsing for a raster layer's category table. */
import {
    DEFAULT_UNMAPPED_RASTER_APPEARANCE,
    MAX_CATEGORICAL_RASTER_CATEGORIES,
    normalizeCategoricalRasterStyle,
} from "./categorical-style.js";

/** Maximum UTF-8 input size, checked independently of the browser File object. */
export const MAX_CATEGORICAL_RASTER_CSV_BYTES = 131072;

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
 * @return {CategoryCsvRecord[]} Decoded records including the header.
 * @throws {Error} If quoting, line endings, or the category row limit is invalid.
 */
function readCategoryCsvRecords(text) {
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
            if (records.length >= MAX_CATEGORICAL_RASTER_CATEGORIES + 1) {
                throw new Error(`CSV row ${recordRow}: import at most ${MAX_CATEGORICAL_RASTER_CATEGORIES} category rows.`);
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
 * Convert CSV numeric text without accepting JavaScript coercion or rounding.
 * Whole codes allow a sign and an optional all-zero fractional suffix. Opacity
 * accepts decimal notation, including a decimal exponent, and defaults to one
 * for a blank cell. The canonical style validator owns numeric range checks.
 *
 * @param {string} text Trimmed field text.
 * @param {"value"|"opacity"} column Numeric field name.
 * @param {number} row One-based starting line of the CSV record.
 * @return {number} Parsed number, with semantic bounds left to the style owner.
 * @throws {Error} If the field does not use the accepted numeric grammar.
 */
function categoryCsvNumber(text, column, row) {
    if (column === "opacity" && text === "") return 1;
    const pattern = column === "value"
        ? /^[+-]?\d+(?:\.0+)?$/
        : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    if (!pattern.test(text)) {
        const requirement = column === "value"
            ? "use a whole decimal integer such as 41 or 41.0, without an exponent"
            : "use a decimal opacity from 0 to 1, such as 0.5; percentages are not accepted";
        throw new Error(`CSV row ${row}, column "${column}": ${requirement}.`);
    }
    return Number(text);
}

/**
 * Import one complete category table without mutating any current appearance.
 *
 * Input is limited to 131,072 UTF-8 bytes and 256 category records. One optional
 * initial UTF-8 BOM, LF/CRLF records, quoted commas/newlines, and doubled quotes
 * are supported. Quoted line breaks normalize to LF for the label editor.
 * Quotes must enclose the whole field; text after a closing quote
 * and bare carriage returns are rejected. Empty physical records are skipped.
 * Headers are trimmed and case-insensitive: value, label and color are required;
 * opacity is optional and missing or blank cells default to one. Other columns
 * and duplicate headers are errors. Codes allow a decimal integer with optional
 * sign and all-zero fractional suffix, never scientific or hexadecimal syntax.
 * Opacity allows decimal notation with an optional decimal exponent.
 *
 * The existing categorical boundary validates the entire table exactly once,
 * including duplicate values, safe integers, labels, hex colors, opacity, and
 * serialized size. Errors identify the source record's starting physical row
 * and field when applicable. Row order is retained. The supplied unmapped
 * appearance is preserved; file I/O, previews, replacement and lifecycle belong
 * to the caller. Failure never returns a partially imported table.
 *
 * @param {string} text CSV file contents decoded as UTF-8.
 * @param {Readonly<import("./categorical-style.js").UnmappedRasterAppearance>}
 * [unmapped=DEFAULT_UNMAPPED_RASTER_APPEARANCE] Existing layer fallback appearance.
 * @return {Readonly<import("./categorical-style.js").CategoricalRasterStyle>}
 * Canonical deeply frozen categorical style.
 * @throws {TypeError} If text is not a string.
 * @throws {Error} If CSV syntax, field values, or resource bounds are invalid.
 */
export function parseCategoricalRasterCsv(text, unmapped = DEFAULT_UNMAPPED_RASTER_APPEARANCE) {
    if (typeof text !== "string") throw new TypeError("Categorical CSV input must be text.");
    if (text.length > MAX_CATEGORICAL_RASTER_CSV_BYTES ||
        new TextEncoder().encode(text).byteLength > MAX_CATEGORICAL_RASTER_CSV_BYTES) {
        throw new Error(`CSV file exceeds ${MAX_CATEGORICAL_RASTER_CSV_BYTES} UTF-8 bytes (128 KiB).`);
    }
    const records = readCategoryCsvRecords(text.startsWith("\ufeff") ? text.slice(1) : text);
    if (records.length === 0) {
        throw new Error("CSV row 1: add a header with value, label, and color columns.");
    }
    const columns = categoryCsvColumns(records[0]);
    const data = records.slice(1);
    const categories = data.map((record) => {
        if (record.fields.length !== columns.length) {
            const column = Math.min(record.fields.length, columns.length) + 1;
            throw new Error(`CSV row ${record.row}, column ${column}: expected ${columns.length} fields to match the header; found ${record.fields.length}.`);
        }
        const row = Object.fromEntries(columns.map((column, index) => [column, record.fields[index].trim()]));
        return {
            value: categoryCsvNumber(row.value, "value", record.row),
            label: row.label,
            color: row.color,
            opacity: row.opacity === undefined ? 1 : categoryCsvNumber(row.opacity, "opacity", record.row),
        };
    });
    try {
        return normalizeCategoricalRasterStyle({ mode: "categorical", categories, unmapped });
    } catch (error) {
        const category = /^Category (\d+) (value|label|color|opacity)\b\s*(.*)$/.exec(error.message);
        if (category) {
            const row = data[Number(category[1]) - 1].row;
            throw new Error(`CSV row ${row}, column "${category[2]}": ${category[3]}`, { cause: error });
        }
        throw new Error(`CSV table: ${error.message}`, { cause: error });
    }
}
