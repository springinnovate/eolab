/** Precise scalar formatting for Processing calculation results. */

/** Preserve integer precision; raw decimal text remains inspectable. @param {Object} row Typed result. @return {string} Display value. */
export function calculationValue(row) {
    if (row.value === null) return "—";
    if (row.valueType === "integer") return BigInt(row.value).toLocaleString();
    const value = Number(row.value);
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 10 }) : row.value;
}
