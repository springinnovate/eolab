/** Present stable calendar and UTC time controls for temporal analyses. */
import { getTemporalMonthBoundaries, getTemporalDayBoundaries, getTemporalSelectedDays,
    selectTemporalPeriodMode, describeTemporalPeriod, snapTemporalHour } from "./temporal-period.js";

/** Edit a month, included day range or exact UTC interval without starting a calculation. */
export class TemporalPeriodView {
    /** Build period controls using the owning form's field presentation.
     * @param {Object} helpers Form element helpers.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create a text-only element.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Create a labelled field.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {Document} helpers.document Owning document, used to preserve focused edits.
     * @param {Object} settings Form-specific identity and callback.
     * @param {(change:Partial<import("./temporal-period.js").TemporalPeriod>)=>void} settings.onEdit Update editable period fields.
     * @param {string} settings.idPrefix Unique prefix for this form's period control IDs.
     * @param {string} settings.describedBy Space-separated IDs of the owning form's period guidance and status.
     */
    constructor({element, field, options, document}, {onEdit, idPrefix, describedBy}) {
        this.document = document;
        this.root = element("div", "", "temporal-period");
        this.periodMode = element("select");
        options(this.periodMode, [{value: "month", label: "Whole month"}, {value: "days", label: "Date range"},
            {value: "times", label: "Exact times"}], "month");
        this.periodMode.addEventListener("change", () => onEdit(selectTemporalPeriodMode(this.temporal, this.periodMode.value)));
        this.monthFields = element("div"); this.dayFields = element("div", "", "temporal-period-grid");
        this.exactFields = element("div", "", "temporal-period-grid");
        this.selectedMonth = element("input"); this.selectedMonth.type = "month"; this.selectedMonth.required = true;
        this.selectedMonth.addEventListener("input", () => onEdit(getTemporalMonthBoundaries(this.selectedMonth.value)));
        this.monthFields.append(field(`${idPrefix}-selected-month`, "Month", this.selectedMonth));
        for (const [name, caption] of [["firstDay", "First day"], ["lastDay", "Last day (included)"]]) {
            const input = this[name] = element("input"); input.type = "date"; input.required = true;
            input.addEventListener("input", () => onEdit(getTemporalDayBoundaries(this.firstDay.value, this.lastDay.value)));
            this.dayFields.append(field(`${idPrefix}-${name}`, caption, input));
        }
        for (const [name, caption] of [["start", "Start"], ["end", "End"]]) {
            const group = element("div", "", "temporal-period-fields");
            for (const [part, type] of [["Date", "date"], ["Time", "time"]]) {
                const input = this[name + part] = element("input"); input.type = type; input.required = true;
                input.setAttribute("aria-describedby", describedBy);
                input.addEventListener("input", () => this.editExactBoundary(name, onEdit, false));
                input.addEventListener("change", () => this.editExactBoundary(name, onEdit, this.roundToHour));
                input.addEventListener("blur", () => {
                    if (this.roundToHour) this.editExactBoundary(name, onEdit, true);
                });
                const label = part === "Date" ? `${caption} date` : name === "start" ? "Start time (UTC)" : "End time (excluded, UTC)";
                group.append(field(`${idPrefix}-${name}${part}`, label, input));
            }
            this.exactFields.append(group);
        }
        this.periodSummary = element("p", "", "temporal-period-summary");
        this.periodSummary.setAttribute("role", "status");
        this.root.append(field(`${idPrefix}-mode`, "Choose time by", this.periodMode),
            this.monthFields, this.dayFields, this.exactFields, this.periodSummary);
    }

    /** Capture one exact boundary, visibly rounding only when the caller requires whole hours.
     * @param {"start"|"end"} name Boundary being edited.
     * @param {(change:Partial<import("./temporal-period.js").TemporalPeriod>)=>void} onEdit Draft update callback.
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

    /** Update the selected mode and boundaries without replacing focused controls.
     * @param {import("./temporal-period.js").TemporalPeriod} temporal Editable UTC period.
     * @param {{roundToHour:boolean}} settings Whether the owning calculation requires whole-hour boundaries.
     * @return {void}
     */
    render(temporal, {roundToHour}) {
        this.temporal = temporal;
        const precisionChanged = roundToHour !== this.roundToHour;
        this.roundToHour = roundToHour;
        this.periodMode.value = temporal.periodMode;
        const days = getTemporalSelectedDays(temporal);
        const values = {selectedMonth: temporal.startTime.split("T")[0].slice(0, 7), ...days};
        for (const name of ["start", "end"]) {
            const [date, time] = temporal[name + "Time"].split("T");
            values[name + "Date"] = date; values[name + "Time"] = time ?? "00:00";
            this[name + "Time"].step = roundToHour ? "3600" : "any";
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
    }
}
