/**
 * Accessible DOM presentation for the retained map-layer stack.
 *
 * This adapter renders top-first keyed rows and forwards visibility,
 * styling, ordering, and removal intent. It does not publish
 * datasets, enforce state invariants, or manipulate Leaflet layers.
 */

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
 * @property {(key: string) => void} onCopyStyle Copy one retained layer style.
 * @property {(key: string) => void} onPasteStyle Paste onto one retained layer.
 * @property {(key: string, visible: boolean) => void} onVisibility Change
 * map visibility.
 * @property {(key: string, targetIndex: number) => void} onReorder Move one
 * layer to a zero-based top-first position.
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
        this.scrollContainer = this.root.parentElement ?? this.list;
        /** @type {MapLayerStackViewHandlers|null} */
        this.handlers = null;
        /** @type {{key:string,sourceIndex:number,targetIndex:number,pointerId:number}|null} */
        this.pointerDrag = null;
        /** @type {{key:string,originIndex:number}|null} */
        this.keyboardDrag = null;
    }

    /**
     * Retain the complete interaction contract.
     *
     * @param {MapLayerStackViewHandlers} handlers Stack intent handlers.
     * @return {void}
     * @throws {Error} If handlers are already bound.
     */
    bind(handlers) {
        if (this.handlers !== null) {
            throw new Error("Map layer-stack view is already bound");
        }
        this.handlers = handlers;
    }

    /**
     * Stop forwarding intent after viewer destruction.
     *
     * @return {void}
     */
    unbind() {
        this.pointerDrag = null;
        this.keyboardDrag = null;
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
        if (
            this.keyboardDrag !== null &&
            !layers.some((layer) => layer.key === this.keyboardDrag.key)
        ) {
            this.keyboardDrag = null;
        }
        const retainedFocus = requestedFocus ?? this.#readFocusedAction();
        const focusTargets = new Map();
        const rows = layers.map((layer, index) => this.#buildRow(
            layer,
            index,
            layers.length,
            activeKey,
            focusTargets
        ));
        this.list.replaceChildren(...rows);
        this.root.hidden = layers.length === 0;
        if (retainedFocus !== null) {
            const action = retainedFocus.action === "remove"
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
     * @param {string|null} activeKey Active layer key.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @return {HTMLLIElement} Complete accessible row.
     */
    #buildRow(
        layer,
        index,
        layerCount,
        activeKey,
        focusTargets
    ) {
        const accessibleName = `${layer.label}; Catalog Item ${layer.item.collection} / ${layer.item.id}`;
        const row = this.documentContext.createElement("li");
        row.className = "raster-layer-row";
        row.dataset.layerKey = layer.key;
        row.dataset.layerIndex = String(index);
        row.classList.toggle("is-hidden", !layer.visible);
        row.classList.toggle(
            "is-dragging",
            this.keyboardDrag?.key === layer.key
        );
        row.setAttribute("aria-label", accessibleName);
        const reorder = this.#buildReorderHandle(
            layer,
            index,
            layerCount,
            accessibleName,
            row,
            focusTargets
        );
        const label = this.documentContext.createElement("label");
        label.className = "raster-layer-visibility";
        const visibility = this.documentContext.createElement("input");
        visibility.type = "checkbox";
        visibility.checked = layer.visible;
        visibility.dataset.layerKey = layer.key;
        visibility.dataset.layerAction = "visibility";
        visibility.setAttribute("aria-label", `${accessibleName} visible`);
        visibility.addEventListener("change", () =>
            this.handlers?.onVisibility(layer.key, visibility.checked)
        );
        this.#rememberFocusTarget(focusTargets, visibility);
        const name = this.documentContext.createElement("span");
        name.className = "raster-layer-name";
        name.textContent = layer.label;
        name.title = accessibleName;
        label.append(visibility, name);
        if (layer.roleBadge !== null && layer.roleBadge !== undefined) {
            const roleBadge = this.documentContext.createElement("span");
            roleBadge.className = "map-layer-role-badge";
            roleBadge.textContent = layer.roleBadge.label;
            roleBadge.title = layer.roleBadge.description;
            roleBadge.setAttribute("aria-label", layer.roleBadge.description);
            label.append(roleBadge);
        }
        const style = this.#button(
            "Style…", `Style ${accessibleName}`, layer.key, "style",
            () => this.handlers?.onStyle(layer.key), focusTargets
        );
        style.setAttribute("aria-haspopup", "dialog");
        style.setAttribute("aria-controls", "layer-style-editor");
        const clipboard = layer.styleClipboard ?? {
            canCopy: false,
            canPaste: false,
            sourceLabel: null,
            pasteReason: "Style copy and paste is unavailable.",
        };
        const copyStyle = this.#styleIconButton(
            "copy",
            `Copy style from ${accessibleName}`,
            clipboard.canCopy
                ? `Copy style and opacity from ${layer.label}`
                : "Copying styles is unavailable for this layer.",
            layer.key,
            "copy-style",
            () => this.handlers?.onCopyStyle(layer.key),
            focusTargets,
            !clipboard.canCopy
        );
        const pasteStyle = this.#styleIconButton(
            "paste",
            `Paste copied style onto ${accessibleName}`,
            clipboard.canPaste
                ? `Paste style and opacity from ${clipboard.sourceLabel}`
                : clipboard.pasteReason,
            layer.key,
            "paste-style",
            () => this.handlers?.onPasteStyle(layer.key),
            focusTargets,
            !clipboard.canPaste
        );
        const styleActions = this.documentContext.createElement("div");
        styleActions.className = "map-layer-style-actions";
        styleActions.append(style, copyStyle, pasteStyle);
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
        const remove = this.#button(
            "Remove from map",
            `Remove from map: ${accessibleName}`,
            layer.key,
            "remove",
            () => {
                actions.open = false;
                this.handlers?.onRemove(layer.key);
            },
            focusTargets
        );
        menu.append(remove);
        actions.append(toggle, menu);
        actions.addEventListener("keydown", (event) => {
            if (event.key !== "Escape" || !actions.open) return;
            event.preventDefault();
            event.stopPropagation();
            actions.open = false;
            toggle.focus();
        });
        row.append(reorder, label, styleActions, actions);
        const legend = this.#buildLegend(layer.legend);
        if (legend !== null) row.append(legend);
        if (layer.error) {
            const error = this.documentContext.createElement("p");
            error.className = "raster-layer-error";
            error.textContent = layer.error;
            row.append(error);
        }
        return row;
    }

    /**
     * Build one pointer- and keyboard-operable layer-order grip.
     *
     * @param {Object} layer Layer presentation snapshot.
     * @param {number} index Current zero-based top-first position.
     * @param {number} layerCount Total retained layer count.
     * @param {string} accessibleName Layer and Catalog identity label.
     * @param {HTMLLIElement} row Owning rendered row.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @return {HTMLButtonElement} Reorder handle.
     */
    #buildReorderHandle(
        layer,
        index,
        layerCount,
        accessibleName,
        row,
        focusTargets
    ) {
        const handle = this.documentContext.createElement("button");
        handle.type = "button";
        handle.className = "map-layer-drag-handle";
        handle.textContent = "⠿";
        handle.title = "Drag to reorder. Keyboard: Space, arrow keys, Space.";
        handle.dataset.layerKey = layer.key;
        handle.dataset.layerAction = "reorder";
        const keyboardPickedUp = this.keyboardDrag?.key === layer.key;
        handle.setAttribute(
            "aria-label",
            `Reorder ${accessibleName}, position ${index + 1} of ` +
            `${layerCount}. ${keyboardPickedUp
                ? "Use arrow keys to move, Space to drop, or Escape to cancel."
                : "Press Space to pick up."}`
        );
        handle.setAttribute(
            "aria-pressed",
            String(keyboardPickedUp)
        );
        handle.setAttribute(
            "aria-keyshortcuts",
            "Space Enter ArrowUp ArrowDown Escape"
        );
        handle.addEventListener("pointerdown", (event) =>
            this.#startPointerDrag(event, layer.key, index, row, handle)
        );
        handle.addEventListener("pointermove", (event) =>
            this.#updatePointerDrag(event)
        );
        handle.addEventListener("pointerup", (event) =>
            this.#finishPointerDrag(event, false, handle)
        );
        handle.addEventListener("pointercancel", (event) =>
            this.#finishPointerDrag(event, true, handle)
        );
        handle.addEventListener("lostpointercapture", (event) =>
            this.#finishPointerDrag(event, true, handle)
        );
        handle.addEventListener("keydown", (event) =>
            this.#handleReorderKey(event, layer, index, layerCount, row, handle)
        );
        this.#rememberFocusTarget(focusTargets, handle);
        return handle;
    }

    /**
     * Begin one captured pointer reorder without changing domain order.
     *
     * @param {PointerEvent} event Pointer-down event.
     * @param {string} key Stable layer key.
     * @param {number} sourceIndex Initial top-first index.
     * @param {HTMLLIElement} row Owning rendered row.
     * @param {HTMLButtonElement} handle Capturing reorder handle.
     * @return {void}
     */
    #startPointerDrag(event, key, sourceIndex, row, handle) {
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        this.keyboardDrag = null;
        this.pointerDrag = {
            key,
            sourceIndex,
            targetIndex: sourceIndex,
            pointerId: event.pointerId,
        };
        row.classList.add("is-dragging");
        this.list.classList.add("is-reordering");
        handle.setAttribute("aria-pressed", "true");
        handle.setPointerCapture?.(event.pointerId);
        handle.focus();
    }

    /**
     * Update the pending destination and insertion marker for a pointer drag.
     *
     * @param {PointerEvent} event Captured pointer-move event.
     * @return {void}
     */
    #updatePointerDrag(event) {
        if (
            this.pointerDrag === null ||
            event.pointerId !== this.pointerDrag.pointerId
        ) {
            return;
        }
        event.preventDefault();
        this.#autoScroll(event.clientY);
        const rows = [...this.list.children];
        let targetIndex = rows.length - 1;
        for (let index = 0; index < rows.length; index += 1) {
            const bounds = rows[index].getBoundingClientRect();
            if (event.clientY <= bounds.bottom) {
                targetIndex = index;
                break;
            }
        }
        this.pointerDrag.targetIndex = targetIndex;
        this.#showDropTarget(
            rows,
            this.pointerDrag.sourceIndex,
            targetIndex
        );
    }

    /**
     * Complete or cancel one pointer reorder and release its capture.
     *
     * @param {PointerEvent} event Pointer completion event.
     * @param {boolean} cancelled Whether no reorder should be emitted.
     * @param {HTMLButtonElement} handle Capturing reorder handle.
     * @return {void}
     */
    #finishPointerDrag(event, cancelled, handle) {
        const drag = this.pointerDrag;
        if (drag === null || event.pointerId !== drag.pointerId) return;
        this.pointerDrag = null;
        handle.releasePointerCapture?.(event.pointerId);
        handle.setAttribute("aria-pressed", "false");
        this.#clearDragClasses();
        if (!cancelled && drag.targetIndex !== drag.sourceIndex) {
            this.handlers?.onReorder(drag.key, drag.targetIndex);
        }
    }

    /**
     * Apply accessible pickup, move, drop, and cancel keyboard semantics.
     *
     * @param {KeyboardEvent} event Reorder-handle key event.
     * @param {Object} layer Layer presentation snapshot.
     * @param {number} index Current zero-based top-first position.
     * @param {number} layerCount Total retained layer count.
     * @param {HTMLLIElement} row Owning rendered row.
     * @param {HTMLButtonElement} handle Keyboard reorder handle.
     * @return {void}
     */
    #handleReorderKey(event, layer, index, layerCount, row, handle) {
        const isToggle = event.key === " " || event.key === "Enter";
        const isActive = this.keyboardDrag?.key === layer.key;
        if (isToggle) {
            event.preventDefault();
            if (isActive) {
                this.keyboardDrag = null;
                row.classList.remove("is-dragging");
                handle.setAttribute("aria-pressed", "false");
                this.setStatus(
                    `${layer.label} dropped at position ${index + 1} of ` +
                    `${layerCount}.`
                );
            } else {
                this.keyboardDrag = { key: layer.key, originIndex: index };
                row.classList.add("is-dragging");
                handle.setAttribute("aria-pressed", "true");
                this.setStatus(
                    `${layer.label} picked up at position ${index + 1} of ` +
                    `${layerCount}. Use Up and Down arrows, then Space to drop.`
                );
            }
            return;
        }
        if (!isActive) return;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const targetIndex = Math.max(
                0,
                Math.min(
                    layerCount - 1,
                    index + (event.key === "ArrowUp" ? -1 : 1)
                )
            );
            if (targetIndex !== index) {
                this.handlers?.onReorder(layer.key, targetIndex);
            }
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            const originIndex = this.keyboardDrag.originIndex;
            this.keyboardDrag = null;
            row.classList.remove("is-dragging");
            handle.setAttribute("aria-pressed", "false");
            if (originIndex !== index) {
                this.handlers?.onReorder(layer.key, originIndex);
            }
            this.setStatus(`${layer.label} reordering cancelled.`);
        }
    }

    /**
     * Mark one prospective insertion edge without changing source order.
     *
     * @param {Element[]} rows Current top-first rendered rows.
     * @param {number} sourceIndex Original row index.
     * @param {number} targetIndex Prospective destination index.
     * @return {void}
     */
    #showDropTarget(rows, sourceIndex, targetIndex) {
        for (const row of rows) {
            row.classList.remove("is-drop-before", "is-drop-after");
        }
        if (sourceIndex === targetIndex) return;
        rows[targetIndex]?.classList.add(
            targetIndex < sourceIndex ? "is-drop-before" : "is-drop-after"
        );
    }

    /** Remove all transient pointer-drag presentation classes. @return {void} */
    #clearDragClasses() {
        this.list.classList.remove("is-reordering");
        for (const row of this.list.children) {
            row.classList.remove(
                "is-dragging",
                "is-drop-before",
                "is-drop-after"
            );
        }
    }

    /**
     * Scroll the bounded map-layer panel when a drag approaches either edge.
     *
     * @param {number} clientY Pointer viewport Y coordinate.
     * @return {void}
     */
    #autoScroll(clientY) {
        if (
            typeof this.scrollContainer.getBoundingClientRect !== "function"
        ) {
            return;
        }
        const bounds = this.scrollContainer.getBoundingClientRect();
        const edgeSize = Math.min(44, bounds.height / 4);
        let delta = 0;
        if (clientY < bounds.top + edgeSize) {
            delta = -Math.ceil((bounds.top + edgeSize - clientY) / 4);
        } else if (clientY > bounds.bottom - edgeSize) {
            delta = Math.ceil((clientY - (bounds.bottom - edgeSize)) / 4);
        }
        if (delta !== 0) this.scrollContainer.scrollTop += delta;
    }

    /**
     * Build one optional neutral multi-entry legend disclosure.
     *
     * @param {unknown} legend Adapter-owned legend snapshot.
     * @return {HTMLDetailsElement|null} Detached legend or null for fixed styles.
     */
    #buildLegend(legend) {
        if (!Array.isArray(legend?.entries) || legend.entries.length === 0) {
            return null;
        }
        const details = this.documentContext.createElement("details");
        details.className = "map-layer-legend";
        const summary = this.documentContext.createElement("summary");
        summary.textContent = "Legend";
        const field = this.documentContext.createElement("span");
        field.className = "map-layer-legend-field";
        field.textContent = typeof legend.label === "string" ? legend.label : "";
        const list = this.documentContext.createElement("ul");
        list.className = "map-layer-legend-list";
        for (const entry of legend.entries) {
            if (typeof entry?.label !== "string" || typeof entry?.color !== "string") {
                continue;
            }
            const item = this.documentContext.createElement("li");
            const swatch = this.documentContext.createElement("span");
            swatch.className = "map-layer-legend-swatch";
            swatch.style.backgroundColor = entry.color;
            swatch.setAttribute("aria-hidden", "true");
            const text = this.documentContext.createElement("span");
            text.textContent = entry.label;
            item.append(swatch, text);
            list.append(item);
        }
        if (list.childElementCount === 0) return null;
        details.append(summary, field, list);
        return details;
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
     * Create one compact icon button beside the primary Style action.
     *
     * The icon is presentation-only CSS so the accessible name and tooltip
     * remain authoritative across pointer, keyboard, and assistive use.
     *
     * @param {"copy"|"paste"} icon Clipboard action icon.
     * @param {string} accessibleName Full accessible action name.
     * @param {string} title Pointer tooltip or disabled-state explanation.
     * @param {string} key Stable layer key.
     * @param {string} action Stable focus action.
     * @param {() => void} callback Intent callback.
     * @param {Map<string,Element>} focusTargets Rendered focus targets.
     * @param {boolean} disabled Whether the action is unavailable.
     * @return {HTMLButtonElement} Configured icon button.
     */
    #styleIconButton(
        icon,
        accessibleName,
        title,
        key,
        action,
        callback,
        focusTargets,
        disabled
    ) {
        const button = this.#button(
            "", accessibleName, key, action, callback, focusTargets
        );
        button.classList.add("map-layer-style-icon-button");
        button.title = title;
        button.disabled = disabled;
        const image = this.documentContext.createElement("span");
        image.className = `map-layer-style-${icon}-icon`;
        image.setAttribute("aria-hidden", "true");
        button.append(image);
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
