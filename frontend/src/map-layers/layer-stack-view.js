/**
 * Accessible DOM presentation for the retained map-layer stack.
 *
 * This adapter renders top-first keyed rows and forwards activation,
 * visibility, opacity, ordering, and removal intent. It does not publish
 * datasets, enforce state invariants, or manipulate Leaflet layers.
 */
import { MAX_VISIBLE_MAP_LAYERS } from "./layer-stack.js";

/**
 * Resolve one required stack element.
 *
 * @param {Document} documentContext Application document.
 * @param {string} selector Required selector.
 * @return {Element} Matching element.
 * @throws {Error} If the markup violates the stack view contract.
 */
function requireLayerStackElement(documentContext, selector) {
    const element = documentContext.querySelector(selector);
    if (element === null) {
        throw new Error(`Required map layer-stack element is missing: ${selector}`);
    }
    return element;
}

/**
 * @typedef {Object} MapLayerStackViewHandlers
 * @property {(key: string) => void} onActivate Activate one retained layer.
 * @property {(key: string, visible: boolean) => void} onVisibility Change
 * map visibility.
 * @property {(key: string, opacity: number) => void} onOpacity Change
 * ordinary-overlay opacity.
 * @property {(key: string, direction: "up"|"down") => void} onMove Move one
 * layer in top-first order.
 * @property {(key: string) => void} onRemove Remove one retained layer.
 */

/** Own the map layer-list elements and their direct event listeners. */
export class MapLayerStackView {
    /**
     * Resolve the fixed layer-stack markup.
     *
     * @param {Document} [documentContext=globalThis.document] Application
     * document.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.root = requireLayerStackElement(
            documentContext,
            "#raster-layer-stack"
        );
        this.list = requireLayerStackElement(
            documentContext,
            "#raster-layer-list"
        );
        this.status = requireLayerStackElement(
            documentContext,
            "#raster-layer-stack-status"
        );
        this.limit = requireLayerStackElement(
            documentContext,
            "#raster-layer-stack-limit"
        );
        this.body = requireLayerStackElement(
            documentContext,
            "#raster-layer-stack-body"
        );
        this.toggle = requireLayerStackElement(
            documentContext,
            "#toggle-map-layer-widget"
        );
        this.count = requireLayerStackElement(
            documentContext,
            "#raster-layer-widget-count"
        );
        /** @type {MapLayerStackViewHandlers|null} */
        this.handlers = null;
        this.boundToggle = this.#handleToggle.bind(this);
        this.boundKeydown = this.#handleKeydown.bind(this);
    }

    /**
     * Retain the complete interaction contract.
     *
     * @param {MapLayerStackViewHandlers} handlers Stack intent handlers.
     * @return {void}
     * @throws {Error} If listeners are already bound.
     */
    bind(handlers) {
        if (this.handlers !== null) {
            throw new Error("Map layer-stack view is already bound");
        }
        this.handlers = handlers;
        this.toggle.addEventListener("click", this.boundToggle);
        this.root.addEventListener("keydown", this.boundKeydown);
    }

    /**
     * Stop forwarding intent after viewer destruction.
     *
     * @return {void}
     */
    unbind() {
        this.toggle.removeEventListener("click", this.boundToggle);
        this.root.removeEventListener("keydown", this.boundKeydown);
        this.handlers = null;
    }

    /**
     * Render all retained rows from topmost to bottommost.
     *
     * @param {Array<Object>} layers Layer presentation snapshots.
     * @param {string|null} activeKey Active layer key.
     * @param {{key:string,action:string}|null} [requestedFocus=null] Optional
     * focus target after a reorder or removal.
     * @return {void}
     */
    render(layers, activeKey, requestedFocus = null) {
        const wasEmpty = this.root.hidden;
        const retainedFocus = requestedFocus ?? this.#readFocusedAction();
        const visibleCount = layers.filter((layer) => layer.visible).length;
        const focusTargets = new Map();
        const rows = layers.map((layer, index) => this.#buildRow(
            layer,
            index,
            layers.length,
            visibleCount,
            activeKey,
            focusTargets
        ));
        this.list.replaceChildren(...rows);
        this.root.hidden = layers.length === 0;
        this.toggle.hidden = layers.length === 0;
        this.count.textContent = String(layers.length);
        if (layers.length > 0 && wasEmpty) {
            this.#setExpanded(true);
        }
        this.limit.textContent = visibleCount >= MAX_VISIBLE_MAP_LAYERS
            ? "Two layers are visible. Hide one before showing another."
            : "";
        if (retainedFocus !== null) {
            let focusTarget = focusTargets.get(
                `${retainedFocus.key}\u0000${retainedFocus.action}`
            );
            if (focusTarget?.disabled) {
                const fallbackAction = retainedFocus.action === "move-up"
                    ? "move-down"
                    : retainedFocus.action === "move-down"
                        ? "move-up"
                        : "activate";
                focusTarget = focusTargets.get(
                    `${retainedFocus.key}\u0000${fallbackAction}`
                );
            }
            if (focusTarget === undefined && layers.length === 0) {
                focusTarget = this.status;
            }
            focusTarget?.focus();
        }
    }

    /**
     * Replace the polite stack announcement.
     *
     * @param {string} message User-facing state change or error.
     * @return {void}
     */
    setStatus(message) {
        this.status.textContent = message;
    }

    /**
     * Construct one semantic list row and register its focusable controls.
     *
     * @param {Object} layer Layer presentation snapshot.
     * @param {number} index Top-first row index.
     * @param {number} layerCount Total retained layers.
     * @param {number} visibleCount Current visible count.
     * @param {string|null} activeKey Active layer key.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @return {HTMLLIElement} Complete accessible row.
     */
    #buildRow(
        layer,
        index,
        layerCount,
        visibleCount,
        activeKey,
        focusTargets
    ) {
        const itemIdentity = `${layer.item.collection} / ${layer.item.id}`;
        const accessibleName = `${layer.label}; Catalog Item ${itemIdentity}`;
        const row = this.documentContext.createElement("li");
        row.className = "raster-layer-row";
        row.classList.toggle("has-fixed-legend", layer.legend.kind === "fixed");
        row.classList.toggle("is-active", layer.key === activeKey);
        row.classList.toggle("is-hidden", !layer.visible);
        row.setAttribute("aria-label", accessibleName);

        const heading = this.documentContext.createElement("div");
        heading.className = "raster-layer-heading";

        const activeInput = this.documentContext.createElement("input");
        activeInput.type = "radio";
        activeInput.name = "active-map-layer";
        activeInput.checked = layer.key === activeKey;
        activeInput.dataset.layerKey = layer.key;
        activeInput.dataset.layerAction = "activate";
        activeInput.setAttribute(
            "aria-label",
            `${layer.legend.kind === "fixed" ? "Select" : "Edit"} ${accessibleName}`
        );
        activeInput.addEventListener("change", () => {
            if (activeInput.checked) {
                this.handlers?.onActivate(layer.key);
            }
        });
        this.#rememberFocusTarget(focusTargets, activeInput);

        const nameBlock = this.documentContext.createElement("span");
        nameBlock.className = "raster-layer-name-block";
        const name = this.documentContext.createElement("span");
        name.className = "raster-layer-name";
        name.textContent = layer.label;
        name.title = layer.label;
        const identity = this.documentContext.createElement("span");
        identity.className = "raster-layer-identity";
        identity.textContent = itemIdentity;
        identity.title = itemIdentity;
        nameBlock.append(name, identity);

        const state = this.documentContext.createElement("span");
        state.className = "raster-layer-state";
        state.textContent = layer.visible ? "Visible" : "Hidden";

        const removeButton = this.#button(
            "Remove",
            `Remove ${accessibleName}`,
            layer.key,
            "remove",
            () => this.handlers?.onRemove(layer.key),
            focusTargets
        );
        heading.append(activeInput, nameBlock, state, removeButton);

        const presentation = this.documentContext.createElement("div");
        presentation.className = "raster-layer-presentation";

        const visibilityLabel = this.documentContext.createElement("label");
        visibilityLabel.className = "raster-layer-visibility";
        const visibilityInput = this.documentContext.createElement("input");
        visibilityInput.type = "checkbox";
        visibilityInput.checked = layer.visible;
        visibilityInput.disabled =
            !layer.visible && visibleCount >= MAX_VISIBLE_MAP_LAYERS;
        visibilityInput.dataset.layerKey = layer.key;
        visibilityInput.dataset.layerAction = "visibility";
        visibilityInput.setAttribute(
            "aria-label",
            `${accessibleName} visible`
        );
        visibilityInput.setAttribute("aria-describedby", "raster-layer-stack-limit");
        visibilityInput.addEventListener("change", () => {
            this.handlers?.onVisibility(layer.key, visibilityInput.checked);
        });
        this.#rememberFocusTarget(focusTargets, visibilityInput);
        visibilityLabel.append(
            visibilityInput,
            this.documentContext.createTextNode(" Visible")
        );

        const opacityLabel = this.documentContext.createElement("label");
        opacityLabel.className = "raster-layer-opacity";
        const opacityText = this.documentContext.createElement("span");
        opacityText.textContent = "Opacity";
        const opacityInput = this.documentContext.createElement("input");
        opacityInput.type = "range";
        opacityInput.id = `raster-layer-opacity-${index}`;
        opacityInput.min = "0";
        opacityInput.max = "100";
        opacityInput.step = "1";
        const displayedOpacity = layer.effectiveOpacity ?? layer.opacity;
        opacityInput.value = String(Math.round(displayedOpacity * 100));
        opacityInput.disabled = layer.opacityLocked === true;
        opacityInput.dataset.layerKey = layer.key;
        opacityInput.dataset.layerAction = "opacity";
        opacityInput.setAttribute(
            "aria-label",
            layer.opacityLocked === true
                ? `${accessibleName} opacity locked for bivariate mode`
                : `${accessibleName} opacity`
        );
        opacityInput.setAttribute(
            "aria-valuetext",
            `${opacityInput.value} percent`
        );
        const opacityOutput = this.documentContext.createElement("output");
        opacityOutput.setAttribute("for", opacityInput.id);
        opacityOutput.value = `${opacityInput.value}%`;
        opacityOutput.textContent = `${opacityInput.value}%`;
        opacityInput.addEventListener("input", () => {
            opacityOutput.value = `${opacityInput.value}%`;
            opacityOutput.textContent = opacityOutput.value;
            opacityInput.setAttribute(
                "aria-valuetext",
                `${opacityInput.value} percent`
            );
            this.handlers?.onOpacity(
                layer.key,
                Number(opacityInput.value) / 100
            );
        });
        this.#rememberFocusTarget(focusTargets, opacityInput);
        opacityLabel.append(opacityText, opacityInput, opacityOutput);

        const order = this.documentContext.createElement("div");
        order.className = "raster-layer-order";
        const upButton = this.#button(
            "Up",
            `Move ${accessibleName} up`,
            layer.key,
            "move-up",
            () => this.handlers?.onMove(layer.key, "up"),
            focusTargets
        );
        upButton.disabled = index === 0;
        const downButton = this.#button(
            "Down",
            `Move ${accessibleName} down`,
            layer.key,
            "move-down",
            () => this.handlers?.onMove(layer.key, "down"),
            focusTargets
        );
        downButton.disabled = index === layerCount - 1;
        order.append(upButton, downButton);
        presentation.append(visibilityLabel, opacityLabel, order);

        const { legend, labels } = layer.legend.kind === "fixed"
            ? this.#buildFixedLegend(layer, accessibleName)
            : this.#buildGradientLegend(layer, accessibleName);

        const error = this.documentContext.createElement("p");
        error.className = "raster-layer-error";
        error.textContent = layer.error ?? "";
        error.hidden = !layer.error;

        row.append(heading, presentation, legend, labels, error);
        return row;
    }

    /**
     * Build one feature-owned gradient legend and numeric labels.
     *
     * @param {Object} layer Map-layer presentation snapshot.
     * @param {string} accessibleName Complete layer accessible name.
     * @return {{legend:HTMLDivElement,labels:HTMLDivElement}} Legend elements.
     */
    #buildGradientLegend(layer, accessibleName) {
        const legend = this.documentContext.createElement("div");
        legend.className = "raster-layer-legend";
        legend.setAttribute("role", "img");
        legend.style.background = layer.legend.gradient;
        legend.setAttribute(
            "aria-label",
            `${accessibleName}. ${layer.legend.description}`
        );
        const labels = this.documentContext.createElement("div");
        labels.className = "raster-layer-legend-labels";
        labels.setAttribute("aria-hidden", "true");
        for (const value of layer.legend.labels) {
            const label = this.documentContext.createElement("span");
            label.textContent = String(value);
            labels.append(label);
        }
        return { legend, labels };
    }

    /**
     * Build one feature-owned fixed swatch without raster style controls.
     *
     * @param {Object} layer Fixed-style layer presentation snapshot.
     * @param {string} accessibleName Complete layer accessible name.
     * @return {{legend:HTMLDivElement,labels:HTMLDivElement}} Legend elements.
     */
    #buildFixedLegend(layer, accessibleName) {
        const { label, fill, stroke } = layer.legend;
        const legend = this.documentContext.createElement("div");
        legend.className = "raster-layer-legend";
        legend.setAttribute("role", "img");
        legend.style.background = fill;
        legend.style.borderColor = stroke;
        legend.setAttribute(
            "aria-label",
            `${accessibleName}. Default ${label.toLowerCase()} symbology.`
        );
        const labels = this.documentContext.createElement("div");
        labels.className = "raster-layer-legend-labels";
        labels.textContent = `${label} features · fixed default style`;
        return { legend, labels };
    }

    /**
     * Create one named stack action button.
     *
     * @param {string} text Visible short label.
     * @param {string} accessibleName Full accessible name.
     * @param {string} key Stable layer key.
     * @param {string} action Stable focus action.
     * @param {() => void} callback Intent callback.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @return {HTMLButtonElement} Configured button.
     */
    #button(text, accessibleName, key, action, callback, focusTargets) {
        const button = this.documentContext.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = text;
        button.setAttribute("aria-label", accessibleName);
        button.dataset.layerKey = key;
        button.dataset.layerAction = action;
        button.addEventListener("click", callback);
        this.#rememberFocusTarget(focusTargets, button);
        return button;
    }

    /**
     * Register a rendered control by stable layer/action identity.
     *
     * @param {Map<string,Element>} targets Rendered focus targets.
     * @param {Element} element Focusable stack control.
     * @return {void}
     */
    #rememberFocusTarget(targets, element) {
        targets.set(
            `${element.dataset.layerKey}\u0000${element.dataset.layerAction}`,
            element
        );
    }

    /**
     * Read a stack control's stable focus identity before rebuilding rows.
     *
     * @return {{key:string,action:string}|null} Current stack focus or null.
     */
    #readFocusedAction() {
        const activeElement = this.documentContext.activeElement;
        const key = activeElement?.dataset?.layerKey;
        const action = activeElement?.dataset?.layerAction;
        return typeof key === "string" && typeof action === "string"
            ? { key, action }
            : null;
    }

    /**
     * Apply sidebar layer-section disclosure without changing retained layers.
     *
     * @param {boolean} isExpanded Whether layer controls are displayed.
     * @return {void}
     */
    #setExpanded(isExpanded) {
        this.body.hidden = !isExpanded;
        this.root.classList.toggle("is-collapsed", !isExpanded);
        this.toggle.setAttribute("aria-expanded", String(isExpanded));
        this.toggle.setAttribute(
            "aria-label",
            isExpanded ? "Hide layers" : "Show layers"
        );
    }

    /** Toggle the sidebar layer section. @return {void} */
    #handleToggle() {
        this.#setExpanded(
            this.toggle.getAttribute("aria-expanded") !== "true"
        );
    }

    /**
     * Collapse only the sidebar layer section when Escape originates within it.
     *
     * @param {KeyboardEvent} event Widget keyboard event.
     * @return {void}
     */
    #handleKeydown(event) {
        if (
            event.key !== "Escape" ||
            this.toggle.getAttribute("aria-expanded") !== "true"
        ) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.#setExpanded(false);
        this.toggle.focus();
    }
}
