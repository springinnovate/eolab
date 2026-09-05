/**
 * DOM presentation adapter for raster histogram percentile controls.
 *
 * This adapter owns the percentile region, its three range inputs and value
 * outputs, ordered-input feedback, the apply action, and their direct event
 * listeners. It makes no statistics, styling, rendering, or request decisions.
 */
import { requireRasterControl } from "./required-control.js";

/** Ordered percentile names represented by the controls. */
const PERCENTILE_NAMES = Object.freeze(["lower", "middle", "upper"]);

/**
 * @typedef {Object} RasterPercentileHandlers
 * @property {() => void} onPercentileInput Updates percentile estimates.
 * @property {() => void} onApplyPercentiles Applies the percentile range.
 */

/** Own direct DOM interaction and presentation for histogram percentiles. */
export class RasterPercentileControlsView {
    /**
     * Resolve the required percentile elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the percentile controls.
     * @throws {Error} If any required percentile element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.percentileControls = requireRasterControl(
            documentContext,
            "#raster-percentile-controls"
        );
        this.percentileInputs = {
            lower: requireRasterControl(
                documentContext,
                "#raster-lower-percentile"
            ),
            middle: requireRasterControl(
                documentContext,
                "#raster-middle-percentile"
            ),
            upper: requireRasterControl(
                documentContext,
                "#raster-upper-percentile"
            ),
        };
        this.percentileValues = {
            lower: requireRasterControl(
                documentContext,
                "#raster-lower-percentile-value"
            ),
            middle: requireRasterControl(
                documentContext,
                "#raster-middle-percentile-value"
            ),
            upper: requireRasterControl(
                documentContext,
                "#raster-upper-percentile-value"
            ),
        };
        this.percentileError = requireRasterControl(
            documentContext,
            "#raster-percentile-error"
        );
        this.applyPercentilesButton = requireRasterControl(
            documentContext,
            "#apply-raster-percentiles"
        );
        this.renderingIsAvailable = true;
        this.statisticsAreAvailable = !this.percentileControls.hidden;
        this.modeIsCompatible = true;
        this.handlers = null;
        this.boundPercentileInput = this.#handlePercentileInput.bind(this);
        this.boundApplyPercentiles = this.#handleApplyPercentiles.bind(this);
    }

    /**
     * Attach direct percentile listeners to semantic viewer handlers.
     *
     * @param {RasterPercentileHandlers} handlers Percentile handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        for (const input of Object.values(this.percentileInputs)) {
            input.addEventListener("input", this.boundPercentileInput);
        }
        this.applyPercentilesButton.addEventListener(
            "click",
            this.boundApplyPercentiles
        );
    }

    /** Remove every direct listener installed by {@link bind}. @return {void} */
    unbind() {
        for (const input of Object.values(this.percentileInputs)) {
            input.removeEventListener("input", this.boundPercentileInput);
        }
        this.applyPercentilesButton.removeEventListener(
            "click",
            this.boundApplyPercentiles
        );
        this.handlers = null;
    }

    /**
     * Read the three selected histogram positions as percentages.
     *
     * @return {{lower: number, middle: number, upper: number}} Percentiles.
     */
    readPercentiles() {
        return {
            lower: Number(this.percentileInputs.lower.value),
            middle: Number(this.percentileInputs.middle.value),
            upper: Number(this.percentileInputs.upper.value),
        };
    }

    /**
     * Restore percentile controls to the application defaults.
     *
     * @param {{lower: number, middle: number, upper: number}} defaults Default
     * ordered histogram positions.
     * @return {void}
     */
    resetPercentiles(defaults) {
        for (const percentileName of PERCENTILE_NAMES) {
            this.percentileInputs[percentileName].value =
                defaults[percentileName];
            this.percentileInputs[percentileName].removeAttribute(
                "aria-invalid"
            );
        }
        this.percentileError.textContent = "";
        this.applyPercentilesButton.disabled = false;
    }

    /**
     * Present approximate values and ordered-input feedback for percentiles.
     *
     * @param {{lower: number, middle: number, upper: number}} percentiles
     * Selected histogram positions.
     * @param {{lower: string, middle: string, upper: string}} values Formatted
     * approximate raster values.
     * @param {boolean} isOrdered Whether the positions increase strictly.
     * @param {boolean} isApplicable Whether the current histogram applies.
     * @return {void}
     */
    renderPercentileValues(percentiles, values, isOrdered, isApplicable) {
        for (const percentileName of PERCENTILE_NAMES) {
            const input = this.percentileInputs[percentileName];
            if (isOrdered) {
                input.removeAttribute("aria-invalid");
            } else {
                input.setAttribute("aria-invalid", "true");
            }
            this.percentileValues[percentileName].textContent =
                `${percentiles[percentileName]}% ≈ ` + values[percentileName];
        }
        this.percentileError.textContent = isOrdered
            ? ""
            : "Choose lower, middle, and upper percentiles in increasing order.";
        this.applyPercentilesButton.textContent =
            `Apply ${percentiles.lower}/${percentiles.middle}/` +
            `${percentiles.upper} stretch to map`;
        this.applyPercentilesButton.disabled = !isOrdered || !isApplicable;
    }

    /**
     * Set whether the percentile controls are available.
     *
     * @param {boolean} isVisible Whether the controls should be visible.
     * @return {void}
     */
    setPercentileControlsVisible(isVisible) {
        this.statisticsAreAvailable = isVisible;
        this.#synchronizeVisibility();
    }

    /**
     * Set whether the active analysis target has a renderer whose thresholds
     * can receive percentile values.
     *
     * @param {boolean} isAvailable Whether appearance controls have a target.
     * @return {void}
     */
    setRenderingAvailable(isAvailable) {
        this.renderingIsAvailable = isAvailable;
        this.#synchronizeVisibility();
    }

    /**
     * Set whether the active comparison mode accepts univariate percentiles.
     *
     * @param {boolean} isCompatible Whether percentile editing is compatible.
     * @return {void}
     */
    setModeCompatible(isCompatible) {
        this.modeIsCompatible = isCompatible;
        this.#synchronizeVisibility();
    }

    /**
     * Set whether the current percentile range can be applied.
     *
     * @param {boolean} isEnabled Whether the apply action should be enabled.
     * @return {void}
     */
    setApplyPercentilesEnabled(isEnabled) {
        this.applyPercentilesButton.disabled = !isEnabled;
    }

    /** Forward one percentile edit to the raster viewer. @return {void} */
    #handlePercentileInput() {
        this.handlers.onPercentileInput();
    }

    /** Forward the apply-percentiles action. @return {void} */
    #handleApplyPercentiles() {
        this.handlers.onApplyPercentiles();
    }

    /** Apply independent statistics and rendering availability. @return {void} */
    #synchronizeVisibility() {
        this.percentileControls.hidden = !(
            this.renderingIsAvailable &&
            this.statisticsAreAvailable &&
            this.modeIsCompatible
        );
    }
}
