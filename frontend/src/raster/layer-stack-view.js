/**
 * Accessible DOM presentation for the retained raster layer stack.
 *
 * This adapter renders top-first keyed rows and forwards activation,
 * visibility, opacity, ordering, and removal intent. It does not publish
 * rasters, enforce state invariants, or manipulate Leaflet layers.
 */
import { MAX_VISIBLE_RASTER_LAYERS } from "./layer-stack.js";
import { buildRasterLegend } from "./style.js";

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
        throw new Error(`Required raster layer-stack element is missing: ${selector}`);
    }
    return element;
}

/**
 * @typedef {Object} RasterLayerStackViewHandlers
 * @property {(key: string) => void} onActivate Activate one retained layer.
 * @property {(key: string, visible: boolean) => void} onVisibility Change
 * map visibility.
 * @property {(key: string, opacity: number) => void} onOpacity Change
 * ordinary-overlay opacity.
 * @property {(key: string, direction: "up"|"down") => void} onMove Move one
 * layer in top-first order.
 * @property {(key: string) => void} onRemove Remove one retained layer.
 */

/** Own the raster layer-list elements and their direct event listeners. */
export class RasterLayerStackView {
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
        /** @type {RasterLayerStackViewHandlers|null} */
        this.handlers = null;
    }

    /**
     * Retain the complete interaction contract.
     *
     * @param {RasterLayerStackViewHandlers} handlers Stack intent handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
    }

    /** Stop forwarding intent after viewer destruction. */
    unbind() {
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
        this.limit.textContent = visibleCount >= MAX_VISIBLE_RASTER_LAYERS
            ? `Two raster layers are visible. Hide one before showing another.`
            : `${visibleCount} of ${MAX_VISIBLE_RASTER_LAYERS} raster layers visible.`;
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
        row.classList.toggle("is-active", layer.key === activeKey);
        row.classList.toggle("is-hidden", !layer.visible);
        row.setAttribute("aria-label", accessibleName);

        const heading = this.documentContext.createElement("div");
        heading.className = "raster-layer-heading";

        const activeInput = this.documentContext.createElement("input");
        activeInput.type = "radio";
        activeInput.name = "active-raster-layer";
        activeInput.checked = layer.key === activeKey;
        activeInput.dataset.layerKey = layer.key;
        activeInput.dataset.layerAction = "activate";
        activeInput.setAttribute("aria-label", `Edit ${accessibleName}`);
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
            !layer.visible && visibleCount >= MAX_VISIBLE_RASTER_LAYERS;
        visibilityInput.dataset.layerKey = layer.key;
        visibilityInput.dataset.layerAction = "visibility";
        visibilityInput.setAttribute(
            "aria-label",
            `${layer.visible ? "Hide" : "Show"} ${accessibleName}`
        );
        visibilityInput.setAttribute("aria-describedby", "raster-layer-stack-limit");
        visibilityInput.addEventListener("change", () => {
            this.handlers?.onVisibility(layer.key, visibilityInput.checked);
        });
        this.#rememberFocusTarget(focusTargets, visibilityInput);
        visibilityLabel.append(
            visibilityInput,
            this.documentContext.createTextNode(" Show")
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
        opacityInput.value = String(Math.round(layer.opacity * 100));
        opacityInput.dataset.layerKey = layer.key;
        opacityInput.dataset.layerAction = "opacity";
        opacityInput.setAttribute("aria-label", `${accessibleName} opacity`);
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

        const legend = this.documentContext.createElement("div");
        legend.className = "raster-layer-legend";
        legend.setAttribute("role", "img");
        const legendDefinition = buildRasterLegend(layer.style);
        legend.style.background = legendDefinition.gradient;
        legend.setAttribute(
            "aria-label",
            `${accessibleName}. ${legendDefinition.description}`
        );

        const labels = this.documentContext.createElement("div");
        labels.className = "raster-layer-legend-labels";
        labels.setAttribute("aria-hidden", "true");
        for (const value of [
            layer.style.minimum,
            layer.style.midpoint,
            layer.style.maximum,
        ]) {
            const label = this.documentContext.createElement("span");
            label.textContent = String(value);
            labels.append(label);
        }

        const error = this.documentContext.createElement("p");
        error.className = "raster-layer-error";
        error.textContent = layer.error ?? "";
        error.hidden = !layer.error;

        row.append(heading, presentation, legend, labels, error);
        return row;
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
}
