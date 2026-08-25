import assert from "node:assert/strict";
import test from "node:test";

import { MapLayerStackView } from "../../src/map-layers/layer-stack-view.js";

/** Minimal DOM element used by the raster layer-stack view tests. */
class FakeLayerStackElement extends EventTarget {
  /**
   * Create one mutable DOM-like element.
   *
   * @param {string} tagName HTML tag name.
   * @param {FakeLayerStackDocument} documentContext Owning fake document.
   */
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
    this.checked = false;
    this.value = "";
    this.textContent = "";
    this.title = "";
    this.type = "";
    this.name = "";
    this._classNames = new Set();
    this.classList = {
      contains: (className) => this._classNames.has(className),
      toggle: (className, force) => {
        const shouldAdd = force ?? !this._classNames.has(className);
        if (shouldAdd) {
          this._classNames.add(className);
        } else {
          this._classNames.delete(className);
        }
        return shouldAdd;
      },
    };
  }

  /** Space-separated CSS classes, kept in sync with classList. */
  get className() {
    return [...this._classNames].join(" ");
  }

  set className(value) {
    this._classNames = new Set(value.split(/\s+/).filter(Boolean));
  }

  /**
   * Append child nodes.
   *
   * @param {...FakeLayerStackElement} children Child nodes.
   * @return {void}
   */
  append(...children) {
    this.children.push(...children);
  }

  /**
   * Replace all child nodes.
   *
   * @param {...FakeLayerStackElement} children Replacement nodes.
   * @return {void}
   */
  replaceChildren(...children) {
    this.children = children;
  }

  /**
   * Store one element attribute.
   *
   * @param {string} name Attribute name.
   * @param {string} value Attribute value.
   * @return {void}
   */
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  /**
   * Return one element attribute.
   *
   * @param {string} name Attribute name.
   * @return {string|null} Attribute value or null.
   */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** Give this control fake document focus. */
  focus() {
    this.ownerDocument.activeElement = this;
  }
}

/** Minimal text node used for visible label suffixes. */
class FakeTextNode {
  /** @param {string} text Text node content. */
  constructor(text) {
    this.textContent = text;
  }
}

/** Fixed layer-stack markup plus an element factory. */
class FakeLayerStackDocument {
  /** Create the required semantic layer-stack markup. */
  constructor() {
    this.activeElement = null;
    this.elements = new Map([
      ["#raster-layer-stack", new FakeLayerStackElement("section", this)],
      ["#raster-layer-stack-body", new FakeLayerStackElement("div", this)],
      ["#toggle-map-layer-widget", new FakeLayerStackElement("button", this)],
      ["#raster-layer-widget-count", new FakeLayerStackElement("span", this)],
      ["#raster-layer-list", new FakeLayerStackElement("ol", this)],
      ["#raster-layer-stack-status", new FakeLayerStackElement("p", this)],
      ["#raster-layer-stack-limit", new FakeLayerStackElement("p", this)],
    ]);
    this.elements.get("#raster-layer-stack").hidden = true;
    this.elements.get("#toggle-map-layer-widget")
      .setAttribute("aria-expanded", "true");
  }

  /**
   * Resolve one required fixed element.
   *
   * @param {string} selector Element ID selector.
   * @return {FakeLayerStackElement|null} Registered element or null.
   */
  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  /**
   * Create one fake HTML element.
   *
   * @param {string} tagName HTML tag name.
   * @return {FakeLayerStackElement} New fake element.
   */
  createElement(tagName) {
    return new FakeLayerStackElement(tagName, this);
  }

  /**
   * Create one fake text node.
   *
   * @param {string} text Node content.
   * @return {FakeTextNode} New fake text node.
   */
  createTextNode(text) {
    return new FakeTextNode(text);
  }
}

/**
 * Return every descendant with one CSS class.
 *
 * @param {FakeLayerStackElement} element Search root.
 * @param {string} className CSS class.
 * @return {FakeLayerStackElement[]} Matching descendants.
 */
function elementsByClass(element, className) {
  const matches = [];
  for (const child of element.children) {
    if (child instanceof FakeLayerStackElement) {
      if (child.classList.contains(className)) {
        matches.push(child);
      }
      matches.push(...elementsByClass(child, className));
    }
  }
  return matches;
}

/**
 * Find one row control by its stable action identity.
 *
 * @param {FakeLayerStackElement} row Rendered layer row.
 * @param {string} action Layer action.
 * @return {FakeLayerStackElement} Matching control.
 */
function actionControl(row, action) {
  const controls = [];
  const visit = (element) => {
    for (const child of element.children) {
      if (child instanceof FakeLayerStackElement) {
        if (child.dataset.layerAction === action) {
          controls.push(child);
        }
        visit(child);
      }
    }
  };
  visit(row);
  assert.equal(controls.length, 1, `expected one ${action} control`);
  return controls[0];
}

/**
 * Build the neutral gradient-legend contract emitted by a layer owner.
 *
 * @param {Object} style Test ramp with numeric stops and CSS colors.
 * @return {{kind:"gradient",gradient:string,description:string,labels:number[]}}
 * Presentation-only legend consumed by the map-layer view.
 */
function gradientLegend(style) {
  const midpointPosition =
    ((style.midpoint - style.minimum) /
      (style.maximum - style.minimum)) * 100;
  return {
    kind: "gradient",
    gradient: `linear-gradient(90deg, ${style.minimumColor} 0%, ` +
      `${style.midpointColor} ${midpointPosition}%, ` +
      `${style.maximumColor} 100%)`,
    description:
      `Color ramp: ${style.minimum} at ${style.minimumColor}, ` +
      `${style.midpoint} at ${style.midpointColor}, and ` +
      `${style.maximum} at ${style.maximumColor}.`,
    labels: [style.minimum, style.midpoint, style.maximum],
  };
}

const LAYERS = [
  {
    key: "temperature",
    item: { collection: "climate", id: "temperature-annual" },
    label: "Global surface temperature anomaly (1981–2010 baseline)",
    visible: true,
    opacity: 0.42,
    error: null,
    legend: gradientLegend({
      minimum: -10,
      midpoint: 0,
      maximum: 15,
      minimumColor: "#0000ff",
      midpointColor: "#ffffff",
      maximumColor: "#ff0000",
    }),
  },
  {
    key: "vegetation",
    item: { collection: "vegetation", id: "health-index" },
    label: "Vegetation health index",
    visible: true,
    opacity: 1,
    error: null,
    legend: gradientLegend({
      minimum: 0,
      midpoint: 50,
      maximum: 100,
      minimumColor: "#30123b",
      midpointColor: "#a4fc3c",
      maximumColor: "#7a0403",
    }),
  },
  {
    key: "moisture",
    item: { collection: "soil", id: "moisture-anomaly" },
    label: "Soil moisture anomaly",
    visible: false,
    opacity: 0.75,
    error: "Statistics unavailable.",
    legend: gradientLegend({
      minimum: -5,
      midpoint: 1,
      maximum: 9,
      minimumColor: "#5e4fa2",
      midpointColor: "#ffffbf",
      maximumColor: "#9e0142",
    }),
  },
];

test("MapLayerStackView renders semantic, accessible independent rows", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);

  view.render(LAYERS, "vegetation");

  const root = documentContext.querySelector("#raster-layer-stack");
  const list = documentContext.querySelector("#raster-layer-list");
  const limit = documentContext.querySelector("#raster-layer-stack-limit");
  assert.equal(root.hidden, false);
  assert.equal(
    documentContext.querySelector("#raster-layer-widget-count").textContent,
    "3",
  );
  assert.equal(
    documentContext.querySelector("#toggle-map-layer-widget")
      .getAttribute("aria-label"),
    "Hide layers",
  );
  assert.equal(list.tagName, "OL");
  assert.deepEqual(list.children.map((row) => row.tagName), ["LI", "LI", "LI"]);
  assert.equal(
    limit.textContent,
    "Two map layers are visible. Hide one before showing another.",
  );

  const [temperatureRow, vegetationRow, moistureRow] = list.children;
  assert.equal(temperatureRow.classList.contains("is-active"), false);
  assert.equal(vegetationRow.classList.contains("is-active"), true);
  assert.equal(moistureRow.classList.contains("is-hidden"), true);
  assert.equal(actionControl(vegetationRow, "activate").checked, true);
  assert.equal(actionControl(temperatureRow, "visibility").checked, true);
  assert.equal(actionControl(moistureRow, "visibility").checked, false);
  assert.equal(actionControl(moistureRow, "visibility").disabled, true);
  assert.equal(
    actionControl(moistureRow, "visibility").getAttribute("aria-describedby"),
    "raster-layer-stack-limit",
  );

  const temperatureName = elementsByClass(
    temperatureRow,
    "raster-layer-name",
  )[0];
  assert.equal(temperatureName.textContent, LAYERS[0].label);
  assert.equal(temperatureName.title, LAYERS[0].label);
  assert.equal(
    elementsByClass(temperatureRow, "raster-layer-identity")[0].textContent,
    "climate / temperature-annual",
  );
  const temperatureAccessibleName =
    `${LAYERS[0].label}; Catalog Item climate / temperature-annual`;
  assert.equal(
    actionControl(temperatureRow, "activate").getAttribute("aria-label"),
    `Edit ${temperatureAccessibleName}`,
  );
  assert.equal(
    actionControl(temperatureRow, "visibility").getAttribute("aria-label"),
    `Hide ${temperatureAccessibleName}`,
  );
  assert.equal(
    actionControl(temperatureRow, "remove").getAttribute("aria-label"),
    `Remove ${temperatureAccessibleName}`,
  );
  assert.equal(
    actionControl(moistureRow, "visibility").getAttribute("aria-label"),
    `Show ${LAYERS[2].label}; Catalog Item soil / moisture-anomaly`,
  );

  const legends = list.children.map(
    (row) => elementsByClass(row, "raster-layer-legend")[0],
  );
  assert.ok(legends.every((legend) => legend.getAttribute("role") === "img"));
  assert.equal(new Set(legends.map((legend) => legend.style.background)).size, 3);
  assert.match(legends[0].getAttribute("aria-label"), /-10 at #0000ff/);
  assert.match(legends[1].getAttribute("aria-label"), /50 at #a4fc3c/);
  assert.match(legends[2].getAttribute("aria-label"), /9 at #9e0142/);
  assert.deepEqual(
    list.children.map((row) =>
      elementsByClass(row, "raster-layer-legend-labels")[0].children.map(
        (label) => label.textContent,
      )),
    [["-10", "0", "15"], ["0", "50", "100"], ["-5", "1", "9"]],
  );
  assert.equal(
    elementsByClass(moistureRow, "raster-layer-error")[0].textContent,
    "Statistics unavailable.",
  );
  assert.equal(elementsByClass(moistureRow, "raster-layer-error")[0].hidden, false);
});

test("MapLayerStackView renders a neutral fixed-swatch legend", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  const layer = {
    ...LAYERS[0],
    legend: {
      kind: "fixed",
      label: "Polygon",
      fill: "#a855f7",
      stroke: "#581c87",
    },
  };

  view.render([layer], layer.key);

  const row = documentContext.querySelector("#raster-layer-list").children[0];
  const legend = elementsByClass(row, "raster-layer-legend")[0];
  const labels = elementsByClass(row, "raster-layer-legend-labels")[0];
  assert.equal(row.classList.contains("has-fixed-legend"), true);
  assert.equal(legend.style.background, "#a855f7");
  assert.equal(legend.style.borderColor, "#581c87");
  assert.match(legend.getAttribute("aria-label"), /Default polygon symbology/);
  assert.equal(labels.textContent, "Polygon features · fixed default style");
});

test("MapLayerStackView forwards controls and updates opacity output", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  const received = [];
  view.bind({
    onActivate: (key) => received.push(["activate", key]),
    onVisibility: (key, visible) => received.push(["visibility", key, visible]),
    onOpacity: (key, opacity) => received.push(["opacity", key, opacity]),
    onMove: (key, direction) => received.push(["move", key, direction]),
    onRemove: (key) => received.push(["remove", key]),
  });
  view.render(LAYERS, "vegetation");
  const widgetBody = documentContext.querySelector("#raster-layer-stack-body");
  const widgetToggle = documentContext.querySelector("#toggle-map-layer-widget");
  widgetToggle.dispatchEvent(new Event("click"));
  assert.equal(widgetBody.hidden, true);
  assert.equal(widgetToggle.getAttribute("aria-expanded"), "false");
  assert.equal(widgetToggle.getAttribute("aria-label"), "Show layers");
  widgetToggle.dispatchEvent(new Event("click"));
  assert.equal(widgetBody.hidden, false);
  const [temperatureRow, vegetationRow, moistureRow] = documentContext
    .querySelector("#raster-layer-list").children;

  const activate = actionControl(temperatureRow, "activate");
  activate.checked = true;
  activate.dispatchEvent(new Event("change"));
  const visibility = actionControl(temperatureRow, "visibility");
  visibility.checked = false;
  visibility.dispatchEvent(new Event("change"));
  const opacity = actionControl(vegetationRow, "opacity");
  const opacityOutput = elementsByClass(
    vegetationRow,
    "raster-layer-opacity",
  )[0].children[2];
  assert.equal(opacity.value, "100");
  assert.equal(opacityOutput.textContent, "100%");
  assert.equal(opacity.getAttribute("aria-valuetext"), "100 percent");
  assert.equal(opacityOutput.getAttribute("for"), opacity.id);
  opacity.value = "37";
  opacity.dispatchEvent(new Event("input"));
  actionControl(vegetationRow, "move-up").dispatchEvent(new Event("click"));
  actionControl(moistureRow, "remove").dispatchEvent(new Event("click"));

  assert.equal(opacityOutput.value, "37%");
  assert.equal(opacityOutput.textContent, "37%");
  assert.equal(opacity.getAttribute("aria-valuetext"), "37 percent");
  assert.deepEqual(received, [
    ["activate", "temperature"],
    ["visibility", "temperature", false],
    ["opacity", "vegetation", 0.37],
    ["move", "vegetation", "up"],
    ["remove", "moisture"],
  ]);
  assert.equal(actionControl(temperatureRow, "move-up").disabled, true);
  assert.equal(actionControl(moistureRow, "move-down").disabled, true);

  view.unbind();
  actionControl(moistureRow, "remove").dispatchEvent(new Event("click"));
  assert.equal(received.length, 5);
});

test("MapLayerStackView renders and forwards neutral per-layer tools", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  const received = [];
  view.bind({
    onActivate() {},
    onVisibility() {},
    onOpacity() {},
    onMove() {},
    onRemove() {},
    onTool: (key, toolId) => received.push([key, toolId]),
  });
  const layer = {
    ...LAYERS[0],
    tools: [
      {
        id: "distribution",
        label: "Distribution",
        status: "50 km map sample",
        preview: {
          kind: "bars",
          values: [1, 4, 2, 8],
          label: "Sample distribution",
        },
      },
      { id: "style", label: "Style" },
    ],
  };

  view.render([layer], layer.key);

  const row = documentContext.querySelector("#raster-layer-list").children[0];
  const toolGroup = elementsByClass(row, "map-layer-tools")[0];
  const preview = elementsByClass(row, "map-layer-tool-bars")[0];
  assert.equal(toolGroup.hidden, false);
  assert.equal(preview.getAttribute("role"), "img");
  assert.equal(preview.getAttribute("aria-label"), "Sample distribution");
  assert.deepEqual(
    preview.children.map(({ style }) => style.height),
    ["12.5%", "50%", "25%", "100%"],
  );

  actionControl(row, "tool-distribution").dispatchEvent(new Event("click"));
  actionControl(row, "tool-style").dispatchEvent(new Event("click"));
  assert.deepEqual(received, [
    [layer.key, "distribution"],
    [layer.key, "style"],
  ]);
});

test("MapLayerStackView Escape collapses only its floating widget", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  view.bind({
    onActivate() {},
    onVisibility() {},
    onOpacity() {},
    onMove() {},
    onRemove() {},
  });
  view.render([LAYERS[0]], LAYERS[0].key);
  const root = documentContext.querySelector("#raster-layer-stack");
  const toggle = documentContext.querySelector("#toggle-map-layer-widget");
  const escapeEvent = new Event("keydown", { cancelable: true });
  Object.defineProperty(escapeEvent, "key", { value: "Escape" });

  root.dispatchEvent(escapeEvent);

  assert.equal(escapeEvent.defaultPrevented, true);
  assert.equal(
    documentContext.querySelector("#raster-layer-stack-body").hidden,
    true,
  );
  assert.equal(documentContext.activeElement, toggle);
});

test("MapLayerStackView announces status and retains stable action focus", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  view.render(LAYERS, "temperature");
  const list = documentContext.querySelector("#raster-layer-list");
  const focusedBeforeRender = actionControl(list.children[2], "remove");
  focusedBeforeRender.focus();

  view.render([LAYERS[2], LAYERS[0], LAYERS[1]], "temperature");

  assert.notEqual(documentContext.activeElement, focusedBeforeRender);
  assert.equal(documentContext.activeElement.dataset.layerKey, "moisture");
  assert.equal(documentContext.activeElement.dataset.layerAction, "remove");

  view.render(
    [LAYERS[0], LAYERS[1]],
    "vegetation",
    { key: "vegetation", action: "move-up" },
  );
  assert.equal(documentContext.activeElement.dataset.layerKey, "vegetation");
  assert.equal(documentContext.activeElement.dataset.layerAction, "move-up");

  view.render(
    [LAYERS[1], LAYERS[0]],
    "vegetation",
    { key: "vegetation", action: "move-up" },
  );
  assert.equal(documentContext.activeElement.dataset.layerKey, "vegetation");
  assert.equal(documentContext.activeElement.dataset.layerAction, "move-down");

  view.setStatus("Soil moisture anomaly removed.");
  assert.equal(
    documentContext.querySelector("#raster-layer-stack-status").textContent,
    "Soil moisture anomaly removed.",
  );

  view.render([], null);
  assert.equal(documentContext.querySelector("#raster-layer-stack").hidden, true);
  assert.equal(list.children.length, 0);
  assert.equal(
    documentContext.activeElement,
    documentContext.querySelector("#raster-layer-stack-status"),
  );
  assert.equal(
    documentContext.querySelector("#raster-layer-stack-limit").textContent,
    "0 of 2 map layers visible.",
  );
});
