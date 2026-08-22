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

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HISTOGRAM_CHART_WIDTH = 640;
const HISTOGRAM_CHART_HEIGHT = 112;
const HISTOGRAM_PLOT_HEIGHT = 100;
const HISTOGRAM_TOOLTIP_WIDTH = 300;
const HISTOGRAM_TOOLTIP_HEIGHT = 24;
const HISTOGRAM_TOOLTIP_MARGIN = 4;

/**
 * Build the immediate in-chart presentation for one histogram bin.
 *
 * @param {Document} documentContext DOM document used to create SVG nodes.
 * @return {{element: SVGGElement, text: SVGTextElement}} Tooltip elements.
 */
function createHistogramTooltip(documentContext) {
    const tooltip = documentContext.createElementNS(SVG_NAMESPACE, "g");
    tooltip.classList.add("raster-histogram-tooltip");
    tooltip.setAttribute("hidden", "");
    tooltip.setAttribute("aria-hidden", "true");
    const background = documentContext.createElementNS(
        SVG_NAMESPACE,
        "rect"
    );
    background.setAttribute("width", String(HISTOGRAM_TOOLTIP_WIDTH));
    background.setAttribute("height", String(HISTOGRAM_TOOLTIP_HEIGHT));
    background.setAttribute("rx", "3");
    const text = documentContext.createElementNS(SVG_NAMESPACE, "text");
    text.setAttribute("x", "8");
    text.setAttribute("y", "16");
    tooltip.append(background, text);
    return { element: tooltip, text };
}

/**
 * Format one bin's compact hover readout.
 *
 * @param {number} minimum Inclusive lower bin edge.
 * @param {number} maximum Exclusive upper bin edge.
 * @param {number} count Valid sampled pixels in the bin.
 * @param {number} samplePercent Percentage of the valid sample in the bin.
 * @return {string} Immediate tooltip text.
 */
function formatHistogramBinTooltip(
    minimum,
    maximum,
    count,
    samplePercent
) {
    return `${formatRasterPixelValue(minimum)}–${
        formatRasterPixelValue(maximum)
    } · ${count.toLocaleString()} pixels · ${samplePercent.toFixed(2)}%`;
}

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
    const { counts, edges } = statistics.histogram;
    const maximumCount = Math.max(...counts);
    const barWidth = HISTOGRAM_CHART_WIDTH / counts.length;
    const bars = [];
    const title = documentContext.createElementNS(SVG_NAMESPACE, "title");
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
        const barHeight = count / maximumCount * HISTOGRAM_PLOT_HEIGHT;
        const bar = documentContext.createElementNS(SVG_NAMESPACE, "rect");
        bar.classList.add("raster-histogram-bar");
        bar.setAttribute("x", String(binIndex * barWidth));
        bar.setAttribute(
            "y",
            String(HISTOGRAM_CHART_HEIGHT - barHeight)
        );
        bar.setAttribute("width", String(barWidth - 1));
        bar.setAttribute("height", String(barHeight));
        const binMidpoint = (edges[binIndex] + edges[binIndex + 1]) / 2;
        bar.style.fill = getRasterStyleColor(style, binMidpoint);
        const samplePercent = count / statistics.validSampleCount * 100;
        const binDescription =
            `Bin midpoint ${formatRasterPixelValue(binMidpoint)}; ` +
            `${samplePercent.toFixed(2)}% of the valid sample ` +
            `(${count.toLocaleString()} pixels). Value range ` +
            `${formatRasterPixelValue(edges[binIndex])} to ` +
            `${formatRasterPixelValue(edges[binIndex + 1])}.`;
        bar.setAttribute("aria-label", binDescription);
        chart.append(bar);
        bars.push(bar);
    }
    const tooltip = createHistogramTooltip(documentContext);
    let activeBar = null;
    for (const [binIndex, bar] of bars.entries()) {
        const count = counts[binIndex];
        const samplePercent = count / statistics.validSampleCount * 100;
        const preferredTooltipX =
            binIndex * barWidth + barWidth / 2 -
            HISTOGRAM_TOOLTIP_WIDTH / 2;
        const tooltipX = Math.max(
            HISTOGRAM_TOOLTIP_MARGIN,
            Math.min(
                preferredTooltipX,
                HISTOGRAM_CHART_WIDTH - HISTOGRAM_TOOLTIP_WIDTH -
                HISTOGRAM_TOOLTIP_MARGIN
            )
        );
        bar.addEventListener("pointerenter", () => {
            activeBar?.classList.remove("is-hovered");
            activeBar = bar;
            activeBar.classList.add("is-hovered");
            tooltip.text.textContent = formatHistogramBinTooltip(
                edges[binIndex],
                edges[binIndex + 1],
                count,
                samplePercent
            );
            tooltip.element.setAttribute(
                "transform",
                `translate(${tooltipX} ${HISTOGRAM_TOOLTIP_MARGIN})`
            );
            tooltip.element.removeAttribute("hidden");
        });
        bar.addEventListener("pointerleave", () => {
            if (activeBar !== bar) {
                return;
            }
            activeBar.classList.remove("is-hovered");
            activeBar = null;
            tooltip.element.setAttribute("hidden", "");
        });
    }
    chart.append(tooltip.element);
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
