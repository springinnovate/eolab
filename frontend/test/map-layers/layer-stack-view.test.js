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
      ["#raster-layer-stack", new FakeLayerStackElement("div", this)],
      ["#raster-layer-list", new FakeLayerStackElement("ol", this)],
      ["#raster-layer-stack-status", new FakeLayerStackElement("p", this)],
      ["#raster-layer-stack-limit", new FakeLayerStackElement("p", this)],
    ]);
    this.elements.get("#raster-layer-stack").hidden = true;
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

test("rows expose filename, visibility, Style and contained actions only", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  view.render(LAYERS, "vegetation");
  const rows = doc.querySelector("#raster-layer-list").children;
  assert.equal(rows.length, 3);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.tagName, "LI");
    assert.equal(row.classList.contains("is-active"), false);
    assert.equal(elementsByClass(row, "raster-layer-name")[0].textContent, LAYERS[index].label);
    assert.equal(elementsByClass(row, "raster-layer-legend").length, 0);
    assert.equal(elementsByClass(row, "raster-layer-opacity").length, 0);
    assert.equal(actionControl(row, "style").getAttribute("aria-haspopup"), "dialog");
    assert.equal(actionControl(row, "visibility").type, "checkbox");
    assert.equal(actionControl(row, "visibility").checked, LAYERS[index].visible);
  }
  assert.equal(actionControl(rows[2], "visibility").disabled, true);
  assert.equal(actionControl(rows[0], "move-up").disabled, true);
  assert.equal(actionControl(rows[2], "move-down").disabled, true);
  assert.equal(elementsByClass(rows[2], "raster-layer-error")[0].textContent, "Statistics unavailable.");
  assert.equal(doc.querySelector("#raster-layer-stack").hidden, false);
});

test("raster and vector rows use the same compact action layout", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const vector = { ...LAYERS[0], legend: { kind: "fixed", label: "Polygon" } };
  view.render([vector, { ...LAYERS[1], opacityLocked: true, effectiveOpacity: 1 }], null);
  for (const row of doc.querySelector("#raster-layer-list").children) {
    assert.equal(actionControl(row, "style").textContent, "Style…");
    assert.equal(elementsByClass(row, "raster-layer-legend").length, 0);
  }
});

test("neutral classified legends render as compact layer disclosures", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const vector = {
    ...LAYERS[0],
    legend: {
      kind: "graduated",
      label: "risk score",
      entries: [
        { label: "≤ 1", color: "#f7fbff" },
        { label: "> 1", color: "#08306b" },
      ],
    },
  };

  view.render([vector], null);
  const row = doc.querySelector("#raster-layer-list").children[0];
  const legend = elementsByClass(row, "map-layer-legend")[0];
  const swatches = elementsByClass(legend, "map-layer-legend-swatch");

  assert.equal(legend.tagName, "DETAILS");
  assert.equal(elementsByClass(legend, "map-layer-legend-field")[0].textContent, "risk score");
  assert.equal(swatches.length, 2);
  assert.equal(swatches[0].style.backgroundColor, "#f7fbff");
});

test("row actions forward stable identity; Escape closes actions before the workspace", () => {
  const doc = new FakeLayerStackDocument();
  const view = new MapLayerStackView(doc);
  const received = [];
  view.bind({
    onStyle: key => received.push(["style", key]),
    onVisibility: (key, visible) => received.push(["visibility", key, visible]),
    onMove: (key, direction) => received.push(["move", key, direction]),
    onRemove: key => received.push(["remove", key]),
  });
  view.render(LAYERS, null);
  const [first, second, third] = doc.querySelector("#raster-layer-list").children;
  actionControl(first, "style").dispatchEvent(new Event("click"));
  const visibility = actionControl(first, "visibility");
  visibility.checked = false;
  visibility.dispatchEvent(new Event("change"));
  actionControl(second, "move-up").dispatchEvent(new Event("click"));
  actionControl(third, "remove").dispatchEvent(new Event("click"));
  assert.deepEqual(received, [
    ["style", "temperature"], ["visibility", "temperature", false],
    ["move", "vegetation", "up"], ["remove", "moisture"],
  ]);
  const actions = elementsByClass(first, "raster-layer-actions")[0];
  actions.open = true;
  const escape = new Event("keydown", { cancelable: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  actions.dispatchEvent(escape);
  assert.equal(actions.open, false);
  assert.equal(doc.activeElement, actionControl(first, "actions"));
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.cancelBubble, true);
  assert.equal(doc.querySelector("#raster-layer-stack").hidden, false);
  view.unbind();
  actionControl(third, "remove").dispatchEvent(new Event("click"));
  assert.equal(received.length, 4);
});

test("the layer list leaves Escape to its owning workspace", () => {
  const documentContext = new FakeLayerStackDocument();
  const view = new MapLayerStackView(documentContext);
  view.bind({
    onStyle() {},
    onVisibility() {},
    onMove() {},
    onRemove() {},
  });
  view.render([LAYERS[0]], LAYERS[0].key);
  const root = documentContext.querySelector("#raster-layer-stack");
  const list = documentContext.querySelector("#raster-layer-list");
  const rows = [...list.children];
  const escapeEvent = new Event("keydown", { cancelable: true });
  Object.defineProperty(escapeEvent, "key", { value: "Escape" });

  root.dispatchEvent(escapeEvent);

  assert.equal(escapeEvent.defaultPrevented, false);
  assert.equal(escapeEvent.cancelBubble, false);
  assert.equal(root.hidden, false);
  assert.equal(root.classList.contains("is-collapsed"), false);
  assert.deepEqual(list.children, rows);
  view.unbind();
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
  assert.equal(documentContext.activeElement.dataset.layerAction, "actions");

  view.render(
    [LAYERS[0], LAYERS[1]],
    "vegetation",
    { key: "vegetation", action: "move-up" },
  );
  assert.equal(documentContext.activeElement.dataset.layerKey, "vegetation");
  assert.equal(documentContext.activeElement.dataset.layerAction, "actions");

  view.render(
    [LAYERS[1], LAYERS[0]],
    "vegetation",
    { key: "vegetation", action: "move-up" },
  );
  assert.equal(documentContext.activeElement.dataset.layerKey, "vegetation");
  assert.equal(documentContext.activeElement.dataset.layerAction, "actions");

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
    "",
  );
});
