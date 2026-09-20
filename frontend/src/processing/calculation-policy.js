/** Shared automatic-calculation policy; each consumer decides when to ask for confirmation. */
export const AUTOMATIC_CALCULATION_LIMITS = Object.freeze({ nativeBlocks: 128, decodedBytes: 64 * 1024 * 1024, geometryCells: 25000 });

/** Decide whether an edit or map click may run without another Calculate click.
 * Cached values can be reused for any area without confirming raster work.
 * Uncached requests qualify only for rectangular map selections within the
 * block, memory and geometry limits below.
 * This UI policy does not replace the server's resource limits.
 * @param {Object} plan Server plan with estimated grid work.
 * @param {Object} intent Calculation settings including the sampling area.
 * @return {boolean} Whether automatic submission is allowed.
 */
export function canAutomaticallyCalculate(plan, intent) {
    if (plan?.cacheHit === true) return true;
    const grid = plan?.grid;
    return intent.area.kind === "selectedArea" && !!grid &&
        Number.isFinite(grid.nativeBlocks) && grid.nativeBlocks <= AUTOMATIC_CALCULATION_LIMITS.nativeBlocks &&
        Number.isFinite(grid.decodedBytes) && grid.decodedBytes <= AUTOMATIC_CALCULATION_LIMITS.decodedBytes &&
        (!grid.groundArea || (Number.isFinite(grid.groundArea.estimatedGeometryCells) &&
            grid.groundArea.estimatedGeometryCells <= AUTOMATIC_CALCULATION_LIMITS.geometryCells));
}
