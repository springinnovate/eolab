/**
 * Accessible DOM presentation for the retained map-layer stack.
 *
 * This adapter renders top-first keyed rows and forwards activation,
 * visibility, styling, ordering, and removal intent. It does not publish
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
 * @property {(key: string) => void} onStyle Open one retained layer style editor.
 * @property {(key: string, visible: boolean) => void} onVisibility Change
 * map visibility.
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
            const action = retainedFocus.action.startsWith("move-") || retainedFocus.action === "remove"
                ? "actions" : retainedFocus.action;
            let focusTarget = focusTargets.get(
                `${retainedFocus.key}\u0000${action}`
            );
            if (focusTarget?.disabled) {
                focusTarget = focusTargets.get(
                    `${retainedFocus.key}\u0000style`
                );
            }
            if (focusTarget === undefined && layers.length === 0) {
                focusTarget = this.documentContext.querySelector("#toggle-map-layers") ?? this.status;
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
        const accessibleName = `${layer.label}; Catalog Item ${layer.item.collection} / ${layer.item.id}`;
        const row = this.documentContext.createElement("li");
        row.className = "raster-layer-row";
        row.classList.toggle("is-hidden", !layer.visible);
        row.setAttribute("aria-label", accessibleName);
        const label = this.documentContext.createElement("label");
        label.className = "raster-layer-visibility";
        const visibility = this.documentContext.createElement("input");
        visibility.type = "checkbox";
        visibility.checked = layer.visible;
        visibility.disabled = !layer.visible && visibleCount >= MAX_VISIBLE_MAP_LAYERS;
        visibility.dataset.layerKey = layer.key;
        visibility.dataset.layerAction = "visibility";
        visibility.setAttribute("aria-label", `${accessibleName} visible`);
        visibility.setAttribute("aria-describedby", "raster-layer-stack-limit");
        visibility.addEventListener("change", () =>
            this.handlers?.onVisibility(layer.key, visibility.checked)
        );
        this.#rememberFocusTarget(focusTargets, visibility);
        const name = this.documentContext.createElement("span");
        name.className = "raster-layer-name";
        name.textContent = layer.label;
        name.title = accessibleName;
        label.append(visibility, name);
        const style = this.#button(
            "Style…", `Style ${accessibleName}`, layer.key, "style",
            () => this.handlers?.onStyle(layer.key), focusTargets
        );
        style.setAttribute("aria-haspopup", "dialog");
        style.setAttribute("aria-controls", "layer-style-editor");
        const actions = this.documentContext.createElement("details");
        actions.className = "raster-layer-actions";
        const toggle = this.documentContext.createElement("summary");
        toggle.textContent = "⋯";
        toggle.setAttribute("aria-label", `Actions for ${accessibleName}`);
        toggle.dataset.layerKey = layer.key;
        toggle.dataset.layerAction = "actions";
        this.#rememberFocusTarget(focusTargets, toggle);
        const menu = this.documentContext.createElement("div");
        menu.className = "raster-layer-action-list";
        for (const [text, action, disabled, callback] of [
            ["Move up", "move-up", index === 0,
                () => this.handlers?.onMove(layer.key, "up")],
            ["Move down", "move-down", index === layerCount - 1,
                () => this.handlers?.onMove(layer.key, "down")],
            ["Remove from map", "remove", false,
                () => this.handlers?.onRemove(layer.key)],
        ]) {
            const button = this.#button(
                text, `${text}: ${accessibleName}`, layer.key, action,
                () => { actions.open = false; callback(); }, focusTargets
            );
            button.disabled = disabled;
            menu.append(button);
        }
        actions.append(toggle, menu);
        actions.addEventListener("keydown", (event) => {
            if (event.key !== "Escape" || !actions.open) return;
            event.preventDefault();
            event.stopPropagation();
            actions.open = false;
            toggle.focus();
        });
        row.append(label, style, actions);
        if (layer.error) {
            const error = this.documentContext.createElement("p");
            error.className = "raster-layer-error";
            error.textContent = layer.error;
            row.append(error);
        }
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
