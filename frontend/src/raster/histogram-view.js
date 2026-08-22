/**
 * SVG presentation adapter for raster histograms.
 *
 * This module renders and clears the fixed-bin histogram from already
 * validated statistics and a committed raster style. Statistics loading,
 * percentile decisions, and broader controls visibility remain outside it.
 */
import {
    formatRasterPixelValue
} from "./pixel-probe.js";
import { getRasterStyleColor } from "./style.js";

/**
 * Render the validated fixed-bin distribution into its SVG chart.
 *
 * SVG elements do not implement HTMLElement.hidden, so visibility is changed
 * through the actual attribute that the stylesheet consumes.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @param {Object} statistics Validated raster statistics.
 * @param {Object} style Committed raster color-map style.
 * @param {Document} [documentContext=globalThis.document] DOM document;
 * injectable for tests.
 * @return {void}
 */
export function renderRasterHistogramChart(
    chart,
    statistics,
    style,
    documentContext = globalThis.document
) {
    const svgNamespace = "http://www.w3.org/2000/svg";
    const chartWidth = 640;
    const chartHeight = 112;
    const plotHeight = 100;
    const { counts, edges } = statistics.histogram;
    const maximumCount = Math.max(...counts);
    const barWidth = chartWidth / counts.length;
    const title = documentContext.createElementNS(svgNamespace, "title");
    title.textContent =
        `Approximate band 1 histogram with ${counts.length} bins from ` +
        `${statistics.validSampleCount.toLocaleString()} valid sampled ` +
        `pixels. Values range from ${formatRasterPixelValue(
            statistics.sampleMinimum
        )} to ${formatRasterPixelValue(statistics.sampleMaximum)}; ` +
        `the 5th, 50th, and 95th percentiles are ${formatRasterPixelValue(
            statistics.percentiles.p05
        )}, ${formatRasterPixelValue(statistics.percentiles.p50)}, and ` +
        `${formatRasterPixelValue(statistics.percentiles.p95)}.`;
    chart.replaceChildren(title);
    for (const [binIndex, count] of counts.entries()) {
        const barHeight = count / maximumCount * plotHeight;
        const bar = documentContext.createElementNS(svgNamespace, "rect");
        bar.classList.add("raster-histogram-bar");
        bar.setAttribute("x", String(binIndex * barWidth));
        bar.setAttribute("y", String(chartHeight - barHeight));
        bar.setAttribute("width", String(barWidth - 1));
        bar.setAttribute("height", String(barHeight));
        const binMidpoint = (edges[binIndex] + edges[binIndex + 1]) / 2;
        bar.style.fill = getRasterStyleColor(style, binMidpoint);
        const binTitle = documentContext.createElementNS(
            svgNamespace,
            "title"
        );
        const samplePercent = count / statistics.validSampleCount * 100;
        binTitle.textContent =
            `Bin midpoint ${formatRasterPixelValue(binMidpoint)}; ` +
            `${samplePercent.toFixed(2)}% of the valid sample ` +
            `(${count.toLocaleString()} pixels). Value range ` +
            `${formatRasterPixelValue(edges[binIndex])} to ` +
            `${formatRasterPixelValue(edges[binIndex + 1])}.`;
        bar.append(binTitle);
        chart.append(bar);
    }
    chart.setAttribute("aria-label", title.textContent);
    chart.removeAttribute("hidden");
}

/**
 * Remove a histogram and hide its SVG through the SVG attribute contract.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @return {void}
 */
export function clearRasterHistogramChart(chart) {
    chart.replaceChildren();
    chart.setAttribute("hidden", "");
}
