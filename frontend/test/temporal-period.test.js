import test from "node:test";
import assert from "node:assert/strict";
import { getTemporalYearBoundaries, selectTemporalPeriodMode, describeTemporalPeriod } from "../src/temporal-period.js";

test("whole years retain leap days and use the existing excluded UTC end", () => {
    for (const [year, days] of [["2000", 366], ["1900", 365], ["2024", 366]]) {
        const period = {periodMode: "year", ...getTemporalYearBoundaries(year)};
        assert.equal((Date.parse(`${period.endTime}Z`) - Date.parse(`${period.startTime}Z`)) / 86400000, days);
        assert.equal(describeTemporalPeriod(period), `${year} · whole year · UTC`);
        assert.deepEqual(selectTemporalPeriodMode(period, "times"), {...period, periodMode: "times"});
    }
    assert.deepEqual(getTemporalYearBoundaries(""), {startTime: "", endTime: ""});
});

test("changing to a whole year expands the selected calendar year without relying on availability", () => {
    const temporal = {startTime: "2000-04-15T03:25", endTime: "2000-06-01T00:00"};
    const year = selectTemporalPeriodMode(temporal, "year");
    assert.deepEqual(year, {periodMode: "year", startTime: "2000-01-01T00:00", endTime: "2001-01-01T00:00"});
    assert.deepEqual(selectTemporalPeriodMode(year, "days"), {...year, periodMode: "days"});
    assert.deepEqual(selectTemporalPeriodMode(temporal, "month"),
        {periodMode: "month", startTime: "2000-04-01T00:00", endTime: "2000-05-01T00:00"});
});
