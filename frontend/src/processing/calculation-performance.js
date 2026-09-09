/** Presentation of reviewed native execution sizes and durable wall-time metrics. */
import { formatDownloadBytes } from "./presentation.js";

/** Describe the effective execution plan. @param {Object} grid Reviewed grid. @return {string[]} Lines. */
export function executionDescription(grid) {
    const p = grid?.execution;
    if (!p) return [];
    return [
        `Target: ${p.targetChunkPixels == null ? "current behavior" : `${p.targetChunkPixels.toLocaleString()} pixels per batch`}.`,
        `Up to ${p.readWidth.toLocaleString()} × ${p.readHeight.toLocaleString()} pixels per read; ${p.evaluationWidth.toLocaleString()} × ${p.evaluationHeight.toLocaleString()} per calculation tile. Edge tiles may be smaller.`,
        `${grid.nativeBlocks.toLocaleString()} native blocks in ${p.readWindows.toLocaleString()} reads; ${formatDownloadBytes(grid.estimatedMemoryBytes)} estimated working memory.`,
        ...(grid.groundArea?.strategy === "cell_polygons" ? ["This grid requires individual pixel geometry, so calculation tiles stay small."] : []),
    ];
}

/** Describe final timings with precise measurement boundaries.
 * @param {Object} job Completed job.
 * @param {number|undefined} totalWaitSeconds Browser request through result DOM update, if observed.
 * @return {string[]} Lines.
 */
export function performanceDescription(job, totalWaitSeconds) {
    const p = job.result?.performance;
    const lines = [...(Number.isFinite(totalWaitSeconds) && totalWaitSeconds >= 0
        ? [`Total wait → result displayed: ${totalWaitSeconds.toFixed(3)} s.`,
            "Measured in this tab from the calculation request through the result UI update, including debounce, planning, queueing and polling; excludes earlier confirmation time and the browser's subsequent paint."]
        : ["Total wait unavailable for this result. Request-to-display timing is recorded only for statistic cards completed in this tab, without a page reload."]),
    ...executionDescription(job.grid)];
    if (!p) return [...lines, "Timing measurements are unavailable for this saved result."];
    const seconds = n => `${n.toFixed(3)} s`;
    return [...lines,
        `Kernel elapsed: ${seconds(p.kernelSeconds)}. Read/decode and source mask: ${seconds(p.readSeconds)}. Calculation: ${seconds(p.calculationSeconds)}. Write CSV and checksum: ${seconds(p.resultWriteSeconds)}.`,
        `${p.readWindows.toLocaleString()} reads; ${p.evaluationTiles.toLocaleString()} calculation tiles; ${p.reducerUpdates.toLocaleString()} statistic updates.`,
        "Wall times include waiting within each operation. Calculation includes tile preparation, selection masks, area weights and reductions. Kernel elapsed also includes source opening and geometry setup; it ends after the CSV checksum. Queueing, worker startup, provenance writing, publication and browser latency are excluded.",
    ];
}
