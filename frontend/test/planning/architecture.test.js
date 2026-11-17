import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("Planning consumes injected map capabilities without importing sibling implementations", async () => {
    for (const name of ["api.js", "controller.js", "view.js"]) {
        const source = await readFile(new URL(`../../src/planning/${name}`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /(?:from\s+|import\s*\()["']\.\.\//);
        assert.doesNotMatch(source, /localStorage|sessionStorage/);
    }
    const source = await readFile(new URL("../../src/planning/controller.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /fetch\s*\(/);
});
