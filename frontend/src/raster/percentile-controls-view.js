/** Inspect histogram percentiles and opt into rescaling one raster view. */
import { estimateRasterHistogramPercentile } from "./statistics.js";
import { formatRasterPixelValue } from "./value-format.js";
import { clampHistogramPercentileInput } from "./percentile-slider-input.js";

/** @typedef {{lower:number,middle:number,upper:number,rescale:boolean}} HistogramPercentileSettings */

/** Percentile names and the committed colors used by their chart markers. */
const PERCENTILE_STOPS = Object.freeze([
    ["lower", "Lower (L)", "minimumColor"],
    ["middle", "Middle (M)", "midpointColor"],
    ["upper", "Upper (U)", "maximumColor"],
]);

/** Own one histogram's percentile sliders, estimates and rescale choice. */
export class RasterPercentileControlsView {
    /**
     * Create controls that report edits without requesting data or applying styles.
     * @param {Document} documentContext Document owning the histogram.
     * @param {(settings:HistogramPercentileSettings)=>void} onInput Report each slider or checkbox edit.
     */
    constructor(documentContext, onInput) {
        this.root = documentContext.createElement("fieldset");
        this.root.className = "raster-percentile-controls raster-histogram-percentiles";
        const legend = documentContext.createElement("legend");
        legend.textContent = "Percentiles";
        this.root.append(legend);
        this.inputs = {};
        this.values = {};
        this.onInput = onInput;
        this.handleInput = this.#handleInput.bind(this);
        for (const [name, labelText] of PERCENTILE_STOPS) {
            const label = documentContext.createElement("label");
            const nameElement = documentContext.createElement("span");
            nameElement.textContent = labelText;
            const input = documentContext.createElement("input");
            input.type = "range";
            input.min = "0";
            input.max = "100";
            input.step = "1";
            input.setAttribute("aria-label", `${labelText} percentile`);
            input.addEventListener("input", this.handleInput);
            const output = documentContext.createElement("output");
            label.append(nameElement, input, output);
            this.root.append(label);
            this.inputs[name] = input;
            this.values[name] = output;
        }
        const rescaleLabel = documentContext.createElement("label");
        rescaleLabel.className = "raster-histogram-rescale";
        this.rescaleInput = documentContext.createElement("input");
        this.rescaleInput.type = "checkbox";
        this.rescaleInput.addEventListener("change", this.handleInput);
        const rescaleText = documentContext.createElement("span");
        rescaleText.textContent = "Match the map color scale to these percentiles";
        rescaleLabel.append(this.rescaleInput, rescaleText);
        const help = documentContext.createElement("p");
        this.rescaleLabel = rescaleLabel;
        this.rescaleHelp = help;
        help.className = "raster-histogram-rescale-help";
        help.textContent = "Map colors update as you move the sliders.";
        this.status = documentContext.createElement("p");
        this.status.className = "raster-percentile-status";
        this.status.setAttribute("role", "status");
        this.root.append(rescaleLabel, help, this.status);
    }

    /** Show color matching independently of the sliders used to read percentile estimates.
     * @param {boolean} enabled Whether this histogram may change the raster's colors.
     * @return {void}
     */
    setStyleEditingEnabled(enabled) {
        this.rescaleLabel.hidden = !enabled;
        this.rescaleHelp.hidden = !enabled;
        if (this.settings) this.#renderValues();
    }

    /**
     * Update estimates and availability while retaining focused inputs.
     * @param {Object|null} statistics Current validated histogram, or null while unavailable.
     * @param {import("./style.js").RasterStyle} style Current colors for chart markers.
     * @param {HistogramPercentileSettings} settings This view's percentile positions and rescale choice.
     * @param {boolean} canRescale Whether the current result can set map colors.
     * @param {string} message Reason rescaling is unavailable, or empty text.
     * @return {void}
     */
    render(statistics, style, settings, canRescale, message) {
        this.statistics = statistics;
        this.style = style;
        this.settings = { ...settings };
        this.canRescale = canRescale;
        this.message = message;
        for (const [name] of PERCENTILE_STOPS) {
            const value = String(settings[name]);
            if (this.inputs[name].value !== value) this.inputs[name].value = value;
        }
        this.rescaleInput.checked = settings.rescale && !this.rescaleLabel.hidden;
        this.#renderValues();
    }

    /**
     * Return raw percentile estimates for the existing histogram marker renderer.
     * Constant values remain unchanged here; style range expansion belongs to styling.
     * @return {Array<{label:string,value:number,color:string}>} Markers, or an empty list for invalid ordering.
     */
    get markers() {
        if (!this.ordered || this.statistics === null) return [];
        return PERCENTILE_STOPS.map(([name, , colorName]) => ({
            label: `${name} ${this.settings[name]}%`,
            value: this.estimates[name],
            color: this.style[colorName],
        }));
    }

    /** Remove owned listeners when the histogram is replaced. @return {void} */
    dispose() {
        for (const input of Object.values(this.inputs)) input.removeEventListener("input", this.handleInput);
        this.rescaleInput.removeEventListener("change", this.handleInput);
    }

    /**
     * Keep the active slider ordered, update estimates and report accepted values.
     * @param {Event} event Native slider input or color-matching checkbox change.
     * @return {void}
     */
    #handleInput(event) {
        clampHistogramPercentileInput(this.inputs, event.currentTarget);
        this.settings = {
            lower: Number(this.inputs.lower.value),
            middle: Number(this.inputs.middle.value),
            upper: Number(this.inputs.upper.value),
            rescale: !this.rescaleLabel.hidden && this.rescaleInput.checked,
        };
        this.#renderValues();
        this.onInput({ ...this.settings });
    }

    /** Present estimated values and keep invalid input from applying colors. @return {void} */
    #renderValues() {
        const { lower, middle, upper } = this.settings;
        this.ordered = lower < middle && middle < upper;
        this.estimates = {};
        for (const [name] of PERCENTILE_STOPS) {
            const value = this.statistics === null ? null
                : estimateRasterHistogramPercentile(this.statistics, this.settings[name]);
            this.estimates[name] = value;
            const text = `${this.settings[name]}% ≈ ${value === null ? "—" : formatRasterPixelValue(value)}`;
            this.values[name].textContent = text;
            this.inputs[name].disabled = this.statistics === null;
            this.inputs[name].setAttribute("aria-valuetext", text);
            if (this.ordered) this.inputs[name].removeAttribute("aria-invalid");
            else this.inputs[name].setAttribute("aria-invalid", "true");
        }
        // A selected checkbox remains operable while its result is unavailable.
        this.rescaleInput.disabled = this.rescaleLabel.hidden || (!this.settings.rescale && (!this.canRescale || !this.ordered));
        this.status.textContent = !this.ordered
            ? "Choose lower, middle, and upper percentiles in increasing order."
            : this.rescaleLabel.hidden ? "" : this.message;
        this.status.hidden = this.status.textContent === "";
    }
}
