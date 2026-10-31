/** Present stable calendar and UTC time controls for temporal analyses. */
import { getTemporalYearBoundaries, getTemporalMonthBoundaries, getTemporalDayBoundaries, getTemporalSelectedDays,
    selectTemporalPeriodMode, describeTemporalPeriod, snapTemporalHour } from "./temporal-period.js";

/** Validate typed calendar text before it enters the UTC period contract.
 * @param {HTMLInputElement} input Year or ISO calendar-date text field.
 * @param {boolean} [yearOnly=false] Whether the field accepts a four-digit year rather than a date.
 * @return {string} Complete calendar value, or empty while invalid or incomplete.
 */
function readCalendarInput(input, yearOnly = false) {
    const value = input.value.trim();
    const pattern = yearOnly ? /^[0-9]{4}$/ : /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
    const date = new Date(`${yearOnly ? `${value}-01-01` : value}T00:00Z`);
    const valid = pattern.test(value) && !value.startsWith("0000") && Number.isFinite(date.getTime()) &&
        (yearOnly || date.toISOString().slice(0, 10) === value);
    input.setCustomValidity(value && !valid ? yearOnly ? "Enter a four-digit year, for example 2000." :
        "Enter a valid date as YYYY-MM-DD, for example 2000-01-01." : "");
    input.setAttribute("aria-invalid", String(Boolean(value && !valid)));
    return valid ? value : "";
}

/** Edit a year, month, included day range or exact UTC interval without starting a calculation. */
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
        options(this.periodMode, [{value: "year", label: "Whole year"}, {value: "month", label: "Whole month"},
            {value: "days", label: "Date range"}, {value: "times", label: "Exact times"}], "month");
        this.periodMode.addEventListener("change", () => onEdit(selectTemporalPeriodMode(this.temporal, this.periodMode.value)));
        this.calendarFields = element("div", "", "temporal-period-grid");
        this.dayFields = element("div", "", "temporal-period-grid");
        this.exactFields = element("div", "", "temporal-period-grid");
        this.selectedYear = element("input"); this.selectedYear.type = "text"; this.selectedYear.inputMode = "numeric";
        this.selectedYear.placeholder = "2000"; this.selectedYear.required = true;
        this.selectedYear.setAttribute("aria-describedby", describedBy);
        this.selectedMonth = element("select");
        options(this.selectedMonth, Array.from({length: 12}, (_, month) => ({value: String(month + 1).padStart(2, "0"),
            label: new Intl.DateTimeFormat(undefined, {month: "long", timeZone: "UTC"}).format(new Date(Date.UTC(2000, month)))})), "01");
        for (const input of [this.selectedYear, this.selectedMonth]) input.addEventListener("input", () => {
            const year = readCalendarInput(this.selectedYear, true);
            onEdit(this.periodMode.value === "year" ? getTemporalYearBoundaries(year) :
                getTemporalMonthBoundaries(year ? `${year}-${this.selectedMonth.value}` : ""));
        });
        this.monthField = field(`${idPrefix}-selected-month`, "Month", this.selectedMonth);
        this.calendarFields.append(field(`${idPrefix}-selected-year`, "Year", this.selectedYear), this.monthField);
        /** Capture typed or calendar-picked days without starting a calculation.
         * @return {void}
         */
        const editDays = () => onEdit(getTemporalDayBoundaries(readCalendarInput(this.firstDay), readCalendarInput(this.lastDay)));
        for (const [name, caption] of [["firstDay", "First day"], ["lastDay", "Last day (included)"]]) {
            this.dayFields.append(this.createDateField(name, caption, {element, field, idPrefix, describedBy}, editDays));
        }
        for (const [name, caption] of [["start", "Start"], ["end", "End"]]) {
            const group = element("div", "", "temporal-period-fields");
            group.append(this.createDateField(name + "Date", `${caption} date`, {element, field, idPrefix, describedBy},
                () => this.editExactBoundary(name, onEdit, this.roundToHour)));
            const date = this[name + "Date"];
            date.addEventListener("input", () => this.editExactBoundary(name, onEdit, false));
            date.addEventListener("change", () => this.editExactBoundary(name, onEdit, this.roundToHour));
            date.addEventListener("blur", () => { if (this.roundToHour) this.editExactBoundary(name, onEdit, true); });
            const time = this[name + "Time"] = element("input"); time.type = "time"; time.required = true;
            time.setAttribute("aria-describedby", describedBy);
            time.addEventListener("input", () => this.editExactBoundary(name, onEdit, false));
            time.addEventListener("change", () => this.editExactBoundary(name, onEdit, this.roundToHour));
            time.addEventListener("blur", () => { if (this.roundToHour) this.editExactBoundary(name, onEdit, true); });
            group.append(field(`${idPrefix}-${name}Time`, name === "start" ? "Start time (UTC)" : "End time (excluded, UTC)", time));
            this.exactFields.append(group);
        }
        this.periodSummary = element("p", "", "temporal-period-summary");
        this.periodSummary.setAttribute("role", "status");
        this.root.append(field(`${idPrefix}-mode`, "Time range", this.periodMode),
            this.calendarFields, this.dayFields, this.exactFields, this.periodSummary);
    }

    /** Pair a full-date text field with a compact, independently labelled native calendar.
     * @param {string} name Property used for the date field and its calendar picker.
     * @param {string} caption Visible date label.
     * @param {Object} helpers Existing form presentation and identity.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create a text-only element.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Create a labelled field.
     * @param {string} helpers.idPrefix Unique form ID prefix.
     * @param {string} helpers.describedBy Owning form's period guidance and status IDs.
     * @param {()=>void} onEdit Capture a changed calendar date.
     * @return {HTMLDivElement} Label, editable ISO date and native calendar picker.
     */
    createDateField(name, caption, {element, field, idPrefix, describedBy}, onEdit) {
        const input = this[name] = element("input"); input.type = "text"; input.required = true;
        input.placeholder = "YYYY-MM-DD"; input.setAttribute("aria-describedby", describedBy);
        const label = field(`${idPrefix}-${name}`, `${caption} (YYYY-MM-DD)`, input);
        const picker = this[name + "Picker"] = element("input", "", "temporal-calendar-picker"); picker.type = "date";
        picker.setAttribute("aria-label", `Choose ${caption.toLowerCase()} from calendar`);
        picker.title = `Choose ${caption.toLowerCase()} from calendar`;
        picker.addEventListener("change", () => { input.value = picker.value; onEdit(); });
        if (name === "firstDay" || name === "lastDay") input.addEventListener("input", onEdit);
        const row = element("div", "", "temporal-date-entry"); row.append(input, picker);
        const root = element("div", "", "temporal-date-field"); root.append(label, row);
        return root;
    }

    /** Capture one exact boundary, visibly rounding only when the caller requires whole hours.
     * @param {"start"|"end"} name Boundary being edited.
     * @param {(change:Partial<import("./temporal-period.js").TemporalPeriod>)=>void} onEdit Draft update callback.
     * @param {boolean} round Whether this completed edit must snap to a whole UTC hour.
     * @return {void}
     */
    editExactBoundary(name, onEdit, round) {
        const date = this[name + "Date"], time = this[name + "Time"], day = readCalendarInput(date);
        let value = day ? `${day}T${time.value}` : "";
        if (round && value) {
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
        const values = {selectedYear: temporal.startTime.slice(0, 4), selectedMonth: temporal.startTime.slice(5, 7) || "01", ...days};
        for (const name of ["start", "end"]) {
            const [date, time] = temporal[name + "Time"].split("T");
            values[name + "Date"] = date; values[name + "Time"] = time ?? "00:00";
            this[name + "Time"].step = roundToHour ? "3600" : "any";
        }
        for (const [name, value] of Object.entries(values)) {
            if (precisionChanged || this.document.activeElement !== this[name]) {
                this[name].value = value;
                if (name !== "selectedMonth") this[name].setCustomValidity("");
                this[name].setAttribute("aria-invalid", "false");
            }
            if (this[name + "Picker"]) this[name + "Picker"].value = value;
        }
        this.calendarFields.hidden = !["year", "month"].includes(temporal.periodMode);
        this.selectedYear.disabled = this.calendarFields.hidden;
        this.monthField.hidden = temporal.periodMode !== "month";
        this.selectedMonth.disabled = this.monthField.hidden;
        for (const [mode, group, fields] of [["days", this.dayFields, ["firstDay", "lastDay"]],
            ["times", this.exactFields, ["startDate", "startTime", "endDate", "endTime"]]]) {
            group.hidden = temporal.periodMode !== mode;
            for (const name of fields) {
                this[name].disabled = group.hidden;
                if (this[name + "Picker"]) this[name + "Picker"].disabled = group.hidden;
            }
        }
        this.periodSummary.textContent = describeTemporalPeriod(temporal);
    }
}
