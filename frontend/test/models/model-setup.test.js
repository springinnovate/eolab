import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ModelsController } from "../../src/models/controller.js";
import { ModelsView } from "../../src/models/view.js";
import { captureModelSubmission } from "../../src/models/inputs.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, raster, area, selection } from "../../test-support/models/fixtures.js";

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
    assert.deepEqual(capabilities[0], ["api", "closeInputEditor", "getCatalogItem", "render"]);
});

test("Habitat preparation policy stays behind the registered model integration", () => {
    const read = name => readFileSync(new URL(`../../src/models/${name}`, import.meta.url), "utf8");
    for (const name of ["controller.js", "inputs.js", "view.js"]) {
        const source = read(name);
        assert.doesNotMatch(source, /from ["']\.\/habitat-/u, name);
        assert.doesNotMatch(source, /getHabitatEarthEngineInput|captureHabitat|loadHabitat|habitatCoverage|habitatPreparationSelections/u, name);
        assert.doesNotMatch(source, /setupState\./u, `${name} must treat integration state as opaque`);
    }
    assert.match(read("model-setup.js"), /from "\.\/habitat-setup\.js"/u);
    assert.doesNotMatch(read("habitat-setup.js"), /from ["']\.\/(controller|inputs|view)\.js/u);
});

test("ordinary models retain editable source and custom grids through duplication and metadata failures", async t => {
    const recipe = {...model, id: "editable-grid", inputs: {...model.inputs,
        preparation: {type: "raster_preparation", label: "Raster preparation"}},
    steps: [{id: "calculate", inputs: {raster: {input: "raster"}, preparation: {input: "preparation"}, settings: {value: {}}}}]};
    const document = new SummaryControlDocument(), view = new ModelsView(document);
    const sourceGrid = {crs: "EPSG:32610", pixelSize: [60, 30], origin: [17, 29], unit: "metre", approximate: false};
    let lookups = 0;
    const controller = new ModelsController({api: {discoverModels: async () => [recipe]},
        jobs: {subscribe: () => () => {}, tracked: new Set(), schedule: () => {}}, view,
        getContext: () => ({rasters: [structuredClone(raster)], area}),
        describeSource: async () => { lookups += 1; return {crs: sourceGrid.crs, projectedGrid: sourceGrid}; },
        closeVectorFilter: () => {}, newId: (() => { let sequence = 0; return () => String(++sequence).padStart(32, "0"); })()});
    t.after(() => controller.destroy());
    await controller.loadLibrary(); controller.chooseModel(recipe);
    view.setup.inputs.raster.source.dispatchEvent(new Event("change"));
    await new Promise(resolve => setImmediate(resolve));
    let grid = view.setup.inputs.preparation;
    assert.equal(grid.projection.disabled, false);
    assert.equal(grid.projection.value, "EPSG:32610");
    assert.equal(Number(grid.pixelX.value), 60); assert.equal(Number(grid.pixelY.value), 30);
    assert.deepEqual(controller.state.draft.inputs.preparation.origin, [17, 29]);
    assert.ok(lookups > 0);
    grid.resolution.value = "custom"; grid.resolution.dispatchEvent(new Event("change"));
    grid.pixelX.value = "0"; grid.pixelX.dispatchEvent(new Event("input"));
    assert.match(grid.status.textContent, /positive pixel/); assert.equal(view.setup.run.disabled, true);
    grid.pixelX.value = "12.5"; grid.pixelX.dispatchEvent(new Event("input"));
    grid.pixelY.value = "25.25"; grid.pixelY.dispatchEvent(new Event("input"));
    view.setup.inputs.raster.resampling.value = "bilinear";
    view.setup.inputs.raster.resampling.dispatchEvent(new Event("change"));
    const captured = captureModelSubmission(controller.state.draft, "b".repeat(32));
    const expected = {crs: "EPSG:32610", pixelSize: [12.5, 25.25], origin: [0, 0], resampling: {raster: "bilinear"}};
    assert.deepEqual(captured.inputs.preparation, expected); assert.equal(view.setup.run.disabled, false);
    controller.state.invocation = captured;
    await controller.duplicateRun(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(captureModelSubmission(controller.state.draft, "c".repeat(32)).inputs.preparation, expected);
    grid = view.setup.inputs.preparation;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    controller.describeSource = async () => { await pending; return {crs: sourceGrid.crs, projectedGrid: sourceGrid}; };
    grid.retry.dispatchEvent(new Event("click"));
    grid.pixelX.value = "100"; grid.pixelX.dispatchEvent(new Event("input"));
    grid.pixelY.value = "200"; grid.pixelY.dispatchEvent(new Event("input"));
    assert.equal(controller.state.draft.inputs.preparation.loading, true);
    assert.equal(view.setup.run.disabled, false);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(controller.state.draft.inputs.preparation.pixelSize, [100, 200]);
    controller.describeSource = async () => { throw new Error("Metadata temporarily unavailable"); };
    grid.retry.dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
    assert.match(grid.status.textContent, /enter a custom size/); assert.equal(view.setup.run.disabled, false);
    assert.deepEqual(captureModelSubmission(controller.state.draft, "d".repeat(32)).inputs.preparation.pixelSize, [100, 200]);
});
