import {getTemporalDayBoundaries, getTemporalMonthBoundaries, getTemporalYearBoundaries} from "./temporal-period.js";

/** Return the last covered UTC date of a prepared interval, or the date of a snapshot.
 * @param {string} time Exact UTC selection key.
 * @param {string|undefined} period Declared calendar period, explicit range or snapshot precision.
 * @return {string} ISO calendar date used for browsing.
 */
export function observationDate(time, period) {
    return (period?.startsWith("calendar_") || period === "explicit" ?
        new Date(Date.parse(time) - 1).toISOString() : time).slice(0, 10);
}

/** Format a reviewed stack's timestamp for the period or snapshot that it represents.
 * @param {string} time Exact UTC observation key.
 * @param {string|undefined} period Archive's declared period or snapshot precision.
 * @param {string} [start] Inclusive UTC start of an explicit range.
 * @return {string|null} Human-readable observation or null for the viewer's ordinary timestamp.
 */
export function observationLabel(time, period, start) {
    if (!period) return null;
    const date = observationDate(time, period);
    switch (period) {
    case "year": case "calendar_year": return date.slice(0, 4);
    case "month": case "calendar_month": return date.slice(0, 7);
    case "day": case "calendar_day": return date.slice(0, 10);
    case "explicit": return start ?
        `${start.replace("T", " ").replace(/(?:\.000)?Z$/, "")} to ${time.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC")} (end excluded)` :
        "Period ending " + time.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
    default: return time.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
    }
}

/** Label a populated index month for the year or calendar month represented by its observations.
 * @param {string} month Populated UTC month returned by the catalog.
 * @param {string|undefined} period Declared period or snapshot precision.
 * @return {string} Display label for this navigation choice.
 */
export function observationMonthLabel(month, period) {
    return ["year", "calendar_year"].includes(period) ? month.slice(0, 4) : month;
}

/** Fill a UTC analysis period from the displayed observations in chronological order.
 * @param {string} first Exact key of the first included observation.
 * @param {string} last Exact key of the last included observation, equal to first for a single frame.
 * @param {string|undefined} period Declared stack period, or undefined for ordinary monthly browsing.
 * @param {Object<string,string>} [starts] Published inclusive starts of explicit ranges.
 * @return {import("./temporal-period.js").TemporalPeriod} Editable analysis bounds with an excluded end.
 */
export function observationPeriod(first, last, period, starts) {
    const day = observationDate(first, period);
    switch (period) {
    case "year": case "calendar_year":
        return {periodMode: "year", ...getTemporalYearBoundaries(day.slice(0, 4))};
    case "day": case "calendar_day":
        return {periodMode: "days", ...getTemporalDayBoundaries(day, observationDate(last, period))};
    case "explicit":
        return {periodMode: "times", startTime: starts[first].slice(0, 19), endTime: last.slice(0, 19)};
    case "timestamp":
        return {periodMode: "times", startTime: first.slice(0, 19),
            endTime: new Date(Date.parse(last) + 1000).toISOString().slice(0, 19)};
    default:
        return {periodMode: "month", ...getTemporalMonthBoundaries(day.slice(0, 7))};
    }
}
