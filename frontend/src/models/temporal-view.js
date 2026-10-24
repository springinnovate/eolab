/** Present temporal period and statistic choices inside the existing Models form. */
import { modelSourceKey } from "./inputs.js";
import { getTemporalStatistics, supportsPrecipitationTotal, snapTemporalHour, temporalSelectionError, captureTemporalReduction,
    temporalMonthPeriod, temporalDayPeriod, temporalPeriodDays, selectTemporalPeriodMode, describeTemporalPeriod } from "./temporal-inputs.js";

/** Format an available observation label without using the browser's timezone.
 * @param {string} time Catalog timestamp.
 * @return {string} Human-readable date and time including UTC.
 */
function observationLabel(time) {
    return new Date(time).toLocaleString(undefined, {timeZone: "UTC", dateStyle: "medium", timeStyle: "long"});
}

/** Keep temporal setup fields stable while their availability guidance changes. */
export class TemporalModelInputsView {
    /** Build source and statistic groups for the owning Models form.
     * @param {Object} helpers Existing Models presentation helpers.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create a text-only element.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Create a labelled field.
     * @param {(label:string,action:()=>void,className?:string)=>HTMLButtonElement} helpers.button Create a button.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {Document} helpers.document Owning document, used to preserve focused edits.
     * @param {Object} handlers Controller-owned user actions.
     * @param {(key:string)=>void} handlers.onTemporalDataset Choose a retained Catalog dataset.
     * @param {(variable:string)=>void} handlers.onTemporalVariable Choose its variable.
     * @param {(month:string)=>void} handlers.onTemporalMonth Browse availability without changing dates.
     * @param {()=>void} handlers.onUseTemporalMonth Explicitly set the calendar-month period.
     * @param {()=>void} handlers.onRefreshTemporal Refresh guidance while preserving dates.
     * @param {(change:Object)=>void} handlers.onTemporalEdit Edit entry mode and UTC period boundaries.
     * @param {(change:Object)=>void} handlers.onEdit Edit the statistic choice.
     * @param {string} statisticLabel Label declared by the recipe's statistic input.
     */
    constructor({element, field, button, options, document}, handlers, statisticLabel) {
        this.document = document; this.options = options;
        this.sourceRoot = element("div", "", "models-vector");
        this.dataset = element("select"); this.dataset.required = true;
        this.dataset.addEventListener("change", () => handlers.onTemporalDataset(this.dataset.value));
        this.variable = element("select"); this.variable.required = true;
        this.variable.addEventListener("change", () => handlers.onTemporalVariable(this.variable.value));
        this.support = element("p", "", "models-help"); this.support.id = "models-temporal-support";
        this.variable.setAttribute("aria-describedby", this.support.id);
        this.sourceRoot.append(field("models-temporal-dataset", "Dataset", this.dataset),
            field("models-temporal-variable", "Variable", this.variable), this.support);
        this.periodMode = element("select");
        options(this.periodMode, [{value: "month", label: "Whole month"}, {value: "days", label: "Date range"},
            {value: "times", label: "Exact times"}], "month");
        this.periodMode.addEventListener("change", () => handlers.onTemporalEdit(selectTemporalPeriodMode(this.temporal, this.periodMode.value)));
        this.monthFields = element("div"); this.dayFields = element("div", "", "models-time-grid");
        this.exactFields = element("div", "", "models-time-grid");
        this.selectedMonth = element("input"); this.selectedMonth.type = "month"; this.selectedMonth.required = true;
        this.selectedMonth.addEventListener("input", () => handlers.onTemporalEdit(temporalMonthPeriod(this.selectedMonth.value)));
        this.monthFields.append(field("models-temporal-selected-month", "Month", this.selectedMonth));
        for (const [name, caption] of [["firstDay", "First day"], ["lastDay", "Last day (included)"]]) {
            const input = this[name] = element("input"); input.type = "date"; input.required = true;
            input.addEventListener("input", () => handlers.onTemporalEdit(temporalDayPeriod(this.firstDay.value, this.lastDay.value)));
            this.dayFields.append(field(`models-temporal-${name}`, caption, input));
        }
        for (const [name, caption] of [["start", "Start"], ["end", "End"]]) {
            const group = element("div", "", "models-vector");
            for (const [part, type] of [["Date", "date"], ["Time", "time"]]) {
                const input = this[name + part] = element("input"); input.type = type; input.required = true;
                input.setAttribute("aria-describedby", "models-temporal-period-help models-temporal-status");
                input.addEventListener("input", () => this.editExactBoundary(name, handlers.onTemporalEdit, false));
                input.addEventListener("change", () => this.editExactBoundary(name, handlers.onTemporalEdit, this.precipitation));
                input.addEventListener("blur", () => {
                    if (this.precipitation) this.editExactBoundary(name, handlers.onTemporalEdit, true);
                });
                const label = part === "Date" ? `${caption} date` : name === "start" ? "Start time (UTC)" : "End time (excluded, UTC)";
                group.append(field(`models-temporal-${name}${part}`, label, input));
            }
            this.exactFields.append(group);
        }
        this.periodSummary = element("p", "", "models-period-summary");
        this.periodSummary.setAttribute("role", "status");
        this.sourceRoot.append(field("models-temporal-mode", "Choose time by", this.periodMode),
            this.monthFields, this.dayFields, this.exactFields, this.periodSummary);
        this.periodHelp = element("p", "", "models-help");
        this.periodHelp.id = "models-temporal-period-help";
        this.status = element("p", "", "models-help"); this.status.id = "models-temporal-status";
        this.status.setAttribute("role", "status");
        this.availability = element("details", "", "models-details");
        this.availability.append(element("summary", "Available observations"));
        this.month = element("select");
        this.month.addEventListener("change", () => handlers.onTemporalMonth(this.month.value));
        this.coverage = element("p", "", "models-help"); this.coverage.setAttribute("role", "status");
        this.useMonth = button("Use this month", handlers.onUseTemporalMonth, "models-action");
        this.refresh = button("Refresh dates", handlers.onRefreshTemporal, "models-action");
        const actions = element("div", "", "models-actions"); actions.append(this.useMonth, this.refresh);
        this.availabilityHelp = element("p", "", "models-help");
        this.availability.append(field("models-temporal-month", "Browse month", this.month), this.coverage, actions, this.availabilityHelp);
        this.sourceRoot.append(this.periodHelp, this.status, this.availability);
        this.reductionRoot = element("div", "", "models-vector");
        this.statistic = element("select");
        this.statistic.addEventListener("change", () => handlers.onEdit({reduction: {...this.reduction, reducer: this.statistic.value}}));
        this.percentile = element("input"); this.percentile.type = "number"; this.percentile.min = "0";
        this.percentile.max = "100"; this.percentile.step = "any"; this.percentile.required = true;
        this.percentile.setAttribute("aria-describedby", "models-temporal-reduction-status");
        this.percentile.addEventListener("input", () => handlers.onEdit({reduction: {...this.reduction,
            percentile: this.percentile.value === "" ? null : Number(this.percentile.value)}}));
        this.percentileField = field("models-temporal-percentile", "Percentile (0–100)", this.percentile);
        this.reductionHelp = element("p", "", "models-help");
        this.reductionStatus = element("p", "", "models-error"); this.reductionStatus.id = "models-temporal-reduction-status";
        this.reductionStatus.setAttribute("role", "status");
        this.reductionRoot.append(field("models-temporal-statistic", statisticLabel, this.statistic),
            this.percentileField, this.reductionHelp, this.reductionStatus);
    }

    /** Capture one exact boundary and display precipitation rounding before updating the draft.
     * @param {"start"|"end"} name Boundary being edited.
     * @param {(change:Object)=>void} onEdit Draft update callback.
     * @param {boolean} round Whether this completed edit must snap to a whole UTC hour.
     * @return {void}
     */
    editExactBoundary(name, onEdit, round) {
        const date = this[name + "Date"], time = this[name + "Time"];
        let value = `${date.value}T${time.value}`;
        if (round) {
            value = snapTemporalHour(value);
            [date.value, time.value] = value.split("T");
        }
        onEdit({[name + "Time"]: value});
    }

    /** Refresh guidance and values without replacing controls or focused edits.
     * @param {ReturnType<typeof import("./temporal-inputs.js").createTemporalDraft>} temporal Editable source and period.
     * @param {{reducer:string,percentile:number|null}} reduction Editable statistic choice.
     * @return {string} Local source, period or statistic problem; empty when complete.
     */
    render(temporal, reduction) {
        this.temporal = temporal;
        this.reduction = reduction;
        this.options(this.dataset, [{value: "", label: "Choose a temporal dataset…"}, ...temporal.datasets.map(dataset =>
            ({value: modelSourceKey(dataset), label: modelSourceKey(dataset) === temporal.datasetKey && temporal.item ?
                temporal.item.properties.title : dataset.label}))], temporal.datasetKey);
        const variables = Object.entries(temporal.item?.properties["cube:variables"] ?? {});
        this.options(this.variable, [{value: "", label: "Choose a variable…"}, ...variables.map(([id, value]) => ({value: id,
            label: `${value.description} (${value.unit})${getTemporalStatistics(value, temporal).length ? "" : " — not supported"}`,
            disabled: !getTemporalStatistics(value, temporal).length}))], temporal.variable);
        this.variable.disabled = !temporal.item;
        this.support.hidden = !variables.some(([, value]) => !getTemporalStatistics(value, temporal).length);
        this.support.textContent = this.support.hidden ? "" : `Period maps support instantaneous measurements and mean precipitation rates in ${temporal.precipitation.inputUnit}. Other rates and accumulated values are not supported.`;
        const variable = temporal.item?.properties["cube:variables"][temporal.variable];
        const precipitation = supportsPrecipitationTotal(variable, temporal), precisionChanged = precipitation !== this.precipitation;
        const areaSeries = temporal.statisticType === "area_statistic";
        const intervalSeries = areaSeries && variable && variable["eolab:time_support"] !== "instantaneous";
        this.precipitation = precipitation;
        this.periodMode.value = temporal.periodMode;
        const days = temporalPeriodDays(temporal);
        const values = {selectedMonth: temporal.startTime.split("T")[0].slice(0, 7), ...days};
        for (const name of ["start", "end"]) {
            const [date, time] = temporal[name + "Time"].split("T");
            values[name + "Date"] = date; values[name + "Time"] = time ?? "00:00";
            this[name + "Time"].step = precipitation ? "3600" : "any";
        }
        for (const [name, value] of Object.entries(values)) {
            if (precisionChanged || this.document.activeElement !== this[name]) this[name].value = value;
        }
        for (const [mode, group, fields] of [["month", this.monthFields, ["selectedMonth"]],
            ["days", this.dayFields, ["firstDay", "lastDay"]],
            ["times", this.exactFields, ["startDate", "startTime", "endDate", "endTime"]]]) {
            group.hidden = temporal.periodMode !== mode;
            for (const name of fields) this[name].disabled = group.hidden;
        }
        this.periodSummary.textContent = describeTemporalPeriod(temporal);
        this.periodHelp.textContent = precipitation ?
            "Total precipitation between these dates. Dates round to the nearest whole UTC hour when you finish editing; 30 minutes rounds forward. The calculation uses the dates shown." :
            (intervalSeries ? "Include each complete observation whose time interval overlaps this period. Dates are not rounded; values are not prorated or integrated over time." :
                temporal.periodMode === "times" ? "Include observations at or after the start and before the end." : "Include available observations throughout the selected whole UTC days.") +
            " Changing the observation displayed on the map does not change these dates.";
        this.availabilityHelp.textContent = "Browsing months does not change your period. Use this month sets the start to its first day and the end to the first day of the next month, both at 00:00 UTC. " +
            (precipitation ? "These are observation labels, not the boundaries of the intervals they represent. Missing intervals are omitted from the total." : "Missing observations are omitted from the calculation.");
        const selectionError = temporalSelectionError(temporal);
        this.status.textContent = selectionError; this.status.hidden = !selectionError;
        this.sourceRoot.setAttribute("aria-busy", String(temporal.loading));
        const choices = temporal.choices;
        this.options(this.month, (choices?.months ?? []).map(value => ({value, label: value})), choices?.month ?? "");
        this.month.disabled = temporal.loading || !choices?.months.length;
        this.useMonth.disabled = temporal.loading || !choices?.times.length;
        this.refresh.disabled = temporal.loading || !temporal.datasetKey;
        this.availability.hidden = !temporal.datasetKey;
        this.coverage.textContent = temporal.loading ? "Loading available observations…" : temporal.datesError ? temporal.datesError : !choices ? "Choose a variable to see available observations." :
            choices.times.length ? `${choices.times.length.toLocaleString()} observations in ${choices.month}. First: ${observationLabel(choices.times[0])}. Last: ${observationLabel(choices.times.at(-1))}.` :
                "No observations are available in this month. Choose another month or enter a different period.";
        this.options(this.statistic, getTemporalStatistics(variable, temporal), reduction.reducer);
        this.percentileField.hidden = reduction.reducer !== "percentile";
        this.percentile.disabled = reduction.reducer !== "percentile";
        if (this.document.activeElement !== this.percentile) this.percentile.value = reduction.percentile ?? "";
        let reductionError = "";
        try { captureTemporalReduction(reduction); } catch (error) { reductionError = error.message; }
        this.reductionStatus.textContent = reductionError; this.reductionStatus.hidden = !reductionError;
        const convention = reduction.reducer === "stdev" ? " Standard deviation uses the population formula." :
            reduction.reducer === "percentile" || reduction.reducer === "median" ? " Percentiles use linear interpolation between ordered values." :
                reduction.reducer === "sum" ? " The sum adds observations without multiplying by elapsed time." : "";
        const unit = variable?.unit;
        this.reductionHelp.textContent = areaSeries ?
            `Each CSV row summarizes valid pixels in the selected area for one observation. Pixels have equal weight; missing pixel values are omitted. Rows with no valid pixels have an empty value and are marked as having no valid data.${reduction.reducer === "count" ? " Result units: cells." : unit ? ` Result units: ${unit}.` : ""}${reduction.reducer === "stdev" ? " Standard deviation uses the population formula." : ""}` : precipitation ?
            `Each precipitation rate in ${temporal.precipitation.inputUnit} is multiplied by its interval duration in seconds and converted to ${temporal.precipitation.outputUnit}. Missing intervals and missing pixel values are omitted, not filled with zero. A second map counts valid available observations at each pixel.` :
            `Each valid observation has equal weight; missing values are omitted.${unit ? ` Result units: ${unit}.` : ""}${convention} A second map counts valid observations at each pixel.`;
        return selectionError || reductionError;
    }
}
