/** Local axes and debounced sample recounts for a single continuous raster chart. */
import { HistogramAxisControls } from "./histogram-axis-controls.js";
import { createHistogramAxis } from "./histogram-axis-scale.js";
import { HistogramRangeNavigator } from "./histogram-range-navigator.js";

/** @typedef {{edges:number[],counts:number[]}} HistogramBins */

/** Keep the displayed bins, value axis, and bar heights together across asynchronous edits. */
export class ContinuousHistogramControls extends HistogramAxisControls {
    /** Create a full-range chart and restore any range retained by this layer.
     * @param {Document} doc Owning document.
     * @param {Object} statistics Full statistics for the active sample.
     * @param {string} valueLabel Value-axis label with optional units.
     * @param {Object} state Layer-owned display settings.
     * @param {(range:number[],signal:AbortSignal)=>Promise<HistogramBins>} loadWindow Recount this source and area.
     * @param {(bins:HistogramBins,axes:Object)=>void} draw Paint bins with current colors and markers.
     */
    constructor(doc, statistics, valueLabel, state, loadWindow, draw) {
        const distribution = {...statistics.histogram, total: statistics.validSampleCount};
        super(doc, [
            {...distribution, key: "y", label: "Bar height (% of pixels)", frequency: true, nice: true},
            {...distribution, key: "x", label: valueLabel, rebin: true},
        ], state, () => this.#select());
        this.full = statistics.histogram;
        this.bins = this.full;
        this.displayedX = createHistogramAxis(distribution);
        this.loadWindow = loadWindow;
        this.draw = draw;
        this.request = null;
        this.navigator = new HistogramRangeNavigator(doc, this.full, range => this.setValueWindow(range), () => this.#cancel());
        this.binWidth = doc.createElement("span");
        this.binWidth.className = "histogram-bin-width";
        this.pixelCount = doc.createElement("span");
        this.pixelCount.className = "histogram-sample-count";
        this.pixelCount.textContent = `${statistics.validSampleCount.toLocaleString()} sampled pixels`;
        this.#select();
        if (this.request) this.redraw();
    }

    /** Update metadata and repaint the last complete result using the latest display settings.
     * @return {void}
     */
    redraw() {
        const {edges, counts} = this.bins;
        const width = (edges.at(-1) - edges[0]) / counts.length;
        this.binWidth.textContent = `${counts.length} bins · width ${new Intl.NumberFormat("en-US", {
            maximumSignificantDigits: 8, notation: width < 1e-5 ? "scientific" : "standard",
        }).format(width)}`;
        this.draw(this.bins, {x: this.displayedX, y: this.axes.y});
    }

    /** Synchronize accepted bounds and coalesce changes before requesting the new bins.
     * @return {void}
     */
    #select() {
        const {minimum, maximum} = this.axes.x;
        this.navigator.show([minimum, maximum]);
        if (this.request?.minimum === minimum && this.request.maximum === maximum) return;
        this.#cancel();
        if (this.bins.edges[0] === minimum && this.bins.edges.at(-1) === maximum) {
            this.displayedX = this.axes.x;
            this.#showCountStatus();
            this.redraw();
            return;
        }
        if (this.full.edges[0] === minimum && this.full.edges.at(-1) === maximum) {
            this.#display(this.full);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const bins = await this.loadWindow([minimum, maximum], controller.signal);
                if (!controller.signal.aborted) this.#display(bins);
            } catch (error) {
                if (!controller.signal.aborted) {
                    this.navigator.status.textContent = `Could not update the histogram. ${error.message}`;
                }
            } finally {
                if (!controller.signal.aborted) {
                    this.request = null;
                    this.navigator.root.setAttribute("aria-busy", "false");
                }
            }
        }, 200);
        this.request = {minimum, maximum, controller, timer};
        this.navigator.root.setAttribute("aria-busy", "true");
        this.navigator.status.textContent = "";
    }

    /** Show the newly counted distribution using a bar-height scale fitted to it.
     * @param {HistogramBins} bins Full sample or accepted window.
     * @return {void}
     */
    #display(bins) {
        this.bins = bins;
        this.setBarHeightHistogram(bins.counts.some(count => count > 0) ? bins : this.full);
        this.displayedX = this.axes.x;
        this.#showCountStatus();
        this.redraw();
    }

    /** Explain an empty window while keeping the navigator available.
     * @return {void}
     */
    #showCountStatus() {
        this.navigator.status.textContent = this.bins.counts.some(count => count > 0) ? "" : "No sampled pixels in this range.";
    }

    /** Cancel both the debounce and any outstanding response for the old window.
     * @return {void}
     */
    #cancel() {
        if (!this.request) return;
        clearTimeout(this.request.timer);
        this.request.controller.abort();
        this.request = null;
        this.navigator.root.setAttribute("aria-busy", "false");
    }

    /** Enable range controls with the axes and discard work for a superseded sample.
     * @param {boolean} enabled Whether the sample can be edited.
     * @return {void}
     */
    setEnabled(enabled) {
        const resume = enabled && !this.enabled;
        super.setEnabled(enabled);
        this.navigator.setEnabled(enabled);
        if (!enabled) this.#cancel();
        if (resume) this.#select();
    }
}
