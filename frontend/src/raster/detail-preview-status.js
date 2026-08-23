/** Pure status formatting for bounded raster detail preview dimensions. */

/**
 * Format the sampled-grid dimensions and automatic-refinement state.
 *
 * @param {Object|null} previewState Current sampled-raster session state, or
 * null when no detail-only preview is displayed.
 * @return {string} User-facing base/detail dimensions and lifecycle status.
 */
export function formatRasterDetailPreviewResolution(previewState) {
    if (previewState === null) {
        return "Base sample grid: —; current-view detail: —";
    }
    const base = previewState.basePreview.actual;
    if (previewState.mode === "representativePatch") {
        return `Representative patch: ${base.sampleGridWidth} × ` +
            `${base.sampleGridHeight}; automatic current-view refinement: off`;
    }
    let detail = "—";
    if (previewState.detailStatus === "loading") {
        detail = "loading…";
    } else if (previewState.detailStatus === "error") {
        detail = previewState.detailPreview === null
            ? "update failed"
            : `${previewState.detailPreview.actual.sampleGridWidth} × ` +
                `${previewState.detailPreview.actual.sampleGridHeight} ` +
                "(retained; update failed)";
    } else if (previewState.detailPreview !== null) {
        const actual = previewState.detailPreview.actual;
        detail = `${actual.sampleGridWidth} × ${actual.sampleGridHeight}`;
    }
    return `Base sample grid: ${base.sampleGridWidth} × ` +
        `${base.sampleGridHeight}; current-view detail: ${detail}`;
}
