/** Parse category-table CSV values according to a vector field's data type. */
import { readCategoryCsvTable, categoryCsvCells, MAX_CATEGORY_CSV_BYTES } from "../category-csv.js";
import { CATEGORY_MAXIMUM_LIMIT, normalizeVectorCategorical, vectorCategoricalFieldKind } from "./style.js";

export { MAX_CATEGORY_CSV_BYTES };

/**
 * Parse a CSV category value using the selected vector field's catalog data type.
 * Strings retain meaningful whitespace, including empty strings. Integer codes
 * use whole decimal notation; numeric fields allow decimal exponents. Boolean
 * fields use true/false. No JavaScript coercion or type inference is accepted.
 * @param {string} text Literal value cell.
 * @param {"boolean"|"integer"|"number"|"string"} kind Catalog-owned scalar kind.
 * @param {number} row Starting physical line for an actionable error.
 * @return {import("./style.js").VectorCategoryValue} Explicitly typed value.
 * @throws {Error} If text does not use the field's accepted grammar.
 */
function parseVectorCategoryValue(text, kind, row) {
    if (kind === "string") return { kind, value: text };
    const literal = text.trim();
    const pattern = kind === "boolean" ? /^(true|false)$/i : kind === "integer"
        ? /^[+-]?\d+(?:\.0+)?$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    if (!pattern.test(literal)) {
        throw new Error(`CSV row ${row}, column "value": use ${kind === "boolean" ? "true or false" : kind === "integer" ? "a whole decimal integer without an exponent" : "a finite decimal number"} for this attribute.`);
    }
    return { kind, value: kind === "boolean" ? literal.toLowerCase() === "true" : Number(literal) };
}

/**
 * Import a complete vector category table for one selected Catalog field.
 * The shared CSV parser reads the rows, then vector-style validation checks their
 * values, colors and opacity. The caller reads the file and decides when to preview
 * or apply the style. Source attributes are not changed, and invalid rows reject
 * the whole table.
 * @param {string} text UTF-8 decoded CSV contents.
 * @param {{name:string,type:string}} field Selected authoritative attribute.
 * @param {{otherColor:string|null,missingColor:string|null}} fallback Retained fallback appearance.
 * @return {Readonly<import("./style.js").VectorCategoricalStyle>} Frozen complete typed table in file order.
 * @throws {Error|TypeError|RangeError} If syntax, field, values, appearance or limits are invalid.
 */
export function parseCategoricalVectorCsv(text, field, fallback) {
    const kind = vectorCategoricalFieldKind(field.type);
    if (kind === null) throw new TypeError("Choose a supported categorical attribute field before importing.");
    const { columns, data } = readCategoryCsvTable(text, CATEGORY_MAXIMUM_LIMIT);
    const rules = data.map(record => {
        const cells = categoryCsvCells(record, columns);
        const opacityText = cells.opacity?.trim() ?? "";
        if (opacityText !== "" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(opacityText)) {
            throw new Error(`CSV row ${record.row}, column "opacity": use a decimal opacity from 0 to 1; percentages are not accepted.`);
        }
        return { value: parseVectorCategoryValue(cells.value, kind, record.row), label: cells.label.trim(),
            color: cells.color.trim(), opacity: opacityText === "" ? 1 : Number(opacityText) };
    });
    try {
        return normalizeVectorCategorical({ field: field.name, limit: Math.max(1, rules.length), rules, ...fallback });
    } catch (error) {
        const category = /^Category (\d+) (value|label|color|opacity)\b\s*(.*)$/.exec(error.message);
        if (category) {
            throw new Error(`CSV row ${data[Number(category[1]) - 1].row}, column "${category[2]}": ${category[3]}`, { cause: error });
        }
        throw new Error(`CSV table: ${error.message}`, { cause: error });
    }
}
