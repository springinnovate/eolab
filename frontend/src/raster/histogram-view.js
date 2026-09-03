/**
 * SVG presentation adapter for raster histograms.
 *
 * This module renders and clears the fixed-bin histogram from already
 * validated statistics and a committed raster style. Statistics loading,
 * percentile decisions, and broader controls visibility remain outside it.
 */
import {
    formatRasterPixelValue
} from "./value-format.js";
import { getRasterStyleColor } from "./style.js";
import { drawHistogramAxes, formatHistogramTick, histogramScales } from "./histogram-axes.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HISTOGRAM_CHART_WIDTH = 640;
const HISTOGRAM_CHART_HEIGHT = 190;
const HISTOGRAM_PLOT_HEIGHT = 116;
const HISTOGRAM_TOOLTIP_HEIGHT = 42;
const HISTOGRAM_TOOLTIP_MARGIN = 4;
const chartObservers = new WeakMap();

/**
 * Build the immediate in-chart presentation for one histogram bin.
 *
 * @param {Document} documentContext DOM document used to create SVG nodes.
 * @param {number} width Tooltip width fitted inside its chart.
 * @return {{element: SVGGElement, text: SVGTextElement, counts: SVGTextElement}} Tooltip elements.
 */
function createHistogramTooltip(documentContext, width) {
    const tooltip = documentContext.createElementNS(SVG_NAMESPACE, "g");
    tooltip.classList.add("raster-histogram-tooltip");
    tooltip.setAttribute("hidden", "");
    tooltip.setAttribute("aria-hidden", "true");
    const background = documentContext.createElementNS(
        SVG_NAMESPACE,
        "rect"
    );
    background.setAttribute("width", String(width));
    background.setAttribute("height", String(HISTOGRAM_TOOLTIP_HEIGHT));
    background.setAttribute("rx", "3");
    const text = documentContext.createElementNS(SVG_NAMESPACE, "text");
    text.setAttribute("x", "8");
    text.setAttribute("y", "16");
    const counts = documentContext.createElementNS(SVG_NAMESPACE, "text");
    counts.setAttribute("x", "8");
    counts.setAttribute("y", "32");
    tooltip.append(background, text, counts);
    return { element: tooltip, text, counts };
}

/**
 * Format one bin's compact hover readout.
 *
 * @param {number} minimum Inclusive lower bin edge.
 * @param {number} maximum Exclusive upper bin edge.
 * @param {number} offset Shared x-axis offset for tightly spaced large values.
 * @return {string} Immediate tooltip text.
 */
function formatHistogramBinTooltip(
    minimum,
    maximum,
    offset
) {
    const precision = (maximum - minimum) / 100;
    return `${formatHistogramTick(minimum - offset, precision)}–${
        formatHistogramTick(maximum - offset, precision)
    }${offset === 0 ? "" : " + axis offset"}`;
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
 * @param {Document} documentContext DOM document; injectable for tests.
 * @param {number} width Current chart content width in CSS pixels.
 * @param {string} valueLabel X-axis name including known units.
 * @return {void}
 */
function drawRasterHistogramChart(
    chart,
    statistics,
    style,
    documentContext,
    width,
    valueLabel
) {
    const { counts, edges } = statistics.histogram;
    const plot = { left: 48, top: 28, width: width - 60, height: HISTOGRAM_PLOT_HEIGHT, bottom: 28 + HISTOGRAM_PLOT_HEIGHT };
    const scales = histogramScales(statistics, plot.width);
    const tooltipWidth = Math.min(360, width - 2 * HISTOGRAM_TOOLTIP_MARGIN);
    chart.setAttribute("viewBox", `0 0 ${width} ${HISTOGRAM_CHART_HEIGHT}`);
    chart.setAttribute("preserveAspectRatio", "none");
    chart.setAttribute("role", "img");
    const bars = [];
    const title = documentContext.createElementNS(SVG_NAMESPACE, "title");
    const provenance = statistics.estimated
        ? "Approximate sampled"
        : "Exact bounded";
    title.textContent =
        `${provenance} band 1 histogram with ${counts.length} bins from ` +
        `${statistics.validSampleCount.toLocaleString()} valid values. ` +
        `Values range from ${formatRasterPixelValue(
            statistics.sampleMinimum
        )} to ${formatRasterPixelValue(statistics.sampleMaximum)}; ` +
        `the 5th, 50th, and 95th percentiles are ${formatRasterPixelValue(
            statistics.percentiles.p05
        )}, ${formatRasterPixelValue(statistics.percentiles.p50)}, and ` +
        `${formatRasterPixelValue(statistics.percentiles.p95)}. ` +
        `Horizontal axis: ${valueLabel}${scales.offset === 0 ? "" : `, tick offset ${scales.offset}`}. ` +
        `Vertical axis: percentage of valid sampled pixels, from 0 to ${scales.maximumPercent}%.`;
    chart.replaceChildren(title);
    drawHistogramAxes(chart, plot, scales, valueLabel, documentContext);
    for (const [binIndex, count] of counts.entries()) {
        const samplePercent = count / statistics.validSampleCount * 100;
        const barHeight = samplePercent / scales.maximumPercent * plot.height;
        const x = plot.left + (edges[binIndex] - scales.minimum) / scales.span * plot.width;
        const barWidth = (edges[binIndex + 1] - edges[binIndex]) / scales.span * plot.width;
        const bar = documentContext.createElementNS(SVG_NAMESPACE, "rect");
        bar.classList.add("raster-histogram-bar");
        bar.setAttribute("x", String(x));
        bar.setAttribute(
            "y",
            String(plot.bottom - barHeight)
        );
        bar.setAttribute("width", String(barWidth * 0.9));
        bar.setAttribute("height", String(barHeight));
        const binMidpoint = (edges[binIndex] + edges[binIndex + 1]) / 2;
        bar.style.fill = getRasterStyleColor(style, binMidpoint);
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
    const tooltip = createHistogramTooltip(documentContext, tooltipWidth);
    let activeBar = null;
    for (const [binIndex, bar] of bars.entries()) {
        const count = counts[binIndex];
        const samplePercent = count / statistics.validSampleCount * 100;
        const preferredTooltipX =
            plot.left + ((edges[binIndex] + edges[binIndex + 1]) / 2 - scales.minimum) / scales.span * plot.width -
            tooltipWidth / 2;
        const tooltipX = Math.max(
            HISTOGRAM_TOOLTIP_MARGIN,
            Math.min(
                preferredTooltipX,
                width - tooltipWidth -
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
                scales.offset
            );
            tooltip.counts.textContent = `${count.toLocaleString()} pixels · ${samplePercent.toFixed(2)}% of sample`;
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
 * Render a self-contained responsive chart, including axes and coordinates.
 * Resize observation keeps fonts/margins in CSS pixels rather than shrinking
 * labels along with the bars. Re-render/clear disconnects the previous owner.
 * @param {SVGSVGElement} chart Histogram SVG (static or dynamically created).
 * @param {Object} statistics Validated current statistics, with nonempty bins.
 * @param {Object} style Committed raster color-map style.
 * @param {Document} [documentContext=globalThis.document] Owning DOM document.
 * @param {string} [valueLabel="Raster value"] X-axis label with known units.
 * @return {void}
 */
export function renderRasterHistogramChart(chart, statistics, style, documentContext = globalThis.document, valueLabel = "Raster value") {
    clearRasterHistogramChart(chart);
    let width = Math.max(180, chart.clientWidth || HISTOGRAM_CHART_WIDTH);
    drawRasterHistogramChart(chart, statistics, style, documentContext, width, valueLabel);
    const Observer = documentContext.defaultView?.ResizeObserver;
    if (!Observer) return;
    /** Refit live coordinates; never redraw a replaced or cleared chart. */
    const observer = new Observer(entries => {
        if (chartObservers.get(chart) !== observer) return;
        const nextWidth = entries[0]?.contentRect.width;
        // Ignore hidden/detached charts; they redraw when visible again.
        if (!(nextWidth > 0) || Math.abs(nextWidth - width) < 0.5) return;
        width = Math.max(180, nextWidth);
        drawRasterHistogramChart(chart, statistics, style, documentContext, width, valueLabel);
    });
    chartObservers.set(chart, observer);
    observer.observe(chart);
}

/**
 * Remove a histogram and hide its SVG through the SVG attribute contract.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @return {void}
 */
export function clearRasterHistogramChart(chart) {
    chartObservers.get(chart)?.disconnect();
    chartObservers.delete(chart);
    chart.replaceChildren();
    chart.setAttribute("hidden", "");
}
