import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ModelsController} from "../../src/models/controller.js";
import {ModelsView} from "../../src/models/view.js";
import {ProcessingJobs} from "../../src/processing/jobs.js";
import {SummaryControlDocument} from "../../test-support/processing/summary-document.js";
import {model, job} from "../../test-support/models/fixtures.js";

/** Read this recipe's plain scalar declarations for its browser integration test.
 * Backend tests own full YAML parsing. This fixture reads the installed input
 * labels, field roles and numeric setting instead of copying their configuration.
 * @return {Object} Model fixture populated from the summary recipe's declarations.
 * @throws {Error} If the installed recipe cannot be read or its expected sections are absent.
 */
function installedSummaryRecipe() {
    const yaml = readFileSync(new URL("../../../src/eolab_app/processing/recipes/vector-summary.yaml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const input = yaml.match(/^inputs:\n([\s\S]*?)^parameters:/m)[1];
    const declarations = Object.fromEntries([...input.matchAll(/^    (type|label|geometry): (.+)$/gm)].map(([, key, value]) => [key, value]));
    declarations.fields = Object.fromEntries([...input.matchAll(/^      ([a-z][a-z0-9_-]*):\n        label: (.+)\n        kind: (scalar|numeric)$/gm)]
        .map(([, role, label, kind]) => [role, {label, kind}]));
    const parameter = yaml.match(/^parameters:\n  boundary_tolerance_m:\n([\s\S]*?)^steps:/m)[1];
    const settings = Object.fromEntries([...parameter.matchAll(/^    (type|label|unit|minimum|default): (.+)$/gm)]
        .map(([, key, value]) => [key, ["minimum", "default"].includes(key) ? Number(value) : value]));
    return {...model, id: "vector-summary", title: "Vector summary", inputs: {vector: declarations},
        parameters: {boundary_tolerance_m: settings},
        outputs: {summary: {source: "calculate.summary", role: "result", presentation: "map", saveEligible: true}}};
}

/** Apply an option through the actual retained control's change event.
 * @param {HTMLSelectElement} control Generic input control.
 * @param {string} value Selected option.
 * @return {void}
 */
function choose(control, value) { control.value = value; control.dispatchEvent(new Event("change")); }

test("the installed summary recipe configures generic vector controls and captures its named field roles", async t => {
    const recipe = installedSummaryRecipe();
    assert.deepEqual(recipe.inputs.vector, {type: "vector", label: "Polygon layer", geometry: "polygon", fields: {
        group: {label: "Group by", kind: "scalar"}, value: {label: "Field to sum", kind: "numeric"},
    }});
    const filter = {enabled: true, match: "all", rules: [{field: "state_name", operator: "eq", value: "North"}]};
    const selection = {collectionId: "vectors", itemId: "ecosystems", assetKey: "data", layerName: "ecosystems", filter};
    const fields = [{name: "state_name", type: "str"}, {name: "total_es", type: "float"}];
    const context = {rasters: [], vectors: [{key: "states", label: "Ecosystem values", filter, fields,
        scalarFields: fields, numericFields: fields.slice(1), selection,
        allSelection: {...selection, filter: {enabled: false, match: "all", rules: []}}}]};
    const submissions = [], stored = new Map(), run = job({model: recipe});
    const api = {discoverModels: async () => [recipe], submitModelRun: async value => { submissions.push(value); return run; },
        getJob: async () => run, readJobStatuses: async () => ({jobs: []}),
        readModelInvocation: async () => ({model: {...recipe, definition: recipe}, inputs: submissions[0].inputs,
            parameters: submissions[0].parameters})};
    const clock = {setTimeout() {}, clearTimeout() {}}, view = new ModelsView(new SummaryControlDocument());
    const controller = new ModelsController({api, jobs: new ProcessingJobs(api, clock), view, clock, getContext: () => context,
        storage: {getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key)},
        closeVectorFilter() {}, onOpen() {}, onClose() {}, newId: () => "e".repeat(32)});
    t.after(() => controller.destroy());
    await controller.loadLibrary();
    controller.chooseModel(controller.state.library[0]);
    const controls = view.setup.inputs.vector;
    assert.ok(controls.root.querySelectorAll("label").some(label => label.textContent === "Group by"));
    assert.ok(controls.root.querySelectorAll("label").some(label => label.textContent === "Field to sum"));
    choose(controls.source, "states");
    assert.equal(controls.fields.value.children.some(option => option.value === "state_name"), false);
    choose(controls.fields.group, "state_name");
    choose(controls.fields.value, "total_es");
    assert.equal(view.setup.run.disabled, false);
    await controller.submit();
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0].inputs.vector, {selection, fields: {group: "state_name", value: "total_es"}});
    assert.deepEqual(submissions[0].parameters, {boundary_tolerance_m: 1000});
});
