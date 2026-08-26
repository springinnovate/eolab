import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  catalogItemsMatch,
  CatalogMapActionRegistry,
  CatalogVisualizationAssessmentCache,
} from "../src/catalog-map-actions.js";
import { getCatalogVisualization } from "../src/catalog.js";

const MAIN_SOURCE = readFileSync(
  new URL("../src/main.js", import.meta.url),
  "utf8",
);
const MARKUP = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const ATTEMPT_SOURCE = sourceBetween(
  MAIN_SOURCE,
  "async function toggleCatalogLayer()",
  'catalogLayerToggle.addEventListener("click", toggleCatalogLayer);',
);

/**
 * Return source bounded by two unique implementation markers.
 *
 * @param {string} source Complete source document.
 * @param {string} startMarker Inclusive opening marker.
 * @param {string} endMarker Exclusive closing marker.
 * @return {string} Source between the requested markers.
 * @throws {Error} If either marker is absent or ordered incorrectly.
 */
function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Unable to locate source range: ${startMarker}`);
  }
  return source.slice(start, end);
}

/**
 * Require ordered source fragments in one implementation range.
 *
 * @param {string} source Source range under test.
 * @param {string[]} fragments Fragments required in ascending order.
 * @return {void}
 * @throws {AssertionError} If a fragment is absent or out of order.
 */
function assertOrdered(source, fragments) {
  let previousIndex = -1;
  for (const fragment of fragments) {
    const currentIndex = source.indexOf(fragment);
    assert.ok(currentIndex >= 0, `Missing source fragment: ${fragment}`);
    assert.ok(
      currentIndex > previousIndex,
      `Source fragment is out of order: ${fragment}`,
    );
    previousIndex = currentIndex;
  }
}

/**
 * Build one current-policy Catalog raster for the visualization flow.
 *
 * @param {string} id Stable Item identifier.
 * @param {boolean} eligible Current rendering eligibility.
 * @param {string|null} [reason=null] Backend-owned rejection reason.
 * @return {Object} Minimal authoritative raster Item.
 */
function createRasterItem(id, eligible, reason = null) {
  const rendering = {
    policy: "raster-v3",
    eligible,
    source_signature: [1, 2, 3, 4, 5],
  };
  if (reason !== null) {
    rendering.reason = reason;
  }
  return {
    collection: "eolab-mounted-geotiffs",
    id,
    assets: { data: { "eolab:rendering": rendering } },
    properties: { title: `${id}.tif` },
  };
}

/**
 * Build one current-policy Catalog vector for the visualization flow.
 *
 * @param {string} id Stable Item identifier.
 * @param {boolean} eligible Current rendering eligibility.
 * @return {Object} Minimal authoritative vector Item.
 */
function createVectorItem(id, eligible) {
  return {
    collection: "eolab-mounted-vectors",
    id,
    assets: { data: {} },
    properties: {
      title: `${id}.gpkg`,
      "eolab:vector_rendering": {
        policy: "vector-v1",
        eligible,
      },
    },
  };
}

/**
 * Execute the production Add handler against observable owned boundaries.
 *
 * The production function remains inside the browser composition root. This
 * harness evaluates that exact function body while injecting only the same
 * closure contracts used at runtime, avoiding a second orchestration
 * implementation created solely for tests.
 *
 * @param {Object} configuration Harness configuration.
 * @param {Object} configuration.selectedItem Initially selected Catalog Item.
 * @param {(item:Object)=>Promise<Object>} configuration.assess Assessment
 * boundary.
 * @param {(item:Object)=>Promise<Object|null>} [configuration.show] Publication
 * boundary.
 * @param {boolean} [configuration.retained=false] Initial retained state.
 * @return {{run:()=>Promise<void>,state:Object,calls:Array,registry:Object,
 * layerButton:Object,status:Object}} Executable handler and observed state.
 */
function createAttemptHarness({
  selectedItem,
  assess,
  show = async () => ({ layerName: "eolab:test" }),
  retained = false,
}) {
  const calls = [];
  const registry = new CatalogMapActionRegistry();
  const layerButton = { textContent: "Add to map layers" };
  const status = { textContent: "" };
  const state = {
    selectedItem,
    visualizationAssessments: new CatalogVisualizationAssessmentCache(),
    collectionsDocument: { collections: [] },
  };
  let isRetained = retained;
  const catalogVisualization = {
    describe: getCatalogVisualization,
    noun(item) {
      return getCatalogVisualization(item).kind === "raster"
        ? "raster"
        : "vector layer";
    },
    contains() {
      return isRetained;
    },
    remove(item) {
      calls.push(["remove", item.id]);
      isRetained = false;
    },
    async assess(item) {
      calls.push(["assess", item.id]);
      return assess(item);
    },
    async show(item) {
      calls.push(["show", item.id]);
      const publication = await show(item);
      if (publication !== null) {
        isRetained = true;
      }
      return publication;
    },
  };
  const rasterVisualization = {
    removeSampled(item) {
      calls.push(["remove-sampled", item.id]);
    },
    activateAnalysis(item) {
      calls.push(["activate-analysis", item.id]);
    },
  };
  const rasterDetailPreview = {
    remove(item) {
      calls.push(["remove-preview", item.id]);
    },
  };
  const beginCatalogMapAction = (item, buttonText, statusText) => {
    calls.push(["begin", item.id]);
    layerButton.textContent = buttonText;
    status.textContent = statusText;
    return registry.begin(item, buttonText, statusText);
  };
  const finishCatalogMapAction = (action) => {
    if (!registry.finish(action)) {
      return;
    }
    calls.push(["finish", action.item.id]);
    if (!catalogItemsMatch(state.selectedItem, action.item)) {
      return;
    }
    const current = getCatalogVisualization(state.selectedItem);
    layerButton.textContent = isRetained
      ? "Remove from map layers"
      : "Add to map layers";
    status.textContent = current?.metadata?.reason ?? "";
  };
  const factory = new Function(
    "catalogState",
    "catalogVisualization",
    "rasterVisualization",
    "rasterDetailPreview",
    "beginCatalogMapAction",
    "finishCatalogMapAction",
    "catalogItemsMatch",
    "renderCatalogItemInspector",
    "appGlobalConfiguration",
    "catalogLayerToggle",
    "catalogLayerStatus",
    "onRenderingWorkspaceRequested",
    `${ATTEMPT_SOURCE}; return toggleCatalogLayer;`,
  );
  const run = factory(
    state,
    catalogVisualization,
    rasterVisualization,
    rasterDetailPreview,
    beginCatalogMapAction,
    finishCatalogMapAction,
    catalogItemsMatch,
    (item) => calls.push(["render-inspector", item.id]),
    { scanDisplayPathPrefix: "Mounted" },
    layerButton,
    status,
    () => calls.push(["open-rendering"]),
  );
  return { run, state, calls, registry, layerButton, status };
}

test("visualization assessment is internal rather than a user action", () => {
  assert.match(MARKUP, /id="toggle-catalog-layer"[\s\S]*?>\s*Add to map layers\s*</);
  assert.match(MARKUP, /id="show-raster-detail-preview"[\s\S]*?>\s*Use low-resolution rendering\s*</);
  assert.doesNotMatch(MARKUP, /id="reassess-detail-raster"/);
  assert.doesNotMatch(
    `${MARKUP}\n${MAIN_SOURCE}`,
    /Assess for visualization|Reassess visualization|Check for full visualization/,
  );
});

test("every non-retained Add attempt assesses then publishes when eligible", () => {
  const attempt = ATTEMPT_SOURCE;

  assertOrdered(attempt, [
    "catalogVisualization.contains(selectedItem)",
    "onRenderingWorkspaceRequested();",
    "beginCatalogMapAction(",
    "await catalogVisualization.assess(",
    "catalogState.visualizationAssessments.record(",
    "catalogItemsMatch(",
    "catalogState.visualizationAssessments.apply(",
    "const currentVisualization = catalogVisualization.describe(",
    'currentVisualization?.metadata?.eligible !== true',
    "await catalogVisualization.show(",
  ]);
  assert.match(attempt, /catalogVisualization\.show\(\s*currentItem\s*\)/s);
  assert.doesNotMatch(
    attempt,
    /visualization\?\.metadata === undefined|visualization\.metadata\.eligible === false/,
  );
});

test("attempt feedback remains visible and stale selections cannot publish", () => {
  const attempt = ATTEMPT_SOURCE;
  const presentation = sourceBetween(
    MAIN_SOURCE,
    "function updateCatalogMapAction(item)",
    "function clearCatalogSelection()",
  );

  assert.match(
    attempt,
    /if \(!catalogItemsMatch\([\s\S]*?\)\) \{\s*return;\s*\}[\s\S]*?catalogVisualization\.show/s,
  );
  assert.match(
    attempt,
    /currentVisualization\?\.metadata\?\.eligible !== true[\s\S]*?finishCatalogMapAction\(pendingAction\);\s*return;/s,
  );
  assert.match(
    attempt,
    /catch \(visualizationError\)[\s\S]*?catalogLayerStatus\.textContent = visualizationError\.message/s,
  );
  assert.match(presentation, /catalogLayerToggle\.hidden = false/);
  assert.match(
    presentation,
    /isRetained\s*\? "Remove from map layers"\s*:\s*"Add to map layers"/s,
  );
  assert.match(
    MAIN_SOURCE,
    /\(\) => layoutController\.showWorkspace\("map-layers"\)/,
  );
});

test("eligible raster assessment publishes in the same pending action", async () => {
  const selected = createRasterItem("eligible", true);
  const assessed = createRasterItem("eligible", true);
  const harness = createAttemptHarness({
    selectedItem: selected,
    assess: async () => assessed,
  });

  await harness.run();

  assert.ok(
    harness.calls.findIndex(([call]) => call === "assess") <
      harness.calls.findIndex(([call]) => call === "show"),
  );
  assert.deepEqual(
    harness.calls.filter(([call]) => call === "open-rendering"),
    [["open-rendering"], ["open-rendering"]],
  );
  assert.equal(harness.layerButton.textContent, "Remove from map layers");
  assert.equal(harness.status.textContent, "Raster added to Map layers.");
  assert.equal(harness.registry.get(selected), null);
});

test("ineligible raster preserves its reason and never publishes", async () => {
  const reason =
    "Visualization unavailable: this raster needs an internal overview pyramid.";
  const selected = createRasterItem("ineligible", true);
  const harness = createAttemptHarness({
    selectedItem: selected,
    assess: async () => createRasterItem("ineligible", false, reason),
  });

  await harness.run();

  assert.equal(harness.calls.some(([call]) => call === "show"), false);
  assert.equal(harness.layerButton.textContent, "Add to map layers");
  assert.equal(harness.status.textContent, reason);
  assert.equal(harness.registry.get(selected), null);
});

test("assessment errors restore Add and expose the exact failure", async () => {
  const selected = createRasterItem("broken", true);
  const harness = createAttemptHarness({
    selectedItem: selected,
    assess: async () => {
      throw new Error("Raster metadata could not be read.");
    },
  });

  await harness.run();

  assert.equal(harness.calls.some(([call]) => call === "show"), false);
  assert.equal(harness.layerButton.textContent, "Add to map layers");
  assert.equal(harness.status.textContent, "Raster metadata could not be read.");
  assert.equal(harness.registry.get(selected), null);
});

test("selection changes during assessment prevent stale publication", async () => {
  const selected = createRasterItem("first", true);
  let completeAssessment;
  const assessment = new Promise((resolve) => {
    completeAssessment = resolve;
  });
  const harness = createAttemptHarness({
    selectedItem: selected,
    assess: () => assessment,
  });

  const attempt = harness.run();
  harness.state.selectedItem = createRasterItem("second", true);
  completeAssessment(createRasterItem("first", true));
  await attempt;

  assert.equal(harness.calls.some(([call]) => call === "show"), false);
  assert.equal(harness.registry.get(selected), null);
  assert.equal(harness.state.selectedItem.id, "second");
});

test("eligible vectors share the outcome-oriented Add flow", async () => {
  const selected = createVectorItem("roads", true);
  const harness = createAttemptHarness({
    selectedItem: selected,
    assess: async () => createVectorItem("roads", true),
    show: async () => ({ layerName: "eolab:roads" }),
  });

  await harness.run();

  assert.deepEqual(
    harness.calls.filter(([call]) => call === "assess" || call === "show"),
    [["assess", "roads"], ["show", "roads"]],
  );
  assert.equal(
    harness.calls.some(([call]) => call === "activate-analysis"),
    false,
  );
  assert.equal(harness.layerButton.textContent, "Remove from map layers");
});
