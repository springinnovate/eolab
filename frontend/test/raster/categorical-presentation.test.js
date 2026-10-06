import assert from "node:assert/strict";
import test from "node:test";

import {
    buildCategoricalRasterLegend,
    presentRasterPixelSnapshot,
} from "../../src/raster/categorical-presentation.js";
import { normalizeCategoricalRasterStyle } from "../../src/raster/categorical-style.js";

/**
 * Build a committed appearance containing exact edge codes in deliberate order.
 * @return {Readonly<import("../../src/raster/categorical-style.js").CategoricalRasterStyle>}
 * Normalized immutable category table.
 */
function categoryStyle() {
    return normalizeCategoricalRasterStyle({
        mode: "categorical",
        categories: [
            { value: 7, label: "Forest", color: "#008800", opacity: 0.4 },
            { value: 0, label: "Empty", color: "#000000", opacity: 0 },
            { value: -2, label: "Water", color: "#0000ff" },
            { value: Number.MAX_SAFE_INTEGER, label: "Maximum", color: "#ffffff" },
            { value: Number.MIN_SAFE_INTEGER, label: "Minimum", color: "#111111" },
        ],
        unmapped: { color: "#abcdef", opacity: 0.25 },
    });
}

/**
 * Build a point-result snapshot from finite values.
 * @param {number[]} values Values already validated by the analysis boundary.
 * @return {import("../../src/raster/categorical-presentation.js").RasterPixelPresentationSnapshot}
 * Raw mutable fixture used to verify projection copies.
 */
function pixelSnapshot(values) {
    return {
        position: { longitude: 1, latitude: 2 },
        samples: values.map((value, index) => ({
            key: `raster-${index}`, label: "Raster", axis: null,
            state: "value", value, errorMessage: "",
        })),
    };
}

test("categorical legend preserves table order, exact codes and independent opacity", () => {
    const style = categoryStyle();
    const legend = buildCategoricalRasterLegend(style);
    assert.equal(legend.kind, "categories");
    assert.equal(legend.description, "5 categories and unmapped values");
    assert.deepEqual(legend.entries.map(entry => entry.label), [
        "Forest (7)", "Empty (0)", "Water (-2)",
        "Maximum (9007199254740991)", "Minimum (-9007199254740991)", "Unmapped",
    ]);
    assert.deepEqual(legend.entries[0].symbol, {
        shape: "polygon", fill: "#008800", fillOpacity: 0.4,
        stroke: "#008800", strokeOpacity: 0, strokeWidth: 0,
    });
    assert.equal(legend.entries[1].symbol.fillOpacity, 0);
    assert.equal(legend.entries.at(-1).symbol.fill, "#abcdef");
    assert.equal(legend.entries.at(-1).symbol.fillOpacity, 0.25);
    assert.ok(Object.isFrozen(legend));
    assert.ok(Object.isFrozen(legend.entries));
    assert.ok(legend.entries.every(entry => Object.isFrozen(entry) && Object.isFrozen(entry.symbol)));
    assert.throws(() => { legend.entries[0].symbol.fillOpacity = 1; }, TypeError);
    const single = buildCategoricalRasterLegend(normalizeCategoricalRasterStyle({
        mode: "categorical", categories: [style.categories[0]],
    }));
    assert.equal(single.description, "1 category and unmapped values");
});

test("categorical pixels preserve exact numeric outcomes including transparent categories", () => {
    const input = pixelSnapshot([7, 0, -2, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 7.01, 8]);
    const result = presentRasterPixelSnapshot(input, () => categoryStyle());
    assert.deepEqual(result.samples.map(sample => sample.displayValue), [
        "Forest (7)", "Empty (0)", "Water (-2)",
        "Maximum (9007199254740991)", "Minimum (-9007199254740991)",
        "Unmapped (7.01)", "Unmapped (8)",
    ]);
    assert.deepEqual(result.samples.map(sample => sample.value), input.samples.map(sample => sample.value));
    assert.ok(result.samples.every(sample => sample.state === "value"));
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.position));
    assert.ok(Object.isFrozen(result.samples));
    assert.ok(result.samples.every(Object.isFrozen));
    input.position.latitude = 20;
    input.samples[0].value = 99;
    assert.equal(result.position.latitude, 2);
    assert.equal(result.samples[0].value, 7);
    assert.equal(Object.hasOwn(input.samples[0], "displayValue"), false);
});

test("unmapped numbers expand exponents without rounding fractional values", () => {
    const values = [1e-7, -1e-7, 1e21, -1.2345e22, Number.MIN_VALUE,
        Number.MAX_VALUE, 7 + Number.EPSILON * 4, 123456.78901234567];
    const result = presentRasterPixelSnapshot(pixelSnapshot(values), () => categoryStyle());
    const codes = result.samples.map(sample => sample.displayValue.slice("Unmapped (".length, -1));
    assert.deepEqual(codes.slice(0, 4), [
        "0.0000001", "-0.0000001", "1000000000000000000000", "-12345000000000000000000",
    ]);
    assert.equal(codes[4], `0.${"0".repeat(323)}5`);
    assert.equal(codes[6], "7.000000000000001");
    assert.equal(codes[7], "123456.78901234567");
    assert.ok(codes.every(code => !/[eE]/.test(code)));
    assert.deepEqual(codes.map(Number), values);
});

test("only committed categorical value results receive overrides and reprojection removes stale text", () => {
    const input = pixelSnapshot([7, 7]);
    input.omittedCount = 3;
    input.samples.push(...["nodata", "outside", "loading", "error"].map(state => ({
        key: state, label: state, state, value: null, errorMessage: state === "error" ? "Failed" : "",
        displayValue: "Stale presentation",
    })));
    const resolvedKeys = [];
    const result = presentRasterPixelSnapshot(input, key => {
        resolvedKeys.push(key);
        return key === "raster-0" ? categoryStyle() : null;
    });
    assert.deepEqual(resolvedKeys, ["raster-0", "raster-1"]);
    assert.equal(result.samples[0].displayValue, "Forest (7)");
    assert.ok(result.samples.slice(1).every(sample => !Object.hasOwn(sample, "displayValue")));
    assert.deepEqual(result.samples.slice(2).map(sample => sample.state), ["nodata", "outside", "loading", "error"]);
    assert.equal(result.omittedCount, 3);
    const continuous = presentRasterPixelSnapshot(result, () => null);
    assert.ok(continuous.samples.every(sample => !Object.hasOwn(sample, "displayValue")));
    assert.deepEqual(continuous.samples.map(sample => sample.value), result.samples.map(sample => sample.value));
    assert.equal(presentRasterPixelSnapshot(null, () => assert.fail("No sample to resolve")), null);
});

test("category label text stays literal in both legend and pixel descriptors", () => {
    const label = '<img src=x onerror="alert(1)">';
    const style = normalizeCategoricalRasterStyle({
        mode: "categorical", categories: [{ value: 7, label, color: "#000000" }],
    });
    assert.equal(buildCategoricalRasterLegend(style).entries[0].label, `${label} (7)`);
    assert.equal(presentRasterPixelSnapshot(pixelSnapshot([7]), () => style).samples[0].displayValue, `${label} (7)`);
});
