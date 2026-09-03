/** Ordered numeric analysis for bounded vector feature-inspection results. */

import {
    formatSeriesNumber,
    renderOrdinalSeriesChart,
} from "./series-chart.js";
import { validateVectorInspectionObservations } from "./inspection-observation.js";

export const VECTOR_TIME_SERIES_LAYER_LABEL = "__eolab_layer_label__";

const NATURAL_TEXT = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
});

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
            sourceId: observation.sourceId,
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

/** Own persistent vector-series configuration and presentation. */
export class VectorTimeSeriesController {
    /**
     * Configure the vector-series analysis component.
     *
     * @param {Object} configuration Collaborators.
     * @param {(visible:boolean,moveFocus:boolean)=>void}
     * configuration.onVisibilityChange Requests presentation through composition.
     * @param {(sourceId:string)=>boolean} configuration.onSourceLayerZoom
     * Requests source-layer navigation through application composition.
     * @param {Document} [configuration.documentContext=document] DOM owner.
     */
    constructor({
        onVisibilityChange,
        onSourceLayerZoom,
        documentContext = document,
    }) {
        if (typeof onVisibilityChange !== "function") {
            throw new TypeError("onVisibilityChange must be a function.");
        }
        if (typeof onSourceLayerZoom !== "function") {
            throw new TypeError("onSourceLayerZoom must be a function.");
        }
        this.onVisibilityChange = onVisibilityChange;
        this.onSourceLayerZoom = onSourceLayerZoom;
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
        this.chartType = documentContext.querySelector(
            "#vector-time-series-chart-type"
        );
        this.status = documentContext.querySelector(
            "#vector-time-series-status"
        );
        this.chart = documentContext.querySelector("#vector-time-series-chart");
        this.table = documentContext.querySelector("#vector-time-series-table");
        this.tableBody = documentContext.querySelector(
            "#vector-time-series-table-body"
        );
        this.selection = documentContext.querySelector(
            "#vector-time-series-selection"
        );
        this.selectionText = documentContext.querySelector(
            "#vector-time-series-selection-text"
        );
        this.zoomSourceButton = documentContext.querySelector(
            "#zoom-vector-time-series-source"
        );
        this.observations = Object.freeze([]);
        this.pointElements = [];
        this.selectedPoint = null;
        this.sampleState = "empty";
        this.sampleMessage = "Click the map to inspect vector features first.";
        this.settings = {
            xField: VECTOR_TIME_SERIES_LAYER_LABEL,
            yField: null,
            direction: "ascending",
            chartType: "line",
        };
        this.onClose = () => this.close({ moveFocus: true });
        this.onControlChange = () => {
            this.settings.xField = this.xField.value;
            this.settings.yField = this.yField.value || null;
            this.settings.direction = this.direction.value;
            this.settings.chartType = this.chartType.value;
            this.render();
        };
        this.onZoomSource = () => {
            if (this.selectedPoint === null) return;
            if (this.onSourceLayerZoom(this.selectedPoint.sourceId)) return;
            this.zoomSourceButton.disabled = true;
            this.selectionText.textContent =
                `${this.#pointIdentity(this.selectedPoint)} · ` +
                "Source layer is no longer available.";
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
        this.chartType.addEventListener("change", this.onControlChange);
        this.zoomSourceButton.addEventListener("click", this.onZoomSource);
        this.document.addEventListener("keydown", this.onKeydown);
        this.render();
    }

    /** Reveal the series panel without changing its sample. @return {void} */
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
     * Replace the bounded sample while retaining chart settings.
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
        this.#clearPointSelection();
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
        this.chartType.value = this.settings.chartType;
        this.chart.replaceChildren();
        this.pointElements = [];
        this.tableBody.replaceChildren();
        this.chart.setAttribute("hidden", "");
        this.table.hidden = true;
        if (this.sampleState !== "ready") {
            this.#clearPointSelection();
            this.status.textContent = this.sampleMessage;
            return;
        }
        if (this.settings.yField === null) {
            this.#clearPointSelection();
            this.status.textContent =
                "No finite numeric attribute is available for the Y axis.";
            return;
        }
        const series = buildVectorTimeSeriesSeries(
            this.observations,
            this.settings
        );
        if (series.points.length === 0) {
            this.#clearPointSelection();
            this.status.textContent =
                `No inspection result has both ${this.#xAxisLabel()} and ` +
                `a finite ${this.settings.yField} value.`;
            return;
        }
        if (
            this.selectedPoint !== null &&
            !series.points.some((point) =>
                point.sourceIndex === this.selectedPoint.sourceIndex
            )
        ) {
            this.#clearPointSelection();
        }
        this.pointElements = renderOrdinalSeriesChart({
            documentContext: this.document,
            chart: this.chart,
            points: series.points,
            chartType: this.settings.chartType,
            xAxisLabel: this.#xAxisLabel(),
            yAxisLabel: this.settings.yField,
            ariaLabel: `Vector series ${this.settings.chartType} chart showing ` +
                `${this.settings.yField} by ${this.#xAxisLabel()} for ` +
                `${series.points.length} observations.`,
            pointAccessibleLabel: (point) => this.#pointIdentity(point),
            pointTooltip: (point) =>
                `${point.layerLabel} · ${point.featureId ?? "No feature ID"} · ` +
                `${point.xLabel} · ${formatSeriesNumber(point.yValue)}`,
            onPointSelect: (point) => this.#selectPoint(point),
        }).pointElements;
        if (this.selectedPoint !== null) {
            const selected = series.points.find((point) =>
                point.sourceIndex === this.selectedPoint.sourceIndex
            );
            if (selected !== undefined) this.#selectPoint(selected);
        }
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
     * Return a concise accessible identity for one plotted observation.
     *
     * @param {Object} point Plotted observation.
     * @return {string} Source layer, feature, and plotted values.
     */
    #pointIdentity(point) {
        return `Source layer: ${point.layerLabel} · Feature: ` +
            `${point.featureId ?? "No feature ID"} · X: ${point.xLabel} · ` +
            `Y: ${formatSeriesNumber(point.yValue)}`;
    }

    /**
     * Select one plotted observation without redrawing or moving keyboard focus.
     *
     * @param {Object} point Plotted observation.
     * @return {void}
     */
    #selectPoint(point) {
        this.selectedPoint = point;
        for (const entry of this.pointElements) {
            const selected = entry.point.sourceIndex === point.sourceIndex;
            if (selected) entry.circle.classList.add("is-selected");
            else entry.circle.classList.remove("is-selected");
            entry.circle.setAttribute("aria-pressed", String(selected));
        }
        this.selectionText.textContent = this.#pointIdentity(point);
        this.selection.hidden = false;
        this.zoomSourceButton.disabled = false;
    }

    /** Clear selected-point presentation and retained navigation identity. @return {void} */
    #clearPointSelection() {
        this.selectedPoint = null;
        this.pointElements = [];
        this.selection.hidden = true;
        this.selectionText.textContent = "";
        this.zoomSourceButton.disabled = true;
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
                formatSeriesNumber(point.yValue),
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
        this.chartType.removeEventListener("change", this.onControlChange);
        this.zoomSourceButton.removeEventListener("click", this.onZoomSource);
        this.document.removeEventListener("keydown", this.onKeydown);
        this.onVisibilityChange(false, false);
    }
}
