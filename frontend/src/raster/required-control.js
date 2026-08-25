/**
 * Resolve one required raster-control element from the application document.
 *
 * The focused raster DOM adapters share this strict startup contract: missing
 * static markup is an application error rather than an optional control.
 *
 * @param {Document} documentContext Document that owns the raster controls.
 * @param {string} selector CSS selector for the required element.
 * @return {Element} The matching raster-control element.
 * @throws {Error} If the application document violates the control contract.
 */
export function requireRasterControl(documentContext, selector) {
    const element = documentContext.querySelector(selector);
    if (element === null) {
        throw new Error(`Required raster control is missing: ${selector}`);
    }
    return element;
}
