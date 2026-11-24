/** Format observation timestamps for raster layer names and date choices. */

const dateTimeOptions = {
    timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
};
const minuteFormat = new Intl.DateTimeFormat(undefined, dateTimeOptions);
const secondFormat = new Intl.DateTimeFormat(undefined, {...dateTimeOptions, second: "2-digit"});

/**
 * Format a Catalog observation in UTC, showing seconds only when nonzero.
 * @param {string} timestamp ISO timestamp of the selected observation.
 * @return {string} Localized date and time for a control or title labeled UTC.
 * @throws {RangeError} If the timestamp is invalid.
 */
export function formatObservationTime(timestamp) {
    const date = new Date(timestamp);
    const formatter = date.getUTCSeconds() === 0 ? minuteFormat : secondFormat;
    return formatter.format(date);
}
