import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeRasterAppearanceState } from "../../src/raster/appearance-state.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";

/**
 * Read an independent portable appearance from the browser/server fixture.
 * @return {Object} Complete appearance preserving both configurations.
 */
function appearance() {
    return JSON.parse(readFileSync(new URL(
        "../../../tests/fixtures/saved-map-v3-categorical.json", import.meta.url
    ), "utf8")).layers[0].style;
}

test("portable appearance preserves both styles and remains independent of its caller", () => {
    const candidate = appearance();
    const normalized = normalizeRasterAppearanceState(candidate);
    assert.deepEqual(normalized, candidate);
    candidate.continuous.definition.minimum = -500;
    candidate.categorical.categories[0].label = "Changed";
    assert.equal(normalized.continuous.definition.minimum, 0);
    assert.equal(normalized.categorical.categories[0].label, "Forest");
    assert.ok(Object.isFrozen(normalized));
    assert.ok(Object.isFrozen(normalized.continuous.definition));
    assert.ok(Object.isFrozen(normalized.categorical.categories[0]));
    const switched = normalizeRasterAppearanceState({ ...normalized, mode: "continuous" });
    assert.deepEqual(switched.categorical, normalized.categorical);
    assert.equal(switched.continuous.styleWasEdited, false);
});

test("legacy six-field and nine-field ramps migrate without replacing saved ranges", () => {
    for (const withOpacity of [false, true]) {
        const definition = { ...DEFAULT_RASTER_STYLE, minimum: -10 };
        if (!withOpacity) {
            for (const stop of ["minimum", "midpoint", "maximum"]) delete definition[`${stop}Opacity`];
        }
        const normalized = normalizeRasterAppearanceState({
            kind: "raster", definition, paletteName: "custom"
        });
        assert.equal(normalized.mode, "continuous");
        assert.equal(normalized.categorical, null);
        assert.equal(normalized.continuous.styleWasEdited, true);
        assert.deepEqual(normalized.continuous.definition, { ...DEFAULT_RASTER_STYLE, minimum: -10 });
    }
});

test("portable appearance rejects malformed modes, retained styles, and category tables", () => {
    const mutations = [
        candidate => { candidate.kind = "vector"; },
        candidate => { candidate.appearanceVersion = 2; },
        candidate => { candidate.appearanceVersion = true; },
        candidate => { candidate.mode = "other"; },
        candidate => { candidate.definition = {}; },
        candidate => { candidate.categorical = null; },
        candidate => { delete candidate.categorical; },
        candidate => { candidate.continuous.styleWasEdited = "false"; },
        candidate => { candidate.continuous.paletteName = "unknown"; },
        candidate => { candidate.continuous.definition.extra = 0; },
        candidate => { delete candidate.continuous.definition.minimumOpacity; },
        candidate => { candidate.continuous.definition.minimumOpacity = undefined; },
        candidate => { candidate.continuous.definition.minimumColor = ["#000000"]; },
        candidate => { candidate.continuous.definition.minimum = 200; },
        candidate => { candidate.categorical.categories[1].value = 41; },
        candidate => { candidate.categorical.categories[0].value = 1.5; },
        candidate => { candidate.categorical.categories[0].label = " "; },
        candidate => { candidate.categorical.categories[0].opacity = 2; },
        candidate => { candidate.categorical.sourcePath = "/data.tif"; },
        candidate => { candidate.mode = "continuous"; candidate.categorical.categories = []; }
    ];
    for (const mutate of mutations) {
        const candidate = appearance();
        mutate(candidate);
        assert.throws(() => normalizeRasterAppearanceState(candidate));
    }
    const unused = appearance(); unused.mode = "continuous"; unused.categorical = null;
    assert.equal(normalizeRasterAppearanceState(unused).categorical, null);
});

test("portable appearance keeps category resource limits at the raster boundary", () => {
    const candidate = appearance();
    candidate.categorical.categories = Array.from({ length: 257 }, (_, value) => ({
        value, label: "Land", color: "#000000", opacity: 1
    }));
    assert.throws(() => normalizeRasterAppearanceState(candidate), /256/);
    candidate.categorical.categories = candidate.categorical.categories.slice(0, 256)
        .map(category => ({ ...category, label: "🌲".repeat(128) }));
    assert.throws(() => normalizeRasterAppearanceState(candidate), /65536/);
});
