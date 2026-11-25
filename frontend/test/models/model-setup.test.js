import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ModelsController } from "../../src/models/controller.js";
import { ModelsView } from "../../src/models/view.js";
import { captureModelSubmission, createModelDraft } from "../../src/models/inputs.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, raster, area, selection, invocation, job } from "../../test-support/models/fixtures.js";

test("an unrelated model owns setup actions, readiness, capture, restoration and disposal through the common host", async t => {
    const recipe = {...model, id: "test-edge-model", title: "Edge model"};
    const events = [], sessions = [], capabilities = [];
    const integration = {
        createState: () => ({ready: false, restored: false}),
        createInput: () => undefined,
        captureInput: (draft, name) => {
            if (name !== "area") return undefined;
            if (!draft.setupState.ready) throw new Error("Choose the model's eligible features.");
            return {kind: "catalogSelection", selection: structuredClone(selection)};
        },
        restoreInput: (draft, name, value) => {
            if (name !== "area") return false;
            draft.inputs[name].area = structuredClone(value);
            events.push("restore-input");
            return true;
        },
        restoreState: draft => { draft.setupState.restored = true; events.push("restore-state"); },
        buildInput: (ui, handlers, name) => {
            if (name !== "area") return null;
            const root = ui.element("div"), choose = ui.button("Choose eligible features", () => handlers.onSetupAction("choose-features"));
            root.append(choose); ui.append(root);
            return {root, choose, renderModelInput: draft => draft.setupState.ready};
        },
        createSession: (draft, dependencies) => {
            capabilities.push(Object.keys(dependencies).sort());
            const abort = new AbortController();
            const session = {abort, dependencies,
                start: async () => { events.push(`start:${draft.setupState.restored}`); },
                inputChanged: (name, change) => { events.push(`change:${name}:${Object.keys(change).join(",")}`); },
                action: () => { draft.setupState.ready = true; dependencies.render(); },
                dispose: () => { abort.abort(); events.push("dispose"); },
            };
            sessions.push(session); return session;
        },
    };
    const document = new SummaryControlDocument(), view = new ModelsView(document);
    const api = {discoverModels: async () => [recipe, model]};
    const jobs = {subscribe: () => () => {}, tracked: new Set(), schedule: () => {}};
    const controller = new ModelsController({api, jobs, view,
        getContext: () => ({rasters: [structuredClone(raster)]}), closeVectorFilter: () => {},
        getSetupIntegration: value => value.id === recipe.id ? integration : null,
        newId: (() => { let sequence = 0; return () => String(++sequence).padStart(32, "0"); })(),
    });
    t.after(() => controller.destroy());
    await controller.loadLibrary(); controller.chooseModel(recipe);
    assert.equal(view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(controller.state.draft, "a".repeat(32)), /eligible features/);
    view.setup.inputs.area.choose.dispatchEvent(new Event("click"));
    assert.equal(view.setup.run.disabled, false);
    controller.editInput("raster", {raster: structuredClone(raster)});
    assert.ok(events.includes("change:raster:raster"));
    const captured = captureModelSubmission(controller.state.draft, "b".repeat(32));
    assert.deepEqual(captured.inputs.area.selection, selection);
    const currentDraft = controller.state.draft;
    controller.state.invocation = {...captured, model: {...captured.model, version: "unavailable"}};
    await controller.duplicateRun();
    assert.equal(controller.state.draft, currentDraft);
    assert.equal(sessions[0].abort.signal.aborted, false, "failed duplication leaves the current setup session usable");
    view.setup.inputs.area.choose.dispatchEvent(new Event("click"));
    assert.equal(view.setup.run.disabled, false);
    controller.state.invocation = captured;
    await controller.duplicateRun();
    assert.equal(sessions[0].abort.signal.aborted, true);
    assert.ok(events.indexOf("restore-state") < events.indexOf("start:true"));
    assert.ok(events.indexOf("restore-input") < events.indexOf("restore-state"));
    assert.equal(view.setup.run.disabled, true, "the restored integration still owns current readiness");
    view.setup.inputs.area.choose.dispatchEvent(new Event("click"));
    assert.equal(view.setup.run.disabled, false);
    controller.chooseModel(model);
    assert.equal(sessions[1].abort.signal.aborted, true);
    let renders = 0;
    const originalRender = view.render.bind(view);
    view.render = state => { renders += 1; originalRender(state); };
    sessions[1].dependencies.render();
    assert.equal(renders, 0, "late notifications from replaced setup cannot render its successor");
    assert.deepEqual(capabilities[0], ["api", "closeInputEditor", "getCatalogItem", "render", "showAreaOutline"]);
});

test("Habitat preparation policy stays behind the registered model integration", () => {
    const read = name => readFileSync(new URL(`../../src/models/${name}`, import.meta.url), "utf8");
    for (const name of ["controller.js", "inputs.js", "view.js"]) {
        const source = read(name);
        assert.doesNotMatch(source, /from ["']\.\/habitat-/u, name);
        assert.doesNotMatch(source, /getHabitatEarthEngineInput|captureHabitat|loadHabitat|habitatCoverage|habitatPreparationSelections/u, name);
        assert.doesNotMatch(source, /setupState\./u, `${name} must treat integration state as opaque`);
        assert.doesNotMatch(source, /output_grid|fixedGrid|raster_preparation|resampling|reference_mask|habitat_mask/u,
            `${name} must not interpret Habitat preparation settings or source roles`);
    }
    assert.match(read("model-setup.js"), /from "\.\/habitat-setup\.js"/u);
    assert.doesNotMatch(read("habitat-setup.js"), /from ["']\.\/(controller|inputs|view)\.js/u);
});

test("saved input descriptions use their model owner and leave ordinary inputs to the shared view", t => {
    const savedRecipe = {...model, id: "described-model", title: "Saved model"};
    const currentRecipe = {...savedRecipe, title: "Current model", version: "2.0.0", definitionSha256: "e".repeat(64)};
    const described = [], selectedDefinitions = [];
    let showArea = true;
    const integration = {describeInput: (saved, name) => {
        described.push({saved, name});
        if (name !== "area") return null;
        return showArea ? [{label: `Area from ${saved.model.definition.title}`, value: saved.inputs.area.selection.layerName},
            {label: "Saved filter", value: saved.inputs.area.selection.filter.rules[0].value}] : [];
    }};
    const document = new SummaryControlDocument(), view = new ModelsView(document, {getSetupIntegration: definition => {
        selectedDefinitions.push(definition);
        return definition.id === savedRecipe.id ? integration : null;
    }});
    const controller = new ModelsController({api: {},
        jobs: {subscribe: () => () => {}, tracked: new Set(), schedule: () => {}}, view,
        getContext: () => ({rasters: [raster], area}), closeVectorFilter: () => {}});
    t.after(() => controller.destroy());
    const saved = {...invocation, model: {...savedRecipe, definition: savedRecipe}, inputs: {...invocation.inputs,
        area: {kind: "catalogSelection", selection: structuredClone(selection)}}};
    const run = job({model: savedRecipe, status: "cancelled"});
    Object.assign(controller.state, {page: "run", library: [currentRecipe],
        draft: createModelDraft(currentRecipe, {rasters: [raster], area}, "current-draft"),
        runs: [run], selectedRun: run.jobId, invocation: saved});
    controller.render();
    const rows = view.run.inputsBody.children[0].children.map(node => node.textContent);
    assert.deepEqual(selectedDefinitions, [savedRecipe]);
    assert.deepEqual(described.map(({name}) => name), ["raster", "area"]);
    assert.ok(described.every(({saved: received}) => received === saved));
    assert.deepEqual(rows.slice(0, 6), ["Raster", `${raster.collectionId} / ${raster.itemId}`,
        "Area from Saved model", "basins", "Saved filter", "North"]);
    assert.equal(rows.includes("Area from Current model"), false);

    showArea = false; controller.state.invocation = {...saved}; controller.render();
    const hiddenRows = view.run.inputsBody.children[0].children.map(node => node.textContent);
    assert.equal(hiddenRows.includes("Area from Saved model"), false);
    assert.equal(hiddenRows.includes("Analysis area"), false, "An empty owned description does not fall back to the shared area description");

    controller.state.invocation = invocation; controller.render();
    const ordinaryRows = view.run.inputsBody.children[0].children.map(node => node.textContent);
    assert.equal(selectedDefinitions.at(-1), model);
    assert.equal(ordinaryRows[2], "Analysis area");
    assert.match(ordinaryRows[3], /Box · W 0.0000°/);
});
