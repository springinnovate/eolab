/** Minimal SVG element implementation shared by raster view tests. */
export class FakeSvgElement {
  /**
   * @param {string} tagName SVG tag name represented by this fake.
   */
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.classNames = [];
    this.classList = { add: (name) => this.classNames.push(name) };
    this.style = {};
    this.textContent = "";
  }

  /**
   * Append one child node.
   *
   * @param {FakeSvgElement} child Child SVG element.
   * @return {void}
   */
  append(child) {
    this.children.push(child);
  }

  /**
   * Replace all child nodes.
   *
   * @param {...FakeSvgElement} children Replacement child elements.
   * @return {void}
   */
  replaceChildren(...children) {
    this.children = children;
  }

  /**
   * Set one serialized SVG attribute.
   *
   * @param {string} name Attribute name.
   * @param {string} value Attribute value.
   * @return {void}
   */
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  /**
   * Remove one serialized SVG attribute.
   *
   * @param {string} name Attribute name.
   * @return {void}
   */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /**
   * Test whether one SVG attribute is present.
   *
   * @param {string} name Attribute name.
   * @return {boolean} Whether the attribute is set.
   */
  hasAttribute(name) {
    return this.attributes.has(name);
  }
}

/** Minimal document implementation that creates FakeSvgElement instances. */
export const FAKE_SVG_DOCUMENT = Object.freeze({
  /**
   * Create one SVG test element.
   *
   * @param {string} _namespace SVG namespace, unused by the fake.
   * @param {string} tagName SVG tag name.
   * @return {FakeSvgElement} New fake SVG element.
   */
  createElementNS: (_namespace, tagName) => new FakeSvgElement(tagName),
});

/**
 * Build a Leaflet-compatible event map for controller tests.
 *
 * @param {{lng:number,lat:number}} [center] Initial map center.
 * @return {Object} Map fake with event and layer bookkeeping.
 */
export function createFakeLeafletMap(center = { lng: 0, lat: 0 }) {
  const handlers = new Map();
  return {
    center,
    layers: [],
    removedLayers: [],
    on(eventName, handler) {
      const eventHandlers = handlers.get(eventName) ?? new Set();
      eventHandlers.add(handler);
      handlers.set(eventName, eventHandlers);
    },
    off(eventName, handler) {
      handlers.get(eventName)?.delete(handler);
    },
    emit(eventName, event = {}) {
      for (const handler of handlers.get(eventName) ?? []) {
        handler(event);
      }
    },
    getCenter() {
      return this.center;
    },
    removeLayer(layer) {
      this.removedLayers.push(layer);
      this.layers = this.layers.filter((candidate) => candidate !== layer);
    },
    listenerCount(eventName) {
      return handlers.get(eventName)?.size ?? 0;
    },
  };
}

/**
 * Build a rectangle factory that records created preview/selection layers.
 *
 * @param {Array<Object>} createdLayers Destination for created layer fakes.
 * @return {Function} Leaflet-compatible rectangle factory.
 */
export function createFakeSampleLayerFactory(createdLayers) {
  return (bounds, kind) => {
    const layer = {
      kind,
      boundsHistory: [bounds],
      addTo(map) {
        map.layers.push(this);
        return this;
      },
      setBounds(nextBounds) {
        this.boundsHistory.push(nextBounds);
      },
    };
    createdLayers.push(layer);
    return layer;
  };
}

/**
 * Build a deterministic setTimeout clock for asynchronous controller tests.
 *
 * @return {Object} Injectable clock with explicit time advancement.
 */
export function createFakeClock() {
  return {
    time: 0,
    nextTimerId: 1,
    timers: new Map(),
    setTimeout(callback, delay) {
      const timerId = this.nextTimerId++;
      this.timers.set(timerId, { callback, at: this.time + delay });
      return timerId;
    },
    clearTimeout(timerId) {
      this.timers.delete(timerId);
    },
    advanceTo(time) {
      this.time = time;
      for (const [timerId, timer] of this.timers) {
        if (timer.at <= time) {
          this.timers.delete(timerId);
          timer.callback();
        }
      }
    },
  };
}
