/** Presentation shared by the two plots of inspected vector features. */
import { formatSeriesNumber, renderOrdinalSeriesChart } from "../charts/series-chart.js";

const FIELD_ORDER = new Intl.Collator("en", {numeric: true, sensitivity: "base"});

/** Number of features in one interactive comparison or native picker page. */
export const FEATURES_PER_PAGE = 1000;

/** Explain an unavailable numeric range while directing users to the unchanged readings. */
export const VECTOR_PLOT_RANGE_MESSAGE = "Some values are too large for this plot. Open Values to see every exact value.";

/** List the exact feature ranges available in a plot, values table, or picker.
 * @param {HTMLSelectElement} select Range control.
 * @param {number} total Number of features in the complete selection.
 * @param {number|null} start First zero-based row, or null for the entire plot.
 * @param {boolean} [offerAll=false] Include the slower whole-selection plot.
 * @return {void}
 */
export function fillFeatureRanges(select, total, start, offerAll = false) {
    select.replaceChildren();
    if (total <= FEATURES_PER_PAGE) return;
    const count = total.toLocaleString();
    for (let offset = 0; offset < total; offset += FEATURES_PER_PAGE) {
        const option = select.ownerDocument.createElement("option");
        option.value = String(offset);
        option.textContent = (offset + 1).toLocaleString() + "–" +
            Math.min(offset + FEATURES_PER_PAGE, total).toLocaleString() + " of " + count;
        select.append(option);
    }
    if (offerAll) {
        const option = select.ownerDocument.createElement("option");
        option.value = "all";
        option.textContent = "Plot all " + count + " features (slower)";
        select.append(option);
    }
    select.value = start === null ? "all" : String(start);
}

/** Bind the result switch and in-place pickers for one vector plot. */
export class VectorPlotPanel {
    /**
     * @param {Document} documentContext Document containing this panel.
     * @param {string} prefix ID of the owning feature plot.
     * @param {()=>void} redraw Render the requested chart or values at the current width.
     * @param {()=>number|null} selectedFeature Index to select when the feature picker opens.
     */
    constructor(documentContext, prefix, redraw, selectedFeature) {
        this.abort = new AbortController();
        const listen = { signal: this.abort.signal };
        const element = suffix => documentContext.querySelector("#" + prefix + "-" + suffix);
        this.plot = element("plots");
        this.values = element("values");
        this.plotButton = element("plot-button");
        this.valuesButton = element("values-button");
        this.fieldButton = element("fields-button");
        this.featureButton = element("features-button");
        this.featureList = element("feature-list");
        this.featureRange = element("feature-range");
        this.featureRangeLabel = element("feature-range-label");
        this.featureRange.addEventListener("change", () => this.#fillFeatureList(Number(this.featureRange.value)), listen);
        this.selectedFeature = selectedFeature;
        this.observations = [];
        this.fieldSearch = element("field-search");
        this.pickers = [
            {button: this.featureButton, body: element("features-picker"), done: element("features-done")},
            {button: this.fieldButton, body: element("fields-picker"), done: element("fields-done")},
            {button: element("statistics-button"), body: element("statistics-picker"), done: element("statistics-done")},
        ];
        this.activePicker = null;
        for (const picker of this.pickers) {
            picker.button.addEventListener("click", () => {
                const opening = this.activePicker !== picker;
                this.closePicker(false);
                if (opening) {
                    this.activePicker = picker;
                    picker.body.hidden = false;
                    picker.button.setAttribute("aria-expanded", "true");
                    if (picker.button === this.featureButton) this.#showFeatureRange();
                    if (picker.button === this.fieldButton) this.fieldSearch.focus();
                }
            }, listen);
            picker.done.addEventListener("click", () => this.closePicker(), listen);
        }
        for (const [button, values] of [[this.plotButton, false], [this.valuesButton, true]]) {
            button.addEventListener("click", () => {
                if (this.plot.hidden === values) return;
                this.showValues(values);
                redraw();
            }, listen);
        }
        this.showValues(false);
        this.width = 0;
        const view = documentContext.defaultView;
        if (view?.ResizeObserver) {
            let frame = null;
            const observer = new view.ResizeObserver(([entry]) => {
                const width = Math.round(entry.contentRect.width);
                if (width <= 0 || width === this.width) return;
                this.width = width;
                // A redraw also changes the observed plot's height. Let the current layout finish first.
                if (frame !== null) return;
                frame = view.requestAnimationFrame(() => {
                    frame = null;
                    redraw();
                });
            });
            observer.observe(this.plot);
            this.abort.signal.addEventListener("abort", () => {
                observer.disconnect();
                if (frame !== null) view.cancelAnimationFrame(frame);
            }, {once: true});
        }
    }

    /**
     * Switch the result in place while keeping the chosen fields and feature.
     * @param {boolean} values Show the exact readings in place of the chart.
     * @return {void}
     */
    showValues(values) {
        this.plot.hidden = values;
        this.values.hidden = !values;
        this.plotButton.setAttribute("aria-pressed", String(!values));
        this.valuesButton.setAttribute("aria-pressed", String(values));
    }

    /** Retain the selectable features and update the list only while it is open.
     * @param {ReadonlyArray<import("./inspection-observation.js").VectorInspectionObservation>} observations Ordered map selection.
     * @return {void}
     */
    setFeatureChoices(observations) {
        this.observations = observations;
        if (this.activePicker?.button === this.featureButton) this.#showFeatureRange();
    }

    /** Follow feature navigation in the open picker, including across page boundaries. @return {void} */
    syncSelectedFeature() {
        if (this.activePicker?.button !== this.featureButton) return;
        const index = this.selectedFeature();
        if (index === null || index >= this.observations.length) return;
        const start = Math.floor(index / FEATURES_PER_PAGE) * FEATURES_PER_PAGE;
        if (this.observations.length > FEATURES_PER_PAGE && this.featureRange.value !== String(start)) {
            this.featureRange.value = String(start);
            this.#fillFeatureList(start);
        } else this.featureList.value = String(index);
    }

    /** Open the picker on the page containing the inspected feature. @return {void} */
    #showFeatureRange() {
        const selected = this.selectedFeature() ?? 0;
        const start = selected < this.observations.length ? Math.floor(selected / FEATURES_PER_PAGE) * FEATURES_PER_PAGE : 0;
        this.featureRangeLabel.hidden = this.observations.length <= FEATURES_PER_PAGE;
        fillFeatureRanges(this.featureRange, this.observations.length, start);
        this.#fillFeatureList(start);
    }

    /** Populate one page of the open native list, keeping original selection indexes.
     * @param {number} start First zero-based feature in the picker. @return {void}
     */
    #fillFeatureList(start) {
        const list = this.featureList;
        const selected = this.selectedFeature();
        list.replaceChildren();
        const end = Math.min(start + FEATURES_PER_PAGE, this.observations.length);
        const onPage = selected !== null && selected >= start && selected < end;
        if (!onPage) {
            const prompt = list.ownerDocument.createElement("option");
            prompt.textContent = "Choose a feature";
            prompt.value = "";
            prompt.disabled = true;
            list.append(prompt);
        }
        for (let index = start; index < end; index++) {
            const option = list.ownerDocument.createElement("option");
            option.value = String(index);
            option.textContent = vectorFeatureLabel(this.observations[index], index);
            list.append(option);
        }
        list.value = onPage ? String(selected) : "";
    }

    /**
     * Close the open context picker and optionally return focus to its button.
     * @param {boolean} [focus=true] Restore keyboard focus when dismissing the picker.
     * @return {boolean} Whether a picker was open.
     */
    closePicker(focus = true) {
        const picker = this.activePicker;
        if (!picker) return false;
        picker.body.hidden = true;
        if (picker.button === this.featureButton) {
            this.featureList.replaceChildren();
            this.featureRange.replaceChildren();
        }
        picker.button.setAttribute("aria-expanded", "false");
        if (focus) picker.button.focus();
        this.activePicker = null;
        return true;
    }

    /** Release panel controls and size observation. @return {void} */
    destroy() {
        this.abort.abort();
    }
}

/** Keep searchable numeric field checkboxes stable while feature data changes. */
export class VectorPlotFields {
    /**
     * @param {Document} doc Owning document.
     * @param {string} prefix ID prefix for this field chooser.
     * @param {(names:string[])=>void} change Replace the plot's selected fields.
     */
    constructor(doc, prefix, change) {
        this.doc = doc;
        this.list = doc.querySelector("#" + prefix + "-field-list");
        this.empty = doc.querySelector("#" + prefix + "-field-empty");
        this.search = doc.querySelector("#" + prefix + "-field-search");
        this.match = doc.querySelector("#" + prefix + "-select-matching");
        this.clear = doc.querySelector("#" + prefix + "-clear-fields");
        this.change = change;
        this.rows = new Map();
        this.selected = [];
        this.available = new Map();
        this.abort = new AbortController();
        const listen = { signal: this.abort.signal };
        this.search.addEventListener("input", () => this.filter(), listen);
        this.match.addEventListener("click", () => change([...this.available.keys()].filter(name => this.matches(name))), listen);
        this.clear.addEventListener("click", () => change([]), listen);
    }

    /**
     * Match a field against the current case-insensitive search.
     * @param {string} name Source attribute name.
     * @return {boolean} Whether the search includes it.
     */
    matches(name) {
        return name.toLocaleLowerCase().includes(this.search.value.trim().toLocaleLowerCase());
    }

    /** Show matching controls without moving focus. @return {void} */
    filter() {
        let visible = 0;
        for (const [name, row] of this.rows) {
            row.hidden = !this.matches(name);
            if (!row.hidden) visible++;
        }
        this.empty.hidden = this.search.value.trim() === "" || visible > 0;
    }

    /**
     * Reconcile available and previously selected fields without replacing focused checkboxes.
     * @param {Map<string,string>} available Ordered field names and value or coverage text.
     * @param {string[]} selected Current choices, including fields absent from this feature.
     * @return {void}
     */
    update(available, selected) {
        this.available = available;
        this.selected = selected;
        const names = new Set([...available.keys(), ...selected]);
        let nextFocus = null;
        for (const [name, row] of this.rows) {
            if (names.has(name)) continue;
            if (row.contains(this.doc.activeElement)) {
                const siblings = [...this.list.children];
                const index = siblings.indexOf(row);
                const next = [...siblings.slice(index + 1), ...siblings.slice(0, index).reverse()]
                    .find(item => !item.hidden && names.has(item.children[0].value));
                nextFocus = next?.children[0] ?? this.search;
            }
            row.remove();
            this.rows.delete(name);
        }
        const sorted = [...names].sort(FIELD_ORDER.compare);
        const checked = new Set(selected);
        for (const [index, name] of sorted.entries()) {
            if (!this.rows.has(name)) {
                const row = this.doc.createElement("label");
                row.classList.add("vector-feature-profile-field");
                const box = this.doc.createElement("input");
                box.type = "checkbox";
                box.value = name;
                box.addEventListener("change", () => this.change(box.checked
                    ? [...new Set([...this.selected, name])] : this.selected.filter(item => item !== name)));
                const text = this.doc.createElement("span");
                text.textContent = name;
                row.append(box, text, this.doc.createElement("span"));
                this.rows.set(name, row);
            }
            const row = this.rows.get(name);
            row.children[0].checked = checked.has(name);
            row.children[2].textContent = available.get(name) ?? "No value";
            if (this.list.children[index] !== row) this.list.insertBefore(row, this.list.children[index] ?? null);
        }
        this.filter();
        nextFocus?.focus();
    }

    /** Release chooser listeners. @return {void} */
    destroy() { this.abort.abort(); }
}

/**
 * Label one observation even when the same feature ID occurs in different layers.
 * @param {import("./inspection-observation.js").VectorInspectionObservation} observation Inspected feature.
 * @param {number} index Position in the inspector's bounded sample.
 * @return {string} Layer and feature identity for the chooser.
 */
export function vectorFeatureLabel(observation, index) {
    return observation.layerLabel + " · " + (observation.featureId ?? "Feature " + (index + 1));
}

/**
 * Measure a field value from an integer origin before converting to chart coordinates.
 * The fractional part of an ordinary reading is retained on mixed numeric axes.
 * @param {number|bigint} value Original numeric reading.
 * @param {bigint|undefined} origin Exact origin, or undefined for an ordinary absolute scale.
 * @return {number} Distance in source units.
 */
function fieldCoordinate(value, origin) {
    if (origin === undefined) return Number(value);
    if (typeof value === "bigint") return Number(value - origin);
    return Number(BigInt(Math.trunc(value)) - origin) + value % 1;
}

/** Shorten a long numeric label while keeping its leading and trailing digits.
 * Signed 64-bit integers fit unchanged. Callers retain the full reading in
 * accessible descriptions and tooltips; this changes display text only.
 * @param {string} text Formatted numeric reading.
 * @return {string} Original text or a compact label with an explicit ellipsis.
 */
function abbreviateNumericLabel(text) {
    return text.length <= 28 ? text : text.slice(0, 12) + "…" + text.slice(-12);
}

/**
 * Draw a feature plot with exact readings for labels, selection and values.
 * Nearby wide integers are spaced by their exact difference. Bars retain a
 * zero baseline. Numeric X ticks show original field values. Long numeric
 * captions are abbreviated; tooltips and accessible descriptions retain them in full.
 * @template {{xValue:number|bigint|string|boolean|null,xLabel:string,yValue:number|bigint|null}} Point
 * @param {Omit<Parameters<typeof renderOrdinalSeriesChart>[0],"series"|"points"|"pointAccessibleLabel"|"pointTooltip"|"onPointSelect"> &
 * {points:Point[],pointAccessibleLabel:(point:Point)=>string,pointTooltip:(point:Point)=>string,onPointSelect:(point:Point)=>void}} options Single-feature or comparison chart.
 * @return {{pointElements:{circle:SVGElement,point:Point}[]}|null} Marks tied to original observations, or null when coordinates or their domain exceed finite numbers.
 * @throws {TypeError} If the underlying chart receives invalid positions or no plottable reading.
 */
export function renderVectorFieldChart(options) {
    const {points, xScale, chartType} = options;
    const firstWideX = xScale === "numeric" ? points.find(point => typeof point.xValue === "bigint") : undefined;
    const firstWideY = points.find(point => typeof point.yValue === "bigint");
    if (!firstWideX && !firstWideY) return renderOrdinalSeriesChart(options);

    const xOrigin = firstWideX?.xValue;
    const yOrigin = chartType === "bar" ? undefined : firstWideY?.yValue;
    const coordinates = points.map(point => ({
        original: point,
        xLabel: point.xLabel,
        xValue: xScale === "numeric" ? fieldCoordinate(point.xValue, xOrigin) : point.xValue,
        yValue: point.yValue === null ? null : fieldCoordinate(point.yValue, yOrigin),
    }));
    if (coordinates.some(point =>
        (point.yValue !== null && !Number.isFinite(point.yValue)) ||
        (xScale === "numeric" && !Number.isFinite(point.xValue)))) return null;

    const originText = yOrigin === undefined ? "" : String(yOrigin);
    const originLabel = abbreviateNumericLabel(originText);
    const rendered = renderOrdinalSeriesChart({
        ...options,
        // A signed 64-bit coordinate needs up to 20 characters, including its sign.
        ...(firstWideX ? {xTickLabelLimit:20, axisFontSize:11} : {}),
        points: coordinates,
        yAxisLabel: yOrigin === undefined ? options.yAxisLabel : options.yAxisLabel + " relative to\n" + originLabel,
        yAxisLabelPosition: yOrigin === undefined ? options.yAxisLabelPosition : "top",
        ...(originLabel !== originText ? {
            yAxisLabelTooltip: originText,
            ariaLabel: options.ariaLabel + "; " + options.yAxisLabel + " relative to " + originText,
        } : {}),
        pointAccessibleLabel: point => options.pointAccessibleLabel(point.original),
        pointTooltip: point => options.pointTooltip(point.original),
        onPointSelect: point => options.onPointSelect(point.original),
    });
    return rendered === null ? null : {
        pointElements: rendered.pointElements.map(({circle, point}) => ({circle, point:point.original})),
    };
}

/**
 * Label the peak of a profile or the readings in a small bar comparison.
 * Labels use the actual painted bar centers, including distinct features at the same X.
 * Long readings use a visible ellipsis without replacing the marks' full readings.
 * @param {SVGElement} chart Rendered comparison or profile SVG.
 * @param {{circle:SVGElement,point:{yValue:number|bigint}}[]} marks Selectable plotted observations.
 * @param {"line"|"scatter"|"bar"} shape Chart style.
 * @return {void}
 */
export function labelVectorPlotValues(chart, marks, shape) {
    if (!marks.length) return;
    const peak = marks.reduce((best, entry) => entry.point.yValue > best.point.yValue ? entry : best);
    const candidates = shape === "bar" && marks.length <= 6
        ? [peak, ...marks.filter(entry => entry !== peak)] : [peak];
    const placed = [];
    const width = Number(chart.getAttribute("viewBox").split(" ")[2]);
    for (const {circle, point} of candidates) {
        const formatted = formatSeriesNumber(point.yValue);
        const text = abbreviateNumericLabel(formatted);
        const half = text.length * 3.6;
        const center = shape === "bar" ? Number(circle.getAttribute("x")) + Number(circle.getAttribute("width")) / 2
            : Number(circle.getAttribute("cx"));
        const x = Math.max(half + 2, Math.min(width - half - 2, center));
        const y = Math.max(12, Number(circle.getAttribute("cy")) - 7);
        if (placed.some(label => Math.abs(label.x - x) < label.half + half + 3 && Math.abs(label.y - y) < 14)) continue;
        const label = chart.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("class", "vector-plot-value");
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("aria-hidden", "true");
        label.setAttribute("x", String(x));
        label.setAttribute("y", String(y));
        label.textContent = text;
        chart.append(label);
        placed.push({x,y,half});
    }
}
