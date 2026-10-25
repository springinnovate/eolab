/** Capture a temporal dataset, UTC period and observation statistic for model setup. */
import { temporalPeriodError } from "../temporal-period.js";

/** Statistics accepted by the temporal_reduction input contract. */
export const TEMPORAL_STATISTICS = [
    {value: "mean", label: "Mean"}, {value: "sum", label: "Sum"},
    {value: "min", label: "Minimum"}, {value: "max", label: "Maximum"},
    {value: "median", label: "Median"}, {value: "percentile", label: "Percentile"},
    {value: "stdev", label: "Standard deviation"},
    {value: "precipitation_total", label: "Precipitation total"},
];

/** Spatial statistics accepted by the area_statistic input contract. */
const AREA_STATISTICS = [
    {value: "mean", label: "Mean"}, {value: "sum", label: "Sum"},
    {value: "min", label: "Minimum"}, {value: "max", label: "Maximum"},
    {value: "stdev", label: "Population standard deviation"}, {value: "count", label: "Valid-pixel count"},
];

/** Check whether a variable matches the model's configured precipitation rate units.
 * @param {Object|undefined} variable Admitted Catalog variable metadata, or no selection.
 * @param {Object} temporal Period choices, statistic input type and model conversion configuration.
 * @return {boolean} Whether the model can integrate this variable over its observation intervals.
 */
export function supportsPrecipitationTotal(variable, temporal) {
    return temporal.statisticType === "temporal_reduction" &&
        variable?.["eolab:time_support"] === "mean_rate" && variable.unit === temporal.precipitation.inputUnit;
}

/** List the statistics supported by the selected variable's measurement type and units.
 * @param {Object|undefined} variable Admitted Catalog variable metadata, or no selection.
 * @param {Object} temporal Period choices, statistic input type and model conversion configuration.
 * @return {{value:string,label:string}[]} Supported choices; empty for an unsupported or missing variable.
 */
export function getTemporalStatistics(variable, temporal) {
    if (temporal.statisticType === "area_statistic") return variable ? AREA_STATISTICS : [];
    if (supportsPrecipitationTotal(variable, temporal))
        return [{value: "precipitation_total", label: `Precipitation total (${temporal.precipitation.outputUnit})`}];
    return variable?.["eolab:time_support"] === "instantaneous" ?
        TEMPORAL_STATISTICS.filter(choice => choice.value !== "precipitation_total") : [];
}

/** Create empty period choices independently of the observation displayed on the map.
 * @param {Object[]} datasets Catalog dataset identities retained in Map layers.
 * @param {"temporal_reduction"|"area_statistic"} statisticType Recipe input defining whether to summarize observations or pixels.
 * @param {{inputUnit:string,outputUnit:string,factor:number}|null} precipitation Period-map conversion fixed in Model YAML; null for area series.
 * @return {Object} Editable choices, statistic type, fixed conversion and Catalog availability state.
 */
export function createTemporalDraft(datasets, statisticType, precipitation) {
    return {datasets: structuredClone(datasets), statisticType, precipitation, datasetKey: "", item: null, variable: "",
        periodMode: "month", startTime: "", endTime: "", choices: null, loading: false, error: "", datesError: ""};
}

/** Explain a missing or invalid temporal choice before submitting a calculation.
 * Dates are datetime-local control values interpreted in UTC, never the browser timezone.
 * Availability guidance does not restrict period boundaries to observation timestamps.
 * Precipitation totals require whole UTC hours already shown in the controls; capture never rounds them.
 * @param {Object} temporal Editable period choices.
 * @return {string} User-facing problem, or an empty string when the choices are complete.
 */
export function temporalSelectionError(temporal) {
    if (!temporal.datasetKey) return temporal.datasets.length ? "Choose a temporal dataset from Map layers." :
        "Add a temporal dataset from Catalog to Map layers, then choose it here.";
    if (temporal.loading) return "Loading available variables and dates…";
    if (temporal.error) return temporal.error;
    if (!temporal.item) return "Load the dataset's variables before running the analysis.";
    const variable = temporal.item.properties["cube:variables"][temporal.variable];
    if (!variable) return "Choose a variable.";
    if (!getTemporalStatistics(variable, temporal).length)
        return `Choose instantaneous measurements or a mean precipitation rate in ${temporal.precipitation.inputUnit}. Other rates and accumulated values are not supported.`;
    const periodError = temporalPeriodError(temporal);
    if (periodError) return periodError;
    const start = Date.parse(`${temporal.startTime}Z`), end = Date.parse(`${temporal.endTime}Z`);
    if (supportsPrecipitationTotal(variable, temporal) && (start % 3600000 !== 0 || end % 3600000 !== 0))
        return "Finish editing the dates to round them to whole UTC hours before running the precipitation total.";
    return "";
}

/** Capture a path-free dataset selection and its requested UTC period.
 * @param {Object} temporal Editable period choices.
 * @return {Object} The temporal_interval input accepted by Processing.
 * @throws {Error} If the selected dataset, variable or date boundaries are unavailable or invalid.
 */
export function captureTemporalInput(temporal) {
    const error = temporalSelectionError(temporal);
    if (error) throw new Error(error);
    return {collectionId: temporal.item.collection, itemId: temporal.item.id, variable: temporal.variable,
        startTime: new Date(`${temporal.startTime}Z`).toISOString(), endTime: new Date(`${temporal.endTime}Z`).toISOString()};
}

/** Capture the statistic, including a percentile only when that statistic is selected.
 * @param {{reducer:string,percentile:number|null}} reduction Choices from the statistic controls.
 * @return {Object} The temporal_reduction input accepted by Processing.
 * @throws {Error} If a requested percentile is missing or outside 0–100.
 */
export function captureTemporalReduction(reduction) {
    if (reduction.reducer !== "percentile") return {reducer: reduction.reducer};
    if (!Number.isFinite(reduction.percentile) || reduction.percentile < 0 || reduction.percentile > 100)
        throw new Error("Enter a percentile from 0 to 100.");
    return {reducer: reduction.reducer, percentile: reduction.percentile};
}

/** Describe the submitted variable and exact UTC boundaries without reading current Catalog state.
 * @param {Object} input Captured temporal_interval input.
 * @return {string} Dataset, variable and requested period for saved run details.
 */
export function describeTemporalInterval(input) {
    return `${input.itemId} · ${input.variable} · Requested period: ${input.startTime} to ${input.endTime}. All times UTC.`;
}

/** Describe the saved statistic independently of the current setup controls.
 * @param {{reducer:string,percentile?:number}} input Captured temporal_reduction input.
 * @return {string} Statistic label and percentile or population convention when applicable.
 */
export function describeTemporalReduction(input) {
    const label = TEMPORAL_STATISTICS.find(choice => choice.value === input.reducer).label;
    return input.reducer === "percentile" ? `${label} ${input.percentile}` : input.reducer === "stdev" ? `${label} (population)` : label;
}
