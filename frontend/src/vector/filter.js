/** Portable vector rule validation and readable applied-filter summaries. */

export const MAX_VECTOR_FILTER_RULES = 12;
export const EMPTY_VECTOR_FILTER = Object.freeze({ enabled: true, match: "all", rules: Object.freeze([]) });
const OPERATORS = Object.freeze({
    eq: "equals", ne: "does not equal", gt: ">", ge: "≥", lt: "<", le: "≤",
    contains: "contains", missing: "is missing", present: "is not missing",
});

/**
 * Describe supported comparisons for one authoritative Catalog field.
 * @param {string} type Catalog Table field type.
 * @return {string|null} Scalar kind, or null for missing checks only.
 */
export function vectorFilterFieldKind(type = "") {
    const base = type.toLowerCase().split(":")[0];
    if (["int", "int16", "int32", "int64", "float", "float32", "float64", "real"].includes(base)) return "number";
    if (["str", "string"].includes(base)) return "string";
    if (["bool", "boolean"].includes(base)) return "boolean";
    return base === "date" ? "date" : null;
}

/**
 * Return operators available for a field, including explicit null checks.
 * @param {string} type Catalog field type.
 * @return {Array<{value:string,label:string}>} Ordered operator choices.
 */
export function vectorFilterOperators(type) {
    const kind = vectorFilterFieldKind(type);
    const values = kind === "number" || kind === "date" ? ["eq", "ne", "gt", "ge", "lt", "le"] :
        kind === "string" ? ["eq", "ne", "contains"] : kind === "boolean" ? ["eq", "ne"] : [];
    return [...values, "missing", "present"].map((value) => ({ value, label: OPERATORS[value] }));
}

/**
 * Validate an untrusted saved state or complete editor draft.
 * @param {unknown} candidate Candidate rule builder state.
 * @param {Array<{name:string,type:string}>} fields Current Catalog attributes.
 * @return {Object} Canonical portable rules with strictly typed values.
 * @throws {TypeError} If a field, operator, or scalar is incompatible.
 */
export function normalizeVectorFilter(candidate, fields) {
    if (!candidate || Object.keys(candidate).sort().join(",") !== "enabled,match,rules" ||
        typeof candidate.enabled !== "boolean" || !["all", "any"].includes(candidate.match) ||
        !Array.isArray(candidate.rules) || candidate.rules.length > MAX_VECTOR_FILTER_RULES) {
        throw new TypeError("Use Match all or Match any with at most 12 conditions.");
    }
    const rules = candidate.rules.map((rule, index) => {
        const field = fields.find(({ name }) => name === rule?.field);
        if (!field || Object.keys(rule).sort().join(",") !== "field,operator,value" ||
            !vectorFilterOperators(field.type).some(({ value }) => value === rule.operator)) {
            throw new TypeError(`Condition ${index + 1}: choose a field and comparison.`);
        }
        const value = rule.value;
        const kind = vectorFilterFieldKind(field.type);
        let valid = ["missing", "present"].includes(rule.operator) ? value === null :
            kind === "number" ? typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER :
            kind === "boolean" ? typeof value === "boolean" :
            typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f]/u.test(value);
        if (valid && kind === "date" && value !== null) {
            const parsed = Date.parse(`${value}T00:00:00Z`);
            valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed) &&
                new Date(parsed).toISOString().slice(0, 10) === value;
        }
        if (!valid) throw new TypeError(`Condition ${index + 1}: enter a valid ${kind ?? "missing"} value.`);
        return { field: rule.field, operator: rule.operator, value };
    });
    return { enabled: candidate.enabled, match: candidate.match, rules };
}

/**
 * Describe the currently applied rules without interpreting user expressions.
 * @param {Object} filter Validated state.
 * @return {string} Readable rule summary.
 */
export function vectorFilterSummary(filter) {
    if (!filter.rules.length) return "No conditions. All features are included.";
    const rules = filter.rules.map(({ field, operator, value }) =>
        `${field} ${OPERATORS[operator]}${value === null ? "" : ` ${JSON.stringify(value)}`}`);
    return `${filter.enabled ? "" : "Disabled: "}${rules.join(filter.match === "all" ? " AND " : " OR ")}`;
}

/**
 * Describe whole-layer counts without implying viewport or sampled totals.
 * @param {Object} state Vector-owned retained state.
 * @return {string} Compact applied-filter status, or empty for no conditions.
 */
export function vectorFilterStatus(state) {
    const filter = state.filter ?? EMPTY_VECTOR_FILTER;
    if (!filter.rules.length) return "";
    if (!filter.enabled) return "Filter disabled";
    const count = state.filterCount;
    if (count?.complete) return `${count.matched.toLocaleString()} of ${count.total.toLocaleString()} features match`;
    return state.filterCounting ? "Filter active · Counting…" : "Filter active · Count unavailable";
}
