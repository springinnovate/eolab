/** Bounded CSV upload parsing for a raster layer's category table. */
import {
    DEFAULT_UNMAPPED_RASTER_APPEARANCE,
    MAX_CATEGORICAL_RASTER_CATEGORIES,
    normalizeCategoricalRasterStyle,
} from "./categorical-style.js";

import { readCategoryCsvTable, categoryCsvCells, MAX_CATEGORY_CSV_BYTES } from "../category-csv.js";

/** Maximum UTF-8 input size, retained for the raster upload boundary. */
export const MAX_CATEGORICAL_RASTER_CSV_BYTES = MAX_CATEGORY_CSV_BYTES;

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
    const { columns, data } = readCategoryCsvTable(text, MAX_CATEGORICAL_RASTER_CATEGORIES);
    const categories = data.map((record) => {
        const row = Object.fromEntries(Object.entries(categoryCsvCells(record, columns)).map(([column, cell]) => [column, cell.trim()]));
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
