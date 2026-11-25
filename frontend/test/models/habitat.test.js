import test from "node:test";
import assert from "node:assert/strict";
import { ModelsController } from "../../src/models/controller.js";
import { ModelsView } from "../../src/models/view.js";
import { captureModelSubmission, createModelDraft, modelSourceKey } from "../../src/models/inputs.js";
import { ProcessingRequestError } from "../../src/processing/api.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, selection, job, fileManifest, clipResult } from "../../test-support/models/fixtures.js";

const habitat = {...model, id: "habitat-condition", title: "Ecosystem Condition",
    description: "Fit expected habitat responses from reference sites and map their similarity.", parameters: {}, inputs: {
    stack: {type: "habitat_stack", label: "Predictors and observed responses"},
    area: {type: "summary_area", label: "Analysis area"},
    references: {type: "habitat_references", label: "Reference sites"},
    habitat_mask: {type: "optional_raster", label: "Habitat assessment mask"},
    preparation: {type: "raster_preparation", label: "Raster preparation"},
}, steps: [{id: "calculate", operation: "habitat.condition.v1", inputs: {
    stack: {input: "stack"}, area: {input: "area"}, references: {input: "references"}, habitat_mask: {input: "habitat_mask"},
    preparation: {input: "preparation"}, settings: {value: {output_grid: {crs: "EPSG:6933", pixel_size: [500, 500], origin: [0, 0]},
    fold_count: 5, sampling_block_size_meters: 25000, validation_block_size_meters: 50000,
    minimum_predictor_coverage: 0.8, maximum_row_missing_fraction: 0.2, spline_knot_count: 6,
    minimum_response_coverage: 0.5, ridge_alpha: 1, samples_per_class_per_block: 100,
    random_seed: 42, tile_size_pixels: 128, tile_origin: [0, 0], window_size_pixels: 256, covariance_shrinkage: 0.1,
}}}, parameters: {}}], outputs: {
    reference_similarity: {type: "raster", label: "Reference similarity", source: "calculate.reference_similarity", role: "result", presentation: "map", saveEligible: true},
    diagnostics: {type: "raster", label: "Response diagnostics", source: "calculate.diagnostics", role: "intermediate", presentation: "download", saveEligible: false},
}};

/** Flush selection and view callbacks after a user action.
 * @return {Promise<void>} Resolves after pending promise reactions.
 */
const settle = () => new Promise(resolve => setImmediate(resolve));

const years = [2015, 2016, 2017, 2018, 2019];
const annual = Object.fromEntries(years.map(year => [year, String(year)]));
const growingSeason = Object.fromEntries(years.map(year => [year, `${year} growing season`]));
const rainfallWindow = Object.fromEntries(years.map(year => [year, `${year - 9}–${year} rainfall variability`]));

const earthEngineOptions = {defaultYear: 2018, minimumYear: 2015, maximumYear: 2019,
    grid: {crs: "EPSG:6933", pixelSize: [500, 500], origin: [0, 0], unit: "metre", approximate: false}, datasets: [
        {id: "era5_daily", label: "ERA5 daily aggregates", url: "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_DAILY", roles: ["predictor"], requiredRoles: [],
            inputsByRole: {predictor: [
                {bands: ["total_precipitation"], requiredDatasets: ["era5_daily"], periods: annual},
                {bands: ["mean_2m_air_temperature", "total_precipitation"], requiredDatasets: ["era5_daily", "modis_phenology"], periods: growingSeason},
                {bands: ["total_precipitation"], requiredDatasets: ["era5_daily"], periods: rainfallWindow},
            ]}},
        {id: "modis_phenology", label: "MODIS phenology", url: "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD12Q2", roles: ["predictor", "response"], requiredRoles: [],
            inputsByRole: {predictor: [{bands: ["Greenup_1", "Senescence_1"], requiredDatasets: ["era5_daily", "modis_phenology"], periods: annual}],
                response: [{bands: ["NumCycles"], requiredDatasets: ["modis_phenology"], periods: annual}]}},
        {id: "landsat_ndvi", label: "Landsat NDVI", url: "https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_COMPOSITES_C02_T1_L2_8DAY_NDVI", roles: ["response"], requiredRoles: [],
            inputsByRole: {response: [{bands: ["NDVI"], requiredDatasets: ["landsat_ndvi"], periods: annual}]}},
        {id: "srtm_landforms", label: "SRTM landforms", url: "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_SRTM_landforms", roles: ["predictor"], requiredRoles: ["predictor"],
            inputsByRole: {predictor: [{bands: ["constant"], requiredDatasets: ["srtm_landforms"],
                periods: Object.fromEntries(years.map(year => [year, "Fixed map for every assessment year"]))}]}},
    ]};

/** Existing Catalog selections used for preparation, independent of Map layers.
 * @type {Object[]}
 */
const preparationSelections = [structuredClone(selection), {...structuredClone(selection),
    filter: {...selection.filter, rules: [{...selection.filter.rules[0], value: "South"}]}}];

/** Choose a preparation descriptor through the rendered control and await coverage.
 * @param {Object} harness Models controller/view fixture.
 * @param {number|null} [index=0] Local option index; null clears the selection.
 * @return {Promise<void>} Completion after current coverage is rendered.
 */
async function choosePreparationSelection(harness, index = 0) {
    edit(harness.view.setup.inputs.area.preparationSelection.source, index === null ? "" : String(index));
    await settle();
}

/** Change a rendered form field through its actual event handler.
 * @param {HTMLElement} control Rendered input or select.
 * @param {string} value User-entered value.
 * @param {string} [event="change"] Event consumed by this control.
 * @return {void}
 */
function edit(control, value, event = "change") {
    control.value = value; control.dispatchEvent(new Event(event));
}

/** Change a setup checkbox through its actual event handler.
 * @param {HTMLInputElement} checkbox Rendered checkbox.
 * @param {boolean} checked Requested checked state.
 * @return {void}
 */
function setCheckbox(checkbox, checked) {
    checkbox.checked = checked; checkbox.dispatchEvent(new Event("change"));
}

/** Open Habitat setup with real Models components and explicit API boundaries.
 * @param {Object} [contextOverrides={}] Map choices to replace in the starting context.
 * @param {import("../../src/models/model-setup.js").ModelSetupDependencies["showAreaOutline"]} [showAreaOutline] Display the selected Catalog polygons for the lifetime of a signal.
 * @return {Promise<Object>} Controller, view, source choices and captured API requests.
 */
async function fixture(contextOverrides = {}, showAreaOutline = async () => true) {
    const requests = [], filters = [], values = new Map();
    const uploads = [], released = [];
    const context = {
        rasters: ["Environment", "Habitat class", "Productivity", "Reference mask", "Assessment mask"].map((label, index) =>
            ({collectionId: "eolab-mounted-geotiffs", itemId: `geotiff-${index.toString(16).padStart(24, "0")}`, label, visible: false})),
        vectors: [{...selection, key: "view:basins", label: "Catalog basins", sourceOrigin: "catalog", fields: [{name: "BASIN", type: "str"}]},
            {key: "view:sites", sourceOrigin: "upload", uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "reference_sites", label: "Uploaded sites",
                filter: structuredClone(selection.filter), fields: [{name: "BASIN", type: "str"}]}],
        area: {kind: "selectedArea", selectedBounds: {west: 0, south: 0, east: 1, north: 1}},
        ...contextOverrides,
    };
    const api = {discoverModels: async () => [model, habitat], listModelRuns: async () => ({jobs: [], nextCursor: null}),
        getHabitatEarthEngineOptions: async () => structuredClone(earthEngineOptions),
        getCatalogItem: async source => ({collection: source.collectionId, id: source.itemId, properties: {title: "Watersheds"}}),
        getHabitatPreparationSelections: async () => ({selections: structuredClone(preparationSelections)}),
        getHabitatPreparationCoverage: async (_selection, year) => ({year, requiredTiles: 4, cachedTiles: 4, missingTiles: 0}),
        uploadPolygonArea: async polygons => {
            const polygonArea = {id: String(uploads.length + 1).padStart(32, "0"), sha256: "a".repeat(64)};
            uploads.push({polygons, polygonArea}); return {polygonArea};
        },
        discardPolygonArea: async id => { released.push(id); },
        submitModelRun: async request => { requests.push(request); return job({model: habitat}); },
        getJob: async () => job({model: habitat}),
        readModelInvocation: async () => ({...requests[0], model: {...habitat, definition: habitat}})};
    const doc = new SummaryControlDocument(), view = new ModelsView(doc);
    const jobs = {subscribe: () => () => {}, tracked: new Set(), schedule() {}, accept() {}};
    let id = 0;
    const controller = new ModelsController({api, jobs, view, getContext: () => context, showAreaOutline,
        getCatalogItem: (source, signal) => api.getCatalogItem(source, signal),
        prepareVector: async source => ({selection: source.uploadId
            ? {uploadId: source.uploadId, layerName: source.layerName, filter: source.filter}
            : {...selection, filter: source.filter}, matched: source.filter.rules[0].value === "North" ? 3 : 1, total: 8}),
        editVectorFilter: request => { filters.push(request); }, closeVectorFilter: () => filters.at(-1)?.close(),
        applyMapFilter: async (source, area) => {
            context.vectors.find(value => value.key === source.key).filter = area.selection.filter;
            controller.refreshMapLayers(); return area.selection.filter;
        }, onOpen: () => {}, onClose: () => {},
        storage: {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)},
        newId: () => String(++id).padStart(32, "0")});
    await controller.loadLibrary();
    assert.deepEqual(controller.state.library.map(recipe => recipe.id), [model.id, habitat.id]);
    controller.setActive(true); controller.chooseModel(habitat);
    await settle();
    return {controller, view, doc, context, api, jobs, requests, filters, uploads, released};
}

/** Select a vector and review the named input's filter using the composed editor.
 * @param {Object} harness Actual Models controller and view fixture.
 * @param {string} name Recipe input receiving this independent selection.
 * @param {Object} source Catalog or uploaded vector offered by the map.
 * @param {string} basin Attribute value to select.
 * @return {Promise<void>} Resolves after the filter is applied.
 */
async function chooseVector(harness, name, source, basin) {
    const controls = harness.view.setup.inputs[name];
    edit(controls.source, `vector:${source.key}`); await settle();
    controls.editFilter.dispatchEvent(new Event("click")); await settle();
    const action = harness.filters.at(-1), filter = structuredClone(selection.filter);
    assert.equal(action.host, controls.filterHost);
    filter.rules[0].value = basin; await action.apply(filter); action.complete();
}

/** Fill the predictor/response lists through their rendered controls.
 * @param {Object} harness Actual Models controller and view fixture.
 * @return {void}
 */
function chooseStack(harness) {
    const controls = harness.view.setup.inputs.stack;
    edit(controls.source, "manual");
    edit(controls.predictors[0].name, "environment", "input");
    edit(controls.predictors[0].source, modelSourceKey(harness.context.rasters[0]));
    controls.addPredictor.dispatchEvent(new Event("click"));
    edit(controls.predictors[1].name, "habitat_type", "input");
    edit(controls.predictors[1].source, modelSourceKey(harness.context.rasters[1]));
    edit(controls.responses[0].name, "productivity", "input");
    edit(controls.responses[0].source, modelSourceKey(harness.context.rasters[2]));
    edit(controls.categorical, "habitat_type");
}

test("Habitat starts with all datasets selected in collapsed role groups", async () => {
    const h = await fixture(), stack = h.view.setup.inputs.stack;
    const chooser = h.view.elements["library-items"].querySelectorAll("button").find(button => button.textContent === "Ecosystem Condition");
    assert.equal(chooser.getAttribute("aria-label"), "Set up Ecosystem Condition");
    assert.equal(h.view.elements["setup-heading"].textContent, "Ecosystem Condition");
    assert.equal(h.view.setup.fields.getAttribute("aria-labelledby"), "models-setup-heading");
    assert.equal(h.view.setup.label.value, "Ecosystem Condition");
    assert.equal(stack.source.value, "earthEngine");
    assert.equal(stack.source.parentElement.textContent, "Input data");
    assert.equal(stack.source.children[0].textContent, "Prepared Earth Engine rasters");
    assert.equal(stack.manual.hidden, true); assert.equal(stack.manual.disabled, true);
    assert.equal(stack.year.value, "2018");
    const links = stack.root.querySelectorAll("a");
    assert.equal(links[0].textContent, "NHI Terrestrial Integrity Modeling");
    assert.equal(links[0].href, "https://github.com/springinnovate/nhi-terrestrial-integrity-modeling");
    const administration = links.find(link => link.textContent === "Manage cached inputs");
    assert.equal(administration.href, "/admin-eolab/habitat");
    assert.equal(administration.target, "_blank");
    assert.equal(administration.rel, "noopener noreferrer");
    for (const [role, group] of Object.entries(stack.datasetGroups)) {
        const datasets = earthEngineOptions.datasets.filter(dataset => dataset.roles.includes(role));
        assert.equal(group.root.open, false);
        assert.equal(group.summary.textContent, `${group.title} · ${datasets.length} of ${datasets.length} selected`);
        for (const dataset of datasets) {
            const controls = group.controls.get(dataset.id);
            assert.equal(controls.checkbox.checked, true);
            assert.equal(controls.checkbox.disabled, dataset.requiredRoles.includes(role));
            assert.equal(controls.label.textContent, dataset.label);
            assert.equal(controls.link.href, dataset.url);
            assert.equal(controls.link.getAttribute("aria-label"), `Source information for ${dataset.label}`);
            assert.notEqual(controls.link.parentElement, controls.checkbox.parentElement, "Source links are outside the checkbox label");
        }
    }
    assert.equal(stack.datasetGroups.predictor.controls.get("srtm_landforms").required.hidden, false);
    const phenology = stack.datasetGroups.predictor.controls.get("modis_phenology");
    const response = stack.datasetGroups.response.controls.get("modis_phenology");
    assert.doesNotMatch(phenology.details.textContent, /2001–2024/, "Only dates used for this assessment belong in the row");
    assert.equal(phenology.details.textContent, "Bands used\n2018 · Greenup_1, Senescence_1");
    assert.equal(response.details.textContent, "Bands used\n2018 · NumCycles");
    assert.equal(phenology.checkbox.getAttribute("aria-describedby"), phenology.details.id);
    const daily = stack.datasetGroups.predictor.controls.get("era5_daily");
    assert.equal(daily.details.textContent, "Bands used\n2018 · total_precipitation\n2018 growing season · mean_2m_air_temperature, total_precipitation\n2009–2018 rainfall variability · total_precipitation");
    edit(stack.year, "2015");
    assert.equal(phenology.details.textContent, "Bands used\n2015 · Greenup_1, Senescence_1");
    assert.match(stack.datasetGroups.predictor.controls.get("srtm_landforms").details.textContent, /Fixed map for every assessment year · constant/);
    toggleDataset(phenology.checkbox, false);
    assert.equal(daily.details.textContent, "Bands used\n2015 · total_precipitation\n2006–2015 rainfall variability · total_precipitation");
    assert.equal(phenology.details.textContent, "Excluded from this analysis.");
    toggleDataset(phenology.checkbox, true);
    toggleDataset(daily.checkbox, false);
    assert.equal(phenology.details.textContent, "No bands used with these dataset choices.");
    assert.equal(response.details.textContent, "Bands used\n2015 · NumCycles");
    assert.deepEqual(h.controller.state.draft.inputs.area.area.selectedBounds, h.context.area.selectedBounds);
    assert.equal(h.requests.length, 0, "Opening the default configuration does not submit a calculation");
    h.controller.destroy();
});

test("Habitat keeps reference choices and the independent optional output mask in the main form", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    const {references, habitat_mask: mask, stack, area} = h.view.setup.inputs;
    assert.equal(mask.root.parentElement, h.view.setup.fields);
    for (const control of [mask.source, references.source, area.preparationSelection.source]) {
        for (let node = control; node && node !== h.view.setup.fields; node = node.parentElement) {
            assert.notEqual(node.tagName, "details");
            assert.equal(node.hidden, false);
        }
    }
    assert.equal(mask.root.contains(mask.source), true);
    assert.equal(mask.root.contains(references.source), false);
    assert.equal(mask.root.contains(area.preparationSelection.source), false);
    assert.equal(mask.source.parentElement.textContent, "Output mask (optional) — calculate scores only where the mask is 1");
    assert.equal(mask.source.getAttribute("aria-describedby"), mask.reason.id);
    assert.equal(mask.reason.hidden, true);
    assert.equal(references.areaDescription.hidden, true);
    assert.deepEqual(h.view.setup.fields.querySelectorAll("p").filter(node => [
        "Date and time are added automatically.", "Choose reference sites above.",
        "Leave None selected to run without this optional input.", "Limits results to cells with a mask value of 1 on the output grid.",
    ].includes(node.textContent)), []);
    assert.deepEqual(area.preparationSelection.root.querySelectorAll("button").filter(node =>
        ["Refresh areas", "Check coverage again"].includes(node.textContent)), []);
    assert.equal(references.choiceHint.textContent, "Choose either polygon features or a raster for the reference sites.");
    assert.equal(references.choiceHint.hidden, false);
    assert.ok(references.source.getAttribute("aria-describedby").split(" ").includes(references.choiceHint.id));

    await choosePreparationSelection(h);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    const reference = captureModelSubmission(h.controller.state.draft, "before-output-mask").inputs.references;
    edit(mask.source, modelSourceKey(h.context.rasters[4]));
    edit(mask.resampling, "mode");
    assert.equal(mask.source.value, modelSourceKey(h.context.rasters[4]));
    const selected = captureModelSubmission(h.controller.state.draft, "selected-output-mask").inputs;
    assert.deepEqual(selected.references, reference);
    assert.deepEqual(selected.habitat_mask, {collectionId: h.context.rasters[4].collectionId, itemId: h.context.rasters[4].itemId});
    assert.equal(selected.preparation.resampling.habitat_mask, "mode");

    chooseStack(h); await settle();
    const manual = captureModelSubmission(h.controller.state.draft, "manual-output-mask").inputs;
    assert.deepEqual(manual.references, reference);
    assert.deepEqual(manual.habitat_mask, selected.habitat_mask);
    assert.equal(mask.source.value, modelSourceKey(h.context.rasters[4]));
    assert.equal(mask.root.hidden, false);
    edit(stack.source, "earthEngine"); await settle();
    const automatic = captureModelSubmission(h.controller.state.draft, "automatic-output-mask").inputs;
    assert.deepEqual(automatic.references, reference);
    assert.deepEqual(automatic.habitat_mask, selected.habitat_mask);
    assert.equal(mask.source.value, modelSourceKey(h.context.rasters[4]));
    assert.equal(mask.root.hidden, false);

    edit(mask.source, "");
    assert.equal(mask.source.value, "");
    const cleared = captureModelSubmission(h.controller.state.draft, "cleared-output-mask").inputs;
    assert.equal(cleared.habitat_mask, null);
    assert.deepEqual(cleared.references, reference);
    assert.equal(cleared.preparation.resampling.habitat_mask, undefined);
});

for (const area of [undefined, {kind: "wholeRaster"}]) test(`Habitat retains a separate manual viewport choice instead of ${area ? "a whole raster" : "an absent area"}`, () => {
    const viewportBounds = {west: -109, south: 46, east: -107, north: 48};
    const draft = createModelDraft(habitat, {area, viewportBounds}, "default-area");
    assert.equal(draft.inputs.stack.kind, "earthEngine");
    assert.equal(draft.setupState.selectedSelection, null);
    assert.equal(draft.inputs.area.areaMode, "viewport");
    assert.deepEqual(draft.inputs.area.area, {kind: "selectedArea", selectedBounds: viewportBounds});
});

test("Default GEE setup requires a preparation selection even when the map cannot supply one", async () => {
    const h = await fixture({area: undefined});
    const areaChoice = h.view.setup.inputs.area.preparationSelection;
    assert.equal(areaChoice.source.parentElement.textContent, "Analysis area");
    assert.equal(areaChoice.source.children[0].textContent, "Choose an area…");
    assert.equal(areaChoice.help.textContent, "Areas are configured by your administrator.");
    assert.equal(areaChoice.status.textContent, "");
    assert.equal(areaChoice.status.hidden, true);
    assert.equal(areaChoice.sourceDetails.hidden, true);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    assert.equal(h.controller.state.draft.inputs.area.area, null);
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "no-area"), /Catalog selection/i);
    await choosePreparationSelection(h);
    assert.equal(areaChoice.status.hidden, false);
    assert.equal(areaChoice.sourceDetails.hidden, false);
    assert.equal(Boolean(areaChoice.sourceDetails.open), false);
    assert.equal(areaChoice.sourceDetails.children[0].textContent, "Area source");
    assert.equal(areaChoice.selectionDetails.parentElement, areaChoice.sourceDetails);
    assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "preparation-selection").inputs.area,
        {kind: "catalogSelection", selection: preparationSelections[0]});
    h.controller.destroy();
});

for (const [label, areaIndex, referenceIndex, withMask] of [
    ["Catalog area and uploaded reference sites", 0, 1, false],
    ["uploaded area and Catalog reference sites", 1, 0, false],
    ["raster reference sites and an assessment mask", 0, null, true],
]) test(`Habitat submits ${label} through the ordinary Models workflow`, async () => {
    const h = await fixture(); chooseStack(h);
    await chooseVector(h, "area", h.context.vectors[areaIndex], "North");
    const references = h.view.setup.inputs.references;
    if (referenceIndex === null) {
        edit(references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
        assert.match(references.maskHint.textContent, /^Non-zero cells are reference sites; NoData is ignored\./);
        assert.match(references.maskHint.textContent, /Negative values are included; nonfinite values are excluded\./);
        assert.doesNotMatch(references.maskHint.textContent, /greater than zero/);
    } else {
        await chooseVector(h, "references", h.context.vectors[referenceIndex], "South");
        assert.equal(h.view.setup.inputs.area.selectedCount.textContent, "3 of 8 features selected");
        assert.equal(references.selectedCount.textContent, "1 of 8 features selected");
    }
    assert.equal(references.source.required, true);
    assert.equal(references.maskGroup.hidden, referenceIndex !== null);
    assert.equal(references.resampling, undefined);
    assert.equal(h.view.setup.inputs.habitat_mask.source.required, false);
    if (withMask) edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    assert.equal(h.requests.length, 0); assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(h.view.setup.parameters, {});
    await h.controller.submit();
    assert.equal(h.requests.length, 1); assert.equal(h.controller.state.error, "");
    const request = h.requests[0], sources = h.context.rasters.map(({collectionId, itemId}) => ({collectionId, itemId}));
    assert.deepEqual(request.inputs.stack, {predictors: [{name: "environment", source: sources[0]}, {name: "habitat_type", source: sources[1]}],
        responses: [{name: "productivity", source: sources[2]}], categoricalPredictor: "habitat_type"});
    assert.equal(request.inputs.area.selection.filter.rules[0].value, "North");
    assert.equal(request.inputs.area.selection.uploadId, h.context.vectors[areaIndex].uploadId);
    if (referenceIndex === null) assert.deepEqual(request.inputs.references, {kind: "raster", source: sources[3]});
    else {
        assert.equal(request.inputs.references.kind, "vector");
        assert.equal(request.inputs.references.selection.filter.rules[0].value, "South");
        assert.equal(request.inputs.references.selection.uploadId, h.context.vectors[referenceIndex].uploadId);
    }
    assert.deepEqual(request.inputs.habitat_mask, withMask ? sources[4] : null);
    assert.deepEqual(request.parameters, {});
    h.controller.destroy();
});

test("reference choices retain upload provenance after selection and a display-name change", async () => {
    const h = await fixture();
    const references = h.view.setup.inputs.references;
    const groups = references.source.querySelectorAll("optgroup");
    assert.equal(groups.find(group => group.label === "Your uploads").children[0].textContent, "Uploaded sites · Polygons");
    assert.equal(groups.find(group => group.label === "Catalog layers").children[0].textContent, "Catalog basins · Polygons");
    await chooseVector(h, "references", h.context.vectors[1], "South");
    assert.equal(references.sourceOrigin.textContent, "Uploaded by you · Polygons");
    assert.equal(references.sourceOrigin.hidden, false);
    h.context.vectors[1].label = "Trusted reference sites";
    h.controller.refreshMapLayers();
    assert.equal(references.sourceOrigin.textContent, "Uploaded by you · Polygons");
    assert.deepEqual(references.source.getAttribute("aria-describedby").split(" ").sort(),
        [references.choiceHint.id, references.sourceOrigin.id].sort());
    h.controller.destroy();
});

test("uploaded raster reference sites keep their origin in choices, saved runs and duplication", async () => {
    const h = await fixture(); chooseStack(h);
    const source = {kind: "uploadedRaster", uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d"};
    const mask = {...source, label: "Trusted mask", visible: false};
    h.context.rasters.push(mask); h.controller.refreshMapLayers();
    const controls = h.view.setup.inputs.references;
    const uploadGroup = controls.source.querySelectorAll("optgroup").find(group => group.label === "Your uploads");
    assert.deepEqual(uploadGroup.children.map(option => option.textContent), ["Uploaded sites · Polygons", "Trusted mask · Raster mask (hidden on map)"]);
    edit(controls.source, `raster:${modelSourceKey(mask)}`); await settle();
    assert.equal(controls.sourceOrigin.textContent, "Uploaded by you · Raster mask");
    assert.match(controls.source.getAttribute("aria-describedby"), /source-origin/);
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    assert.deepEqual(h.requests[0].inputs.references, {kind: "raster", source});
    const saved = h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    assert.ok(saved.includes("Uploaded by you · Raster mask · valid finite non-zero cells"));
    assert.ok(saved.every(text => !text.includes("undefined")));
    await h.controller.duplicateRun(); await settle();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-upload").inputs.references, {kind: "raster", source});
    h.context.rasters = h.context.rasters.filter(value => value !== mask); h.controller.refreshMapLayers();
    assert.equal(h.view.setup.run.disabled, true);
    assert.equal(h.controller.state.draft.inputs.references.maskRaster.available, false);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "removed-upload"), /no longer available/);
    h.controller.destroy();
});

test("Habitat stack edits preserve other rows and require unambiguous roles before Run", async () => {
    const h = await fixture(), controls = h.view.setup.inputs.stack;
    assert.equal(h.view.setup.run.disabled, true);
    chooseStack(h);
    edit(h.view.setup.inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    await settle();
    assert.equal(h.view.setup.run.disabled, false);
    const category = controls.predictors[1].name;
    category.focus(); edit(category, "", "input");
    assert.equal(h.view.setup.run.disabled, true);
    edit(category, "land_class", "input");
    assert.equal(h.doc.activeElement, category); assert.equal(controls.categorical.value, "land_class");
    edit(controls.responses[0].name, "environment", "input");
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "duplicate-name"), /unique|different|duplicate/i);
    edit(controls.responses[0].name, "response", "input");
    edit(controls.responses[0].source, modelSourceKey(h.context.rasters[4]));
    controls.addResponse.dispatchEvent(new Event("click"));
    assert.equal(h.view.setup.run.disabled, true);
    edit(controls.responses[1].name, "productivity", "input");
    edit(controls.responses[1].source, modelSourceKey(h.context.rasters[2]));
    edit(controls.responses[1].resampling, "cubic");
    const remaining = controls.responses[1].name;
    controls.responses[0].remove.dispatchEvent(new Event("click"));
    assert.equal(controls.responses[0].name, remaining);
    assert.equal(controls.responses[0].resampling.value, "cubic");
    const stack = captureModelSubmission(h.controller.state.draft, "edited-stack").inputs.stack;
    assert.deepEqual(stack.responses, [{name: "productivity", source: {collectionId: h.context.rasters[2].collectionId, itemId: h.context.rasters[2].itemId}}]);
    assert.equal(stack.predictors[0].name, "environment"); assert.equal(stack.categoricalPredictor, "land_class");
    controls.predictors[1].remove.dispatchEvent(new Event("click"));
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "removed-category"), /categorical/i);
    h.controller.destroy();
});

test("Habitat duplicates a large mixed stack and preserves unavailable private selections", async () => {
    const h = await fixture(), artifacts = fileManifest(), parentId = "2".repeat(32);
    artifacts.jobId = parentId;
    for (const file of artifacts.files) file.url = `/api/processing/jobs/${parentId}/artifacts/${file.artifactId}`;
    const parent = job({jobId: parentId, status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    h.controller.rememberRun(parent);
    h.context.rasters.push(...Array.from({length: 17}, (_, index) => ({collectionId: "eolab-mounted-geotiffs",
        itemId: `geotiff-${(index + 10).toString(16).padStart(24, "0")}`, label: `Response ${index + 1}`})));
    h.controller.refreshMapLayers(); chooseStack(h);
    const source = h.controller.state.draft.sources.find(value => value.kind === "runArtifact");
    const controls = h.view.setup.inputs.stack;
    edit(controls.responses[0].source, modelSourceKey(source));
    for (let index = 0; index < 17; index += 1) {
        controls.addResponse.dispatchEvent(new Event("click"));
        edit(controls.responses[index + 1].name, `response_${index + 1}`, "input");
        edit(controls.responses[index + 1].source, modelSourceKey(h.context.rasters[index + 5]));
    }
    await chooseVector(h, "area", h.context.vectors[0], "North");
    await chooseVector(h, "references", h.context.vectors[1], "South");
    edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(source));
    assert.equal(h.view.setup.inputs.habitat_mask.reason.hidden, true);
    assert.equal(controls.responses[0].raster.reason.hidden, true);
    await h.controller.submit();
    assert.equal(h.requests.length, 1);
    const expected = structuredClone(h.requests[0].inputs);
    assert.equal(expected.stack.responses.length, 18);
    assert.deepEqual(expected.stack.responses[0].source, {kind: "runArtifact", jobId: parentId, artifactId: source.artifactId});
    assert.equal(new Set(expected.stack.responses.map(value => modelSourceKey(value.source))).size, 18);
    await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.inputs.stack.kind, "manual");
    const references = h.view.setup.inputs.references;
    assert.equal(references.source.value, "captured");
    assert.equal(references.source.children.find(option => option.value === "captured").textContent, "Area from original run");
    assert.match(references.areaDescription.textContent, /BASIN equals "South"/);
    assert.equal(references.vectorGroup.hidden, true);
    h.context.vectors.forEach(value => { value.filter = {enabled: false, match: "all", rules: []}; });
    h.context.area.selectedBounds.west = -5; h.controller.refreshMapLayers(); h.controller.refreshMapArea();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-stack").inputs, expected);
    assert.equal(h.requests.length, 1);
    h.controller.rememberRun({...parent, status: "expired", updatedAt: "2026-10-09T00:00:00Z",
        artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "expired-parent"), /available|expired/i);
    const draft = h.controller.state.draft;
    assert.equal(draft.inputs.stack.responses[0].raster.artifactId, source.artifactId);
    assert.equal(draft.inputs.habitat_mask.raster.artifactId, source.artifactId);
    assert.equal(h.view.setup.inputs.habitat_mask.reason.hidden, false);
    assert.match(h.view.setup.inputs.habitat_mask.reason.textContent, /no longer available/);
    assert.equal(h.view.setup.inputs.stack.responses[0].raster.reason.hidden, false);
    assert.match(h.view.setup.inputs.stack.responses[0].raster.reason.textContent, /no longer available/);
    edit(h.view.setup.inputs.stack.responses[0].source, modelSourceKey(h.context.rasters[2]));
    assert.equal(h.view.setup.run.disabled, true, "The unavailable optional mask must not become an omitted mask");
    edit(h.view.setup.inputs.habitat_mask.source, "");
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(h.view.setup.inputs.habitat_mask.reason.hidden, true);
    assert.equal(h.view.setup.inputs.habitat_mask.reason.textContent, "");
    assert.equal(captureModelSubmission(draft, "mask-omitted").inputs.habitat_mask, null);
    h.controller.destroy();
});

test("Habitat keeps raster reference and assessment choices separate through duplication and removal", async () => {
    const h = await fixture(); chooseStack(h);
    edit(h.view.setup.inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    await settle();
    await h.controller.submit(); await h.controller.duplicateRun();
    const mask = h.view.setup.inputs.habitat_mask;
    assert.equal(mask.root.parentElement, h.view.setup.fields);
    assert.equal(mask.root.hidden, false);
    assert.equal(mask.source.value, modelSourceKey(h.context.rasters[4]));
    assert.equal(mask.source.parentElement.textContent, "Output mask (optional) — calculate scores only where the mask is 1");
    assert.equal(h.controller.state.draft.model.inputs.habitat_mask.label, "Habitat assessment mask");
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-masks").inputs, h.requests[0].inputs);
    h.context.rasters.pop(); h.controller.refreshMapLayers();
    const unavailableMask = mask.source.querySelectorAll("option").find(option => option.value === mask.source.value);
    assert.equal(unavailableMask.disabled, true);
    assert.match(unavailableMask.textContent, /Assessment mask.*unavailable/);
    assert.equal(mask.reason.hidden, false);
    assert.match(mask.reason.textContent, /no longer available/);
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "missing-mask"), /available|Map layers|mask/i);
    edit(h.view.setup.inputs.habitat_mask.source, "");
    assert.equal(mask.source.value, "");
    assert.equal(h.view.setup.run.disabled, false);
    const inputs = captureModelSubmission(h.controller.state.draft, "without-mask").inputs;
    assert.deepEqual(inputs.references, h.requests[0].inputs.references); assert.equal(inputs.habitat_mask, null);
    const parentId = "2".repeat(32), artifacts = fileManifest();
    artifacts.jobId = parentId;
    for (const file of artifacts.files) file.url = `/api/processing/jobs/${parentId}/artifacts/${file.artifactId}`;
    const parent = job({jobId: parentId, status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    h.controller.rememberRun(parent); h.controller.refreshMapLayers();
    const privateReference = h.controller.state.draft.sources.find(source => source.kind === "runArtifact");
    const referenceControls = h.view.setup.inputs.references;
    edit(referenceControls.source, `raster:${modelSourceKey(privateReference)}`);
    assert.equal(h.jobs.tracked.has(parentId), true);
    edit(referenceControls.source, "");
    assert.equal(h.jobs.tracked.has(parentId), false);
    edit(referenceControls.source, `raster:${modelSourceKey(privateReference)}`);
    assert.equal(h.jobs.tracked.has(parentId), true); assert.equal(h.view.setup.run.disabled, false);
    edit(referenceControls.source, "");
    h.controller.rememberRun({...parent, status: "expired", updatedAt: "2026-10-09T00:00:00Z",
        artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    const unavailable = referenceControls.source.querySelectorAll("option").find(option => option.value === `raster:${modelSourceKey(privateReference)}`);
    assert.equal(unavailable.disabled, true);
    assert.match(unavailable.textContent, /unavailable/);
    h.controller.chooseArea("references", "raster");
    assert.equal(h.controller.state.draft.inputs.references.maskRaster.artifactId, privateReference.artifactId);
    assert.equal(h.controller.state.draft.inputs.references.maskRaster.available, false);
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "expired-reference"), /available|expired/i);
    h.controller.destroy();
});

test("Habitat shows Reference similarity first and diagnostics under Details with an omitted mask", async () => {
    const h = await fixture(); chooseStack(h);
    edit(h.view.setup.inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    const artifacts = fileManifest(), [primary, diagnostics, provenance] = artifacts.files;
    Object.assign(primary, {name: "reference_similarity", label: "Reference similarity", displayName: "Reference similarity · Habitat condition"});
    Object.assign(diagnostics, {name: "diagnostics", label: "Response diagnostics", displayName: "Response diagnostics · Habitat condition",
        filename: "diagnostics.zip", mediaType: "application/zip"});
    artifacts.files = [diagnostics, provenance, primary];
    h.api.getJob = async () => job({model: habitat, status: "ready", expiresAt: artifacts.expiresAt, artifacts,
        result: {...clipResult, name: primary.name, label: primary.label}});
    h.controller.outputState = (_jobId, _artifactId, file) => ({canShow: file.mediaType === "image/tiff"});
    await settle();
    await h.controller.submit();
    assert.equal(h.controller.state.error, "");
    const [result, details] = h.view.run.result.children;
    assert.equal(result.children[0].textContent, "Reference similarity");
    assert.equal(details.className, "models-details"); assert.equal(Boolean(details.open), false);
    assert.equal(result.children.at(-2).children[0].hidden, false);
    assert.equal(details.children[1].children[0].textContent, diagnostics.displayName);
    assert.equal(details.children[1].children.at(-2).children[0].hidden, true);
    assert.equal(details.children[1].children.at(-2).children[1].href, diagnostics.url);
    const savedInputs = h.view.run.inputsBody.children[0].children.map(node => node.textContent);
    assert.ok(savedInputs.includes("Predictor: environment")); assert.ok(savedInputs.includes("Observed response: productivity"));
    assert.ok(savedInputs.includes("Predictor: habitat_type (categorical)"));
    assert.equal(savedInputs[savedInputs.indexOf("Habitat assessment mask") + 1], "None");
    h.controller.destroy();
});

test("Habitat manual runs retain independent resampling without grid controls", async () => {
    const h = await fixture();
    chooseStack(h);
    const stack = h.view.setup.inputs.stack;
    const references = h.view.setup.inputs.references, mask = h.view.setup.inputs.habitat_mask;
    edit(references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    edit(mask.source, modelSourceKey(h.context.rasters[4]));
    edit(stack.responses[0].source, modelSourceKey(h.context.rasters[0]));
    await settle();
    assert.equal(h.view.setup.fields.querySelectorAll("legend").some(node => node.textContent === "Raster preparation"), false);
    assert.equal(h.view.setup.fields.querySelectorAll("select").some(node => node.id === "models-preparation-projection"), false);
    edit(stack.predictors[0].resampling, "bilinear"); edit(stack.predictors[1].resampling, "mode");
    edit(stack.responses[0].resampling, "average"); edit(mask.resampling, "cubic");
    edit(stack.predictors[1].name, "renamed_class", "input");
    await settle();
    edit(stack.predictors[1].source, modelSourceKey(h.context.rasters[4])); await settle();
    assert.equal(stack.predictors[1].resampling.value, "mode");
    assert.equal(h.view.setup.run.disabled, false);
    h.controller.state.draft.inputs.references.resampling = "bilinear";
    await h.controller.submit();
    const expected = {resampling: {predictor_0: "bilinear", predictor_1: "mode", response_0: "average", reference_mask: "nearest", habitat_mask: "cubic"}};
    assert.deepEqual(h.requests[0].inputs.preparation, expected);
    const saved = h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    assert.ok(saved.includes("EPSG:6933 · pixel size 500 × 500 · origin 0, 0"));
    h.controller.state.invocation.inputs.preparation.resampling.reference_mask = "bilinear";
    await h.controller.duplicateRun(); await settle();
    assert.equal(h.controller.state.draft.inputs.references.resampling, "nearest");
    h.context.rasters.reverse(); h.controller.refreshMapLayers();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-grid").inputs.preparation, expected);
    assert.equal(h.view.setup.inputs.stack.responses[0].resampling.value, "average");
    assert.equal(h.view.setup.inputs.habitat_mask.resampling.value, "cubic");
    edit(h.view.setup.inputs.references.source, "");
    await chooseVector(h, "references", h.context.vectors[1], "South");
    edit(h.view.setup.inputs.habitat_mask.source, "");
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "active-methods").inputs.preparation.resampling,
        {predictor_0: "bilinear", predictor_1: "mode", response_0: "average"});
    h.controller.destroy();
});

test("Earth Engine runs capture and duplicate dataset choices, year, area and reference filter", async () => {
    const h = await fixture();
    h.context.rasters = []; h.controller.refreshMapLayers();
    h.context.viewportBounds = {west: -109, south: 46, east: -107, north: 48};
    const stack = h.view.setup.inputs.stack;
    edit(stack.source, "manual");
    edit(h.view.setup.inputs.area.source, "whole");
    edit(stack.source, "earthEngine");
    assert.equal(stack.manual.hidden, true); assert.equal(stack.manual.disabled, true);
    assert.equal(stack.automatic.disabled, false); assert.equal(stack.year.value, "2018");
    assert.equal(h.view.setup.inputs.area.group.hidden, true);
    assert.equal(h.view.setup.inputs.area.preparationSelection.root.hidden, false);
    await choosePreparationSelection(h);
    await chooseVector(h, "references", h.context.vectors[1], "South");
    setCheckbox(stack.datasetGroups.predictor.controls.get("era5_daily").checkbox, false);
    setCheckbox(stack.datasetGroups.response.controls.get("modis_phenology").checkbox, false);
    edit(stack.year, "2017");
    assert.equal(h.view.setup.run.disabled, true);
    await settle();
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    const expected = h.requests[0].inputs;
    assert.deepEqual(expected.stack, {kind: "earthEngine", year: 2017,
        predictorDatasets: ["modis_phenology", "srtm_landforms"], responseDatasets: ["landsat_ndvi"]});
    assert.deepEqual(expected.area, {kind: "catalogSelection", selection: preparationSelections[0]});
    assert.deepEqual(expected.preparation, {resampling: {}});
    const summary = h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    assert.ok(summary.includes("Prepared Earth Engine rasters · Assessment year 2017"));
    assert.ok(summary.includes("Predictor datasets")); assert.ok(summary.includes("MODIS phenology, SRTM landforms"));
    assert.ok(summary.includes("Observed response datasets")); assert.ok(summary.includes("Landsat NDVI"));
    await h.controller.duplicateRun();
    h.context.viewportBounds.west = -110; h.controller.refreshMapArea();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "duplicate-auto").inputs, expected);
    assert.equal(h.view.setup.inputs.stack.source.value, "earthEngine");
    assert.equal(h.view.setup.inputs.stack.year.value, "2017");
    assert.equal(h.view.setup.inputs.stack.datasetGroups.predictor.controls.get("era5_daily").checkbox.checked, false);
    assert.equal(h.view.setup.inputs.stack.datasetGroups.response.controls.get("modis_phenology").checkbox.checked, false);
    h.controller.state.draft.inputs.area.area = {kind: "wholeRaster"};
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "saved-only").inputs.area, expected.area);
    await choosePreparationSelection(h, null);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "missing-area"), /Choose a Catalog selection/);
    h.controller.destroy();
});

test("dataset roles remain independent and keep focus and disclosure state through refreshes", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    await choosePreparationSelection(h);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    const stack = h.view.setup.inputs.stack, predictors = stack.datasetGroups.predictor, responses = stack.datasetGroups.response;
    const checkbox = predictors.controls.get("modis_phenology").checkbox;
    predictors.root.open = true; checkbox.focus();
    setCheckbox(checkbox, false);
    assert.equal(h.doc.activeElement, checkbox);
    assert.equal(predictors.root.open, true); assert.equal(responses.root.open, false);
    assert.equal(responses.controls.get("modis_phenology").checkbox.checked, true);
    assert.equal(predictors.summary.textContent, "Select predictor datasets · 2 of 3 selected");
    edit(stack.year, "2019");
    edit(stack.source, "manual"); edit(stack.source, "earthEngine");
    h.view.setup.inputs.stack.retry.dispatchEvent(new Event("click")); await settle();
    assert.equal(predictors.controls.get("modis_phenology").checkbox, checkbox);
    assert.equal(h.doc.activeElement, checkbox); assert.equal(checkbox.checked, false);
    assert.equal(predictors.root.open, true); assert.equal(responses.root.open, false);
    setCheckbox(checkbox, true);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "all-datasets").inputs.stack,
    {kind: "earthEngine", year: 2019, predictorDatasets: ["era5_daily", "modis_phenology", "srtm_landforms"],
        responseDatasets: ["modis_phenology", "landsat_ndvi"]});
});

test("saved run dataset identities appear before optional labels and distinguish equal-size selections", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    await choosePreparationSelection(h);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    const saved = captureModelSubmission(h.controller.state.draft, "saved-datasets");
    saved.inputs.stack.predictorDatasets = ["modis_phenology", "srtm_landforms"];
    saved.inputs.stack.responseDatasets = ["landsat_ndvi"];
    h.api.readModelInvocation = async () => ({...structuredClone(saved), model: {...habitat, definition: habitat}});
    let finishLabels;
    let labelReads = 0;
    h.api.getHabitatEarthEngineOptions = () => {
        labelReads++;
        return new Promise(resolve => { finishLabels = resolve; });
    };
    const summary = () => h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    await h.controller.showRun("1".repeat(32));
    assert.ok(summary().includes("modis_phenology, srtm_landforms"));
    assert.ok(summary().includes("landsat_ndvi"));
    finishLabels(earthEngineOptions); await settle();
    assert.ok(summary().includes("MODIS phenology, SRTM landforms"));
    assert.ok(summary().includes("Landsat NDVI"));

    saved.inputs.stack.predictorDatasets = ["era5_daily", "srtm_landforms"];
    saved.inputs.stack.responseDatasets = ["retired_observation"];
    await h.controller.showRun("1".repeat(32));
    assert.ok(summary().includes("ERA5 daily aggregates, SRTM landforms"));
    assert.ok(!summary().includes("MODIS phenology, SRTM landforms"));
    assert.ok(summary().includes("retired_observation"));
    assert.equal(labelReads, 1);
});

test("optional dataset label failures and obsolete reads leave saved inputs and navigation intact", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    await choosePreparationSelection(h);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    const saved = captureModelSubmission(h.controller.state.draft, "saved-datasets");
    h.api.readModelInvocation = async () => ({...structuredClone(saved), model: {...habitat, definition: habitat}});
    h.api.getHabitatEarthEngineOptions = async () => { throw new Error("Metadata unavailable"); };
    await h.controller.showRun("1".repeat(32)); await settle();
    assert.equal(h.controller.state.invocationError, "");
    assert.equal(h.controller.state.error, "");
    assert.ok(h.view.run.inputsBody.children[0].children.some(child => child.textContent === "modis_phenology, landsat_ndvi"));

    let finishLabels;
    h.api.getHabitatEarthEngineOptions = () => new Promise(resolve => { finishLabels = resolve; });
    await h.controller.showRun("1".repeat(32));
    h.controller.navigate("library");
    finishLabels(earthEngineOptions); await settle();
    assert.equal(h.controller.state.page, "library");
    assert.equal(h.controller.state.habitatDatasetLabels, null);
});

test("saved API runs with omitted dataset choices display and duplicate the configured defaults", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    await choosePreparationSelection(h);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    h.api.readModelInvocation = async () => {
        const saved = structuredClone(h.requests[0]);
        delete saved.inputs.stack.predictorDatasets; delete saved.inputs.stack.responseDatasets;
        return {...saved, model: {...habitat, definition: habitat}};
    };
    await h.controller.submit();
    assert.equal(h.controller.state.error, "");
    const summary = h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    assert.equal(summary.filter(text => text === "All configured datasets").length, 2);
    await h.controller.duplicateRun();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "default-api-datasets").inputs.stack,
        {kind: "earthEngine", year: 2018, predictorDatasets: ["era5_daily", "modis_phenology", "srtm_landforms"],
            responseDatasets: ["modis_phenology", "landsat_ndvi"]});
});

test("an empty response selection stays empty on refresh and prevents submission with useful guidance", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    await choosePreparationSelection(h);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    const stack = h.view.setup.inputs.stack;
    for (const controls of stack.datasetGroups.response.controls.values()) setCheckbox(controls.checkbox, false);
    h.view.setup.inputs.stack.retry.dispatchEvent(new Event("click")); await settle();
    assert.deepEqual(h.controller.state.draft.inputs.stack.responseDatasets, []);
    assert.equal(h.view.setup.run.disabled, true);
    assert.equal(stack.status.textContent, "Select at least one observed response dataset.");
    assert.equal(stack.datasetGroups.response.summary.textContent, "Select observed response datasets · 0 of 2 selected");
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "empty-responses"), /at least one observed response dataset/);
    setCheckbox(stack.datasetGroups.response.controls.get("landsat_ndvi").checkbox, true);
    assert.equal(h.view.setup.run.disabled, false);
});

test("Earth Engine runs use the recipe grid and preserve mask resampling through duplication", async () => {
    const h = await fixture(), inputs = h.view.setup.inputs;
    await choosePreparationSelection(h);
    edit(inputs.references.source, `raster:${modelSourceKey(h.context.rasters[3])}`);
    edit(inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    await settle();
    assert.equal(h.view.setup.fields.querySelectorAll("select").some(node => node.id === "models-preparation-projection"), false);
    edit(inputs.habitat_mask.resampling, "mode");
    await h.controller.submit();
    assert.deepEqual(h.requests[0].inputs.preparation, {resampling: {reference_mask: "nearest", habitat_mask: "mode"}});
    const saved = h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    assert.ok(saved.includes("EPSG:6933 · pixel size 500 × 500 · origin 0, 0"));
    assert.ok(saved.includes("Reference raster resampling")); assert.ok(saved.includes("Most common value (mode)"));
    await h.controller.duplicateRun(); await settle();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "auto-masks").inputs, h.requests[0].inputs);
    h.controller.destroy();
});

test("Habitat saved grid descriptions use the captured recipe rather than the current library", async t => {
    const h = await fixture();
    t.after(() => h.controller.destroy());
    await choosePreparationSelection(h);
    await chooseVector(h, "references", h.context.vectors[1], "South");
    await h.controller.submit();
    const saved = structuredClone(h.controller.state.invocation);
    saved.model.definition.steps[0].inputs.settings.value.output_grid = {
        crs: "EPSG:6933", pixel_size: [125, 250], origin: [7, 11],
    };
    h.controller.state.invocation = saved;
    h.controller.render();
    const descriptions = h.view.run.inputsBody.children[0].children.map(child => child.textContent);
    assert.ok(descriptions.includes("EPSG:6933 · pixel size 125 × 250 · origin 7, 11"));
    assert.equal(descriptions.includes("EPSG:6933 · pixel size 500 × 500 · origin 0, 0"), false);
    assert.deepEqual(h.controller.state.library.find(recipe => recipe.id === habitat.id).steps[0].inputs.settings.value.output_grid.pixel_size, [500, 500]);
});

test("Switching Habitat input sources preserves manual rows without showing grid controls", async () => {
    const h = await fixture();
    chooseStack(h);
    edit(h.view.setup.inputs.stack.predictors[0].resampling, "bilinear");
    const rows = structuredClone(h.controller.state.draft.inputs.stack.predictors);
    edit(h.view.setup.inputs.stack.source, "earthEngine");
    await settle();
    assert.deepEqual(h.controller.state.draft.inputs.stack.predictors, rows);
    edit(h.view.setup.inputs.stack.source, "manual"); await settle();
    assert.equal(h.view.setup.inputs.stack.manual.disabled, false);
    assert.equal(h.view.setup.inputs.stack.automatic.disabled, true);
    assert.deepEqual(h.controller.state.draft.inputs.stack.predictors, rows);
    assert.equal(h.view.setup.inputs.stack.categorical.value, "habitat_type");
    assert.equal(h.view.setup.fields.querySelectorAll("legend").some(node => node.textContent === "Raster preparation"), false);
    h.controller.destroy();
});

test("Earth Engine configuration errors can be retried without blocking manual setup", async () => {
    const h = await fixture();
    h.api.getHabitatEarthEngineOptions = async () => { throw new Error("Service unavailable"); };
    h.controller.chooseModel(habitat); await settle(); chooseStack(h);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    assert.equal(h.view.setup.run.disabled, false);
    const stack = h.view.setup.inputs.stack;
    edit(stack.source, "earthEngine");
    assert.equal(h.view.setup.run.disabled, true);
    assert.match(stack.acquisitionStatus.textContent, /Service unavailable/);
    assert.equal(stack.retry.hidden, false);
    h.api.getHabitatEarthEngineOptions = async () => structuredClone(earthEngineOptions);
    stack.retry.dispatchEvent(new Event("click")); await settle();
    await choosePreparationSelection(h);
    assert.equal(stack.year.value, "2018"); assert.equal(h.view.setup.run.disabled, false);
    h.controller.destroy();
});

test("Late Habitat options preserve a chosen custom stack and cannot replace another model draft", async () => {
    const h = await fixture();
    let complete, requestedSignal;
    h.api.getHabitatEarthEngineOptions = signal => new Promise(resolve => { complete = resolve; requestedSignal = signal; });
    h.controller.chooseModel(habitat);
    chooseStack(h);
    const predictors = structuredClone(h.controller.state.draft.inputs.stack.predictors);
    complete(structuredClone(earthEngineOptions)); await settle();
    assert.equal(h.controller.state.draft.inputs.stack.kind, "manual");
    assert.deepEqual(h.controller.state.draft.inputs.stack.predictors, predictors);
    assert.equal(h.view.setup.inputs.stack.manual.hidden, false);
    h.controller.chooseModel(habitat);
    const abandoned = h.controller.state.draft;
    h.controller.chooseModel(model);
    assert.equal(requestedSignal.aborted, true, "replacing the draft cancels the model-owned options request");
    const current = h.controller.state.draft;
    complete(structuredClone(earthEngineOptions)); await settle();
    assert.equal(h.controller.state.draft, current);
    assert.equal(abandoned.inputs.stack.configuration, null);
    assert.equal(h.requests.length, 0);
    h.controller.destroy();
});


test("reference choices switch between polygons and rasters without combining sources or accepting stale selections", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy()); chooseStack(h);
    const references = h.view.setup.inputs.references;
    const vector = h.context.vectors[0], raster = h.context.rasters[3];
    const options = references.source.querySelectorAll("option");
    const vectorOption = options.find(option => option.value === `vector:${vector.key}`);
    const rasterOption = options.find(option => option.value === `raster:${modelSourceKey(raster)}`);
    assert.equal(vectorOption.parentElement, rasterOption.parentElement);
    assert.equal(Boolean(references.source.multiple), false);
    edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    await chooseVector(h, "references", vector, "North");
    const polygonInputs = captureModelSubmission(h.controller.state.draft, "polygon-reference").inputs;
    assert.equal(polygonInputs.references.kind, "vector");
    assert.equal(references.maskGroup.hidden, true);
    assert.equal(references.vectorGroup.hidden, false);

    edit(references.source, `raster:${modelSourceKey(raster)}`); await settle();
    const rasterInputs = captureModelSubmission(h.controller.state.draft, "raster-reference").inputs;
    assert.deepEqual(rasterInputs.references, {kind: "raster", source: {collectionId: raster.collectionId, itemId: raster.itemId}});
    assert.equal(references.maskGroup.hidden, false);
    assert.equal(references.vectorGroup.hidden, true);
    assert.equal(references.choiceHint.hidden, false);
    assert.deepEqual(rasterInputs.habitat_mask, polygonInputs.habitat_mask);

    const prepareVector = h.controller.prepareVector;
    let finishSelection, selectionSignal, pendingSource;
    h.controller.prepareVector = (source, signal) => new Promise(resolve => {
        pendingSource = source; selectionSignal = signal; finishSelection = resolve;
    });
    edit(references.source, `vector:${vector.key}`);
    assert.equal(h.view.setup.run.disabled, true);
    edit(references.source, `raster:${modelSourceKey(raster)}`);
    assert.equal(selectionSignal.aborted, true);
    finishSelection(await prepareVector(pendingSource)); await settle();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "after-stale-selection").inputs.references, rasterInputs.references);
    assert.equal(references.source.value, `raster:${modelSourceKey(raster)}`);
    assert.equal(references.vectorGroup.hidden, true);

    h.controller.prepareVector = prepareVector;
    edit(references.source, `vector:${vector.key}`); await settle();
    const restored = captureModelSubmission(h.controller.state.draft, "restored-polygon-reference").inputs;
    assert.deepEqual(restored.references, polygonInputs.references);
    assert.equal(restored.preparation.resampling.reference_mask, undefined);
    assert.deepEqual(restored.habitat_mask, polygonInputs.habitat_mask);
    assert.equal(references.maskGroup.hidden, true);
    assert.equal(references.vectorGroup.hidden, false);
    assert.equal(references.choiceHint.hidden, false);
});

test("direct spatial choices retain opaque view identity, independent filters and captured areas", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy()); chooseStack(h);
    const first = h.context.vectors[0], second = {...structuredClone(first),
        key: 'retained:view:raster:["basins"]:2', label: "Catalog basins · second view"};
    second.filter.rules[0].value = "South";
    h.context.vectors.push(second); h.controller.refreshMapLayers();
    const controls = h.view.setup.inputs, areaSource = controls.area.source, referenceSource = controls.references.source;
    assert.equal(controls.references.group.contains(referenceSource), true);
    assert.equal(controls.references.group.contains(controls.references.filterHost), true);
    assert.equal(controls.references.group.querySelectorAll("label").filter(label => label.textContent === "Reference sites").length, 1);
    assert.equal(controls.area.source.querySelectorAll("option").some(option => option.value.startsWith("raster:")), false);
    referenceSource.focus();
    edit(areaSource, `vector:${first.key}`); edit(referenceSource, `vector:${second.key}`); await settle();
    assert.equal(h.controller.state.draft.inputs.area.vectorKey, first.key);
    assert.equal(h.controller.state.draft.inputs.references.vectorKey, second.key);
    assert.equal(h.doc.activeElement, referenceSource);
    assert.match(controls.area.filterDescription.textContent, /North/);
    assert.match(controls.references.filterDescription.textContent, /South/);
    assert.equal(controls.references.resampling, undefined);
    await h.controller.openVectorFilter("references");
    const filter = structuredClone(second.filter); filter.rules[0].value = "West";
    await h.filters.at(-1).apply(filter); h.filters.at(-1).complete(); await settle();
    assert.equal(h.context.vectors[0].filter.rules[0].value, "North");
    assert.equal(h.context.vectors[2].filter.rules[0].value, "West");
    assert.equal(h.controller.state.draft.inputs.area.area.selection.filter.rules[0].value, "North");
    assert.equal(h.controller.state.draft.inputs.references.area.selection.filter.rules[0].value, "West");
    assert.equal(h.requests.length, 0);
    await h.controller.submit(); await h.controller.duplicateRun();
    const captured = structuredClone(h.requests[0].inputs);
    assert.equal(h.view.setup.inputs.references.source.value, "captured");
    h.context.vectors[2].filter.rules[0].value = "East"; h.controller.refreshMapLayers(); await settle();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "fixed-areas").inputs, captured);
    edit(h.view.setup.inputs.references.source, `vector:${second.key}`); await settle();
    assert.equal(h.controller.state.draft.inputs.references.area.selection.filter.rules[0].value, "East");
    assert.deepEqual(h.controller.state.draft.inputs.area.area, captured.area);
    edit(h.view.setup.inputs.references.source, "");
    assert.equal(h.controller.state.draft.inputs.references.area, null);
    assert.equal(h.view.setup.inputs.references.source.value, "");
    assert.equal(h.view.setup.inputs.references.selectionCard.hidden, true);
    assert.equal(h.view.setup.inputs.references.resampling, undefined);
    assert.equal(h.view.setup.run.disabled, true);
    assert.deepEqual(h.requests[0].inputs, captured);
});

/** Supply a committed annotation snapshot with one polygon matching the map filter.
 * @param {string} label Layer name displayed by the chooser.
 * @param {number} west Left edge of its matched polygon.
 * @return {{key:string,label:string,polygons:Array<{type:string,coordinates:number[][][]}>,total:number}} Drawn layer with three committed polygons.
 */
function drawnPolygonLayer(label, west) {
    return {key: `local:annotation:${label}`, label, total: 3,
        polygons: [{type: "Polygon", coordinates: [[[west, 0], [west + 1, 0], [west, 1], [west, 0]]]}]};
}

test("manual Ecosystem inputs select filtered drawn layers and capture them together at Run", async t => {
    const study = drawnPolygonLayer("Study", 0), references = drawnPolygonLayer("Forest", 2);
    const h = await fixture({drawnPolygonLayers: [study, references]}); t.after(() => h.controller.destroy()); chooseStack(h); await settle();
    const {area, references: sites} = h.view.setup.inputs;
    edit(area.source, `drawn:${study.key}`); edit(sites.source, `drawn:${references.key}`);
    assert.equal(area.source.value, `drawn:${study.key}`);
    assert.equal(sites.source.value, `drawn:${references.key}`);
    assert.equal(sites.selectedCount.textContent, "1 of 3 polygons selected");
    assert.match(sites.filterDescription.textContent, /layer's filter/);
    assert.equal(sites.editFilter.hidden, true);
    assert.equal(sites.resampling, undefined);
    assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(h.uploads, []);

    h.context.drawnPolygonLayers = [study]; h.controller.refreshMapLayers();
    assert.equal(sites.source.value, "");
    assert.equal(area.source.value, `drawn:${study.key}`);
    h.context.drawnPolygonLayers.push({...references, polygons: []}); h.controller.refreshMapLayers();
    assert.equal(sites.selectedCount.textContent, "0 of 3 polygons selected");
    assert.match(sites.vectorStatus.textContent, /No polygons match/);
    assert.equal(h.view.setup.run.disabled, true);
    await h.controller.submit();
    assert.deepEqual(h.uploads, [], "an invalid second choice is checked before uploading the first");

    h.context.drawnPolygonLayers[1] = references;
    const captured = structuredClone(references.polygons);
    let finishUpload;
    const firstUpload = new Promise(resolve => { finishUpload = resolve; });
    const upload = h.api.uploadPolygonArea;
    h.api.uploadPolygonArea = async polygons => {
        const reply = await upload(polygons);
        if (h.uploads.length === 1) await firstUpload;
        return reply;
    };
    const submitting = h.controller.submit();
    assert.equal(h.uploads.length, 1);
    references.polygons[0].coordinates[0][1][0] += 0.5;
    finishUpload(); await submitting;
    assert.deepEqual(h.uploads[1].polygons, captured, "both choices were copied before the first upload");
    assert.deepEqual(h.requests[0].inputs.area, {kind: "polygonArea", reference: h.uploads[0].polygonArea});
    assert.deepEqual(h.requests[0].inputs.references, {kind: "polygonArea", reference: h.uploads[1].polygonArea});
    assert.deepEqual(h.released, []);

    h.controller.chooseModel(model);
    assert.equal(h.view.setup.inputs.area.source.querySelectorAll("optgroup").some(group => group.label === "Drawn polygons"), false);
});

test("one drawn layer used for both inputs uploads once and duplication keeps the exact accepted reference", async t => {
    const layer = drawnPolygonLayer("Forest", 2);
    const h = await fixture({drawnPolygonLayers: [layer]}); t.after(() => h.controller.destroy()); chooseStack(h); await settle();
    for (const name of ["area", "references"]) edit(h.view.setup.inputs[name].source, `drawn:${layer.key}`);
    await h.controller.submit();
    assert.equal(h.uploads.length, 1);
    assert.deepEqual(h.requests[0].inputs.area, h.requests[0].inputs.references);
    h.context.drawnPolygonLayers = [];
    await h.controller.duplicateRun();
    assert.equal(h.view.setup.inputs.area.source.value, "captured");
    assert.equal(h.view.setup.inputs.references.source.value, "captured");
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "duplicate").inputs, h.requests[0].inputs);
    h.api.submitModelRun = async request => {
        h.requests.push(request);
        throw new ProcessingRequestError("This calculation area expired or is unavailable. Select the layer again.", 409);
    };
    await h.controller.submit();
    assert.deepEqual(h.requests[1].inputs, h.requests[0].inputs);
    assert.equal(h.uploads.length, 1);
    assert.deepEqual(h.released, [], "a duplicated request does not own the original run's reference");
    assert.match(h.controller.state.error, /Select the layer again/);
    assert.equal(h.controller.state.pending, null);
});

for (const obsolete of [false, true]) test(`drawn polygon preparation releases partial uploads when ${obsolete ? "setup changes" : "the second upload fails"}`, async t => {
    const study = drawnPolygonLayer("Study", 0), references = drawnPolygonLayer("Forest", 2);
    const h = await fixture({drawnPolygonLayers: [study, references]}); t.after(() => h.controller.destroy()); chooseStack(h); await settle();
    edit(h.view.setup.inputs.area.source, `drawn:${study.key}`);
    edit(h.view.setup.inputs.references.source, `drawn:${references.key}`);
    let finishUpload;
    const firstUpload = new Promise(resolve => { finishUpload = resolve; });
    const upload = h.api.uploadPolygonArea;
    h.api.uploadPolygonArea = async polygons => {
        if (h.uploads.length) throw new Error("Could not upload the second layer");
        const reply = await upload(polygons); await firstUpload; return reply;
    };
    const submitting = h.controller.submit();
    if (obsolete) h.controller.chooseModel(habitat);
    finishUpload(); await submitting;
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.released, [h.uploads[0].polygonArea.id]);
    assert.equal(h.controller.state.pending, null);
    if (obsolete) assert.equal(h.controller.state.error, "");
    else assert.match(h.controller.state.error, /Could not upload the second layer/);
});

test("uncertain admission retries the captured drawn references and releases them on definite rejection", async t => {
    const layer = drawnPolygonLayer("Forest", 2);
    const h = await fixture({drawnPolygonLayers: [layer]}); t.after(() => h.controller.destroy()); chooseStack(h); await settle();
    for (const name of ["area", "references"]) edit(h.view.setup.inputs[name].source, `drawn:${layer.key}`);
    h.api.submitModelRun = async request => {
        h.requests.push(request);
        if (h.requests.length === 1) throw new TypeError("Connection lost");
        throw new ProcessingRequestError("Invalid reference sites", 422);
    };
    await h.controller.submit();
    assert.deepEqual(h.controller.state.pending, h.requests[0]);
    assert.deepEqual(h.released, []);
    h.context.drawnPolygonLayers = [];
    await h.controller.submit(true);
    assert.deepEqual(h.requests[1], h.requests[0]);
    assert.equal(h.uploads.length, 1);
    assert.deepEqual(h.released, [h.uploads[0].polygonArea.id]);
    assert.equal(h.controller.state.pending, null);
});

test("an expired selected reference output stays identified and explained by the direct chooser", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy()); chooseStack(h);
    const parentId = "2".repeat(32), artifacts = fileManifest(); artifacts.jobId = parentId;
    const parent = job({jobId: parentId, status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    h.controller.rememberRun(parent); h.controller.refreshMapLayers();
    const source = h.controller.state.draft.sources.find(value => value.kind === "runArtifact");
    const references = h.view.setup.inputs.references;
    edit(references.source, `raster:${modelSourceKey(source)}`); await settle();
    assert.equal(h.view.setup.run.disabled, false);
    h.controller.rememberRun({...parent, status: "expired", updatedAt: "2026-10-09T00:00:00Z",
        artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    assert.equal(references.source.value, `raster:${modelSourceKey(source)}`);
    const option = references.source.querySelectorAll("option").find(value => value.value === references.source.value);
    assert.equal(option.disabled, true); assert.match(option.textContent, /unavailable/);
    assert.equal(references.maskGroup.hidden, false); assert.match(references.rasterReason.textContent, /no longer available/);
    assert.ok(references.source.getAttribute("aria-describedby").split(" ").includes(references.rasterReason.id));
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "expired-source"), /available|expired/i);
    assert.equal(h.requests.length, 0);
});


test("Earth Engine preparation selections are independent of Map layers, manual area choices and reference filters", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    chooseStack(h);
    await chooseVector(h, "area", h.context.vectors[0], "South");
    const manual = structuredClone(h.controller.state.draft.inputs.area);
    await chooseVector(h, "references", h.context.vectors[1], "North");
    edit(h.view.setup.inputs.stack.source, "earthEngine");
    await choosePreparationSelection(h, 1);
    const controls = h.view.setup.inputs.area;
    assert.equal(controls.group.hidden, true);
    assert.equal(controls.source.disabled, true);
    assert.deepEqual(controls.preparationSelection.source.children.map(option => option.value), ["", "0", "1"]);
    assert.deepEqual(h.controller.state.draft.inputs.area.area, manual.area);
    edit(h.view.setup.inputs.stack.source, "manual");
    assert.deepEqual(h.controller.state.draft.inputs.area.area, manual.area);
    edit(h.view.setup.inputs.stack.source, "earthEngine"); await settle();
    h.context.vectors = [h.context.vectors[1]];
    h.context.area = {kind: "selectedArea", selectedBounds: {west: 9, south: 9, east: 10, north: 10}};
    h.controller.refreshMapLayers(); h.controller.refreshMapArea();
    const captured = captureModelSubmission(h.controller.state.draft, "independent");
    assert.deepEqual(captured.inputs.area, {kind: "catalogSelection", selection: preparationSelections[1]});
    assert.equal(captured.inputs.references.selection.uploadId, h.context.vectors[0].uploadId);
    assert.equal(captured.inputs.references.selection.filter.rules[0].value, "North");
    assert.equal(h.view.setup.run.disabled, false);
    edit(h.view.setup.inputs.stack.source, "manual");
    assert.equal(controls.preparationSelection.root.hidden, true);
    assert.equal(controls.source.disabled, false);
    assert.equal(h.controller.state.draft.inputs.area.area, null, "Removing the manual source retains its existing unavailability behavior");
    assert.deepEqual(h.controller.state.draft.setupState.selectedSelection, preparationSelections[1]);
});

for (const cachedTiles of [0, 2, 4]) test("preparation selection with " + cachedTiles + " cached tiles has explicit readiness", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    h.api.getHabitatPreparationCoverage = async (_selection, year) => ({year, requiredTiles: 4, cachedTiles, missingTiles: 4 - cachedTiles});
    await chooseVector(h, "references", h.context.vectors[0], "North");
    await choosePreparationSelection(h);
    const controls = h.view.setup.inputs.area.preparationSelection;
    assert.equal(controls.status.getAttribute("role"), "status");
    assert.equal(controls.status.hidden, false);
    assert.equal(controls.source.getAttribute("aria-describedby"), controls.status.id);
    assert.equal(h.view.setup.run.disabled, cachedTiles === 0);
    if (cachedTiles === 0) {
        assert.match(controls.status.textContent, /No prepared inputs.*area and year/);
        await h.controller.submit(); assert.equal(h.requests.length, 0);
    } else {
        assert.match(controls.status.textContent, cachedTiles === 4 ? /all 4 required tiles/ : /2 of 4 tiles.*results will be missing/);
        await h.controller.submit(); assert.equal(h.requests.length, 1);
        assert.deepEqual(h.requests[0].inputs.area, {kind: "catalogSelection", selection: preparationSelections[0]});
    }
});

test("coverage is checked automatically for the chosen year and area, including after reselection", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    await chooseVector(h, "references", h.context.vectors[0], "North");
    const pending = [];
    h.api.getHabitatPreparationCoverage = (selection, year, signal) => new Promise((resolve, reject) => pending.push({selection, year, signal, resolve, reject}));
    await choosePreparationSelection(h);
    assert.equal(h.view.setup.run.disabled, true);
    edit(h.view.setup.inputs.stack.year, "2017");
    assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve({year: 2017, requiredTiles: 4, cachedTiles: 0, missingTiles: 4}); await settle();
    pending[0].resolve({year: 2018, requiredTiles: 4, cachedTiles: 4, missingTiles: 0}); await settle();
    assert.equal(h.controller.state.draft.setupState.coverage.year, 2017);
    assert.equal(h.view.setup.run.disabled, true);
    await choosePreparationSelection(h, 1);
    pending[2].reject(new Error("Connection interrupted")); await settle();
    assert.match(h.view.setup.inputs.area.preparationSelection.status.textContent, /reselect the analysis area.*Connection interrupted/);
    assert.equal(h.view.setup.run.disabled, true);
    await choosePreparationSelection(h, null);
    await choosePreparationSelection(h, 1);
    assert.deepEqual(pending[3].selection, preparationSelections[1]);
    pending[3].resolve({year: 2017, requiredTiles: 4, cachedTiles: 2, missingTiles: 2}); await settle();
    assert.equal(h.view.setup.run.disabled, false);
    await choosePreparationSelection(h, 0);
    edit(h.view.setup.inputs.stack.source, "manual");
    assert.equal(pending[4].signal.aborted, true);
    pending[4].resolve({year: 2017, requiredTiles: 4, cachedTiles: 4, missingTiles: 0}); await settle();
    assert.equal(h.controller.state.draft.setupState.coverage, null);
});

test("area loading errors and empty lists allow manual setup and reopening the model loads its areas", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    h.api.getHabitatPreparationSelections = async () => { throw new Error("Offline"); };
    h.controller.chooseModel(habitat); await settle();
    let controls = h.view.setup.inputs.area.preparationSelection;
    assert.match(controls.status.textContent, /Offline/);
    assert.equal(controls.source.disabled, true);
    chooseStack(h); await chooseVector(h, "references", h.context.vectors[0], "North");
    assert.equal(h.view.setup.run.disabled, false);
    h.api.getHabitatPreparationSelections = async () => ({selections: []});
    edit(h.view.setup.inputs.stack.source, "earthEngine"); await settle();
    assert.match(controls.status.textContent, /No preparation selections.*administrator/);
    assert.equal(h.view.setup.run.disabled, true);
    h.api.getHabitatPreparationSelections = async () => ({selections: structuredClone(preparationSelections)});
    h.controller.chooseModel(habitat); await settle();
    controls = h.view.setup.inputs.area.preparationSelection;
    assert.equal(controls.source.disabled, false); assert.equal(controls.source.value, "");
    await chooseVector(h, "references", h.context.vectors[0], "North");
    await choosePreparationSelection(h); assert.equal(h.view.setup.run.disabled, false);
});

test("late preparation-selection replies cannot restore an abandoned model or destroyed controller", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    const pending = [];
    h.api.getHabitatPreparationSelections = signal => new Promise(resolve => pending.push({signal, resolve}));
    h.controller.chooseModel(habitat);
    const abandoned = h.controller.state.draft;
    assert.equal(h.view.setup.inputs.area.preparationSelection.source.disabled, true);
    h.controller.chooseModel(model);
    assert.equal(pending[0].signal.aborted, true);
    pending[0].resolve({selections: structuredClone(preparationSelections)}); await settle();
    assert.equal(h.controller.state.draft.model.id, model.id);
    assert.equal(abandoned.setupState.loaded, false);
    h.controller.chooseModel(habitat);
    h.controller.destroy(); assert.equal(pending[1].signal.aborted, true);
    pending[1].resolve({selections: structuredClone(preparationSelections)}); await settle();
    assert.equal(h.controller.state.draft.setupState.loaded, false);
});

test("duplicate matches the full saved selection regardless of object-key order and never substitutes another area", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    await choosePreparationSelection(h, 1);
    await chooseVector(h, "references", h.context.vectors[0], "North");
    await h.controller.submit();
    const original = structuredClone(h.requests[0]);
    const chosen = original.inputs.area.selection, filter = chosen.filter;
    original.inputs.area.selection = {filter: {rules: filter.rules.map(rule => ({value: rule.value, operator: rule.operator, field: rule.field})), match: filter.match, enabled: filter.enabled},
        layerName: chosen.layerName, assetKey: chosen.assetKey, itemId: chosen.itemId, collectionId: chosen.collectionId};
    h.api.readModelInvocation = async () => ({...structuredClone(original), model: {...habitat, definition: habitat}});
    await h.controller.duplicateRun();
    assert.deepEqual(h.controller.state.draft.setupState.selectedSelection, preparationSelections[1]);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "ordered").inputs.area.selection, preparationSelections[1]);
    h.api.getHabitatPreparationSelections = async () => ({selections: [structuredClone(preparationSelections[0])]});
    await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.setupState.selectedSelection, null);
    assert.match(h.view.setup.inputs.area.preparationSelection.status.textContent, /original Catalog selection is not available/);
    assert.equal(h.view.setup.run.disabled, true);
    await choosePreparationSelection(h); assert.equal(h.view.setup.run.disabled, false);
    original.inputs.area = {kind: "selectedArea", selectedBounds: {west: 1, south: 1, east: 2, north: 2}};
    await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.setupState.selectedSelection, null);
    assert.equal(h.view.setup.run.disabled, true);
    assert.match(h.view.setup.inputs.area.preparationSelection.status.textContent, /original Catalog selection is not available/);
});

test("Earth Engine preparation selections keep drawn Reference sites independent and upload only those polygons", async t => {
    const references = drawnPolygonLayer("Forest", 2);
    const h = await fixture({drawnPolygonLayers: [references]}); t.after(() => h.controller.destroy());
    await choosePreparationSelection(h);
    edit(h.view.setup.inputs.references.source, "drawn:" + references.key);
    await h.controller.submit();
    assert.equal(h.uploads.length, 1);
    assert.deepEqual(h.uploads[0].polygons, references.polygons);
    assert.deepEqual(h.requests[0].inputs.area, {kind: "catalogSelection", selection: preparationSelections[0]});
    assert.deepEqual(h.requests[0].inputs.references, {kind: "polygonArea", reference: h.uploads[0].polygonArea});
});


test("an abandoned duplicate cannot cancel the next draft's preparation-selection request", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    await choosePreparationSelection(h); await chooseVector(h, "references", h.context.vectors[0], "North");
    await h.controller.submit();
    let finishOldOptions;
    h.api.getHabitatEarthEngineOptions = () => new Promise(resolve => { finishOldOptions = resolve; });
    const duplicate = h.controller.duplicateRun();
    const pending = [];
    h.api.getHabitatPreparationSelections = signal => new Promise(resolve => pending.push({signal, resolve}));
    h.api.getHabitatEarthEngineOptions = async () => structuredClone(earthEngineOptions);
    h.controller.chooseModel(habitat);
    const current = h.controller.state.draft;
    finishOldOptions(structuredClone(earthEngineOptions)); await duplicate;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].signal.aborted, false);
    pending[0].resolve({selections: structuredClone(preparationSelections)}); await settle();
    assert.equal(h.controller.state.draft, current);
    assert.equal(current.setupState.loaded, true);
});


test("switching to preparation selections closes a hidden manual area editor while Reference sites stay independent", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy()); chooseStack(h);
    await chooseVector(h, "area", h.context.vectors[0], "North");
    await chooseVector(h, "references", h.context.vectors[1], "South");
    await h.controller.openVectorFilter("area");
    assert.equal(h.controller.state.draft.inputs.area.filterEditing, true);
    edit(h.view.setup.inputs.stack.source, "earthEngine");
    assert.equal(h.controller.state.draft.inputs.area.filterEditing, false);
    await choosePreparationSelection(h);
    assert.equal(h.view.setup.inputs.area.preparationSelection.source.parentElement.textContent, "Analysis area");
    await h.controller.submit(); assert.equal(h.requests.length, 1);
    await h.controller.duplicateRun();
    await chooseVector(h, "references", h.context.vectors[1], "South");
    await h.controller.openVectorFilter("references");
    edit(h.view.setup.inputs.stack.source, "manual");
    assert.equal(h.controller.state.draft.inputs.references.filterEditing, true);
    edit(h.view.setup.inputs.stack.source, "earthEngine");
    assert.equal(h.controller.state.draft.inputs.references.filterEditing, true);
    h.filters.at(-1).close();
});


test("off-map preparation selections show authoritative titles, layers and distinct filters without waiting for titles", async t => {
    const h = await fixture({vectors: []}); t.after(() => h.controller.destroy());
    const requests = [];
    h.api.getCatalogItem = (source, signal) => new Promise(resolve => requests.push({source, signal, resolve}));
    h.controller.chooseModel(habitat); await settle();
    const controls = h.view.setup.inputs.area.preparationSelection;
    assert.equal(requests.length, 1, "Selections sharing an Item use one metadata read");
    assert.equal(controls.source.children[1].textContent, 'basins · BASIN equals "North"');
    assert.equal(controls.source.children[2].textContent, 'basins · BASIN equals "South"');
    await choosePreparationSelection(h, 1);
    edit(h.view.setup.inputs.references.source, "raster:" + modelSourceKey(h.context.rasters[3])); await settle();
    assert.equal(h.view.setup.run.disabled, false, "Title retrieval does not gate selection or coverage");
    const source = controls.source; source.focus();
    requests[0].resolve({collection: selection.collectionId, id: selection.itemId, properties: {title: "River basins <img src=x>"}}); await settle();
    assert.equal(h.doc.activeElement, source);
    assert.match(controls.selectionDetails.textContent, /River basins <img src=x>.*basins.*South/);
    assert.ok(controls.selectionDetails.textContent.includes("Source: eolab-mounted-vectors / watersheds / data"));
    assert.equal(controls.root.querySelectorAll("img").length, 0);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "exact-selection").inputs.area,
        {kind: "catalogSelection", selection: preparationSelections[1]});
});

test("failed or stale Catalog title reads never block or rename a later preparation selection", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    h.api.getCatalogItem = async () => { throw new Error("Metadata unavailable"); };
    h.controller.chooseModel(habitat); await settle();
    await choosePreparationSelection(h); await chooseVector(h, "references", h.context.vectors[0], "North");
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(h.view.setup.inputs.area.preparationSelection.source.children[1].textContent, 'basins · BASIN equals "North"');
    assert.match(h.view.setup.inputs.area.preparationSelection.selectionDetails.textContent, /^basins.*watersheds/);
    let finish, signal;
    h.api.getCatalogItem = (_source, requestSignal) => new Promise(resolve => { finish = resolve; signal = requestSignal; });
    h.controller.chooseModel(habitat); await settle();
    h.controller.chooseModel(model);
    assert.equal(signal.aborted, true);
    finish({id: selection.itemId, properties: {title: "Stale title"}}); await settle();
    assert.equal(h.controller.state.draft.model.id, model.id);
});

test("matching area labels identify their sources and assets without repeating the layer name", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    const choices = [
        {...structuredClone(selection), itemId: "area-a"},
        {...structuredClone(selection), itemId: "area-b"},
        {...structuredClone(selection), itemId: "area-a", assetKey: "other-polygons"},
    ];
    h.api.getHabitatPreparationSelections = async () => ({selections: choices});
    h.api.getCatalogItem = async source => ({id: source.itemId, properties: {title: "study.gpkg — basins"}});
    h.controller.chooseModel(habitat); await settle();
    const controls = h.view.setup.inputs.area.preparationSelection;
    assert.deepEqual(controls.source.children.slice(1).map(option => option.textContent), choices.map(choice =>
        `study.gpkg — basins · BASIN equals "North" · Source: eolab-mounted-vectors / ${choice.itemId} / ${choice.assetKey}`));
    await chooseVector(h, "references", h.context.vectors[0], "North");
    await choosePreparationSelection(h, 2);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "distinct-source").inputs.area.selection, choices[2]);
    assert.ok(controls.selectionDetails.textContent.endsWith("Source: eolab-mounted-vectors / area-a / other-polygons"));
    await h.controller.submit();
    h.api.getHabitatPreparationSelections = async () => ({selections: [...choices].reverse()});
    await h.controller.duplicateRun();
    assert.equal(h.view.setup.inputs.area.preparationSelection.source.value, "0");
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "reordered-source").inputs.area.selection, choices[2]);
});

test("area titles preserve their text without appending an already named layer", async t => {
    const h = await fixture(); t.after(() => h.controller.destroy());
    for (const [title, label] of [
        ["basins", "basins"],
        ["workshop/regions.gpkg — basins", "workshop/regions.gpkg — basins"],
        ["Authored study — basins", "Authored study — basins"],
        ["Authored basin study", "Authored basin study · basins"],
        ["Authored study — basins expanded", "Authored study — basins expanded · basins"],
    ]) {
        h.api.getCatalogItem = async source => ({id: source.itemId, properties: {title}});
        h.controller.chooseModel(habitat); await settle();
        const controls = h.view.setup.inputs.area.preparationSelection;
        assert.equal(controls.source.children[1].textContent, `${label} · BASIN equals "North"`);
        await choosePreparationSelection(h, 1);
        assert.equal(controls.selectionDetails.textContent,
            `${label} · BASIN equals "South" · Source: eolab-mounted-vectors / watersheds / data`);
        assert.deepEqual(h.controller.state.draft.setupState.selectedSelection, preparationSelections[1]);
    }
});

test("the map outline follows the chosen off-map polygon while coverage and reference sites stay independent", async t => {
    const displays = [];
    const h = await fixture({vectors: []}, (area, signal) => new Promise(resolve => displays.push({area, signal, resolve})));
    t.after(() => h.controller.destroy());
    const controls = h.view.setup.inputs.area.preparationSelection;
    assert.equal(controls.outline.disabled, true);
    await choosePreparationSelection(h);
    assert.equal(controls.outline.disabled, false);
    assert.equal(displays.length, 0);
    setCheckbox(controls.outline, true);
    assert.deepEqual(displays[0].area, preparationSelections[0]);
    assert.match(controls.outlineStatus.textContent, /Loading/);
    edit(h.view.setup.inputs.references.source, "raster:" + modelSourceKey(h.context.rasters[3]));
    edit(h.view.setup.inputs.stack.year, "2017"); await settle();
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(displays.length, 1);
    await choosePreparationSelection(h, 1);
    assert.equal(displays[0].signal.aborted, true);
    assert.deepEqual(displays[1].area, preparationSelections[1]);
    displays[0].resolve(false); await settle();
    assert.equal(controls.outline.checked, true);
    displays[1].resolve(true); await settle();
    h.controller.setActive(false); h.controller.setActive(true);
    assert.equal(displays[1].signal.aborted, false);
    setCheckbox(controls.outline, false);
    assert.equal(displays[1].signal.aborted, true);
    setCheckbox(controls.outline, true);
    displays[2].resolve(false); await settle();
    assert.equal(controls.outline.checked, false);
    assert.match(controls.outlineStatus.textContent, /Could not show the area outline/);
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    assert.deepEqual(h.requests[0].inputs.area, {kind: "catalogSelection", selection: preparationSelections[1]});
    assert.equal(h.requests[0].inputs.references.kind, "raster");
});

test("clearing the area, switching to manual inputs or replacing the draft removes its outline", async t => {
    const displays = [];
    const h = await fixture({}, async (_selection, signal) => { displays.push(signal); return true; });
    t.after(() => h.controller.destroy());
    const controls = h.view.setup.inputs.area.preparationSelection;
    await choosePreparationSelection(h);
    setCheckbox(controls.outline, true);
    await choosePreparationSelection(h, null);
    assert.equal(displays[0].aborted, true);
    assert.equal(controls.outline.checked, false);
    await choosePreparationSelection(h);
    setCheckbox(controls.outline, true);
    edit(h.view.setup.inputs.stack.source, "manual");
    assert.equal(displays[1].aborted, true);
    edit(h.view.setup.inputs.stack.source, "earthEngine"); await settle();
    assert.equal(controls.outline.checked, false);
    setCheckbox(controls.outline, true);
    h.controller.chooseModel(model);
    assert.equal(displays[2].aborted, true);
});
