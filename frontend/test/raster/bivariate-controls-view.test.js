import assert from "node:assert/strict";
import test from "node:test";

import {
  BivariateRasterControlsView,
} from "../../src/raster/bivariate-controls-view.js";

class FakeElement extends EventTarget {
  /** Create a minimal HTML/SVG element for focused view testing. */
  constructor(tagName, documentContext) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = documentContext;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }

  /** Return select options as the current child list. */
  get options() {
    return this.children;
  }

  /** Append one or more child elements. */
  append(...children) {
    this.children.push(...children);
  }

  /** Replace every child element. */
  replaceChildren(...children) {
    this.children = children;
  }

  /** Store one string attribute and synchronize class names. */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") {
      this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }
  }

  /** Remove one attribute. */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** Read one attribute or null. */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeBivariateDocument {
  /** Create all fixed bivariate-control elements. */
  constructor() {
    const selectors = [
      "#raster-bivariate-controls",
      "#raster-comparison-mode",
      "#raster-bivariate-status",
      "#raster-bivariate-panel",
      "#raster-bivariate-x-label",
      "#raster-bivariate-y-label",
      "#raster-bivariate-palette",
      "#swap-raster-bivariate-axes",
      "#raster-bivariate-legend",
      "#raster-bivariate-legend-x-range",
      "#raster-bivariate-legend-y-range",
      "#raster-bivariate-statistics",
      "#raster-bivariate-statistics-heading",
      "#raster-bivariate-statistics-status",
      "#raster-bivariate-statistics-x-label",
      "#raster-bivariate-statistics-y-label",
      "#retry-raster-paired-statistics",
      "#raster-bivariate-histogram",
      "#raster-bivariate-histogram-summary",
    ];
    this.elements = new Map(selectors.map((selector) => [
      selector,
      new FakeElement(selector.slice(1), this),
    ]));
    const mode = this.elements.get("#raster-comparison-mode");
    for (const value of ["overlay", "bivariate"]) {
      const option = new FakeElement("option", this);
      option.value = value;
      mode.append(option);
    }
  }

  /** Resolve one fixed ID selector. */
  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  /** Create one HTML element. */
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  /** Create one SVG element. */
  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName, this);
  }
}

function pairedStatistics() {
  const size = 32;
  const counts = Array.from({ length: size }, () => Array(size).fill(0));
  counts[4][6] = 9;
  return {
    approximate: true,
    pairedSampleCount: 9,
    sampleWidth: 8,
    sampleHeight: 8,
    xMinimum: 0,
    xMaximum: 32,
    yMinimum: 0,
    yMaximum: 32,
    histogram: {
      xEdges: Array.from({ length: size + 1 }, (_, index) => index),
      yEdges: Array.from({ length: size + 1 }, (_, index) => index),
      counts,
      xMarginalCounts: Array.from(
        { length: size },
        (_, index) => index === 6 ? 9 : 0,
      ),
      yMarginalCounts: Array.from(
        { length: size },
        (_, index) => index === 4 ? 9 : 0,
      ),
    },
  };
}

const PRESENTATION = {
  paletteName: "orangeBlue",
  xLabel: "temperature.tif",
  yLabel: "moisture.tif",
  xStyle: {
    minimum: 0,
    midpoint: 16,
    maximum: 32,
    minimumColor: "#000000",
    midpointColor: "#ff8000",
    maximumColor: "#ffcc00",
  },
  yStyle: {
    minimum: 0,
    midpoint: 16,
    maximum: 32,
    minimumColor: "#000000",
    midpointColor: "#408020",
    maximumColor: "#00ffff",
  },
};

test("bivariate controls render labeled legend and inspectable ESOS-C histogram", () => {
  const documentContext = new FakeBivariateDocument();
  const view = new BivariateRasterControlsView(documentContext);
  view.populatePalettes();
  view.renderMode({ active: true, ...PRESENTATION });
  view.renderStatistics(pairedStatistics(), PRESENTATION);

  assert.equal(view.palette.children.length, 8);
  assert.equal(view.panel.hidden, false);
  assert.equal(view.statisticsPanel.hidden, false);
  assert.equal(
    view.statisticsHeading.textContent,
    "temperature.tif vs. moisture.tif",
  );
  assert.equal(view.statisticsXLabel.textContent, "temperature.tif");
  assert.equal(view.statisticsYLabel.textContent, "moisture.tif");
  assert.equal(view.legend.children.length, 145);
  assert.match(view.legend.getAttribute("aria-label"), /temperature\.tif/);
  assert.match(view.legend.getAttribute("aria-label"), /moisture\.tif/);
  assert.equal(view.cells.size, 1);
  const cell = view.cells.get("6:4");
  assert.equal(cell.getAttribute("tabindex"), "0");
  assert.equal(cell.getAttribute("role"), "button");
  assert.match(cell.getAttribute("aria-label"), /9 pixels/);
  assert.match(view.histogram.getAttribute("aria-label"), /temperature\.tif/);
  assert.doesNotMatch(view.histogram.getAttribute("aria-label"), /Raster A/);
  assert.match(view.histogram.getAttribute("aria-label"), /Densest bin/);
  assert.match(view.histogramSummary.textContent, /^Densest · temperature\.tif /);
  const xAxisTitles = view.histogram.children.filter(
    (child) => child.getAttribute("data-axis") === "x",
  );
  const yAxisTitles = view.histogram.children.filter(
    (child) => child.getAttribute("data-axis") === "y",
  );
  assert.deepEqual(xAxisTitles.map((title) => title.textContent), [
    "temperature.tif",
  ]);
  assert.deepEqual(yAxisTitles.map((title) => title.textContent), [
    "moisture.tif",
  ]);

  const keyboardEvent = new Event("keydown");
  Object.defineProperty(keyboardEvent, "key", { value: "Enter" });
  cell.dispatchEvent(keyboardEvent);
  assert.equal(cell.classList.contains("is-selected"), true);
  assert.match(view.histogramSummary.textContent, /100\.0%/);

  view.highlightPair(6.5, 4.5);
  assert.equal(cell.classList.contains("is-probed"), true);
  assert.match(view.histogramSummary.textContent, /Probe/);
});

test("bivariate histogram wraps long raster basenames clear of Y ticks", () => {
  const documentContext = new FakeBivariateDocument();
  const view = new BivariateRasterControlsView(documentContext);
  const longPresentation = {
    ...PRESENTATION,
    xLabel: "barley_NitrogenApplication_Rate_for_2026_scenario_output.tif",
    yLabel: "grassland_carbon_sequestration_reference_projection_2026.tif",
  };
  view.renderMode({ active: true, ...longPresentation });
  view.renderStatistics(pairedStatistics(), longPresentation);

  const xAxisTitles = view.histogram.children.filter(
    (child) => child.getAttribute("data-axis") === "x",
  );
  const yAxisTitles = view.histogram.children.filter(
    (child) => child.getAttribute("data-axis") === "y",
  );
  assert.ok(xAxisTitles.length > 1);
  assert.ok(yAxisTitles.length > 1);
  assert.equal(
    xAxisTitles.map((title) => title.textContent).join(""),
    longPresentation.xLabel,
  );
  assert.equal(
    yAxisTitles.map((title) => title.textContent).join(""),
    longPresentation.yLabel,
  );
  assert.ok(
    yAxisTitles.every((title) => Number(title.getAttribute("x")) < 100),
  );
  assert.equal(
    view.statisticsHeading.textContent,
    `${longPresentation.xLabel} vs. ${longPresentation.yLabel}`,
  );
});

test("bivariate controls forward native mode, palette, swap, and retry actions", () => {
  const documentContext = new FakeBivariateDocument();
  const view = new BivariateRasterControlsView(documentContext);
  const actions = [];
  view.populatePalettes();
  view.bind({
    onBivariateModeChange: (mode) => actions.push(["mode", mode]),
    onBivariatePaletteChange: (palette) => actions.push(["palette", palette]),
    onBivariateSwapAxes: () => actions.push(["swap"]),
    onRetryPairedStatistics: () => actions.push(["retry"]),
  });

  view.mode.value = "bivariate";
  view.mode.dispatchEvent(new Event("change"));
  view.palette.value = "steelRose";
  view.palette.dispatchEvent(new Event("change"));
  view.swapButton.dispatchEvent(new Event("click"));
  view.retryButton.dispatchEvent(new Event("click"));
  view.unbind();

  assert.deepEqual(actions, [
    ["mode", "bivariate"],
    ["palette", "steelRose"],
    ["swap"],
    ["retry"],
  ]);
});
