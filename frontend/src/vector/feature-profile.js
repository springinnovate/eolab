/** Plot several numeric fields from one bounded vector feature observation. */

/** @typedef {import("./inspection-observation.js").VectorInspectionObservation} VectorInspectionObservation */
import {
    formatSeriesNumber,
    renderStackedSeriesChart,
} from "../charts/series-chart.js";

import { labelVectorPlotValues, renderVectorFieldChart, VectorPlotFields, VectorPlotPanel, vectorFeatureLabel } from "./plot-panel.js";
import { isNumericFeatureValue } from "./inspection-observation.js";
import { VectorPlotStatistics } from "./plot-statistics.js";

export const FEATURE_PROFILE_TITLE_NONE = "__eolab_no_title__";
export const FEATURE_PROFILE_TITLE_LAYER = "__eolab_layer_title__";

/**
 * Normalize and validate the inspector-owned position for the current feature.
 *
 * A missing position represents a standalone observation and therefore falls
 * back to a one-feature result set. The profile only consumes this navigation
 * state; it does not own or mutate the inspector result collection.
 *
 * @param {Object|null|undefined} navigation Inspector-owned feature position.
 * @return {{position:number,total:number,canPrevious:boolean,canNext:boolean}}
 * Validated immutable navigation state.
 */
function normalizeFeatureNavigation(navigation) {
    const value = navigation ?? {
        position: 1,
        total: 1,
        canPrevious: false,
        canNext: false,
    };
    if (
        !Number.isInteger(value.position) ||
        !Number.isInteger(value.total) ||
        value.total < 1 ||
        value.position < 1 ||
        value.position > value.total ||
        typeof value.canPrevious !== "boolean" ||
        typeof value.canNext !== "boolean" ||
        value.canPrevious !== (value.position > 1) ||
        value.canNext !== (value.position < value.total)
    ) {
        throw new TypeError("Invalid feature-profile navigation state.");
    }
    return Object.freeze({
        position: value.position,
        total: value.total,
        canPrevious: value.canPrevious,
        canNext: value.canNext,
    });
}

const NATURAL_TEXT = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
});

/**
 * Return naturally ordered field names with finite numeric values.
 *
 * @param {VectorInspectionObservation} observation Immutable inspector observation.
 * @return {string[]} Numeric field names.
 */
export function numericFeatureFields(observation) {
    return Object.entries(observation.properties)
        .filter(([, value]) => isNumericFeatureValue(value))
        .map(([name]) => name)
        .sort(NATURAL_TEXT.compare);
}

/**
 * Split a field name around its last finite unsigned decimal token.
 *
 * The unchanged prefix and suffix identify a repeated field-name family, so
 * CO2_2000 and CO2_2005 are suggested together, unlike CO2_total and CO2_mean.
 * Signs and scientific-notation mantissas remain in the prefix; axis selection
 * must not interpret their trailing unsigned token as a complete coordinate.
 *
 * @param {string} fieldName Attribute name.
 * @return {{value:number,prefix:string,suffix:string}|null} Numeric token and
 * surrounding text, or null when the name has no finite numeric token.
 */
function parseNumericFieldName(fieldName) {
    const matches = [...fieldName.matchAll(/\d+(?:\.\d+)?|\.\d+/g)];
    if (matches.length === 0) return null;
    const match = matches.at(-1);
    const value = Number(match[0]);
    return Number.isFinite(value) ? {
        value,
        prefix: fieldName.slice(0, match.index),
        suffix: fieldName.slice(match.index + match[0].length),
    } : null;
}

/**
 * Suggest a useful title attribute from conventional field names.
 *
 * @param {VectorInspectionObservation} observation Immutable inspector observation.
 * @return {string} Field name or the layer-title sentinel.
 */
export function suggestFeatureProfileTitle(observation) {
    const fieldNames = Object.keys(observation.properties);
    const exactPriority = ["node_nm", "name", "label"];
    for (const candidate of exactPriority) {
        const match = fieldNames.find((name) => name.toLowerCase() === candidate);
        if (match !== undefined) return match;
    }
    const suffixMatch = fieldNames.find((name) =>
        /(?:_nm|_name)$/i.test(name)
    );
    return suffixMatch ?? FEATURE_PROFILE_TITLE_LAYER;
}

/**
 * Build the visible identity for one feature-field plot.
 *
 * The configured title field wins when it contains a useful scalar. A
 * conventional name field is the next choice, followed by the stable feature
 * ID and a generic final fallback. The source layer and feature ID remain
 * explicit context even when a friendly name is available.
 *
 * @param {VectorInspectionObservation} observation Immutable inspector observation.
 * @param {string|null} [titleField=null] Configured chart-title field.
 * @return {{label:string,title:string,heading:string,context:string}} Identity.
 */
export function vectorFeatureProfilePresentation(
    observation,
    titleField = null
) {
    if (titleField !== null && typeof titleField !== "string") {
        throw new TypeError("Feature profile title field must be a string.");
    }
    const suggestedField = suggestFeatureProfileTitle(observation);
    const candidates = [titleField, suggestedField].filter((field, index, all) =>
        typeof field === "string" &&
        field !== FEATURE_PROFILE_TITLE_NONE &&
        field !== FEATURE_PROFILE_TITLE_LAYER &&
        all.indexOf(field) === index
    );
    let featureLabel = null;
    for (const field of candidates) {
        const value = observation.properties[field];
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (text.length > 0) {
            featureLabel = text;
            break;
        }
    }
    const featureId = observation.featureId === null
        ? null
        : String(observation.featureId);
    featureLabel ??= featureId ?? "Selected feature";
    const featureContext = featureId === null
        ? "Feature ID unavailable"
        : `Feature ID: ${featureId}`;
    return Object.freeze({
        label: `Feature · ${featureLabel}`,
        title: `Fields from ${featureLabel} · Layer: ` +
            `${observation.layerLabel} · ${featureContext}`,
        heading: titleField === FEATURE_PROFILE_TITLE_LAYER ? observation.layerLabel : featureLabel,
        context: `${observation.layerLabel} · ${featureContext}`,
    });
}

/**
 * Select the largest repeated numeric field-name family as an initial series.
 *
 * A family has identical text around its last finite number, so R2000 through
 * R2024 are selected together while unrelated numeric identifiers stay separate.
 *
 * @param {VectorInspectionObservation} observation Immutable inspector observation.
 * @return {string[]} Suggested field names.
 */
export function suggestFeatureProfileFields(observation) {
    const numericFields = numericFeatureFields(observation);
    const families = new Map();
    for (const fieldName of numericFields) {
        const parts = parseNumericFieldName(fieldName);
        if (parts === null) continue;
        const family = JSON.stringify([parts.prefix, parts.suffix]);
        if (!families.has(family)) families.set(family, []);
        families.get(family).push(fieldName);
    }
    const repeated = [...families.entries()]
        .filter(([, fields]) => fields.length >= 2)
        .sort(([leftName, left], [rightName, right]) =>
            right.length - left.length || NATURAL_TEXT.compare(leftName, rightName)
        );
    return repeated.length > 0 ? repeated[0][1] : numericFields;
}

/**
 * Build ordered points from selected fields while preserving missing values.
 * Numeric spacing requires at least two distinct numbers with identical text
 * around the final numeric token in every selected name. A preceding hyphen or
 * minus may be a sign or delimiter, so those names keep complete ordinal labels.
 * Scientific-notation exponents also retain full labels instead of becoming
 * coordinates without their mantissas.
 * Other unmatched selections also use complete labels and natural ordering.
 * Missing values retain their field's position without affecting this decision.
 *
 * @param {import("./inspection-observation.js").VectorInspectionObservation}
 * observation Validated inspection observation.
 * @param {Object} settings Per-source feature-profile settings.
 * @param {string[]} settings.selectedFields Selected attribute names.
 * @param {"ascending"|"descending"} settings.direction Sort direction.
 * @return {{points:{fieldName:string,xValue:number|null,xLabel:string,yValue:number|bigint|null}[],
 * finiteCount:number,missingCount:number,xAxisLabel:string,xScale:"numeric"|"ordinal"}}
 * Ordered chart model with its matching horizontal scale.
 * @throws {TypeError} If the observation or settings violate their contract.
 */
export function buildVectorFeatureProfile(observation, settings) {
    if (
        !Array.isArray(settings?.selectedFields) ||
        !settings.selectedFields.every((field) => typeof field === "string") ||
        !["ascending", "descending"].includes(settings.direction)
    ) {
        throw new TypeError("Invalid vector feature-profile settings.");
    }
    const selectedFields = [...new Set(settings.selectedFields)];
    const numericNames = selectedFields.map(parseNumericFieldName);
    const firstNumericName = numericNames[0];
    const usesNumericNames = numericNames.length >= 2 && firstNumericName !== null &&
        numericNames.every((parts) => parts !== null &&
            !/[-\u2212]\s*$/.test(parts.prefix) &&
            !/\d\.?[eE][+-]?\s*$/.test(parts.prefix) &&
            parts.prefix === firstNumericName.prefix &&
            parts.suffix === firstNumericName.suffix
        ) && new Set(numericNames.map((parts) => parts.value)).size === numericNames.length;
    const points = selectedFields.map((fieldName, index) => {
        const number = usesNumericNames ? numericNames[index].value : null;
        const value = observation.properties[fieldName];
        return {
            fieldName,
            xValue: number,
            xLabel: number === null ? fieldName : String(number),
            yValue: isNumericFeatureValue(value) ? value : null,
        };
    });
    points.sort((left, right) => {
        const compared = usesNumericNames
            ? left.xValue - right.xValue
            : NATURAL_TEXT.compare(left.fieldName, right.fieldName);
        return settings.direction === "ascending" ? compared : -compared;
    });
    const finiteCount = points.filter((point) => point.yValue !== null).length;
    return {
        points,
        finiteCount,
        missingCount: points.length - finiteCount,
        xAxisLabel: usesNumericNames ? "Number in field name" : "Field",
        xScale: usesNumericNames ? "numeric" : "ordinal",
    };
}

/** Own per-source feature-field configuration and its map-side presentation. */
export class VectorFeatureProfileController {
    /**
     * Configure the single-feature series component.
     *
     * @param {Object} configuration Collaborators.
     * @param {(visible:boolean,moveFocus:boolean)=>void}
     * configuration.onVisibilityChange Requests presentation through composition.
     * @param {(identity:{label:string,title:string}|null)=>void}
     * configuration.onPresentationChange Publishes a bounded dock identity
     * through application composition.
     * @param {(direction:"previous"|"next")=>void}
     * configuration.onNavigateFeature Publishes navigation intent through
     * application composition without knowing the inspector implementation.
     * @param {(focus:Readonly<Object>)=>boolean} configuration.onFeatureZoom
     * Publishes current-feature map navigation intent through composition.
     * @param {(index:number)=>void} configuration.onSelectFeature Select a result from the current sample.
     * @param {()=>void} configuration.onCompareFeatures Open the across-feature comparison.
     * @param {import("./plot-statistics.js").DescribeStatisticsSource} [configuration.describeStatisticsSource]
     * Look up the original layer and schema for whole-layer benchmarks.
     * @param {Document} [configuration.documentContext=document] DOM owner.
     */
    constructor({
        onVisibilityChange,
        onPresentationChange,
        onNavigateFeature,
        onSelectFeature,
        onCompareFeatures,
        onFeatureZoom,
        describeStatisticsSource = () => null,
        documentContext = document,
    }) {
        if (typeof onVisibilityChange !== "function") {
            throw new TypeError("onVisibilityChange must be a function.");
        }
        if (typeof onPresentationChange !== "function") {
            throw new TypeError("onPresentationChange must be a function.");
        }
        if (typeof onNavigateFeature !== "function") {
            throw new TypeError("onNavigateFeature must be a function.");
        }
        if (typeof onFeatureZoom !== "function") {
            throw new TypeError("onFeatureZoom must be a function.");
        }
        this.onVisibilityChange = onVisibilityChange;
        this.onPresentationChange = onPresentationChange;
        this.onNavigateFeature = onNavigateFeature;
        this.onFeatureZoom = onFeatureZoom;
        this.document = documentContext;
        this.panel = documentContext.querySelector("#vector-feature-profile");
        this.heading = documentContext.querySelector(
            "#vector-feature-profile-heading"
        );
        this.context = documentContext.querySelector(
            "#vector-feature-profile-context"
        );
        this.closeButton = documentContext.querySelector(
            "#close-vector-feature-profile"
        );
        this.previousFeature = documentContext.querySelector(
            "#previous-vector-feature-profile"
        );
        this.nextFeature = documentContext.querySelector(
            "#next-vector-feature-profile"
        );
        this.featurePosition = documentContext.querySelector(
            "#vector-feature-profile-position"
        );
        this.zoomFeatureButton = documentContext.querySelector(
            "#zoom-vector-feature-profile-feature"
        );
        this.titleField = documentContext.querySelector(
            "#vector-feature-profile-title-field"
        );
        this.direction = documentContext.querySelector(
            "#vector-feature-profile-direction"
        );
        this.chartType = documentContext.querySelector(
            "#vector-feature-profile-chart-type"
        );
        this.status = documentContext.querySelector(
            "#vector-feature-profile-status"
        );
        this.chart = documentContext.querySelector(
            "#vector-feature-profile-chart"
        );
        this.table = documentContext.querySelector(
            "#vector-feature-profile-table"
        );
        this.tableBody = documentContext.querySelector(
            "#vector-feature-profile-table-body"
        );
        this.currentObservation = null;
        this.currentNavigation = null;
        this.settingsBySource = new Map();
        this.plotPanel = new VectorPlotPanel(documentContext, "vector-feature-profile", () => this.render(),
            () => (this.currentNavigation?.position ?? 1) - 1);
        this.statistics = new VectorPlotStatistics(documentContext, "vector-feature-profile", describeStatisticsSource);
        this.chooser = new VectorPlotFields(documentContext, "vector-feature-profile", names => {
            const settings = this.#currentSettings();
            if (settings) { settings.selectedFields = names; this.render(); }
        });
        this.compare = documentContext.querySelector("#vector-feature-profile-compare");
        this.selection = documentContext.querySelector("#vector-feature-profile-selection");
        this.selectionText = documentContext.querySelector("#vector-feature-profile-selection-text");
        this.figure = documentContext.querySelector("#vector-feature-profile-figure");
        this.chartTitle = documentContext.querySelector("#vector-feature-profile-chart-title");
        this.legend = documentContext.querySelector("#vector-feature-profile-legend");
        this.xHeading = documentContext.querySelector("#vector-feature-profile-x-heading");
        this.selectedField = null;
        this.abort = new AbortController();
        const listen = { signal: this.abort.signal };
        this.plotPanel.featureList.addEventListener("change", () => {
            onSelectFeature(Number(this.plotPanel.featureList.value));
            this.plotPanel.closePicker();
        }, listen);
        this.compare.addEventListener("click", () => onCompareFeatures(), listen);
        this.modeActive = false;
        this.active = false;
        this.onClose = () => this.close({ moveFocus: true });
        this.onPreviousFeature = () => {
            if (!this.previousFeature.disabled) {
                this.onNavigateFeature("previous");
            }
        };
        this.onNextFeature = () => {
            if (!this.nextFeature.disabled) this.onNavigateFeature("next");
        };
        this.onZoomFeature = () => {
            if (this.currentObservation === null) return;
            if (this.onFeatureZoom(this.currentObservation.focus)) return;
            this.zoomFeatureButton.disabled = true;
            this.status.textContent = "Feature location is unavailable. The map has not moved.";
        };
        this.onSettingsChange = () => {
            const settings = this.#currentSettings();
            if (settings === null) return;
            settings.titleField = this.titleField.value;
            settings.direction = this.direction.value;
            settings.chartType = this.chartType.value;
            this.render();
        };
        this.onKeydown = (event) => {
            if (
                event.key !== "Escape" || this.panel.hidden ||
                !this.panel.contains(this.document.activeElement)
            ) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (!this.plotPanel.closePicker()) this.close({ moveFocus: true });
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.previousFeature.addEventListener("click", this.onPreviousFeature);
        this.nextFeature.addEventListener("click", this.onNextFeature);
        this.zoomFeatureButton.addEventListener("click", this.onZoomFeature);
        this.titleField.addEventListener("change", this.onSettingsChange);
        this.direction.addEventListener("change", this.onSettingsChange);
        this.chartType.addEventListener("change", this.onSettingsChange);
        this.document.addEventListener("keydown", this.onKeydown);
        this.render();
    }

    /**
     * Activate feature-field plotting and reveal the current observation.
     *
     * Later observations reopen the presentation until the user closes it.
     *
     * @return {void}
     */
    open() {
        if (this.currentObservation === null) return;
        this.modeActive = true;
        this.onVisibilityChange(true, false);
        this.setActive(true);
        this.document.querySelector("#vector-feature-profile-one").focus();
    }

    /**
     * Deactivate and hide the panel while retaining per-source plotting rules.
     *
     * @param {Object} [options] Close options.
     * @param {boolean} [options.moveFocus=false] Restore map focus.
     * @return {void}
     */
    close({ moveFocus = false } = {}) {
        this.modeActive = false;
        this.setActive(false);
        this.onVisibilityChange(false, moveFocus);
    }

    /** Render this feature's fields while One feature is in front of the dock.
     * @param {boolean} active Whether the expanded dock presents One feature.
     * @return {void}
     */
    setActive(active) {
        if (this.active === active) return;
        this.active = active;
        if (!active) this.plotPanel.closePicker(false);
        this.render();
    }

    /**
     * Replace the current immutable feature observation.
     *
     * Each source starts with bars and reuses its settings for later features
     * from that layer. An active plot temporarily hides when the observation
     * is null and reopens when a later feature becomes current.
     *
     * @param {VectorInspectionObservation|null} observation Immutable inspector result or null.
     * @param {Object|null} [navigation=null] Inspector-owned result position.
     * @return {void}
     */
    setCurrentObservation(observation, navigation = null) {
        let normalizedNavigation = null;
        if (observation !== null) {
            normalizedNavigation = normalizeFeatureNavigation(navigation);
        }
        this.currentObservation = observation;
        this.currentNavigation = normalizedNavigation;
        this.plotPanel.syncSelectedFeature();
        if (observation === null && !this.panel.hidden) {
            this.onVisibilityChange(false, false);
        }
        if (
            observation !== null &&
            !this.settingsBySource.has(observation.sourceId)
        ) {
            this.settingsBySource.set(observation.sourceId, {
                selectedFields: suggestFeatureProfileFields(observation),
                titleField: suggestFeatureProfileTitle(observation),
                direction: "ascending",
                chartType: "bar",
            });
        }
        if (observation !== null && this.modeActive && this.panel.hidden) {
            this.onVisibilityChange(true, false);
        }
        this.selectedField = null;
        this.chooser.search.value = "";
        this.render();
    }

    /**
     * Retain the selection for direct navigation when the feature picker opens.
     * @param {ReadonlyArray<VectorInspectionObservation>} observations Inspector's ordered sample.
     * @return {void}
     */
    setFeatureChoices(observations) {
        this.plotPanel.setFeatureChoices(observations);
        this.compare.disabled = observations.length < 2;
    }

    /** Update feature navigation and render the requested chart or exact values in the open dock. @return {void} */
    render() {
        this.chart.replaceChildren();
        this.legend.hidden = true;
        this.pointElements = [];
        this.fieldCells = new Map();
        this.figure.hidden = true;
        this.chart.setAttribute("hidden", "");
        this.tableBody.replaceChildren();
        this.table.hidden = true;
        this.selection.hidden = true;
        this.status.textContent = "";
        this.zoomFeatureButton.disabled = this.currentObservation === null || this.currentObservation.focus === null;
        this.zoomFeatureButton.title = this.currentObservation?.focus === null ? "Feature location is unavailable for this selection." : "";
        this.#renderNavigation();
        const settings = this.#currentSettings();
        this.statistics.update(this.active && this.currentObservation ? [this.currentObservation] : [], settings?.selectedFields ?? []);
        if (this.currentObservation === null || settings === null) {
            this.#renderPresentation(null);
            this.titleField.replaceChildren();
            this.chooser.update(new Map(), []);
            this.status.textContent = "Inspect a vector feature first.";
            return;
        }
        const presentation = vectorFeatureProfilePresentation(
            this.currentObservation,
            settings.titleField
        );
        this.#renderPresentation(presentation);
        if (!this.active) return;
        this.#renderTitleOptions(settings);
        this.direction.value = settings.direction;
        this.chartType.value = settings.chartType;
        const attributes = this.currentObservation.properties;
        this.chooser.update(new Map(numericFeatureFields(this.currentObservation).map(name =>
            [name, String(attributes[name])])), settings.selectedFields);
        const count = settings.selectedFields.length;
        this.plotPanel.fieldButton.textContent = count > 1 ? count + " fields" : "Choose fields";
        if (!settings.selectedFields.includes(this.selectedField)) this.selectedField = null;
        const profile = buildVectorFeatureProfile(
            this.currentObservation,
            settings
        );
        const stacked = settings.chartType === "stacked";
        this.xHeading.hidden = stacked || profile.xScale === "ordinal";
        this.xHeading.textContent = profile.xAxisLabel;
        if (!this.plotPanel.values.hidden) this.#renderTable(profile.points);
        if (profile.points.length === 0) {
            this.status.textContent =
                "Select numeric fields to plot from this feature.";
            return;
        }
        if (profile.finiteCount === 0) {
            this.status.textContent =
                "The selected fields have no finite numeric values on this feature.";
            return;
        }
        if (profile.missingCount) this.status.textContent = profile.missingCount === 1
            ? "One field has no numeric value." : profile.missingCount + " fields have no numeric value.";
        if (!this.plotPanel.values.hidden) {
            if (this.selectedField) this.#selectField(this.selectedField);
            return;
        }
        this.figure.hidden = false;
        const first = profile.points[0].fieldName;
        this.chartTitle.textContent = profile.points.length === 1 ? first :
            profile.xScale === "numeric" ? first + " – " + profile.points.at(-1).fieldName : "";
        this.chartTitle.hidden = stacked || this.chartTitle.textContent === "";
        if (stacked) {
            this.#drawStackedProfile(profile.points, presentation.heading);
        } else {
            const {pointElements} = renderVectorFieldChart({
                documentContext: this.document,
                chart: this.chart,
                points: profile.points,
                width: this.plotPanel.width || undefined,
                height: 218,
                fitXAxisLabels: true,
                chartType: settings.chartType,
                xScale: profile.xScale,
                xReverse: profile.xScale === "numeric" && settings.direction === "descending",
                xAxisLabel: profile.xAxisLabel,
                yAxisLabel: "Value",
                ariaLabel: `${settings.chartType} chart of ${profile.finiteCount} ` +
                    `numeric fields for ${this.currentObservation.layerLabel}.`,
                pointAccessibleLabel: (point) => `${point.fieldName}: ` +
                    `${formatSeriesNumber(point.yValue)}`,
                pointTooltip: point => point.fieldName + " · " + point.yValue,
                onPointSelect: point => this.#selectField(point.fieldName),
            });
            this.pointElements = pointElements;
            labelVectorPlotValues(this.chart, pointElements, settings.chartType);
        }
        if (this.selectedField !== null) this.#selectField(this.selectedField);
    }

    /**
     * Draw the current feature as a single stack in the profile's field order.
     * @param {{fieldName:string,yValue:number|bigint|null}[]} points Parsed field readings.
     * @param {string} featureLabel Name shown beside the stack.
     * @return {void}
     */
    #drawStackedProfile(points, featureLabel) {
        this.pointElements = renderStackedSeriesChart({
            documentContext: this.document,
            chart: this.chart,
            legend: this.legend,
            width: this.plotPanel.width || undefined,
            series: points.map(point => ({id: point.fieldName, label: point.fieldName, points: [point]})),
            rowLabels: [featureLabel],
            valueAxisLabel: "Value",
            ariaLabel: `Stacked bars for ${featureLabel}`,
            describePoint: point => `${point.fieldName}: ${point.yValue}`,
            onPointSelect: point => this.#selectField(point.fieldName),
        }).pointElements;
    }

    /** @return {Object|null} Mutable settings for the current source. */
    #currentSettings() {
        if (this.currentObservation === null) return null;
        return this.settingsBySource.get(this.currentObservation.sourceId) ?? null;
    }

    /**
     * Show the exact field and value selected in either the plot or the table.
     * @param {string} field Source field name.
     * @return {void}
     */
    #selectField(field) {
        this.selectedField = field;
        const value = this.currentObservation.properties[field];
        this.selectionText.textContent = field + " · " + (isNumericFeatureValue(value) ? String(value) : "No value");
        this.selection.hidden = false;
        for (const [name, button] of this.fieldCells) {
            button.setAttribute("aria-pressed", String(name === field));
        }
        for (const {circle, point} of this.pointElements) {
            const selected = point.fieldName === field;
            if (selected) circle.classList.add("is-selected");
            else circle.classList.remove("is-selected");
            circle.setAttribute("aria-pressed", String(selected));
        }
    }

    /**
     * Rebuild title choices from scalar attributes without mutating source data.
     *
     * @param {Object} settings Current per-source settings.
     * @return {void}
     */
    #renderTitleOptions(settings) {
        const options = [
            { value: FEATURE_PROFILE_TITLE_NONE, label: "None" },
            { value: FEATURE_PROFILE_TITLE_LAYER, label: "Layer name" },
            ...Object.keys(this.currentObservation.properties)
                .sort(NATURAL_TEXT.compare)
                .map((name) => ({ value: name, label: name })),
        ];
        if (!options.some((option) => option.value === settings.titleField)) {
            options.push({
                value: settings.titleField,
                label: `${settings.titleField} — unavailable`,
            });
        }
        this.titleField.replaceChildren(...options.map(({ value, label }) => {
            const option = this.document.createElement("option");
            option.value = value;
            option.textContent = label;
            return option;
        }));
        this.titleField.value = settings.titleField;
    }

    /**
     * Render analysis-owned feature context and publish only its dock identity.
     *
     * @param {{label:string,title:string,heading:string,context:string}|null}
     * presentation Current presentation identity, or null without a feature.
     * @return {void}
     */
    #renderPresentation(presentation) {
        if (presentation === null) {
            this.heading.textContent = "One feature";
            this.context.textContent = "";
            this.context.hidden = true;
            this.onPresentationChange(null);
            return;
        }
        this.heading.textContent = presentation.heading;
        this.plotPanel.featureButton.textContent = vectorFeatureLabel(this.currentObservation, this.currentNavigation.position - 1);
        this.context.textContent = presentation.context;
        this.context.hidden = false;
        this.onPresentationChange({
            label: presentation.label,
            title: presentation.title,
        });
    }

    /**
     * Render the inspector-owned position and available navigation actions.
     *
     * @return {void}
     */
    #renderNavigation() {
        if (this.currentNavigation === null) {
            this.featurePosition.textContent = "";
            this.previousFeature.disabled = true;
            this.nextFeature.disabled = true;
            return;
        }
        const { position, total, canPrevious, canNext } = this.currentNavigation;
        this.featurePosition.textContent = `${position} of ${total} ` +
            `feature${total === 1 ? "" : "s"}`;
        this.previousFeature.disabled = !canPrevious;
        this.nextFeature.disabled = !canNext;
    }

    /**
     * Present selected fields and missing values in an accessible compact table.
     *
     * @param {Object[]} points Ordered profile points.
     * @return {void}
     */
    #renderTable(points) {
        for (const point of points) {
            const row = this.document.createElement("tr");
            const field = this.document.createElement("td");
            const button = this.document.createElement("button");
            button.type = "button";
            button.classList.add("summary-text-button");
            button.textContent = point.fieldName;
            button.setAttribute("aria-pressed", "false");
            this.fieldCells.set(point.fieldName, button);
            button.addEventListener("click", () => this.#selectField(point.fieldName));
            field.append(button);
            const value = this.document.createElement("td");
            value.textContent = point.yValue === null ? "No value" : String(point.yValue);
            const x = this.document.createElement("td");
            x.textContent = point.xLabel;
            x.hidden = this.xHeading.hidden;
            row.append(field, x, value);
            this.tableBody.append(row);
        }
        this.table.hidden = points.length === 0;
    }

    /** Release listeners and request removal of retained presentation. @return {void} */
    destroy() {
        this.closeButton.removeEventListener("click", this.onClose);
        this.previousFeature.removeEventListener("click", this.onPreviousFeature);
        this.nextFeature.removeEventListener("click", this.onNextFeature);
        this.zoomFeatureButton.removeEventListener("click", this.onZoomFeature);
        this.titleField.removeEventListener("change", this.onSettingsChange);
        this.direction.removeEventListener("change", this.onSettingsChange);
        this.chartType.removeEventListener("change", this.onSettingsChange);
        this.abort.abort();
        this.plotPanel.destroy();
        this.chooser.destroy();
        this.statistics.destroy();
        this.document.removeEventListener("keydown", this.onKeydown);
        this.onPresentationChange(null);
        this.onVisibilityChange(false, false);
    }
}
