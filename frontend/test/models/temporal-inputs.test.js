import test from "node:test";
import assert from "node:assert/strict";
import { describeTemporalResult } from "../../src/models/temporal-inputs.js";

test("period-map heading names the saved statistic and variable for a whole UTC month", () => {
    const input = {variable: "2_metre_dewpoint_temperature", startTime: "2000-04-01T00:00:00Z", endTime: "2000-05-01T00:00:00Z"};
    assert.equal(describeTemporalResult(input, {reducer: "mean"}), "Mean · 2 metre dewpoint temperature · April 2000");
    assert.equal(describeTemporalResult({...input, variable: "river_water_level"}, {reducer: "max"}), "Maximum · river water level · April 2000");
});

test("period-map heading retains exact partial-month boundaries and percentile", () => {
    const input = {variable: "surface_pressure", startTime: "2000-04-01T00:00:00.250Z", endTime: "2000-04-30T23:59:59.750Z"};
    assert.equal(describeTemporalResult(input, {reducer: "percentile", percentile: 97.5}),
        "Percentile 97.5 · surface pressure · 2000-04-01 00:00:00.250 → 2000-04-30 23:59:59.750 UTC · end excluded");
});

test("period-map heading uses UTC calendar boundaries across a year change", () => {
    const input = {variable: "water_temperature", startTime: "2000-11-30T16:00:00-08:00", endTime: "2000-12-31T16:00:00-08:00"};
    assert.equal(describeTemporalResult(input, {reducer: "stdev"}), "Standard deviation (population) · water temperature · December 2000");
});
