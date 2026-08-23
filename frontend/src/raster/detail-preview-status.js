/** Pure Catalog-inspector formatting for adaptive bounded raster detail. */

/**
 * Format a nonnegative decoded-byte count for compact inspector provenance.
 *
 * @param {number} bytes Validated integer byte count.
 * @return {string} Human-readable binary byte quantity.
 */
function formatDecodedBytes(bytes) {
    if (bytes >= 1024 ** 3) {
        return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
    }
    if (bytes >= 1024 ** 2) {
        return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${bytes} B`;
}

/**
 * Format one canonical WGS 84 image rectangle without footprint implications.
 *
 * @param {number[]} bounds Validated west, south, east, north image bounds.
 * @return {string} Compact raster/view rectangle.
 */
function formatBounds(bounds) {
    return `W ${bounds[0].toFixed(4)}, S ${bounds[1].toFixed(4)}, ` +
        `E ${bounds[2].toFixed(4)}, N ${bounds[3].toFixed(4)}`;
}

/**
 * Describe one validated preview's representation, location, and source work.
 *
 * @param {Object} preview Validated adaptive detail-preview response.
 * @return {string} Catalog-inspector provenance for the displayed image.
 */
function formatPreview(preview) {
    const actual = preview.actual;
    const work = `${actual.sourceBlockReadCount.toLocaleString("en-US")} ` +
        `native blocks / ${formatDecodedBytes(actual.decodedSourceBytes)}`;
    const location = formatBounds(preview.imageBounds);
    if (preview.rendering === "exactSourceWindow") {
        const window = actual.sourceWindow;
        const lastColumn = window.columnOffset + window.width - 1;
        const lastRow = window.rowOffset + window.height - 1;
        return `exact bounded detail ${preview.imageWidth} × ` +
            `${preview.imageHeight}; source columns ${window.columnOffset}–` +
            `${lastColumn}, rows ${window.rowOffset}–${lastRow}; ${location}; ` +
            work;
    }
    if (preview.rendering === "representativePatch") {
        const window = actual.sourceWindow;
        return `representative patch ${preview.imageWidth} × ` +
            `${preview.imageHeight}; source window at column ` +
            `${window.columnOffset}, row ${window.rowOffset}; ${location}; ${work}`;
    }
    const policy = preview.mode === "centerSample"
        ? "center samples"
        : "representative samples";
    return `sampled proxy ${preview.imageWidth} × ${preview.imageHeight} ` +
        `${policy}; ${location}; ${work}`;
}

/**
 * Format base and active current-view provenance for the Catalog inspector.
 *
 * @param {Object|null} previewState Current adaptive-raster session state, or
 * null when no detail-only raster is displayed.
 * @param {"idle"|"loading"|"error"} [baseStatus="idle"] Lifecycle of an
 * initial base request when no preview state exists yet.
 * @return {string} User-facing representation, location, work, and lifecycle.
 */
export function formatRasterDetailPreviewResolution(
    previewState,
    baseStatus = "idle"
) {
    if (previewState === null) {
        if (baseStatus === "loading") {
            return "Base raster detail: loading…; active view: —";
        }
        if (baseStatus === "error") {
            return "Base raster detail: request failed; active view: —";
        }
        return "Base raster detail: —; active view: —";
    }
    const base = `Base: ${formatPreview(previewState.basePreview)}`;
    if (previewState.mode === "representativePatch") {
        return `${base}; automatic current-view refinement: off`;
    }
    let detail = "zoom in to request a bounded current view";
    if (previewState.detailStatus === "loading") {
        detail = previewState.detailPreview === null
            ? "updating…"
            : `${formatPreview(previewState.detailPreview)} (retained; updating…)`;
    } else if (previewState.detailStatus === "error") {
        detail = previewState.detailPreview === null
            ? "update failed"
            : `${formatPreview(previewState.detailPreview)} ` +
                "(retained; update failed)";
    } else if (previewState.detailPreview !== null) {
        detail = formatPreview(previewState.detailPreview);
    }
    return `${base}; Active view: ${detail}`;
}
