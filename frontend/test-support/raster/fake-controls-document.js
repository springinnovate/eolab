/** Minimal DOM element used by focused raster-control adapter tests. */
export class FakeRasterControlElement extends EventTarget {
    /**
     * Create an element with mutable DOM-like presentation state.
     *
     * @param {string} [type=""] Input type exposed to event handlers.
     */
    constructor(type = "", ownerDocument = null) {
        super();
        this.ownerDocument = ownerDocument;
        this.type = type;
        this.value = "";
        this.textContent = "";
        this.hidden = false;
        this.disabled = false;
        this.title = "";
        this.style = {};
        this.children = [];
        this.attributes = new Map();
        this.classNames = [];
        this.scrollRequests = [];
        this.classList = {
            add: (className) => {
                if (!this.classNames.includes(className)) {
                    this.classNames.push(className);
                }
            },
            contains: (className) => this.classNames.includes(className),
            remove: (className) => {
                this.classNames = this.classNames.filter(
                    (candidate) => candidate !== className
                );
            },
        };
    }

    /**
     * Append child elements.
     *
     * @param {...FakeRasterControlElement} children Elements to append.
     * @return {void}
     */
    append(...children) {
        this.children.push(...children);
    }

    /**
     * Check ownership for focus-scoped keyboard interactions.
     * @param {FakeRasterControlElement|null} element Candidate descendant.
     * @return {boolean} Whether this element owns the candidate.
     */
    contains(element) {
        return element === this || this.children.some(child => child.contains(element));
    }

    /**
     * Replace all child elements.
     *
     * @param {...FakeRasterControlElement} children Replacement elements.
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
     * Remove one element attribute.
     *
     * @param {string} name Attribute name.
     * @return {void}
     */
    removeAttribute(name) {
        this.attributes.delete(name);
    }

    /**
     * Return one element attribute.
     *
     * @param {string} name Attribute name.
     * @return {string|null} Attribute value or null when absent.
     */
    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    /**
     * Return deterministic control dimensions.
     *
     * @return {{width: number, height: number}} Element dimensions.
     */
    getBoundingClientRect() {
        return { width: 120, height: 48 };
    }

    /** Give this control focus in its fake document. @return {void} */
    focus() {
        if (this.ownerDocument !== null) {
            this.ownerDocument.activeElement = this;
        }
    }

    /**
     * Retain a requested scroll presentation for focused view assertions.
     *
     * @param {{block?: string, inline?: string}} options Scroll alignment.
     * @return {void}
     */
    scrollIntoView(options) {
        this.scrollRequests.push(options);
    }
}

/** Minimal selector and element factory used by focused adapter tests. */
export class FakeRasterControlDocument {
    /** Create an empty document-backed selector registry. */
    constructor() {
        this.activeElement = null;
        this.elements = new Map();
    }

    /**
     * Resolve or create one fake element for a raster selector.
     *
     * @param {string} selector CSS selector.
     * @return {FakeRasterControlElement} Stable fake element.
     */
    querySelector(selector) {
        if (!this.elements.has(selector)) {
            const isPercentileInput = [
                "#raster-lower-percentile",
                "#raster-middle-percentile",
                "#raster-upper-percentile",
            ].includes(selector);
            const type = selector.endsWith("-color")
                ? "color"
                : isPercentileInput || selector.endsWith("-range")
                    ? "range"
                    : selector.includes("minimum") ||
                        selector.includes("midpoint") ||
                        selector.includes("maximum") ||
                        selector.endsWith("-number")
                        ? "number"
                        : "";
            this.elements.set(
                selector,
                new FakeRasterControlElement(type, this)
            );
        }
        return this.elements.get(selector);
    }

    /**
     * Create one fake HTML element.
     *
     * @return {FakeRasterControlElement} New fake element.
     */
    createElement() {
        return new FakeRasterControlElement("", this);
    }

    /**
     * Create one fake SVG element.
     *
     * @return {FakeRasterControlElement} New fake SVG element.
     */
    createElementNS() {
        return new FakeRasterControlElement("", this);
    }
}
