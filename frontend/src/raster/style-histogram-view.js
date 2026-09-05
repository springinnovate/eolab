/**
 * Histogram context embedded in the keyed raster style editor.
 *
 * This presentation adapter consumes explicit statistics and style snapshots.
 * It owns no sampling, rendering, layer-selection, or persistence decisions.
 */
import {
    clearRasterHistogramChart,
    renderRasterHistogramChart,
} from "./histogram-view.js";
import { requireRasterControl } from "./required-control.js";

/** Ordered style stops paired with the percentile controls. */
const STYLE_STOPS = Object.freeze([
    ["lower", "minimum", "minimumColor"],
    ["middle", "midpoint", "midpointColor"],
    ["upper", "maximum", "maximumColor"],
]);

/**
 * @typedef {Object} RasterStyleHistogramHandlers
 * @property {() => void} onOpenHistogram Opens the full raster-analysis view.
 */

/** Own the style editor's read-only distribution preview and navigation. */
export class RasterStyleHistogramView {
    /**
     * Resolve the required style-histogram elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Owning document.
     * @throws {Error} If any required style-histogram element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.root = requireRasterControl(
            documentContext,
            "#raster-style-histogram"
        );
        this.chart = requireRasterControl(
            documentContext,
            "#raster-style-histogram-chart"
        );
        this.scope = requireRasterControl(
            documentContext,
            "#raster-style-histogram-scope"
        );
        this.status = requireRasterControl(
            documentContext,
            "#raster-style-histogram-status"
        );
        this.openHistogramButton = requireRasterControl(
            documentContext,
            "#open-raster-histogram-analysis"
        );
        this.handlers = null;
        this.boundOpenHistogram = this.#handleOpenHistogram.bind(this);
    }

    /**
     * Attach the analysis-navigation action to its semantic handler.
     *
     * @param {RasterStyleHistogramHandlers} handlers Navigation handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.openHistogramButton.addEventListener(
            "click",
            this.boundOpenHistogram
        );
    }

    /** Remove the listener installed by {@link bind}. @return {void} */
    unbind() {
        this.openHistogramButton.removeEventListener(
            "click",
            this.boundOpenHistogram
        );
        this.handlers = null;
        this.clear();
    }

    /**
     * Render one style target's distribution with candidate range markers.
     *
     * @param {Object} statistics Validated raster statistics snapshot.
     * @param {Object} style Candidate raster color and range snapshot.
     * @param {string} scopeLabel Readable sampling scope.
     * @param {string} [valueLabel="Raster value"] Horizontal-axis label.
     * @param {{lower:number,middle:number,upper:number}|null}
     * [percentiles=null] Draft percentile positions, when applicable.
     * @return {void}
     */
    render(
        statistics,
        style,
        scopeLabel,
        valueLabel = "Raster value",
        percentiles = null
    ) {
        const markers = STYLE_STOPS.map(
            ([percentileName, valueName, colorName]) => ({
                label: percentiles === null
                    ? valueName
                    : `${percentileName} ${percentiles[percentileName]}%`,
                value: style[valueName],
                color: style[colorName],
            })
        );
        this.root.hidden = false;
        this.root.setAttribute("aria-busy", "false");
        this.scope.textContent = scopeLabel;
        this.status.textContent = "";
        renderRasterHistogramChart(
            this.chart,
            statistics,
            style,
            this.documentContext,
            valueLabel,
            markers
        );
    }

    /**
     * Show a loading or unavailable state without retaining a stale chart.
     *
     * @param {string} scopeLabel Readable sampling scope.
     * @param {string} message Current histogram status.
     * @param {boolean} [isBusy=false] Whether statistics are loading.
     * @return {void}
     */
    renderState(scopeLabel, message, isBusy = false) {
        this.root.hidden = false;
        this.root.setAttribute("aria-busy", String(isBusy));
        this.scope.textContent = scopeLabel;
        this.status.textContent = message;
        clearRasterHistogramChart(this.chart);
    }

    /** Hide the preview and release its responsive chart observer. @return {void} */
    clear() {
        clearRasterHistogramChart(this.chart);
        this.root.hidden = true;
        this.root.setAttribute("aria-busy", "false");
        this.scope.textContent = "";
        this.status.textContent = "";
    }

    /** Forward full-analysis navigation through the raster owner. @return {void} */
    #handleOpenHistogram() {
        this.handlers.onOpenHistogram();
    }
}
