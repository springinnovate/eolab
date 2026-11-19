/** Exchange Feature inspector display settings as a spreadsheet-editable CSV. */

import { csvCells, readCsvRecords } from "../category-csv.js";
import { validateFeatureFieldFormat } from "../feature-field-formats.js";

export const MAX_FIELD_FORMAT_CSV_BYTES = 512 * 1024;
const COLUMNS = ["field", "format", "decimals", "unit", "currency"];
const SPREADSHEET_PREFIX = /^(?:'|\s*[=+@-]|[\t\r\n])/;

/**
 * Encode text as one CSV cell and protect spreadsheet formula prefixes.
 * @param {string} text A field name or value from the template.
 * @return {string} Escaped CSV cell, with a reversible apostrophe prefix when needed.
 */
function encodeCell(text) {
    const safe = SPREADSHEET_PREFIX.test(text) ? "'" + text : text;
    return /[",\r\n]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
}

/**
 * Recover the text from a cell produced by the template's spreadsheet escaping.
 * @param {string} cell Parsed text of the field or unit column.
 * @return {string} Field name or unit text.
 */
function decodeCell(cell) {
    return cell.startsWith("'") && SPREADSHEET_PREFIX.test(cell.slice(1)) ? cell.slice(1) : cell;
}

/**
 * Download one row per numeric field with any display settings already applied.
 * @param {readonly string[]} fields Exact numeric field names in layer order.
 * @param {import("../feature-field-formats.js").FeatureFieldFormats} formats Applied settings.
 * @return {string} UTF-8 spreadsheet CSV with empty settings for unformatted fields.
 */
export function makeFieldFormatTemplate(fields, formats) {
    const rows = fields.map(field => {
        const format = Object.hasOwn(formats, field) ? formats[field] : null;
        return [field, format?.format ?? "", String(format?.decimals ?? ""), format?.unit ?? "", format?.currency ?? ""]
            .map(encodeCell).join(",");
    });
    return `\ufeff${[COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}

/**
 * Read a complete replacement for one layer's field display settings.
 * Blank or omitted rows use default display. An invalid row rejects the file.
 * @param {string} text UTF-8 decoded contents of a field-format CSV.
 * @param {readonly string[]} fields Exact numeric field names for the selected layer.
 * @return {import("../feature-field-formats.js").FeatureFieldFormats} Valid settings by field name.
 * @throws {Error} If the header, a field name, a duplicate row, or a display option is invalid.
 */
export function parseFieldFormatCsv(text, fields) {
    const [header, ...rows] = readCsvRecords(text, {maxBytes: MAX_FIELD_FORMAT_CSV_BYTES});
    const columns = header?.fields.map(name => name.trim().toLowerCase()) ?? [];
    if (columns.length !== COLUMNS.length || new Set(columns).size !== COLUMNS.length ||
        columns.some(name => !COLUMNS.includes(name))) {
        throw new Error(`Use the template columns ${COLUMNS.join(", ")}.`);
    }
    const allowed = new Set(fields);
    const seen = new Set();
    const formats = [];
    for (const row of rows) {
        const cells = csvCells(row, columns);
        const field = decodeCell(cells.field);
        if (!allowed.has(field)) throw new Error(`CSV row ${row.row}: “${field}” is not a numeric field in this layer.`);
        if (seen.has(field)) throw new Error(`CSV row ${row.row}: “${field}” appears more than once.`);
        seen.add(field);
        const format = cells.format.trim().toLowerCase();
        const decimals = cells.decimals.trim();
        const unit = decodeCell(cells.unit).trim();
        const currency = cells.currency.trim().toUpperCase();
        if (!format && !decimals && !unit && !currency) continue;
        try {
            formats.push([field, validateFeatureFieldFormat({
                format: format || (currency ? "currency" : "number"),
                ...(decimals ? {decimals: /^\d+$/.test(decimals) ? Number(decimals) : NaN} : {}),
                ...(unit ? {unit} : {}),
                ...(currency ? {currency} : {}),
            })]);
        } catch (error) {
            throw new Error(`CSV row ${row.row}, “${field}”: ${error.message}`, {cause: error});
        }
    }
    return Object.freeze(Object.fromEntries(formats));
}
