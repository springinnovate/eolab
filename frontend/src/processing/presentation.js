/** Shared Processing job and native-grid presentation. */
/**
 * Summarize an explicit CRS label or root WKT name/authority for display.
 * This reads presentation metadata only; projection remains backend-owned.
 * @param {string} crs Native CRS definition. @return {string} Compact name.
 */
export function describeClipCrs(crs) {
    const name = crs.match(/^(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|COMPD_CS)\["([^"]+)"/);
    if (!name) return crs;
    const authority = crs.match(/(?:AUTHORITY\["EPSG","(\d+)"\]|ID\["EPSG",(\d+)\])\]$/);
    return authority ? `${name[1]} (EPSG:${authority[1] ?? authority[2]})` : name[1];
}

/** Format file sizes without implying compression precision. @param {number} bytes Byte count. @return {string} Human-readable size. */
export function formatDownloadBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const unit = bytes < 1024 ** 2 ? "KiB" : bytes < 1024 ** 3 ? "MiB" : "GiB";
    const divisor = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[unit];
    return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

/** Describe a public plan or run area.
 * @param {Object|null} area Bounds, whole raster or selected polygon area with optional prepared bounds.
 * @return {string} Explicit geographic description for the clip.
 */
export function describeClipArea(area) {
    if (!area) return "No sampling area selected. Choose a box or vector layer.";
    if (area.kind === "wholeRaster") return "Whole raster";
    if (area.kind === "samplingBox") return `Sampling box · ${area.samplingBox.sideLengthKm} × ${area.samplingBox.sideLengthKm} km · center ${area.samplingBox.center.latitude.toFixed(4)}°, ${area.samplingBox.center.longitude.toFixed(4)}°`;
    if (area.kind === "polygonArea") return "Shared layer polygons";
    if (area.kind === "catalogSelection" && !Array.isArray(area.bounds)) return "Selected vector features; geographic bounds appear after preparation.";
    if (area.kind === "polygonGroup" && !Array.isArray(area.bounds)) return "Combined polygon area";
    const values = area.selectedBounds
        ? [area.selectedBounds.west, area.selectedBounds.south, area.selectedBounds.east, area.selectedBounds.north]
        : area.bounds;
    const label = area.kind === "polygons" ? "Shared layer polygons" : area.kind === "catalogSelection" ? "Selected vector features" :
        area.kind === "polygonGroup" ? "Combined polygon area" : "Box";
    return `${label} · W ${values[0].toFixed(4)}°, S ${values[1].toFixed(4)}°, E ${values[2].toFixed(4)}°, N ${values[3].toFixed(4)}°`;
}

/** Describe a model job's lifecycle or server-supplied stage and measured work.
 * Stages without a description use a generic running label. Counts describe
 * the current stage, never an estimated percentage of the whole run.
 * @param {{status:string,expiresAt?:string|null,progress:{description?:string|null,completed?:number|null,total?:number|null,unit?:string|null}}} job Validated model run status.
 * @return {string} Lifecycle label or stage description with measured work when available.
 */
export function describeModelProgress(job) {
    const status = job.status === "ready" && Date.parse(job.expiresAt) <= Date.now() ? "expired" : job.status;
    if (status !== "running") return ({queued: "Queued", cancelling: "Cancelling…", ready: "Ready", failed: "Failed",
        cancelled: "Cancelled", interrupted: "Interrupted", expired: "Results expired", deleted: "Deleted"})[status] ?? status;
    const description = job.progress.description ?? "Running tool";
    return job.progress.total > 0 ? `${description} · ${job.progress.completed ?? 0} of ${job.progress.total} ${job.progress.unit ?? "units"}` : `${description}…`;
}

/** Format a time interval outward in a unit that matches its uncertainty.
 * @param {number} lowerSeconds Earliest time in the estimated range.
 * @param {number} upperSeconds Latest time in the estimated range.
 * @returns {string} Approximate range in seconds, minutes, or hours.
 */
function durationRange(lowerSeconds, upperSeconds) {
    const unit = lowerSeconds >= 3600 ? 3600 : lowerSeconds >= 60 ? 60 : 1;
    const lo = Math.floor(lowerSeconds / unit), hi = Math.ceil(upperSeconds / unit);
    const name = unit === 3600 ? "hour" : unit === 60 ? "minute" : "second";
    return `${lo === hi ? lo : `${lo}–${hi}`} ${name}${hi === 1 ? "" : "s"}`;
}

/** Describe queue or calculation time and the forecast through verified results.
 * @param {Object} job Owned status snapshot with an optional completion range.
 * @param {number} now Browser clock in epoch milliseconds.
 * @returns {string} Elapsed time and a whole-run estimate, or empty for other jobs.
 */
export function describeCompletionEstimate(job, now) {
    const estimate = job.completionEstimate;
    if (!estimate || !["queued", "running"].includes(job.status)) return "";
    const queued = job.status === "queued";
    const since = queued ? job.createdAt : job.progress.stages?.[0]?.startedAt;
    const elapsed = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
    const duration = elapsed >= 60 ? `${Math.floor(elapsed / 60)} min ${elapsed % 60} sec` : `${elapsed} sec`;
    const observed = Number.isFinite(elapsed) ? `${queued ? "In queue" : "Elapsed"} ${duration}. ` : "";
    if (estimate.lowerSeconds === null) return observed + (queued
        ? "Estimating run time after it starts…" : "Estimating time until results are ready…");
    const range = durationRange(estimate.lowerSeconds, estimate.upperSeconds);
    if (estimate.lowerSeconds === 0) {
        const maximum = durationRange(estimate.upperSeconds, estimate.upperSeconds);
        return observed + (queued ? `Once started, results are expected within ${maximum}.`
            : `Results are expected within ${maximum}.`);
    }
    return observed + (queued ? `Once started, about ${range} until results are ready.`
        : `About ${range} until results are ready.`);
}

/** Describe a job's lifecycle and measured progress using its operation's response format.
 * @param {Object} job Validated Processing job snapshot, including its operation and progress.
 * @return {string} User-facing status or stage with measured work, without invented percentages.
 */
export function describeJobProgress(job) {
    if (job.operation === "model.run.v1") return describeModelProgress(job);
    if (job.status !== "running") return ({ queued: "Queued", cancelling: "Cancelling…", ready: "Ready",
        failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted — submit a new job to retry",
        expired: "Expired — run again to download", deleted: "Deleted" })[job.status] ?? job.status;
    const progress = job.progress;
    if (progress.phase === "preparing") return job.operation === "raster.clip.v1" ? "Preparing clip…" : "Preparing calculation…";
    if (progress.phase === "calculating" && job.operation === "raster.clip.v1") return "Starting clip…";
    if (progress.phase === "calculating") return `Calculating · ${progress.completedBlocks ?? 0} of ${progress.totalBlocks ?? "?"} native source blocks`;
    if (progress.phase === "preparing_selected_polygons") return "Reading and projecting selected polygons…";
    if (progress.phase === "preparing_polygon_mask") return "Creating the polygon mask…";
    if (progress.phase === "writing_results") return "Writing results…";
    if (progress.phase === "clipping") return `Clipping · ${progress.completedBlocks ?? 0} of ${progress.totalBlocks ?? "?"} source blocks`;
    return ({ creating_cog: "Preparing download · creating COG", validating: "Preparing download · validating file",
        checksumming: "Preparing download · verifying checksum" })[progress.phase] ?? "Starting…";
}

