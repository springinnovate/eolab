/** Local display controls shared by ordinary histograms and paired marginals. */
import { defaultHistogramAxisOptions, createHistogramAxis } from "./histogram-axis-scale.js";
import { formatRasterPixelValue } from "./value-format.js";

/**
 * Display controls for choosing histogram axis limits and linear or log scales.
 * Validate entered settings and notify the chart to redraw when they are valid.
 * The caller retains settings so they can be reapplied when the sample changes.
 */
export class HistogramAxisControls {
    /**
     * @param {Document} documentContext Element factory.
     * @param {Object[]} definitions Axis key, label and histogram distribution.
     * @param {{options?:Object,open?:boolean}} state Owner-retained display settings.
     * @param {(axes:Object)=>void} onChange Apply the accepted limits to the chart.
     */
    constructor(documentContext, definitions, state, onChange) {
        this.documentContext = documentContext;
        this.definitions = definitions;
        this.state = state;
        this.state.options ??= {};
        this.onChange = onChange;
        this.timer = null;
        this.enabled = true;
        this.root = documentContext.createElement("details");
        this.root.className = "histogram-axis-controls";
        this.root.open = state.open ?? false;
        this.root.addEventListener("toggle", () => { state.open = this.root.open; });
        const summary = documentContext.createElement("summary");
        summary.textContent = "Adjust histogram axes";
        this.summary = summary;
        this.root.append(summary);
        this.rows = new Map();
        /** @type {HTMLButtonElement[]} Buttons installed beside the 1D bar-height axis. */
        this.barHeightButtons = [];
        for (const definition of definitions) {
            state.options[definition.key] ??= defaultHistogramAxisOptions();
            this.#addRow(definition);
        }
        const help = documentContext.createElement("p");
        help.className = "histogram-axis-help";
        help.textContent = "Values use the labeled axis units. Value percentiles are estimated from sampled bins. " +
            "Bar-height percentiles interpolate the sorted non-empty bar heights; empty bins are excluded. " +
            (definitions.some(axis => axis.rebin) ? "Changing the value range recalculates the histogram bins." :
                "These controls change the display only, not sampling, binning or raster colors.");
        help.textContent += " Off-scale style markers are pinned to the plot edge; nonpositive markers cannot appear on log axes.";
        this.root.append(help);
        const reset = documentContext.createElement("button");
        reset.type = "button";
        reset.className = "secondary-button";
        reset.textContent = "Reset axes";
        this.reset = reset;
        reset.addEventListener("click", () => {
            if (!this.enabled) return;
            clearTimeout(this.timer);
            for (const definition of this.definitions) {
                this.state.options[definition.key] = defaultHistogramAxisOptions();
                this.#populateAxisInputs(definition.key);
            }
            this.axes = this.#buildAxesFromSettings();
            this.onChange(this.axes);
        });
        this.root.append(reset);
        this.axes = this.#buildAxesFromSettings();
    }

    /**
     * Create the 1D histogram's Y-axis label and one-click bar-height scale choices.
     * The pressed button follows the displayed scale, including after reset or fallback.
     * An incompatible choice opens the axis editor so its range error is visible.
     * @return {HTMLDivElement} Labeled button group to mount above this chart.
     */
    createBarHeightScaleControl() {
        const group = this.documentContext.createElement("div");
        group.className = "histogram-bar-height-scale";
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", "Bar height scale");
        const label = this.documentContext.createElement("span");
        label.textContent = "Sampled pixels (%)";
        group.append(label);
        const scaleInput = this.rows.get("y").fields.scale.input;
        for (const option of scaleInput.children) {
            const button = this.documentContext.createElement("button");
            button.type = "button";
            button.className = "secondary-button";
            button.value = option.value;
            button.textContent = option.textContent;
            button.setAttribute("aria-pressed", String(button.value === this.axes.y.scale));
            button.addEventListener("click", () => {
                if (!this.enabled) return;
                scaleInput.value = button.value;
                if (!this.#applyAxisInputs("y")) this.root.open = true;
            });
            this.barHeightButtons.push(button);
            group.append(button);
        }
        return group;
    }

    /**
     * Add the Scale and Range dropdowns, Min/Max number inputs, and status text
     * for one axis. Standard HTML select and input elements provide keyboard
     * navigation and editing without custom key handlers.
     * @param {Object} definition Axis key, label and distribution.
     * @return {void}
     */
    #addRow(definition) {
        const doc = this.documentContext;
        const fieldset = doc.createElement("fieldset");
        const legend = doc.createElement("legend");
        legend.textContent = definition.label;
        fieldset.append(legend);
        const fields = {};
        for (const [name, label, choices] of [
            ["scale", "Scale", [["linear", "Linear"], ["log", "Log"]]],
            ["bounds", "Range", [["auto", "Auto"], ["values", "Values"], ["percentiles", "Percentiles"]]],
            ["minimum", "Min", null], ["maximum", "Max", null],
        ]) {
            const wrapper = doc.createElement("label");
            const text = doc.createElement("span");
            text.textContent = label;
            const input = doc.createElement(choices ? "select" : "input");
            input.setAttribute("aria-label", `${definition.label}: ${label}`);
            if (choices) {
                for (const [value, caption] of choices) {
                    const option = doc.createElement("option");
                    option.value = value;
                    option.textContent = caption;
                    input.append(option);
                }
            } else {
                input.type = "number";
                input.step = "any";
            }
            input.addEventListener("change", () => {
                if (name === "bounds" && input.value !== "auto") {
                    const axis = this.axes[definition.key];
                    fields.minimum.input.value = input.value === "percentiles" ? "0" : String(axis.minimum);
                    fields.maximum.input.value = input.value === "percentiles" ? "100" : String(axis.maximum);
                }
                this.#applyAxisInputs();
            });
            if (!choices) input.addEventListener("input", () => {
                if (definition.rebin) {
                    this.#applyAxisInputs(definition.key);
                    return;
                }
                clearTimeout(this.timer);
                this.timer = setTimeout(() => this.#applyAxisInputs(), 200);
            });
            wrapper.append(text, input);
            fieldset.append(wrapper);
            fields[name] = { input, wrapper };
        }
        const status = doc.createElement("p");
        status.className = "histogram-axis-status";
        status.setAttribute("role", "status");
        fieldset.append(status);
        this.rows.set(definition.key, { fields, status, usingFallback: false });
        this.root.append(fieldset);
        this.#populateAxisInputs(definition.key);
    }

    /**
     * Fill one axis's dropdowns and number inputs from its saved settings.
     * Show Min/Max inputs only when the saved range mode needs them.
     * @param {string} key Axis whose inputs should be populated.
     * @return {void}
     */
    #populateAxisInputs(key) {
        const { fields } = this.rows.get(key);
        for (const name of Object.keys(fields)) fields[name].input.value = this.state.options[key][name];
        this.#rangeFields(key);
    }

    /**
     * Show min/max only for explicit limits, labeling percentile inputs.
     * @param {string} key Axis key.
     * @return {void}
     */
    #rangeFields(key) {
        const { fields } = this.rows.get(key);
        const mode = fields.bounds.input.value;
        for (const name of ["minimum", "maximum"]) {
            fields[name].wrapper.hidden = mode === "auto";
            fields[name].input.placeholder = mode === "percentiles" ? (name === "minimum" ? "P0" : "P100") : "";
        }
    }

    /**
     * Build numeric axis limits and coordinate conversions from saved settings
     * and the current histogram. Percentile limits are recalculated for this sample.
     * If a saved range or log scale cannot be used, build that axis with Auto/Linear
     * and show a warning without overwriting the saved settings.
     * Update each axis's status text and the "Adjust histogram axes" label.
     * @return {Object} Axis limits and coordinate conversions, indexed by axis key.
     * @throws {RangeError} If the histogram cannot form even an Auto/Linear axis.
     */
    #buildAxesFromSettings() {
        const axes = Object.fromEntries(this.definitions.map(definition => {
            const row = this.rows.get(definition.key);
            row.usingFallback = false;
            let axis, warning = "";
            try {
                axis = createHistogramAxis(definition, this.state.options[definition.key]);
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                row.usingFallback = true;
                warning = `${error.message} Showing Auto/Linear for this sample. `;
                axis = createHistogramAxis(definition);
            }
            row.status.textContent = warning + this.#describe(axis);
            return [definition.key, axis];
        }));
        this.#updateScaleLabels(axes);
        return axes;
    }

    /**
     * Show the displayed scales on the axis disclosure and the 1D bar-height buttons.
     * The disclosure also identifies clipped ranges and fallbacks for the current sample.
     * @param {Record<string, ReturnType<typeof createHistogramAxis>>} axes Displayed axis limits and scales.
     * @return {void}
     */
    #updateScaleLabels(axes) {
        for (const button of this.barHeightButtons) {
            button.setAttribute("aria-pressed", String(button.value === axes.y.scale));
        }
        const notes = [];
        if ([...this.rows.values()].some(row => row.usingFallback)) notes.push("using Auto/Linear");
        if (Object.values(axes).some(axis => axis.scale === "log")) notes.push("log");
        if (Object.values(axes).some(axis => axis.notice.includes("clipped"))) notes.push("clipped");
        this.summary.textContent = "Adjust histogram axes" + (notes.length ? " · " + notes.join(" · ") : "");
    }

    /**
     * Explain resolved numeric limits and any clipped or omitted data.
     * @param {Object} axis Resolved display transform.
     * @return {string} User-visible axis description.
     */
    #describe(axis) {
        return `${axis.scale === "log" ? "Log" : "Linear"}: ${formatRasterPixelValue(axis.minimum)} to ` +
            `${formatRasterPixelValue(axis.maximum)}. ${axis.notice}`;
    }

    /**
     * Apply the selected axes' scale and range together after validating their inputs.
     * An axis shortcut leaves the other axes' drafts and pending edits in place.
     * @param {string} [axisKey] Axis to apply. The detailed form applies all axes.
     * @return {boolean} Whether the chart accepted the requested settings.
     */
    #applyAxisInputs(axisKey) {
        if (axisKey === undefined) clearTimeout(this.timer);
        if (!this.enabled) return false;
        const definitions = axisKey === undefined ? this.definitions
            : this.definitions.filter(definition => definition.key === axisKey);
        const options = { ...this.state.options }, axes = { ...this.axes };
        let invalid = false;
        for (const definition of definitions) {
            const { fields, status } = this.rows.get(definition.key);
            this.#rangeFields(definition.key);
            const option = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.input.value]));
            try {
                const axis = createHistogramAxis(definition, option);
                axes[definition.key] = axis;
                options[definition.key] = option;
                status.textContent = this.#describe(axis);
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                status.textContent = error.message + " Chart unchanged.";
                invalid = true;
            }
        }
        if (invalid) {
            for (const { key } of definitions) {
                const { status } = this.rows.get(key);
                if (!status.textContent.endsWith("Chart unchanged.")) status.textContent += " Chart unchanged.";
            }
            return false;
        }
        this.state.options = options;
        this.axes = axes;
        for (const { key } of definitions) this.rows.get(key).usingFallback = false;
        this.#updateScaleLabels(axes);
        this.onChange(axes);
        return true;
    }

    /**
     * Disable edits while the owning histogram awaits a new sample.
     * @param {boolean} enabled Whether the current chart can be edited.
     * @return {void}
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) clearTimeout(this.timer);
        for (const { fields } of this.rows.values()) {
            for (const { input } of Object.values(fields)) input.disabled = !enabled;
        }
        this.reset.disabled = !enabled;
        for (const button of this.barHeightButtons) button.disabled = !enabled;
    }

    /** Apply a navigator edit to the same value-axis settings as the detailed editor.
     * @param {number[]|null} range Minimum and maximum, or null for the full linear domain.
     * @return {boolean} Whether the axis accepted the edit.
     */
    setValueWindow(range) {
        const {fields} = this.rows.get("x");
        fields.bounds.input.value = range ? "values" : "auto";
        if (!range) fields.scale.input.value = "linear";
        fields.minimum.input.value = range ? String(range[0]) : "";
        fields.maximum.input.value = range ? String(range[1]) : "";
        return this.#applyAxisInputs("x");
    }

    /** Recalculate the bar-height scale from the bins currently plotted.
     * @param {{edges:number[],counts:number[]}} histogram Visible distribution; empty windows retain a usable full-sample scale.
     * @return {void}
     */
    setBarHeightHistogram(histogram) {
        Object.assign(this.definitions.find(axis => axis.key === "y"), histogram);
        this.axes = this.#buildAxesFromSettings();
    }

    /** Stop pending edits when the owning chart is replaced or cleared. @return {void} */
    dispose() {
        this.setEnabled(false);
        clearTimeout(this.timer);
        this.onChange = () => {};
    }
}
