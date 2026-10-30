/** Convert calendar controls to UTC periods shared by temporal analyses. */

/**
 * @typedef {Object} TemporalPeriod
 * @property {"year"|"month"|"days"|"times"} periodMode Calendar or exact-time entry mode.
 * @property {string} startTime Editable UTC start without a timezone suffix.
 * @property {string} endTime Editable excluded UTC end without a timezone suffix.
 */

/** Round a date-control value to the nearest UTC hour, with half hours rounded forward.
 * @param {string} value Editable date and time interpreted as UTC, possibly incomplete.
 * @return {string} Rounded boundary, or the unchanged incomplete entry for the user to finish.
 */
export function snapTemporalHour(value) {
    const time = Date.parse(`${value}Z`);
    return Number.isFinite(time) ? new Date(Math.round(time / 3600000) * 3600000).toISOString().slice(0, 16) : value;
}

/** Convert a calendar year to its UTC start and excluded end.
 * @param {string} year Complete four-digit calendar year, or empty.
 * @return {{startTime:string,endTime:string}} Boundaries for a temporal input.
 */
export function getTemporalYearBoundaries(year) {
    if (!year) return {startTime: "", endTime: ""};
    return {startTime: `${year}-01-01T00:00`, endTime: `${String(Number(year) + 1).padStart(4, "0")}-01-01T00:00`};
}

/** Convert a calendar month to its UTC start and excluded end.
 * @param {string} month Validated calendar month (YYYY-MM), or empty.
 * @return {{startTime:string,endTime:string}} Boundaries for a temporal input.
 */
export function getTemporalMonthBoundaries(month) {
    if (!month) return {startTime: "", endTime: ""};
    const startTime = `${month}-01T00:00`, end = new Date(`${startTime}Z`);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return {startTime, endTime: end.toISOString().slice(0, 16)};
}

/** Include both selected calendar days in a midnight-to-midnight UTC period.
 * @param {string} firstDay Validated calendar date (YYYY-MM-DD), or empty.
 * @param {string} lastDay Included final calendar date, or empty.
 * @return {{startTime:string,endTime:string}} UTC boundaries; an unfilled side stays empty.
 */
export function getTemporalDayBoundaries(firstDay, lastDay) {
    const end = lastDay ? new Date(`${lastDay}T00:00Z`) : null;
    end?.setUTCDate(end.getUTCDate() + 1);
    return {startTime: firstDay ? `${firstDay}T00:00` : "", endTime: end ? end.toISOString().slice(0, 16) : ""};
}

/** Return the calendar days touched by the editable UTC period.
 * An excluded midnight belongs to the previous selected day.
 * @param {{startTime:string,endTime:string}} temporal Editable UTC boundaries, including incomplete entries.
 * @return {{firstDay:string,lastDay:string}} Included dates for the day-range controls.
 */
export function getTemporalSelectedDays(temporal) {
    const end = Date.parse(`${temporal.endTime}Z`);
    return {firstDay: temporal.startTime.split("T")[0], lastDay: end % 86400000 === 0 ?
        new Date(end - 86400000).toISOString().slice(0, 10) : temporal.endTime.split("T")[0]};
}

/** Change entry mode, expanding to the selected year, month or whole days when requested.
 * Choosing Exact times keeps the current boundaries. The caller displays the new period before submission.
 * @param {{startTime:string,endTime:string}} temporal Current editable UTC boundaries.
 * @param {"year"|"month"|"days"|"times"} periodMode Chosen entry mode.
 * @return {TemporalPeriod} Draft fields to replace.
 */
export function selectTemporalPeriodMode(temporal, periodMode) {
    const {firstDay, lastDay} = getTemporalSelectedDays(temporal);
    const period = periodMode === "year" ? getTemporalYearBoundaries(firstDay.slice(0, 4)) :
        periodMode === "month" ? getTemporalMonthBoundaries(firstDay.slice(0, 7)) :
        periodMode === "days" ? getTemporalDayBoundaries(firstDay, lastDay) :
            {startTime: temporal.startTime, endTime: temporal.endTime};
    return {periodMode, ...period};
}

/** Describe the requested calendar period or exact UTC boundaries beside its controls.
 * @param {TemporalPeriod} temporal Editable mode and UTC boundaries.
 * @return {string} Human-readable period, or guidance while boundaries are incomplete or reversed.
 */
export function describeTemporalPeriod(temporal) {
    const start = new Date(`${temporal.startTime}Z`), end = new Date(`${temporal.endTime}Z`);
    if (!(end > start)) return "Choose a valid period.";
    if (temporal.periodMode === "year") return `${start.getUTCFullYear()} · whole year · UTC`;
    if (temporal.periodMode === "month") return new Intl.DateTimeFormat(undefined,
        {month: "long", year: "numeric", timeZone: "UTC"}).format(start) + " · whole month · UTC";
    const date = new Intl.DateTimeFormat(undefined, {day: "numeric", month: "short", year: "numeric", timeZone: "UTC"});
    if (temporal.periodMode === "days") return `${date.format(start)} – ${date.format(new Date(end - 86400000))} · both days included · UTC`;
    return `${date.format(start)} ${temporal.startTime.split("T")[1]} → ${date.format(end)} ${temporal.endTime.split("T")[1]} UTC · end excluded`;
}

/** Explain incomplete or reversed UTC boundaries at the user-input boundary.
 * @param {{startTime:string,endTime:string}} temporal Editable UTC boundaries.
 * @return {string} User-facing problem, or an empty string for a valid period.
 */
export function temporalPeriodError(temporal) {
    if (!temporal.startTime || !temporal.endTime) return "Choose a year, a month, a valid YYYY-MM-DD date range or exact times in UTC.";
    const start = Date.parse(`${temporal.startTime}Z`), end = Date.parse(`${temporal.endTime}Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "Enter a valid start and end date and time in UTC.";
    if (start >= end) return "The end must be later than the start.";
    return "";
}
