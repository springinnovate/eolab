/** Plot several numeric fields from one bounded vector feature observation. */

import { validateVectorInspectionObservations } from "./inspection-observation.js";
import {
    formatSeriesNumber,
    renderOrdinalSeriesChart,
} from "./series-chart.js";

export const FEATURE_PROFILE_TITLE_NONE = "__eolab_no_title__";
export const FEATURE_PROFILE_TITLE_LAYER = "__eolab_layer_title__";

const NATURAL_TEXT = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
});

/**
 * Return naturally ordered field names with finite numeric values.
 *
 * @param {Object} observation Validated inspection observation.
 * @return {string[]} Numeric field names.
 */
export function numericFeatureFields(observation) {
    validateVectorInspectionObservations([observation]);
    return Object.entries(observation.properties)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
        .map(([name]) => name)
        .sort(NATURAL_TEXT.compare);
}

/**
 * Extract the last finite decimal number embedded in one field name.
 *
 * @param {string} fieldName Attribute name.
 * @return {number|null} Numeric X value or null when the name has none.
 */
export function fieldNameNumber(fieldName) {
    const matches = [...fieldName.matchAll(/\d+(?:\.\d+)?/g)];
    if (matches.length === 0) return null;
    const value = Number(matches.at(-1)[0]);
    return Number.isFinite(value) ? value : null;
}

/**
 * Suggest a useful title attribute from conventional field names.
 *
 * @param {Object} observation Validated inspection observation.
 * @return {string} Field name or the layer-title sentinel.
 */
export function suggestFeatureProfileTitle(observation) {
    validateVectorInspectionObservations([observation]);
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
 * Select the largest repeated numeric field-name family as an initial series.
 *
 * A family replaces the last number with a marker, so R2000 through R2024 are
 * selected together while unrelated numeric identifiers remain separate.
 *
 * @param {Object} observation Validated inspection observation.
 * @return {string[]} Suggested field names.
 */
export function suggestFeatureProfileFields(observation) {
    const numericFields = numericFeatureFields(observation);
    const families = new Map();
    for (const fieldName of numericFields) {
        const matches = [...fieldName.matchAll(/\d+(?:\.\d+)?/g)];
        if (matches.length === 0) continue;
        const match = matches.at(-1);
        const family = `${fieldName.slice(0, match.index)}#` +
            fieldName.slice(match.index + match[0].length);
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
 *
 * @param {Object} observation Validated inspection observation.
 * @param {Object} settings Per-source feature-profile settings.
 * @param {string[]} settings.selectedFields Selected attribute names.
 * @param {"ascending"|"descending"} settings.direction Sort direction.
 * @return {{points:Object[],finiteCount:number,missingCount:number,xAxisLabel:string,xScale:string}}
 * Neutral ordinal chart model.
 */
export function buildVectorFeatureProfile(observation, settings) {
    validateVectorInspectionObservations([observation]);
    if (
        !Array.isArray(settings?.selectedFields) ||
        !settings.selectedFields.every((field) => typeof field === "string") ||
        !["ascending", "descending"].includes(settings.direction)
    ) {
        throw new TypeError("Invalid vector feature-profile settings.");
    }
    const points = [...new Set(settings.selectedFields)].map((fieldName) => {
        const number = fieldNameNumber(fieldName);
        const value = observation.properties[fieldName];
        return {
            fieldName,
            xValue: number,
            xLabel: number === null ? fieldName : String(number),
            yValue: typeof value === "number" && Number.isFinite(value)
                ? value
                : null,
        };
    });
    points.sort((left, right) => {
        let compared;
        if (left.xValue !== null && right.xValue !== null) {
            compared = left.xValue - right.xValue;
        } else {
            compared = NATURAL_TEXT.compare(left.fieldName, right.fieldName);
        }
        return settings.direction === "ascending" ? compared : -compared;
    });
    const finiteCount = points.filter((point) => point.yValue !== null).length;
    const usesNumericNames = points.length > 0 && points.every(
        (point) => point.xValue !== null
    );
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
     * @param {Document} [configuration.documentContext=document] DOM owner.
     */
    constructor({ onVisibilityChange, documentContext = document }) {
        if (typeof onVisibilityChange !== "function") {
            throw new TypeError("onVisibilityChange must be a function.");
        }
        this.onVisibilityChange = onVisibilityChange;
        this.document = documentContext;
        this.panel = documentContext.querySelector("#vector-feature-profile");
        this.closeButton = documentContext.querySelector(
            "#close-vector-feature-profile"
        );
        this.titleField = documentContext.querySelector(
            "#vector-feature-profile-title-field"
        );
        this.fieldSearch = documentContext.querySelector(
            "#vector-feature-profile-field-search"
        );
        this.selectMatchingButton = documentContext.querySelector(
            "#vector-feature-profile-select-matching"
        );
        this.clearFieldsButton = documentContext.querySelector(
            "#vector-feature-profile-clear-fields"
        );
        this.fieldList = documentContext.querySelector(
            "#vector-feature-profile-field-list"
        );
        this.direction = documentContext.querySelector(
            "#vector-feature-profile-direction"
        );
        this.chartType = documentContext.querySelector(
            "#vector-feature-profile-chart-type"
        );
        this.chartTitle = documentContext.querySelector(
            "#vector-feature-profile-chart-title"
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
        this.settingsBySource = new Map();
        this.filter = "";
        this.modeActive = false;
        this.onClose = () => this.close({ moveFocus: true });
        this.onSettingsChange = () => {
            const settings = this.#currentSettings();
            if (settings === null) return;
            settings.titleField = this.titleField.value;
            settings.direction = this.direction.value;
            settings.chartType = this.chartType.value;
            this.render();
        };
        this.onSearchInput = () => {
            this.filter = this.fieldSearch.value.trim().toLocaleLowerCase();
            this.#renderFieldList();
        };
        this.onSelectMatching = () => {
            const settings = this.#currentSettings();
            if (settings === null) return;
            settings.selectedFields = this.#matchingNumericFields();
            this.render();
        };
        this.onClearFields = () => {
            const settings = this.#currentSettings();
            if (settings === null) return;
            settings.selectedFields = [];
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
            this.close({ moveFocus: true });
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.titleField.addEventListener("change", this.onSettingsChange);
        this.direction.addEventListener("change", this.onSettingsChange);
        this.chartType.addEventListener("change", this.onSettingsChange);
        this.fieldSearch.addEventListener("input", this.onSearchInput);
        this.selectMatchingButton.addEventListener("click", this.onSelectMatching);
        this.clearFieldsButton.addEventListener("click", this.onClearFields);
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
        this.render();
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
        this.onVisibilityChange(false, moveFocus);
    }

    /**
     * Replace the current immutable feature observation.
     *
     * Settings are initialized once per source and reused for later features
     * from the same vector layer. An active mode temporarily hides for a null
     * observation and reopens when a later feature becomes current.
     *
     * @param {Object|null} observation Current inspector result or null.
     * @return {void}
     */
    setCurrentObservation(observation) {
        if (observation !== null) validateVectorInspectionObservations([observation]);
        this.currentObservation = observation;
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
                chartType: "line",
            });
        }
        if (observation !== null && this.modeActive && this.panel.hidden) {
            this.onVisibilityChange(true, false);
        }
        this.filter = "";
        this.fieldSearch.value = "";
        this.render();
    }

    /** Render controls, chart, accessible data, and current-feature status. @return {void} */
    render() {
        this.chart.replaceChildren();
        this.chart.setAttribute("hidden", "");
        this.tableBody.replaceChildren();
        this.table.hidden = true;
        this.chartTitle.hidden = true;
        this.chartTitle.textContent = "";
        const settings = this.#currentSettings();
        if (this.currentObservation === null || settings === null) {
            this.titleField.replaceChildren();
            this.fieldList.replaceChildren();
            this.status.textContent = "Inspect a vector feature first.";
            return;
        }
        this.#renderTitleOptions(settings);
        this.direction.value = settings.direction;
        this.chartType.value = settings.chartType;
        this.#renderFieldList();
        this.#renderTitle(settings);
        const profile = buildVectorFeatureProfile(
            this.currentObservation,
            settings
        );
        this.#renderTable(profile.points);
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
        renderOrdinalSeriesChart({
            documentContext: this.document,
            chart: this.chart,
            points: profile.points,
            chartType: settings.chartType,
            xScale: profile.xScale,
            xAxisLabel: profile.xAxisLabel,
            yAxisLabel: "Value",
            ariaLabel: `${settings.chartType} chart of ${profile.finiteCount} ` +
                `numeric fields for ${this.currentObservation.layerLabel}.`,
            pointAccessibleLabel: (point) => `${point.fieldName}: ` +
                `${formatSeriesNumber(point.yValue)}`,
            pointTooltip: (point) => `${point.fieldName} · ` +
                `${formatSeriesNumber(point.yValue)}`,
        });
        const plotted = `${profile.finiteCount.toLocaleString()} selected ` +
            `field${profile.finiteCount === 1 ? "" : "s"} plotted.`;
        this.status.textContent = profile.missingCount === 0
            ? plotted
            : `${plotted} ${profile.missingCount.toLocaleString()} missing ` +
              `value${profile.missingCount === 1 ? " is" : "s are"} shown as ` +
              "a gap.";
    }

    /** @return {Object|null} Mutable settings for the current source. */
    #currentSettings() {
        if (this.currentObservation === null) return null;
        return this.settingsBySource.get(this.currentObservation.sourceId) ?? null;
    }

    /** @return {string[]} Numeric fields matching the current partial search. */
    #matchingNumericFields() {
        if (this.currentObservation === null) return [];
        return numericFeatureFields(this.currentObservation).filter((fieldName) =>
            fieldName.toLocaleLowerCase().includes(this.filter)
        );
    }

    /** Rebuild the searchable numeric-field checklist. @return {void} */
    #renderFieldList() {
        const settings = this.#currentSettings();
        if (this.currentObservation === null || settings === null) {
            this.fieldList.replaceChildren();
            return;
        }
        const selected = new Set(settings.selectedFields);
        const available = numericFeatureFields(this.currentObservation);
        const fields = [...new Set([...available, ...settings.selectedFields])]
            .sort(NATURAL_TEXT.compare);
        this.fieldList.replaceChildren(...fields.map((fieldName) => {
            const row = this.document.createElement("label");
            row.classList.add("vector-feature-profile-field");
            row.hidden = !fieldName.toLocaleLowerCase().includes(this.filter);
            const checkbox = this.document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = fieldName;
            checkbox.checked = selected.has(fieldName);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selected.add(fieldName);
                else selected.delete(fieldName);
                settings.selectedFields = [...selected];
                this.render();
            });
            const name = this.document.createElement("span");
            name.textContent = fieldName;
            const value = this.document.createElement("output");
            const fieldValue = this.currentObservation.properties[fieldName];
            value.textContent = typeof fieldValue === "number" &&
                Number.isFinite(fieldValue)
                ? formatSeriesNumber(fieldValue)
                : "No value";
            row.append(checkbox, name, value);
            return row;
        }));
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
     * Present the configured title for the current feature.
     *
     * @param {Object} settings Current per-source settings.
     * @return {void}
     */
    #renderTitle(settings) {
        if (settings.titleField === FEATURE_PROFILE_TITLE_NONE) return;
        const value = settings.titleField === FEATURE_PROFILE_TITLE_LAYER
            ? this.currentObservation.layerLabel
            : this.currentObservation.properties[settings.titleField];
        if (value === null || value === undefined || value === "") return;
        this.chartTitle.textContent = String(value);
        this.chartTitle.hidden = false;
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
            for (const value of [
                point.fieldName,
                point.xLabel,
                point.yValue === null
                    ? "No value"
                    : formatSeriesNumber(point.yValue),
            ]) {
                const cell = this.document.createElement("td");
                cell.textContent = String(value);
                row.append(cell);
            }
            this.tableBody.append(row);
        }
        this.table.hidden = points.length === 0;
    }

    /** Release listeners and request removal of retained presentation. @return {void} */
    destroy() {
        this.closeButton.removeEventListener("click", this.onClose);
        this.titleField.removeEventListener("change", this.onSettingsChange);
        this.direction.removeEventListener("change", this.onSettingsChange);
        this.chartType.removeEventListener("change", this.onSettingsChange);
        this.fieldSearch.removeEventListener("input", this.onSearchInput);
        this.selectMatchingButton.removeEventListener("click", this.onSelectMatching);
        this.clearFieldsButton.removeEventListener("click", this.onClearFields);
        this.document.removeEventListener("keydown", this.onKeydown);
        this.onVisibilityChange(false, false);
    }
}
