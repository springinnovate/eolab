/** Capture a temporal dataset, UTC period and observation statistic for model setup. */

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

/** Round a date-control value to the nearest UTC hour, with half hours rounded forward.
 * @param {string} value Editable date and time interpreted as UTC, possibly incomplete.
 * @return {string} Rounded boundary, or the unchanged incomplete entry for the user to finish.
 */
export function snapTemporalHour(value) {
    const time = Date.parse(`${value}Z`);
    return Number.isFinite(time) ? new Date(Math.round(time / 3600000) * 3600000).toISOString().slice(0, 16) : value;
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

/** Convert a calendar month to its UTC start and excluded end.
 * @param {string} month Native month-control value (YYYY-MM), or empty.
 * @return {{startTime:string,endTime:string}} Boundaries for the existing temporal input.
 */
export function temporalMonthPeriod(month) {
    if (!month) return {startTime: "", endTime: ""};
    const startTime = `${month}-01T00:00`, end = new Date(`${startTime}Z`);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return {startTime, endTime: end.toISOString().slice(0, 16)};
}

/** Include both selected calendar days in a midnight-to-midnight UTC period.
 * @param {string} firstDay Native date-control value (YYYY-MM-DD), or empty.
 * @param {string} lastDay Included final date-control value, or empty.
 * @return {{startTime:string,endTime:string}} UTC boundaries; an unfilled side stays empty.
 */
export function temporalDayPeriod(firstDay, lastDay) {
    const end = lastDay ? new Date(`${lastDay}T00:00Z`) : null;
    end?.setUTCDate(end.getUTCDate() + 1);
    return {startTime: firstDay ? `${firstDay}T00:00` : "", endTime: end ? end.toISOString().slice(0, 16) : ""};
}

/** Return the calendar days touched by the editable UTC period.
 * An excluded midnight belongs to the previous selected day.
 * @param {{startTime:string,endTime:string}} temporal Editable UTC boundaries, including incomplete entries.
 * @return {{firstDay:string,lastDay:string}} Included dates for the day-range controls.
 */
export function temporalPeriodDays(temporal) {
    const end = Date.parse(`${temporal.endTime}Z`);
    return {firstDay: temporal.startTime.split("T")[0], lastDay: end % 86400000 === 0 ?
        new Date(end - 86400000).toISOString().slice(0, 10) : temporal.endTime.split("T")[0]};
}

/** Change entry mode, expanding to the selected month or whole days when requested.
 * Exact times preserves the current boundaries. The caller displays the new period before submission.
 * @param {{startTime:string,endTime:string}} temporal Current editable UTC boundaries.
 * @param {"month"|"days"|"times"} periodMode Chosen entry mode.
 * @return {{periodMode:string,startTime:string,endTime:string}} Draft fields to replace.
 */
export function selectTemporalPeriodMode(temporal, periodMode) {
    const {firstDay, lastDay} = temporalPeriodDays(temporal);
    const period = periodMode === "month" ? temporalMonthPeriod(firstDay.slice(0, 7)) :
        periodMode === "days" ? temporalDayPeriod(firstDay, lastDay) :
            {startTime: temporal.startTime, endTime: temporal.endTime};
    return {periodMode, ...period};
}

/** Describe the requested calendar period or exact UTC boundaries beside its controls.
 * @param {{periodMode:string,startTime:string,endTime:string}} temporal Editable mode and UTC boundaries.
 * @return {string} Human-readable period, or guidance while boundaries are incomplete or reversed.
 */
export function describeTemporalPeriod(temporal) {
    const start = new Date(`${temporal.startTime}Z`), end = new Date(`${temporal.endTime}Z`);
    if (!(end > start)) return "Choose a valid period.";
    if (temporal.periodMode === "month") return new Intl.DateTimeFormat(undefined,
        {month: "long", year: "numeric", timeZone: "UTC"}).format(start) + " · whole month · UTC";
    const date = new Intl.DateTimeFormat(undefined, {day: "numeric", month: "short", year: "numeric", timeZone: "UTC"});
    if (temporal.periodMode === "days") return `${date.format(start)} – ${date.format(new Date(end - 86400000))} · both days included · UTC`;
    return `${date.format(start)} ${temporal.startTime.split("T")[1]} → ${date.format(end)} ${temporal.endTime.split("T")[1]} UTC · end excluded`;
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
    if (!temporal.startTime || !temporal.endTime) return "Choose a month, a date range or exact times in UTC.";
    const start = Date.parse(`${temporal.startTime}Z`), end = Date.parse(`${temporal.endTime}Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "Enter a valid start and end date and time in UTC.";
    if (start >= end) return "The end must be later than the start.";
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
