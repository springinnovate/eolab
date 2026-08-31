/** Numeric scales and SVG axes for the bounded, single-band histogram. */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Format a tick with enough precision for its spacing, without scientific
 * notation for ordinary values or floating-point tails around zero.
 * @param {number} value Tick value.
 * @param {number} step Distance between adjacent ticks.
 * @return {string} Compact, distinct numeric label.
 */
export function formatHistogramTick(value, step) {
    if (Math.abs(value) < Math.abs(step) * 1e-8 || value === 0) return "0";
    const magnitude = Math.floor(Math.log10(Math.abs(value)));
    const precision = Math.min(15, Math.max(0, magnitude - Math.floor(Math.log10(step)) + 1));
    if (Math.abs(value) >= 1e6 || Math.abs(value) < 0.001) {
        const [mantissa, exponent] = value.toExponential(Math.max(1, precision)).split("e");
        return `${Number(mantissa)}e${Number(exponent)}`;
    }
    return String(Number(value.toFixed(Math.min(15, Math.max(0, 1 - Math.floor(Math.log10(step)))))));
}

/**
 * Name the value axis from the analyzed data asset's explicit band metadata.
 * Never infer units from a filename or from unrelated assets.
 * @param {Object|null} item Catalog Item; only its first data band is analyzed.
 * @return {string} Axis label, including units only when provided.
 */
export function getHistogramValueLabel(item) {
    const unit = item?.assets?.data?.["raster:bands"]?.[0]?.unit;
    return typeof unit === "string" && unit.trim() !== ""
        ? `Raster value (${unit.trim()})` : "Raster value";
}

/**
 * Create linear x ticks and a zero-based percentage scale for one chart.
 * Actual bin edges, not sample extrema, define the x domain (including padded
 * constant-value bins). A labeled offset preserves small differences around
 * large values without overlapping long tick labels.
 * @param {Object} statistics Validated histogram counts and edges.
 * @param {number} plotWidth Horizontal drawing space in CSS pixels.
 * @return {Object} X domain, positioned labels, optional offset, and y maximum.
 */
export function histogramScales(statistics, plotWidth) {
    const { counts, edges } = statistics.histogram;
    const minimum = edges[0], maximum = edges.at(-1);
    const span = maximum - minimum;
    const offset = Math.max(Math.abs(minimum), Math.abs(maximum)) / span > 1e5 ? minimum : 0;
    /** Format a fractional position; intervals determine numeric precision. */
    const label = (fraction, intervals) => formatHistogramTick(
        (minimum - offset) + fraction * span, span / intervals
    );
    const longest = Math.max(...[0, 0.25, 0.5, 0.75, 1].map(fraction => label(fraction, 4).length));
    const intervals = plotWidth >= 4 * (longest * 7 + 16) ? 4 : 2;
    const ticks = Array.from({ length: intervals + 1 }, (_, index) => ({
        fraction: index / intervals, label: label(index / intervals, intervals),
    }));
    const peakPercent = Math.max(...counts) / statistics.validSampleCount * 100;
    const power = 10 ** Math.floor(Math.log10(peakPercent));
    const ceiling = [1, 2, 5, 10].find(factor => factor * power >= peakPercent) * power;
    return { minimum, maximum, span, offset, ticks, maximumPercent: Math.min(100, ceiling) };
}

/**
 * Append an SVG element with explicit coordinates and optional text.
 * @param {SVGElement} parent Owning chart/group.
 * @param {Document} documentContext Element factory.
 * @param {string} tag SVG tag name.
 * @param {Object} attributes Serialized drawing attributes.
 * @param {string} [text=""] Text for labels.
 * @return {SVGElement} Appended element.
 */
function appendSvg(parent, documentContext, tag, attributes, text = "") {
    const element = documentContext.createElementNS(SVG_NAMESPACE, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    element.textContent = text;
    parent.append(element);
    return element;
}

/**
 * Draw readable axes and quiet grid lines behind the histogram bars.
 * @param {SVGSVGElement} chart Owning SVG, sized in CSS-pixel coordinates.
 * @param {Object} plot Plot rectangle with left, top, width, height, bottom.
 * @param {Object} scales X ticks and percentage maximum from histogramScales.
 * @param {string} valueLabel Raster value label with known units, if any.
 * @param {Document} documentContext SVG element factory.
 * @return {void}
 */
export function drawHistogramAxes(chart, plot, scales, valueLabel, documentContext) {
    const axes = appendSvg(chart, documentContext, "g", { class: "raster-histogram-axes", "aria-hidden": "true" });
    const right = plot.left + plot.width;
    for (const fraction of [0, 0.5, 1]) {
        const y = plot.bottom - fraction * plot.height;
        appendSvg(axes, documentContext, "line", { x1: plot.left, x2: right, y1: y, y2: y, class: "raster-histogram-grid" });
        appendSvg(axes, documentContext, "text", { x: plot.left - 8, y: y + 4, "text-anchor": "end", class: "raster-histogram-y-tick" },
            formatHistogramTick(fraction * scales.maximumPercent, scales.maximumPercent / 2));
    }
    appendSvg(axes, documentContext, "path", { d: `M${plot.left} ${plot.top}V${plot.bottom}H${right}`, class: "raster-histogram-baseline" });
    for (const tick of scales.ticks) {
        const x = plot.left + tick.fraction * plot.width;
        appendSvg(axes, documentContext, "line", { x1: x, x2: x, y1: plot.bottom, y2: plot.bottom + 4, class: "raster-histogram-baseline" });
        appendSvg(axes, documentContext, "text", { x, y: plot.bottom + 18, "text-anchor": tick.fraction === 0 ? "start" : tick.fraction === 1 ? "end" : "middle", class: "raster-histogram-x-tick" }, tick.label);
    }
    appendSvg(axes, documentContext, "text", { x: plot.left, y: 15, class: "raster-histogram-axis-title" }, "Sampled pixels (%)");
    appendSvg(axes, documentContext, "text", { x: plot.left + plot.width / 2, y: plot.bottom + 38, "text-anchor": "middle", class: "raster-histogram-axis-title" },
        scales.offset === 0 ? valueLabel : `${valueLabel} (offset ${scales.offset >= 0 ? "+" : ""}${scales.offset})`);
}
