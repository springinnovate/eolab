/** Focused presentation for bivariate map controls and paired histograms. */
import { requireRasterControl } from "./required-control.js";
import {
    BIVARIATE_RASTER_PALETTES,
    getBivariateAxisCssColor,
    getBivariateColorAt,
    getBivariateColorForValues,
    getBivariateDensityWeight,
    getBivariateHistogramCellColor,
} from "./bivariate.js";
import {
    findRasterPairedHistogramCell,
    getHighestDensityPairedCell,
} from "./paired-statistics.js";
import { formatRasterPixelValue } from "./pixel-probe.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LEGEND_GRID_SIZE = 12;
const HISTOGRAM_VIEWBOX_WIDTH = 660;
const HISTOGRAM_BASE_VIEWBOX_HEIGHT = 620;
const HISTOGRAM_PLOT_X = 160;
const HISTOGRAM_PLOT_Y = 74;
const HISTOGRAM_PLOT_SIZE = 420;
const HISTOGRAM_MARGINAL_SIZE = 54;
const AXIS_TITLE_MAXIMUM_LINE_LENGTH = 40;
const AXIS_TITLE_LINE_HEIGHT = 22;

/**
 * Create one SVG element with a compact attribute mapping.
 *
 * @param {Document} documentContext Owning document.
 * @param {string} name SVG element name.
 * @param {Object} [attributes={}] Stringifiable SVG attributes.
 * @return {SVGElement} Newly created SVG element.
 */
function svgElement(documentContext, name, attributes = {}) {
    const element = documentContext.createElementNS(SVG_NAMESPACE, name);
    for (const [attribute, value] of Object.entries(attributes)) {
        element.setAttribute(attribute, String(value));
    }
    return element;
}

/**
 * Format one closed numeric range for accessible paired summaries.
 *
 * @param {number} minimum Finite lower value.
 * @param {number} maximum Finite upper value.
 * @return {string} Readable inclusive range.
 */
function formatRange(minimum, maximum) {
    return `${formatRasterPixelValue(minimum)} to ` +
        formatRasterPixelValue(maximum);
}

/**
 * Wrap a raster filename at readable separators without dropping characters.
 *
 * Long uninterrupted filename segments are split at the same maximum length
 * so every catalog-provided basename remains visible in the SVG.
 *
 * @param {string} label Catalog-owned raster display basename.
 * @return {string[]} Ordered, non-empty SVG title lines.
 */
function wrapAxisTitle(label) {
    const source = label.trim();
    const tokens = source.match(/[^_.\s-]+(?:[_.\s-]+|$)/g) ?? [source];
    const fragments = [];
    for (const token of tokens) {
        for (
            let start = 0;
            start < token.length;
            start += AXIS_TITLE_MAXIMUM_LINE_LENGTH
        ) {
            fragments.push(token.slice(
                start,
                start + AXIS_TITLE_MAXIMUM_LINE_LENGTH
            ));
        }
    }
    const lines = [];
    let line = "";
    for (const fragment of fragments) {
        if (
            line.length > 0 &&
            line.length + fragment.length > AXIS_TITLE_MAXIMUM_LINE_LENGTH
        ) {
            lines.push(line);
            line = fragment;
        } else {
            line += fragment;
        }
    }
    if (line.length > 0) {
        lines.push(line);
    }
    return lines.length > 0 ? lines : [source];
}

/** Own bivariate DOM listeners and already-validated result presentation. */
export class BivariateRasterControlsView {
    /**
     * Resolve the fixed bivariate-control markup.
     *
     * @param {Document} [documentContext=globalThis.document] Owning document.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.root = requireRasterControl(
            documentContext,
            "#raster-bivariate-controls"
        );
        this.mode = requireRasterControl(
            documentContext,
            "#raster-comparison-mode"
        );
        this.status = requireRasterControl(
            documentContext,
            "#raster-bivariate-status"
        );
        this.panel = requireRasterControl(
            documentContext,
            "#raster-bivariate-panel"
        );
        this.xLabel = requireRasterControl(
            documentContext,
            "#raster-bivariate-x-label"
        );
        this.yLabel = requireRasterControl(
            documentContext,
            "#raster-bivariate-y-label"
        );
        this.palette = requireRasterControl(
            documentContext,
            "#raster-bivariate-palette"
        );
        this.swapButton = requireRasterControl(
            documentContext,
            "#swap-raster-bivariate-axes"
        );
        this.legend = requireRasterControl(
            documentContext,
            "#raster-bivariate-legend"
        );
        this.legendXRange = requireRasterControl(
            documentContext,
            "#raster-bivariate-legend-x-range"
        );
        this.legendYRange = requireRasterControl(
            documentContext,
            "#raster-bivariate-legend-y-range"
        );
        this.statisticsPanel = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics"
        );
        this.statisticsHeading = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics-heading"
        );
        this.statisticsStatus = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics-status"
        );
        this.statisticsXLabel = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics-x-label"
        );
        this.statisticsYLabel = requireRasterControl(
            documentContext,
            "#raster-bivariate-statistics-y-label"
        );
        this.retryButton = requireRasterControl(
            documentContext,
            "#retry-raster-paired-statistics"
        );
        this.histogram = requireRasterControl(
            documentContext,
            "#raster-bivariate-histogram"
        );
        this.histogramSummary = requireRasterControl(
            documentContext,
            "#raster-bivariate-histogram-summary"
        );
        this.handlers = null;
        this.cells = new Map();
        this.activeCell = null;
        this.statistics = null;
        this.labels = null;
        this.boundModeChange = this.#handleModeChange.bind(this);
        this.boundPaletteChange = this.#handlePaletteChange.bind(this);
        this.boundSwap = this.#handleSwap.bind(this);
        this.boundRetry = this.#handleRetry.bind(this);
    }

    /** Populate the eight shared palette definitions exactly once. @return {void} */
    populatePalettes() {
        if (this.palette.children.length > 0) {
            return;
        }
        for (const [name, definition] of Object.entries(
            BIVARIATE_RASTER_PALETTES
        )) {
            const option = this.documentContext.createElement("option");
            option.value = name;
            option.textContent = definition.label;
            this.palette.append(option);
        }
    }

    /**
     * Attach semantic bivariate handlers.
     *
     * @param {Object} handlers Viewer-owned mode and request actions.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.mode.addEventListener("change", this.boundModeChange);
        this.palette.addEventListener("change", this.boundPaletteChange);
        this.swapButton.addEventListener("click", this.boundSwap);
        this.retryButton.addEventListener("click", this.boundRetry);
    }

    /** Remove every direct listener installed by {@link bind}. @return {void} */
    unbind() {
        this.mode.removeEventListener("change", this.boundModeChange);
        this.palette.removeEventListener("change", this.boundPaletteChange);
        this.swapButton.removeEventListener("click", this.boundSwap);
        this.retryButton.removeEventListener("click", this.boundRetry);
        this.handlers = null;
    }

    /**
     * Present whether the explicit bivariate choice can currently start.
     *
     * @param {boolean} canEnter Whether exactly two eligible layers exist.
     * @param {string} guidance Concise eligibility guidance.
     * @return {void}
     */
    setAvailability(canEnter, guidance) {
        const option = [...this.mode.options].find(
            (candidate) => candidate.value === "bivariate"
        );
        if (option !== undefined) {
            option.disabled = !canEnter && this.mode.value !== "bivariate";
        }
        this.status.textContent = guidance;
    }

    /**
     * Render explicit mode state and its coordinated two-dimensional legend.
     *
     * @param {Object} state Viewer-owned mode presentation state.
     * @return {void}
     */
    renderMode(state) {
        this.mode.value = state.active ? "bivariate" : "overlay";
        this.panel.hidden = !state.active;
        this.statisticsPanel.hidden = !state.active;
        if (!state.active) {
            this.clearStatistics();
            return;
        }
        this.palette.value = state.paletteName;
        this.statisticsHeading.textContent =
            `${state.xLabel} vs. ${state.yLabel}`;
        this.xLabel.textContent = `X axis: ${state.xLabel}`;
        this.yLabel.textContent = `Y axis: ${state.yLabel}`;
        this.statisticsXLabel.textContent = state.xLabel;
        this.statisticsYLabel.textContent = state.yLabel;
        this.swapButton.setAttribute(
            "aria-label",
            `Swap X axis ${state.xLabel} with Y axis ${state.yLabel}`
        );
        this.#renderLegend(state);
    }

    /**
     * Show paired loading state without discarding the last valid chart.
     *
     * @param {string} message Current paired request guidance.
     * @return {void}
     */
    setStatisticsLoading(message) {
        this.statisticsStatus.textContent = message;
        this.retryButton.hidden = true;
        this.histogram.setAttribute("aria-busy", "true");
    }

    /**
     * Present a current paired failure and optional retry action.
     *
     * @param {Error} error Current paired request failure.
     * @param {boolean} canRetry Whether repeating may change the outcome.
     * @return {void}
     */
    renderStatisticsError(error, canRetry) {
        this.statisticsStatus.textContent = error.message;
        this.retryButton.hidden = !canRetry;
        this.histogram.removeAttribute("aria-busy");
    }

    /**
     * Render a color-faithful 2D histogram and X/Y marginals.
     *
     * @param {Object} statistics Validated paired response.
     * @param {Object} presentation Axis labels, styles, and palette identity.
     * @return {void}
     */
    renderStatistics(statistics, presentation) {
        this.statistics = statistics;
        this.labels = presentation;
        this.cells.clear();
        this.activeCell = null;
        const { histogram } = statistics;
        const binCount = histogram.counts.length;
        const cellSize = HISTOGRAM_PLOT_SIZE / binCount;
        const maximumCount = Math.max(...histogram.counts.flat());
        const maximumXMarginal = Math.max(...histogram.xMarginalCounts);
        const maximumYMarginal = Math.max(...histogram.yMarginalCounts);
        const highest = getHighestDensityPairedCell(statistics);
        const highestDescription = this.#cellDescription(
            highest.xBin,
            highest.yBin,
            highest.count
        );
        const provenance = statistics.approximate
            ? "Approximate bounded sample"
            : "Exact X-reference sample";
        const summary =
            `${presentation.xLabel}, horizontal range ${formatRange(
                statistics.xMinimum,
                statistics.xMaximum
            )}. ${presentation.yLabel}, vertical range ${formatRange(
                statistics.yMinimum,
                statistics.yMaximum
            )}. ${statistics.pairedSampleCount.toLocaleString()} paired ` +
            `pixels. ${provenance}; the vertical raster uses nearest-neighbor ` +
            "alignment. " +
            `Densest bin: ${highestDescription}`;
        const xAxisTitleLines = wrapAxisTitle(presentation.xLabel);
        const yAxisTitleLines = wrapAxisTitle(presentation.yLabel);
        const xAxisTitleY = HISTOGRAM_PLOT_Y + HISTOGRAM_PLOT_SIZE + 58;
        const viewBoxHeight = Math.max(
            HISTOGRAM_BASE_VIEWBOX_HEIGHT,
            xAxisTitleY +
                (xAxisTitleLines.length - 1) * AXIS_TITLE_LINE_HEIGHT + 24
        );
        this.histogram.setAttribute(
            "viewBox",
            `0 0 ${HISTOGRAM_VIEWBOX_WIDTH} ${viewBoxHeight}`
        );
        const title = svgElement(this.documentContext, "title");
        title.textContent = summary;
        const plotRight = HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE;
        const plotBottom = HISTOGRAM_PLOT_Y + HISTOGRAM_PLOT_SIZE;
        const children = [
            title,
            svgElement(this.documentContext, "rect", {
                x: HISTOGRAM_PLOT_X,
                y: HISTOGRAM_PLOT_Y,
                width: HISTOGRAM_PLOT_SIZE,
                height: HISTOGRAM_PLOT_SIZE,
                class: "raster-bivariate-plot",
            }),
        ];
        for (const fraction of [0.25, 0.5, 0.75]) {
            const offset = HISTOGRAM_PLOT_SIZE * fraction;
            children.push(
                svgElement(this.documentContext, "line", {
                    x1: HISTOGRAM_PLOT_X + offset,
                    y1: HISTOGRAM_PLOT_Y,
                    x2: HISTOGRAM_PLOT_X + offset,
                    y2: plotBottom,
                    class: "raster-bivariate-grid-line",
                }),
                svgElement(this.documentContext, "line", {
                    x1: HISTOGRAM_PLOT_X,
                    y1: HISTOGRAM_PLOT_Y + offset,
                    x2: plotRight,
                    y2: HISTOGRAM_PLOT_Y + offset,
                    class: "raster-bivariate-grid-line",
                })
            );
        }

        histogram.counts.forEach((row, yBin) => {
            row.forEach((count, xBin) => {
                if (count === 0) return;
                const density = getBivariateDensityWeight(
                    count,
                    maximumCount
                );
                const shrink = -0.05 + 0.5 * (1 - density);
                const inset = cellSize * shrink * 0.5;
                const size = cellSize * (1 - shrink);
                const left = HISTOGRAM_PLOT_X + xBin * cellSize + inset;
                const top = HISTOGRAM_PLOT_Y +
                    (binCount - 1 - yBin) * cellSize + inset;
                const xValue = (
                    histogram.xEdges[xBin] + histogram.xEdges[xBin + 1]
                ) / 2;
                const yValue = (
                    histogram.yEdges[yBin] + histogram.yEdges[yBin + 1]
                ) / 2;
                const cell = svgElement(this.documentContext, "rect", {
                    x: left,
                    y: top,
                    width: size,
                    height: size,
                    tabindex: 0,
                    role: "button",
                });
                cell.classList.add("raster-bivariate-cell");
                cell.style.fill = getBivariateHistogramCellColor(
                    getBivariateColorForValues(
                        presentation.paletteName,
                        presentation.xStyle,
                        presentation.yStyle,
                        xValue,
                        yValue
                    ),
                    density
                );
                cell.style.strokeOpacity = String(
                    0.15 * Math.pow(density, 0.7)
                );
                const description = this.#cellDescription(xBin, yBin, count);
                const compactDescription = this.#compactCellDescription(
                    xBin,
                    yBin,
                    count
                );
                cell.setAttribute("aria-label", description);
                const select = () => this.#selectCell(
                    xBin,
                    yBin,
                    compactDescription,
                    cell
                );
                cell.addEventListener("pointerenter", select);
                cell.addEventListener("focus", select);
                cell.addEventListener("click", select);
                cell.addEventListener("keydown", (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        select();
                    }
                });
                this.cells.set(`${xBin}:${yBin}`, cell);
                children.push(cell);
            });
        });

        histogram.xMarginalCounts.forEach((count, xBin) => {
            const height = count / maximumXMarginal * HISTOGRAM_MARGINAL_SIZE;
            const bar = svgElement(this.documentContext, "rect", {
                x: HISTOGRAM_PLOT_X + xBin * cellSize,
                y: HISTOGRAM_PLOT_Y - height,
                width: Math.max(1, cellSize - 1),
                height,
            });
            bar.classList.add("raster-bivariate-marginal");
            const midpoint = (
                histogram.xEdges[xBin] + histogram.xEdges[xBin + 1]
            ) / 2;
            bar.style.fill = getBivariateAxisCssColor(
                presentation.xStyle,
                midpoint
            );
            children.push(bar);
        });
        histogram.yMarginalCounts.forEach((count, yBin) => {
            const width = count / maximumYMarginal * HISTOGRAM_MARGINAL_SIZE;
            const bar = svgElement(this.documentContext, "rect", {
                x: HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE,
                y: HISTOGRAM_PLOT_Y + (binCount - 1 - yBin) * cellSize,
                width,
                height: Math.max(1, cellSize - 1),
            });
            bar.classList.add("raster-bivariate-marginal");
            const midpoint = (
                histogram.yEdges[yBin] + histogram.yEdges[yBin + 1]
            ) / 2;
            bar.style.fill = getBivariateAxisCssColor(
                presentation.yStyle,
                midpoint
            );
            children.push(bar);
        });

        children.push(
            svgElement(this.documentContext, "line", {
                x1: HISTOGRAM_PLOT_X,
                y1: plotBottom,
                x2: plotRight,
                y2: plotBottom,
                class: "raster-bivariate-axis",
            }),
            svgElement(this.documentContext, "line", {
                x1: HISTOGRAM_PLOT_X,
                y1: HISTOGRAM_PLOT_Y,
                x2: HISTOGRAM_PLOT_X,
                y2: plotBottom,
                class: "raster-bivariate-axis",
            })
        );
        const axisLabels = [];
        for (const [fraction, value, anchor] of [
            [0, statistics.xMinimum, "start"],
            [0.5, (statistics.xMinimum + statistics.xMaximum) / 2, "middle"],
            [1, statistics.xMaximum, "end"],
        ]) {
            const x = HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE * fraction;
            children.push(svgElement(this.documentContext, "line", {
                x1: x,
                y1: plotBottom,
                x2: x,
                y2: plotBottom + 7,
                class: "raster-bivariate-axis",
            }));
            axisLabels.push([
                formatRasterPixelValue(value),
                x,
                plotBottom + 25,
                anchor,
            ]);
        }
        for (const [fraction, value] of [
            [0, statistics.yMinimum],
            [0.5, (statistics.yMinimum + statistics.yMaximum) / 2],
            [1, statistics.yMaximum],
        ]) {
            const y = plotBottom - HISTOGRAM_PLOT_SIZE * fraction;
            children.push(svgElement(this.documentContext, "line", {
                x1: HISTOGRAM_PLOT_X - 7,
                y1: y,
                x2: HISTOGRAM_PLOT_X,
                y2: y,
                class: "raster-bivariate-axis",
            }));
            axisLabels.push([
                formatRasterPixelValue(value),
                HISTOGRAM_PLOT_X - 12,
                y + 5,
                "end",
            ]);
        }
        for (const [text, x, y, anchor] of axisLabels) {
            const label = svgElement(this.documentContext, "text", {
                x,
                y,
                "text-anchor": anchor,
                class: "raster-bivariate-axis-label",
            });
            label.textContent = text;
            children.push(label);
        }
        xAxisTitleLines.forEach((line, index) => {
            const xAxisLabel = svgElement(this.documentContext, "text", {
                x: HISTOGRAM_PLOT_X + HISTOGRAM_PLOT_SIZE / 2,
                y: xAxisTitleY + index * AXIS_TITLE_LINE_HEIGHT,
                "text-anchor": "middle",
                class: "raster-bivariate-axis-title",
                "data-axis": "x",
            });
            xAxisLabel.textContent = line;
            children.push(xAxisLabel);
        });
        const yAxisTitleStartX = Math.max(
            14,
            48 - (yAxisTitleLines.length - 1) * AXIS_TITLE_LINE_HEIGHT / 2
        );
        yAxisTitleLines.forEach((line, index) => {
            const x = yAxisTitleStartX + index * AXIS_TITLE_LINE_HEIGHT;
            const y = HISTOGRAM_PLOT_Y + HISTOGRAM_PLOT_SIZE / 2;
            const yAxisLabel = svgElement(this.documentContext, "text", {
                x,
                y,
                "text-anchor": "middle",
                class: "raster-bivariate-axis-title",
                "data-axis": "y",
                transform: `rotate(-90 ${x} ${y})`,
            });
            yAxisLabel.textContent = line;
            children.push(yAxisLabel);
        });

        this.histogram.replaceChildren(...children);
        this.histogram.setAttribute("aria-label", summary);
        this.histogram.removeAttribute("aria-busy");
        this.histogram.removeAttribute("hidden");
        this.histogramSummary.textContent =
            `Densest · ${this.#compactCellDescription(
                highest.xBin,
                highest.yBin,
                highest.count
            )}`;
        this.statisticsStatus.textContent =
            `${statistics.pairedSampleCount.toLocaleString()} paired pixels · ` +
            `${statistics.approximate ? "approximate" : "exact"}`;
        this.retryButton.hidden = true;
    }

    /**
     * Mark the histogram cell containing a dual pixel probe result.
     *
     * @param {number} xValue Current X pixel value.
     * @param {number} yValue Current Y pixel value.
     * @return {void}
     */
    highlightPair(xValue, yValue) {
        if (this.statistics === null) return;
        const bin = findRasterPairedHistogramCell(
            this.statistics,
            xValue,
            yValue
        );
        if (bin === null) return;
        const cell = this.cells.get(`${bin.xBin}:${bin.yBin}`);
        if (cell === undefined) return;
        this.#selectCell(
            bin.xBin,
            bin.yBin,
            `Probe · ${this.#compactCellDescription(
                bin.xBin,
                bin.yBin,
                this.statistics.histogram.counts[bin.yBin][bin.xBin]
            )}`,
            cell
        );
        cell.classList.add("is-probed");
    }

    /** Clear paired result content while preserving explicit mode controls. @return {void} */
    clearStatistics() {
        this.statistics = null;
        this.labels = null;
        this.cells.clear();
        this.activeCell = null;
        this.histogram.replaceChildren();
        this.histogram.setAttribute("hidden", "");
        this.histogram.removeAttribute("aria-busy");
        this.histogramSummary.textContent = "";
        this.statisticsStatus.textContent = "";
        this.retryButton.hidden = true;
    }

    /**
     * Render one compact 2D legend through the same additive surface.
     *
     * @param {Object} state Current palette, labels, and coordinated styles.
     * @return {void}
     */
    #renderLegend(state) {
        const children = [];
        const cellSize = 100 / LEGEND_GRID_SIZE;
        for (let yIndex = 0; yIndex < LEGEND_GRID_SIZE; yIndex += 1) {
            for (let xIndex = 0; xIndex < LEGEND_GRID_SIZE; xIndex += 1) {
                const x = (xIndex + 0.5) / LEGEND_GRID_SIZE;
                const y = (yIndex + 0.5) / LEGEND_GRID_SIZE;
                const cell = svgElement(this.documentContext, "rect", {
                    x: xIndex * cellSize,
                    y: (LEGEND_GRID_SIZE - 1 - yIndex) * cellSize,
                    width: cellSize + 0.1,
                    height: cellSize + 0.1,
                });
                cell.style.fill = getBivariateColorAt(
                    state.paletteName,
                    x,
                    y
                );
                children.push(cell);
            }
        }
        const description =
            `Bivariate additive color encoding. Horizontal X axis ` +
            `${state.xLabel}, range ${formatRange(
                state.xStyle.minimum,
                state.xStyle.maximum
            )}. Vertical Y axis ${state.yLabel}, range ${formatRange(
                state.yStyle.minimum,
                state.yStyle.maximum
            )}. Channel clipping and finite RGB precision can make different ` +
            "value pairs share a displayed color.";
        const title = svgElement(this.documentContext, "title");
        title.textContent = description;
        this.legend.replaceChildren(title, ...children);
        this.legend.setAttribute("aria-label", description);
        this.legendXRange.textContent =
            `${state.xLabel}: ${formatRange(
                state.xStyle.minimum,
                state.xStyle.maximum
            )}`;
        this.legendYRange.textContent =
            `${state.yLabel}: ${formatRange(
                state.yStyle.minimum,
                state.yStyle.maximum
            )}`;
    }

    /**
     * Build one cell's axis ranges, count, and sample percentage.
     *
     * @param {number} xBin Zero-based X histogram bin.
     * @param {number} yBin Zero-based Y histogram bin.
     * @param {number} count Paired samples in the cell.
     * @return {string} Accessible paired-cell description.
     */
    #cellDescription(xBin, yBin, count) {
        const histogram = this.statistics.histogram;
        const percentage = count / this.statistics.pairedSampleCount * 100;
        return `${this.labels.xLabel} ${formatRange(
            histogram.xEdges[xBin],
            histogram.xEdges[xBin + 1]
        )}; ${this.labels.yLabel} ${formatRange(
            histogram.yEdges[yBin],
            histogram.yEdges[yBin + 1]
        )}; ${count.toLocaleString()} pixels (${percentage.toFixed(2)}%).`;
    }

    /**
     * Build the compact visible filename readout for one populated cell.
     *
     * @param {number} xBin Zero-based horizontal-raster histogram bin.
     * @param {number} yBin Zero-based vertical-raster histogram bin.
     * @param {number} count Paired pixels in the cell.
     * @return {string} Direct filename ranges, count, and percentage.
     */
    #compactCellDescription(xBin, yBin, count) {
        const histogram = this.statistics.histogram;
        const percentage = count / this.statistics.pairedSampleCount * 100;
        return `${this.labels.xLabel} ` +
            `${formatRasterPixelValue(histogram.xEdges[xBin])}–` +
            `${formatRasterPixelValue(histogram.xEdges[xBin + 1])} · ` +
            `${this.labels.yLabel} ` +
            `${formatRasterPixelValue(histogram.yEdges[yBin])}–` +
            `${formatRasterPixelValue(histogram.yEdges[yBin + 1])} · ` +
            `${count.toLocaleString()} pixels (${percentage.toFixed(1)}%)`;
    }

    /**
     * Persist pointer, keyboard, or touch selection for useful inspection.
     *
     * @param {number} xBin Zero-based X histogram bin.
     * @param {number} yBin Zero-based Y histogram bin.
     * @param {string} summary Compact selected-cell summary.
     * @param {SVGElement} cell Selected SVG rectangle.
     * @return {void}
     */
    #selectCell(xBin, yBin, summary, cell) {
        this.activeCell?.classList.remove("is-selected", "is-probed");
        this.activeCell = cell;
        cell.classList.add("is-selected");
        cell.dataset.xBin = String(xBin);
        cell.dataset.yBin = String(yBin);
        this.histogramSummary.textContent = summary;
    }

    /** Forward explicit overlay/bivariate selection. @return {void} */
    #handleModeChange() {
        this.handlers?.onBivariateModeChange(this.mode.value);
    }

    /** Forward one coordinated palette selection. @return {void} */
    #handlePaletteChange() {
        this.handlers?.onBivariatePaletteChange(this.palette.value);
    }

    /** Forward the deterministic X/Y role swap. @return {void} */
    #handleSwap() {
        this.handlers?.onBivariateSwapAxes();
    }

    /** Forward paired-statistics retry. @return {void} */
    #handleRetry() {
        this.handlers?.onRetryPairedStatistics();
    }
}
