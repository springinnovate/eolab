/** Format a reviewed stack's timestamp for the period or snapshot that it represents.
 * @param {string} time Exact UTC observation key.
 * @param {string|undefined} period Archive's declared period or snapshot precision.
 * @return {string|null} Human-readable observation or null for the viewer's ordinary timestamp.
 */
export function observationLabel(time, period) {
    if (!period) return null;
    const date = period.startsWith("calendar_")
        ? new Date(Date.parse(time) - 1).toISOString() : time;
    switch (period) {
    case "year": case "calendar_year": return date.slice(0, 4);
    case "month": case "calendar_month": return date.slice(0, 7);
    case "day": case "calendar_day": return date.slice(0, 10);
    case "explicit": return "Period ending " + time.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
    default: return time.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
    }
}

/** Label a populated index month for the year or calendar month represented by its observations.
 * @param {string} month UTC index month.
 * @param {string|undefined} period Declared period or snapshot precision.
 * @return {string} Display label for this navigation choice.
 */
export function observationMonthLabel(month, period) {
    if (["year", "calendar_year", "calendar_month"].includes(period)) {
        return observationLabel(month + "-01T00:00:00Z", period);
    }
    return month;
}
