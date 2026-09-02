/** Ordered numeric analysis for bounded vector feature-inspection results. */

export const VECTOR_TIME_SERIES_LAYER_LABEL = "__eolab_layer_label__";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CHART_WIDTH = 680;
const CHART_HEIGHT = 360;
const CHART_MARGIN = Object.freeze({ top: 20, right: 24, bottom: 92, left: 72 });
const NATURAL_TEXT = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
});

/**
 * @typedef {Object} VectorInspectionObservation
 * @property {string} layerLabel User-facing source layer or filename.
 * @property {string|number|null} featureId Bounded feature identity.
 * @property {Readonly<Record<string,string|number|boolean|null>>} properties
 * Scalar attributes returned by the existing feature inspection.
 */

/**
 * @typedef {Object} VectorTimeSeriesSettings
 * @property {string} xField Layer-label sentinel or inspected attribute name.
 * @property {string|null} yField Numeric inspected attribute name.
 * @property {"ascending"|"descending"} direction Sort direction.
 */

/**
 * Return whether an attribute can label and order a chart observation.
 *
 * @param {unknown} value Candidate inspected attribute.
 * @return {boolean} Whether the value is a supported scalar X value.
 */
function isOrderableValue(value) {
    return (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    );
}

/**
 * Validate the closed inspection-observation boundary.
 *
 * @param {unknown} observations Candidate observations from composition.
 * @return {VectorInspectionObservation[]} Validated observations.
 * @throws {TypeError} If composition violates the observation contract.
 */
export function validateVectorInspectionObservations(observations) {
    if (!Array.isArray(observations)) {
        throw new TypeError("Vector inspection observations must be an array.");
    }
    for (const observation of observations) {
        if (
            typeof observation?.layerLabel !== "string" ||
            observation.layerLabel.length === 0 ||
            !(
                observation.featureId === null ||
                typeof observation.featureId === "string" ||
                typeof observation.featureId === "number"
            ) ||
            observation.properties === null ||
            typeof observation.properties !== "object" ||
            Array.isArray(observation.properties)
        ) {
            throw new TypeError("Invalid vector inspection observation.");
        }
        for (const value of Object.values(observation.properties)) {
            if (!(
                value === null ||
                typeof value === "string" ||
                typeof value === "boolean" ||
                typeof value === "number"
            )) {
                throw new TypeError(
                    "Vector inspection properties must contain JSON scalars."
                );
            }
        }
    }
    return observations;
}

/**
 * Summarize usable X and numeric Y fields without requiring a common schema.
 *
 * @param {VectorInspectionObservation[]} observations Validated observations.
 * @return {{xFields:Object[],numericFields:Object[]}} Field names and coverage.
 */
export function summarizeVectorTimeSeriesFields(observations) {
    validateVectorInspectionObservations(observations);
    const xCoverage = new Map();
    const numericCoverage = new Map();
    for (const observation of observations) {
        for (const [name, value] of Object.entries(observation.properties)) {
            if (isOrderableValue(value)) {
                xCoverage.set(name, (xCoverage.get(name) ?? 0) + 1);
            }
            if (typeof value === "number" && Number.isFinite(value)) {
                numericCoverage.set(name, (numericCoverage.get(name) ?? 0) + 1);
            }
        }
    }
    const summarize = (coverage) => [...coverage]
        .sort(([left], [right]) => NATURAL_TEXT.compare(left, right))
        .map(([name, count]) => ({ name, count, total: observations.length }));
    return {
        xFields: summarize(xCoverage),
        numericFields: summarize(numericCoverage),
    };
}

/**
 * Format one supported scalar as an axis or table label.
 *
 * @param {string|number|boolean} value Scalar chart value.
 * @return {string} Stable user-facing label.
 */
function formatScalar(value) {
    if (typeof value === "boolean") {
        return value ? "True" : "False";
    }
    return String(value);
}

/**
 * Compare supported scalar X values, preserving a deterministic natural order.
 *
 * @param {string|number|boolean} left Left value.
 * @param {string|number|boolean} right Right value.
 * @return {number} Negative, zero, or positive comparison result.
 */
function compareXValues(left, right) {
    if (typeof left === "number" && typeof right === "number") {
        return left - right;
    }
    return NATURAL_TEXT.compare(formatScalar(left), formatScalar(right));
}

/**
 * Build ordered chart points while retaining duplicate X observations.
 *
 * @param {VectorInspectionObservation[]} observations Inspection results.
 * @param {VectorTimeSeriesSettings} settings Persistent chart settings.
 * @return {{points:Object[],omitted:number,total:number}} Ordered plot contract.
 */
export function buildVectorTimeSeriesSeries(observations, settings) {
    validateVectorInspectionObservations(observations);
    if (
        typeof settings?.xField !== "string" ||
        !(
            settings.yField === null ||
            typeof settings.yField === "string"
        ) ||
        !["ascending", "descending"].includes(settings.direction)
    ) {
        throw new TypeError("Invalid vector time-series settings.");
    }
    if (settings.yField === null) {
        return { points: [], omitted: observations.length, total: observations.length };
    }
    const points = [];
    observations.forEach((observation, sourceIndex) => {
        const xValue = settings.xField === VECTOR_TIME_SERIES_LAYER_LABEL
            ? observation.layerLabel
            : observation.properties[settings.xField];
        const yValue = observation.properties[settings.yField];
        if (!isOrderableValue(xValue) || !(
            typeof yValue === "number" && Number.isFinite(yValue)
        )) {
            return;
        }
        points.push({
            sourceIndex,
            layerLabel: observation.layerLabel,
            featureId: observation.featureId,
            xValue,
            xLabel: formatScalar(xValue),
            yValue,
        });
    });
    points.sort((left, right) => {
        const compared = compareXValues(left.xValue, right.xValue);
        if (compared !== 0) {
            return settings.direction === "ascending" ? compared : -compared;
        }
        return left.sourceIndex - right.sourceIndex;
    });
    return {
        points,
        omitted: observations.length - points.length,
        total: observations.length,
    };
}

/**
 * Return compact finite-number text for axes and the accessible table.
 *
 * @param {number} value Finite number.
 * @return {string} Compact localized value.
 */
function formatNumber(value) {
    return new Intl.NumberFormat("en", {
        maximumSignificantDigits: 6,
    }).format(value);
}

/**
 * Keep dense ordinal tick labels readable while full values remain in details.
 *
 * @param {string} label Full X label.
 * @param {number} [maximum=28] Maximum visible characters.
 * @return {string} Bounded tick label.
 */
function formatTickLabel(label, maximum = 28) {
    return label.length <= maximum
        ? label
        : `${label.slice(0, maximum - 1)}…`;
}

/**
 * Choose bounded ordinal tick indexes including both endpoints.
 *
 * @param {number} count Point count.
 * @param {number} [maximum=7] Maximum labels.
 * @return {number[]} Unique point indexes.
 */
function ordinalTickIndexes(count, maximum = 7) {
    if (count <= maximum) {
        return Array.from({ length: count }, (_, index) => index);
    }
    return [...new Set(Array.from(
        { length: maximum },
        (_, index) => Math.round(index * (count - 1) / (maximum - 1))
    ))];
}

/** Own persistent vector time-series configuration and presentation. */
export class VectorTimeSeriesController {
    /**
     * Configure the vector time-series analysis component.
     *
     * @param {Object} configuration Collaborators.
     * @param {(visible:boolean,moveFocus:boolean)=>void}
     * configuration.onVisibilityChange Requests presentation through composition.
     * @param {Document} [configuration.documentContext=document] DOM owner.
     */
    constructor({
        onVisibilityChange,
        documentContext = document,
    }) {
        if (typeof onVisibilityChange !== "function") {
            throw new TypeError("onVisibilityChange must be a function.");
        }
        this.onVisibilityChange = onVisibilityChange;
        this.document = documentContext;
        this.panel = documentContext.querySelector("#vector-time-series");
        this.closeButton = documentContext.querySelector(
            "#close-vector-time-series"
        );
        this.xField = documentContext.querySelector("#vector-time-series-x");
        this.yField = documentContext.querySelector("#vector-time-series-y");
        this.direction = documentContext.querySelector(
            "#vector-time-series-direction"
        );
        this.status = documentContext.querySelector(
            "#vector-time-series-status"
        );
        this.chart = documentContext.querySelector("#vector-time-series-chart");
        this.table = documentContext.querySelector("#vector-time-series-table");
        this.tableBody = documentContext.querySelector(
            "#vector-time-series-table-body"
        );
        this.observations = Object.freeze([]);
        this.sampleState = "empty";
        this.sampleMessage = "Click the map to inspect vector features first.";
        this.settings = {
            xField: VECTOR_TIME_SERIES_LAYER_LABEL,
            yField: null,
            direction: "ascending",
        };
        this.onClose = () => this.close({ moveFocus: true });
        this.onControlChange = () => {
            this.settings.xField = this.xField.value;
            this.settings.yField = this.yField.value || null;
            this.settings.direction = this.direction.value;
            this.render();
        };
        this.onKeydown = (event) => {
            if (
                event.key !== "Escape" ||
                this.panel.hidden ||
                !this.panel.contains(this.document.activeElement)
            ) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.close({ moveFocus: true });
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.xField.addEventListener("change", this.onControlChange);
        this.yField.addEventListener("change", this.onControlChange);
        this.direction.addEventListener("change", this.onControlChange);
        this.document.addEventListener("keydown", this.onKeydown);
        this.render();
    }

    /** Reveal the time-series panel without changing its sample. @return {void} */
    open() {
        this.onVisibilityChange(true, false);
        this.render();
    }

    /**
     * Hide the panel without clearing sample or persistent field settings.
     *
     * @param {Object} [options] Close options.
     * @param {boolean} [options.moveFocus=false] Restore map focus.
     * @return {void}
     */
    close({ moveFocus = false } = {}) {
        this.onVisibilityChange(false, moveFocus);
    }

    /**
     * Replace the bounded sample while retaining X, Y, and direction settings.
     *
     * @param {Object} sample Immutable inspector-owned sample envelope.
     * @param {"loading"|"ready"|"empty"|"invalidated"} sample.state State.
     * @param {VectorInspectionObservation[]} sample.observations Results.
     * @param {string} sample.message Browser-safe status text.
     * @return {void}
     */
    setSample(sample) {
        if (
            !["loading", "ready", "empty", "invalidated"].includes(
                sample?.state
            ) ||
            typeof sample?.message !== "string"
        ) {
            throw new TypeError("Invalid vector inspection sample.");
        }
        validateVectorInspectionObservations(sample.observations);
        this.sampleState = sample.state;
        this.sampleMessage = sample.message;
        this.observations = Object.freeze([...sample.observations]);
        const { numericFields } = summarizeVectorTimeSeriesFields(
            this.observations
        );
        if (this.settings.yField === null && numericFields.length > 0) {
            this.settings.yField = numericFields[0].name;
        }
        this.render();
    }

    /** Render controls, chart, table, and coverage status. @return {void} */
    render() {
        const fields = summarizeVectorTimeSeriesFields(this.observations);
        this.#renderFieldOptions(fields);
        this.direction.value = this.settings.direction;
        this.chart.replaceChildren();
        this.tableBody.replaceChildren();
        this.chart.setAttribute("hidden", "");
        this.table.hidden = true;
        if (this.sampleState !== "ready") {
            this.status.textContent = this.sampleMessage;
            return;
        }
        if (this.settings.yField === null) {
            this.status.textContent =
                "No finite numeric attribute is available for the Y axis.";
            return;
        }
        const series = buildVectorTimeSeriesSeries(
            this.observations,
            this.settings
        );
        if (series.points.length === 0) {
            this.status.textContent =
                `No inspection result has both ${this.#xAxisLabel()} and ` +
                `a finite ${this.settings.yField} value.`;
            return;
        }
        this.#renderChart(series.points);
        this.#renderTable(series.points);
        const plotted = `${series.points.length.toLocaleString()} of ` +
            `${series.total.toLocaleString()} inspection results plotted.`;
        this.status.textContent = series.omitted === 0
            ? plotted
            : `${plotted} ${series.omitted.toLocaleString()} omitted because ` +
              "a selected field was missing or the Y value was not numeric.";
    }

    /**
     * Rebuild X and Y choices with per-sample coverage counts.
     *
     * @param {{xFields:Object[],numericFields:Object[]}} fields Field summary.
     * @return {void}
     */
    #renderFieldOptions(fields) {
        const total = this.observations.length;
        const xOptions = [{
            name: VECTOR_TIME_SERIES_LAYER_LABEL,
            label: `Filename or layer — ${total} of ${total}`,
        }, ...fields.xFields.map((field) => ({
            name: field.name,
            label: `${field.name} — ${field.count} of ${field.total}`,
        }))];
        if (!xOptions.some((option) => option.name === this.settings.xField)) {
            xOptions.push({
                name: this.settings.xField,
                label: `${this.settings.xField} — unavailable in this sample`,
            });
        }
        const yOptions = fields.numericFields.map((field) => ({
            name: field.name,
            label: `${field.name} — ${field.count} of ${field.total}`,
        }));
        if (
            this.settings.yField !== null &&
            !yOptions.some((option) => option.name === this.settings.yField)
        ) {
            yOptions.push({
                name: this.settings.yField,
                label: `${this.settings.yField} — unavailable in this sample`,
            });
        }
        this.#replaceOptions(this.xField, xOptions, this.settings.xField);
        this.#replaceOptions(
            this.yField,
            yOptions.length > 0 ? yOptions : [{ name: "", label: "No numeric fields" }],
            this.settings.yField ?? ""
        );
    }

    /**
     * Replace one select's options without relying on browser option mutation.
     *
     * @param {HTMLSelectElement} select Select element.
     * @param {{name:string,label:string}[]} options Closed options.
     * @param {string} selected Selected value.
     * @return {void}
     */
    #replaceOptions(select, options, selected) {
        select.replaceChildren(...options.map(({ name, label }) => {
            const option = this.document.createElement("option");
            option.value = name;
            option.textContent = label;
            return option;
        }));
        select.value = selected;
    }

    /** @return {string} User-facing X field label. */
    #xAxisLabel() {
        return this.settings.xField === VECTOR_TIME_SERIES_LAYER_LABEL
            ? "filename or layer"
            : this.settings.xField;
    }

    /**
     * Append one namespaced SVG element with string attributes.
     *
     * @param {string} name SVG element name.
     * @param {Record<string,string|number>} attributes SVG attributes.
     * @param {string|null} [text=null] Optional text content.
     * @return {SVGElement} New SVG element.
     */
    #svg(name, attributes, text = null) {
        const element = this.document.createElementNS(SVG_NAMESPACE, name);
        for (const [attribute, value] of Object.entries(attributes)) {
            element.setAttribute(attribute, String(value));
        }
        if (text !== null) element.textContent = text;
        return element;
    }

    /**
     * Draw an ordinal line-and-point chart with numeric Y axes.
     *
     * @param {Object[]} points Ordered plot points.
     * @return {void}
     */
    #renderChart(points) {
        const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
        const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
        const values = points.map((point) => point.yValue);
        let minimum = Math.min(...values);
        let maximum = Math.max(...values);
        if (minimum === maximum) {
            const padding = Math.abs(minimum) * 0.1 || 1;
            minimum -= padding;
            maximum += padding;
        }
        const x = (index) => points.length === 1
            ? CHART_MARGIN.left + plotWidth / 2
            : CHART_MARGIN.left + index * plotWidth / (points.length - 1);
        const y = (value) => CHART_MARGIN.top +
            (maximum - value) * plotHeight / (maximum - minimum);
        this.chart.setAttribute("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
        this.chart.setAttribute(
            "aria-label",
            `Vector time series showing ${this.settings.yField} by ` +
            `${this.#xAxisLabel()} for ${points.length} observations.`
        );
        const xAxisY = CHART_MARGIN.top + plotHeight;
        this.chart.append(
            this.#svg("line", {
                class: "vector-time-series-axis",
                x1: CHART_MARGIN.left,
                y1: xAxisY,
                x2: CHART_MARGIN.left + plotWidth,
                y2: xAxisY,
            }),
            this.#svg("line", {
                class: "vector-time-series-axis",
                x1: CHART_MARGIN.left,
                y1: CHART_MARGIN.top,
                x2: CHART_MARGIN.left,
                y2: xAxisY,
            })
        );
        for (let index = 0; index < 5; index += 1) {
            const value = minimum + (maximum - minimum) * index / 4;
            const tickY = y(value);
            this.chart.append(
                this.#svg("line", {
                    class: "vector-time-series-grid",
                    x1: CHART_MARGIN.left,
                    y1: tickY,
                    x2: CHART_MARGIN.left + plotWidth,
                    y2: tickY,
                }),
                this.#svg("text", {
                    class: "vector-time-series-tick",
                    x: CHART_MARGIN.left - 10,
                    y: tickY + 4,
                    "text-anchor": "end",
                }, formatNumber(value))
            );
        }
        for (const index of ordinalTickIndexes(points.length)) {
            const tickX = x(index);
            this.chart.append(
                this.#svg("line", {
                    class: "vector-time-series-axis",
                    x1: tickX,
                    y1: xAxisY,
                    x2: tickX,
                    y2: xAxisY + 5,
                }),
                this.#svg("text", {
                    class: "vector-time-series-x-tick",
                    x: tickX,
                    y: xAxisY + 16,
                    transform: `rotate(-35 ${tickX} ${xAxisY + 16})`,
                    "text-anchor": "end",
                }, formatTickLabel(points[index].xLabel))
            );
        }
        const path = points.map((point, index) =>
            `${index === 0 ? "M" : "L"}${x(index)},${y(point.yValue)}`
        ).join(" ");
        this.chart.append(this.#svg("path", {
            class: "vector-time-series-line",
            d: path,
        }));
        points.forEach((point, index) => {
            const circle = this.#svg("circle", {
                class: "vector-time-series-point",
                cx: x(index),
                cy: y(point.yValue),
                r: 4.5,
                tabindex: 0,
            });
            circle.append(this.#svg("title", {},
                `${point.layerLabel} · ${point.featureId ?? "No feature ID"} · ` +
                `${point.xLabel} · ${formatNumber(point.yValue)}`
            ));
            this.chart.append(circle);
        });
        this.chart.append(
            this.#svg("text", {
                class: "vector-time-series-axis-title",
                x: CHART_MARGIN.left + plotWidth / 2,
                y: CHART_HEIGHT - 8,
                "text-anchor": "middle",
            }, this.#xAxisLabel()),
            this.#svg("text", {
                class: "vector-time-series-axis-title",
                x: 16,
                y: CHART_MARGIN.top + plotHeight / 2,
                transform: `rotate(-90 16 ${CHART_MARGIN.top + plotHeight / 2})`,
                "text-anchor": "middle",
            }, this.settings.yField)
        );
        this.chart.removeAttribute("hidden");
    }

    /**
     * Render every plotted observation in an accessible compact table.
     *
     * @param {Object[]} points Ordered plot points.
     * @return {void}
     */
    #renderTable(points) {
        for (const point of points) {
            const row = this.document.createElement("tr");
            for (const value of [
                point.layerLabel,
                point.featureId ?? "No feature ID",
                point.xLabel,
                formatNumber(point.yValue),
            ]) {
                const cell = this.document.createElement("td");
                cell.textContent = String(value);
                row.append(cell);
            }
            this.tableBody.append(row);
        }
        this.table.hidden = false;
    }

    /** Release listeners while retaining no presentation state. @return {void} */
    destroy() {
        this.closeButton.removeEventListener("click", this.onClose);
        this.xField.removeEventListener("change", this.onControlChange);
        this.yField.removeEventListener("change", this.onControlChange);
        this.direction.removeEventListener("change", this.onControlChange);
        this.document.removeEventListener("keydown", this.onKeydown);
        this.onVisibilityChange(false, false);
    }
}
