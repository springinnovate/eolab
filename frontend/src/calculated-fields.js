/** Portable arithmetic definitions shared by saved views and vector selections. */

/** A numeric field evaluated after all preceding definitions in the same view.
 * @typedef {{version:1,name:string,expression:string,numericText:boolean}} CalculatedField
 */

/** Validate and detach ordered field definitions at an external JSON boundary.
 * Syntax, source names and numeric semantics are checked by the calculation owner.
 * @param {unknown} candidate Untrusted definitions from a saved map or API.
 * @return {ReadonlyArray<CalculatedField>} Immutable definitions in evaluation order.
 * @throws {TypeError} If a definition violates the portable representation.
 */
export function validateCalculatedFields(candidate) {
    if (!Array.isArray(candidate) || candidate.length > 64) throw new TypeError("Calculated fields must be a list of at most 64 definitions.");
    const names = new Set();
    return Object.freeze(candidate.map(field => {
        if (!field || Object.keys(field).sort().join() !== "expression,name,numericText,version" || field.version !== 1 ||
            typeof field.name !== "string" || !field.name.trim() || [...field.name].length > 256 || /[\u0000-\u001f]/u.test(field.name) ||
            ["fid", "ogc_fid", "geom", "geometry"].includes(field.name.toLowerCase()) || names.has(field.name) ||
            typeof field.expression !== "string" || !field.expression.length || [...field.expression].length > 4096 || typeof field.numericText !== "boolean") {
            throw new TypeError("A calculated field has an invalid name, expression or format.");
        }
        names.add(field.name);
        return Object.freeze({version: 1, name: field.name, expression: field.expression, numericText: field.numericText});
    }));
}
