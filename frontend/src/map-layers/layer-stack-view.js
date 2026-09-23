/**
 * Accessible DOM presentation for the retained map-layer stack.
 *
 * This adapter renders top-first keyed rows and forwards visibility,
 * styling, ordering, and removal intent. It does not publish
 * datasets, enforce state invariants, or manipulate Leaflet layers.
 */

/**
 * @typedef {Object} LegendSymbol
 * @property {"polygon"|"line"|"point"} shape Geometry represented by the key.
 * @property {string|null} fill Fill color; null for lines.
 * @property {number} fillOpacity Fill opacity before whole-layer opacity.
 * @property {string} stroke Outline or line color.
 * @property {number} strokeOpacity Stroke opacity before whole-layer opacity.
 * @property {number} strokeWidth Stroke width in pixels.
 * @property {number|null} [pointSize] Point diameter in pixels.
 *
 * @typedef {Object} LayerLegend
 * @property {"fixed"|"gradient"|"categories"|"graduated"} kind Legend presentation.
 * @property {string} [label] Geometry name, classified field, or raster context.
 * @property {LegendSymbol} [symbol] Fixed symbol.
 * @property {{label:string,symbol:LegendSymbol}[]} [entries] Class labels and their symbols.
 * @property {string} [gradient] CSS color ramp supplied by the raster owner.
 * @property {number[]} [labels] Minimum, midpoint, and maximum raster values.
 * @property {string} [description] Accessible description of a raster ramp.
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
 * @property {(key: string) => void} [onFilter] Open an adapter-supported filter editor.
 * @property {(key: string) => void} [onDownload] Review a raster clip through composition.
 * @property {(key: string) => void} onZoom Fit the map to one retained layer.
 * @property {(key: string) => void} onInfo Open one retained layer's Catalog
 * Item details.
 * @property {(key: string) => void} onCopyStyle Copy one retained layer style.
 * @property {(key: string) => void} onPasteStyle Paste onto one retained layer.
 * @property {(key: string, visible: boolean) => void} onVisibility Change
 * map visibility.
 * @property {(visible: boolean) => void} onAllVisibility Show or hide every
 * retained layer.
 * @property {(key: string, targetIndex: number) => void} onReorder Move one
 * layer to a zero-based top-first position.
 * @property {(order:"name-ascending"|"name-descending"|"visible-first"|"layer-type")=>void} onSort Sort the drawing stack once.
 * @property {(key: string) => void} onRemove Remove one retained layer.
 * @property {()=>void} onUndoRemove Restore the most recently removed layer.
 * @property {()=>void} onDismissRemoval Forget the layer-removal Undo offer.
 */

/** Own the map layer-list elements and their direct event listeners. */
export class MapLayerStackView {
    /**
     * Resolve the fixed layer-stack markup.
     *
     * @param {Document} [documentContext=globalThis.document] Application
     * document.
     * @param {Object} [options] Layer-list presentation options.
     * @param {boolean} [options.allowRemoval=true] Offer removal and its Undo control.
     */
    constructor(documentContext = globalThis.document, { allowRemoval = true } = {}) {
        this.allowRemoval = allowRemoval;
        this.documentContext = documentContext;
        this.filterIndicators = [
            "#map-filter-indicators", "#map-inspection-filter-indicators",
        ].map((selector) => documentContext.querySelector(selector)).filter(Boolean);
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
        this.counts = requireLayerStackElement(
            documentContext,
            "#map-layer-counts"
        );
        this.showAll = requireLayerStackElement(documentContext, "#map-layers-show-all");
        this.hideAll = requireLayerStackElement(documentContext, "#map-layers-hide-all");
        this.showAll.addEventListener("click", () => this.handlers?.onAllVisibility(true));
        this.hideAll.addEventListener("click", () => this.handlers?.onAllVisibility(false));
        this.sort = requireLayerStackElement(documentContext, "#map-layers-sort");
        this.sort.addEventListener("change", () => {
            const order = this.sort.value;
            this.sort.value = "";
            if (order) this.handlers?.onSort(order);
        });
        this.removalNotice = requireLayerStackElement(documentContext, "#map-layer-removal");
        this.removalMessage = requireLayerStackElement(documentContext, "#map-layer-removal-message");
        this.undoRemove = requireLayerStackElement(documentContext, "#undo-layer-removal");
        this.undoRemove.addEventListener("click", () => this.handlers?.onUndoRemove());
        this.removalError = requireLayerStackElement(documentContext, "#map-layer-removal-error");
        this.dismissRemoval = requireLayerStackElement(documentContext, "#dismiss-layer-removal");
        this.dismissRemoval.addEventListener("click", () => this.handlers?.onDismissRemoval());
        this.removalIndex = 0;
        this.scrollContainer = this.root.parentElement ?? this.list;
        /** @type {MapLayerStackViewHandlers|null} */
        this.handlers = null;
        /** @type {{key:string,sourceIndex:number,targetIndex:number,pointerId:number}|null} */
        this.pointerDrag = null;
        /** @type {{key:string,originIndex:number}|null} */
        this.keyboardDrag = null;
        /** @type {Map<string,HTMLDetailsElement>} Last rendered legends, retaining disclosure state. */
        this.legends = new Map();
    }

    /**
     * Show a compact Undo row in the removed layer's drawing position, including when it was the last layer.
     * @param {{label:string,index:number}|null} removal Removed name and top-first position, or null to dismiss.
     * @param {boolean} busy Whether restoration is in progress.
     * @param {string|null} error Failure explanation; Undo remains available to retry.
     * @return {void}
     */
    showRemoval(removal, busy, error) {
        this.removalNotice.hidden = !this.allowRemoval || removal === null;
        this.removalIndex = removal?.index ?? 0;
        this.undoRemove.disabled = busy;
        this.undoRemove.textContent = busy ? "Restoring…" : "Undo";
        this.removalMessage.textContent = removal === null ? "" : `Removed ${removal.label}`;
        this.removalMessage.title = this.removalMessage.textContent;
        this.removalError.textContent = error === null ? "" : `Could not restore: ${error}`;
        this.removalError.hidden = error === null;
        this.#placeRemovalRow();
    }

    /**
     * Place the Undo row among real layer rows without counting it as a layer or rebuilding their controls.
     * @return {void}
     */
    #placeRemovalRow() {
        const layers = [...this.list.children].filter(row => row !== this.removalNotice);
        if (this.removalNotice.hidden) this.removalNotice.remove();
        else this.list.insertBefore(this.removalNotice, layers[Math.min(this.removalIndex, layers.length)] ?? null);
        this.root.hidden = layers.length === 0 && this.removalNotice.hidden;
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
        this.legends.clear();
    }

    /**
     * Render all retained rows from topmost to bottommost.
     *
     * @param {Array<Object>} layers Layer snapshots. Optional detailsControl replaces Info with a retained owner-supplied HTMLElement; primaryControl supplies a retained main action, attribution describes provenance above the title, typeLabel describes origin and stylePanelId identifies the owning style panel.
     * @param {string|null} activeKey Active layer key.
     * @param {{key:string,action:string}|null} [requestedFocus=null] Optional
     * focus target after a reorder or removal.
     * @return {void}
     */
    render(layers, activeKey, requestedFocus = null) {
        const retainedKeys = new Set(layers.map(layer => layer.key));
        for (const key of this.legends.keys()) {
            if (!retainedKeys.has(key)) this.legends.delete(key);
        }
        this.#renderVisibilityActions(layers);
        this.sort.disabled = layers.length < 2;
        this.#renderCounts(layers);
        this.#renderFilters(layers);
        if (
            this.keyboardDrag !== null &&
            !layers.some((layer) => layer.key === this.keyboardDrag.key)
        ) {
            this.keyboardDrag = null;
        }
        const focusedControl = this.documentContext.activeElement;
        const retainRemovalFocus = !this.removalNotice.hidden && [this.undoRemove, this.dismissRemoval].includes(focusedControl);
        const retainLocalFocus = !requestedFocus && layers.some(layer => layer.controls?.contains(focusedControl) || layer.primaryControl?.contains(focusedControl) || layer.detailsControl === focusedControl);
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
        this.#placeRemovalRow();
        if (retainRemovalFocus && !requestedFocus) focusedControl.focus({ preventScroll: true });
        else if (retainLocalFocus) focusedControl.focus({ preventScroll: true });
        else if (retainedFocus !== null) {
            let focusTarget = focusTargets.get(
                `${retainedFocus.key}\u0000${retainedFocus.action}`
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
     * Disable actions with no changes to make and retain keyboard focus nearby.
     *
     * @param {Array<{visible:boolean}>} layers Current retained-layer snapshots.
     * @return {void}
     */
    #renderVisibilityActions(layers) {
        const focused = this.documentContext.activeElement;
        this.showAll.disabled = !layers.some((layer) => !layer.visible);
        this.hideAll.disabled = !layers.some((layer) => layer.visible);
        if (focused === this.showAll && this.showAll.disabled && !this.hideAll.disabled) {
            this.hideAll.focus();
        } else if (focused === this.hideAll && this.hideAll.disabled && !this.showAll.disabled) {
            this.showAll.focus();
        }
    }

    /**
     * Replace the polite stack announcement.
     *
     * @param {string} message User-facing state change or error.
     * @return {void}
     */
    setStatus(message) {
        this.status.classList.remove("visually-hidden");
        this.status.textContent = message;
    }

    /**
     * Describe every retained layer, including hidden layers, in the heading.
     *
     * @param {Array<{datasetKind:"raster"|"vector"}>} layers Current layer
     * presentation snapshots supplied by their owning adapters.
     * @return {void}
     */
    #renderCounts(layers) {
        const parts = ["raster", "vector", "annotation"].flatMap((kind) => {
            const count = layers.filter((layer) => layer.datasetKind === kind).length;
            return count === 0 ? [] : [`${count} ${kind}${count === 1 ? "" : "s"}`];
        });
        this.counts.textContent = `· ${parts.length === 0 ? "Empty" : parts.join(" · ")}`;
    }

    /**
     * Show active-filter summaries in the map and dock presentation slots.
     * @param {Object[]} layers Neutral retained-layer presentation snapshots.
     * @return {void}
     */
    #renderFilters(layers) {
        const active = layers.filter((layer) => layer.visible && layer.filterActive);
        for (const container of this.filterIndicators) {
            const buttons = active.map((layer) => {
                const button = this.documentContext.createElement("button");
                button.type = "button";
                button.className = "secondary-button map-filter-indicator";
                button.textContent = `${layer.label} · ${layer.filterStatus} · Filter`;
                button.title = `Edit filter for ${layer.label}. Counts cover the whole layer.`;
                button.addEventListener("click", () => this.handlers?.onFilter?.(layer.key));
                return button;
            });
            container.replaceChildren(...buttons);
            container.hidden = buttons.length === 0;
        }
    }

    /**
     * Announce a successful state change without retaining visible text.
     *
     * @param {string} message Polite assistive-technology announcement.
     * @return {void}
     */
    announceStatus(message) {
        this.status.classList.add("visually-hidden");
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
        const typeLabel = layer.typeLabel ?? ({ raster: "Raster", vector: "Vector", annotation: "Annotation" }[layer.datasetKind] ?? "Layer");
        const accessibleName = layer.item === null
            ? `${layer.label}; ${typeLabel.toLowerCase()} layer`
            : `${layer.label}; Catalog Item ${layer.item.collection} / ${layer.item.id}`;
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
        label.append(visibility);
        const key = this.#buildLegendKey(layer.legend, layer.effectiveOpacity ?? layer.opacity);
        if (key) label.append(key);
        const title = this.documentContext.createElement("span");
        title.className = "map-layer-title";
        title.append(name);
        label.append(title);
        if (layer.roleBadge !== null && layer.roleBadge !== undefined) {
            const roleBadge = this.documentContext.createElement("span");
            roleBadge.className = "map-layer-role-badge";
            roleBadge.textContent = layer.roleBadge.label;
            roleBadge.title = layer.roleBadge.description;
            roleBadge.setAttribute("aria-label", layer.roleBadge.description);
            label.append(roleBadge);
        }
        const primary = this.documentContext.createElement("div");
        primary.className = "map-layer-primary-row";
        const type = this.documentContext.createElement("span");
        type.className = "map-layer-type";
        type.textContent = typeLabel;
        title.append(type);
        primary.append(label);
        const style = this.#button(
            "Style", `Style ${accessibleName}`, layer.key, "style",
            () => this.handlers?.onStyle(layer.key), focusTargets
        );
        if (layer.stylePanelId) style.setAttribute("aria-controls", layer.stylePanelId);
        else if (!layer.controls) {
            style.setAttribute("aria-haspopup", "dialog");
            style.setAttribute("aria-controls", "layer-style-editor");
        }
        const zoom = this.#button(
            "Zoom to", `Zoom to ${accessibleName}`, layer.key, "zoom",
            () => this.handlers?.onZoom(layer.key), focusTargets
        );
        zoom.title = `Zoom to ${layer.label}`;
        const info = layer.detailsControl ? null : this.#button(
            "Info", `View details for ${accessibleName}`, layer.key, "info",
            () => this.handlers?.onInfo(layer.key), focusTargets
        );
        if (info) info.title = `View details for ${layer.label}`;
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
        if (this.allowRemoval) {
            const remove = this.#button(
                "×",
                `Remove from map: ${accessibleName}`,
                layer.key,
                "remove",
                () => this.handlers?.onRemove(layer.key),
                focusTargets
            );
            remove.classList.add("map-layer-remove-button");
            remove.title = `Remove from map: ${layer.label}`;
            primary.append(remove);
        }
        const rowActions = this.documentContext.createElement("div");
        rowActions.className = "map-layer-row-actions";
        const filterActions = layer.canFilter ? [this.#button(
            layer.filterActive ? "Filter ●" : "Filter", `Filter ${accessibleName}`,
            layer.key, "filter", () => this.handlers?.onFilter?.(layer.key), focusTargets,
        )] : [];
        // Local editors supply their own Edit/Details action instead of the catalog Info action.
        rowActions.append(
            ...(layer.detailsControl ? [layer.detailsControl] : []),
            style,
            ...filterActions,
            ...(layer.datasetKind === "raster" ? [this.#button(
                "Download clip", `Download clip of ${accessibleName}`, layer.key,
                "download", () => this.handlers?.onDownload?.(layer.key), focusTargets,
            ), this.#button(
                "Summarize", "Summarize " + accessibleName, layer.key,
                "calculate", () => this.handlers?.onCalculate?.(layer.key), focusTargets,
            )] : []),
            zoom,
            ...(!layer.detailsControl ? [info] : []),
            copyStyle,
            pasteStyle
        );
        row.append(reorder);
        if (layer.attribution) {
            const attribution = this.documentContext.createElement("p");
            attribution.className = "map-layer-attribution";
            attribution.textContent = layer.attribution;
            row.append(attribution);
        }
        row.append(primary);
        if (layer.primaryControl) row.append(layer.primaryControl);
        row.append(rowActions);
        if (layer.filterStatus) {
            const filterStatus = this.#button(
                layer.filterStatus, `Edit filter for ${accessibleName}: ${layer.filterStatus}`,
                layer.key, "filter-status", () => this.handlers?.onFilter?.(layer.key), focusTargets,
            );
            filterStatus.classList.add("map-layer-filter-status");
            row.append(filterStatus);
        }
        const legend = this.#buildLegend(layer, focusTargets);
        if (legend !== null) row.append(legend);
        if (layer.controls) row.append(layer.controls);
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
        const rows = [...this.list.children].filter(row => row !== this.removalNotice);
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
     * Draw the compact color key beside a layer's name, including fixed styles.
     * Class keys include every class color; full symbols and labels are in Legend.
     * @param {LayerLegend|null} legend Adapter-owned appearance.
     * @param {number} opacity Effective whole-layer opacity.
     * @return {HTMLSpanElement|null} Visible key, or null when the adapter has no legend.
     */
    #buildLegendKey(legend, opacity) {
        if (!legend) return null;
        const key = this.documentContext.createElement("span");
        key.className = "map-layer-color-key";
        key.setAttribute("role", "img");
        if (legend.kind === "gradient") {
            key.append(this.#buildGradient(legend, opacity));
        } else if (legend.entries?.length) {
            key.append(this.#buildClassColorStrip(legend.entries, opacity));
        } else if (legend.symbol) {
            key.append(this.#buildSymbol(legend.symbol, opacity));
        }
        if (!key.childElementCount) return null;
        const description = legend.description ?? (legend.entries
            ? `${legend.label}: ${legend.entries.length} ${legend.entries.length === 1 ? "class" : "classes"}. Expand Legend for all values.`
            : `${legend.label}: fill ${legend.symbol?.fill ?? "none"}, outline ${legend.symbol?.stroke}.`);
        key.title = description;
        key.setAttribute("aria-label", description);
        return key;
    }

    /**
     * Show every class color in order, dividing the compact strip into equal parts.
     * Use stroke colors for lines and fill colors for polygons and points.
     * @param {{label:string,symbol:LegendSymbol}[]} entries All classified legend entries.
     * @param {number} opacity Effective whole-layer opacity, from zero through one.
     * @return {HTMLSpanElement} Decorative palette; full symbols remain in the expanded legend.
     */
    #buildClassColorStrip(entries, opacity) {
        const strip = this.documentContext.createElement("span");
        strip.className = "map-layer-legend-palette";
        strip.setAttribute("aria-hidden", "true");
        for (const { symbol } of entries) {
            const swatch = this.documentContext.createElement("span");
            const isLine = symbol.shape === "line";
            swatch.style.backgroundColor = isLine ? symbol.stroke : symbol.fill;
            swatch.style.opacity = String((isLine ? symbol.strokeOpacity : symbol.fillOpacity) * opacity);
            strip.append(swatch);
        }
        return strip;
    }

    /**
     * Draw a representative polygon, line, or point using its fill and stroke settings.
     * Large strokes and points are scaled to fit the compact key.
     * @param {LegendSymbol} symbol Adapter-supplied geometry appearance.
     * @param {number} opacity Effective layer opacity, from zero through one.
     * @return {SVGElement} Decorative symbol with independent fill and stroke opacity.
     */
    #buildSymbol(symbol, opacity) {
        const svg = this.documentContext.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 28 22");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        const tag = symbol.shape === "point" ? "circle" : symbol.shape === "line" ? "path" : "rect";
        const shape = this.documentContext.createElementNS("http://www.w3.org/2000/svg", tag);
        const dimensions = tag === "circle" ? { cx: 14, cy: 11, r: Math.min(symbol.pointSize / 2, 8) }
            : tag === "path" ? { d: "M 3 17 L 11 6 L 18 15 L 25 5" }
            : { x: 4, y: 4, width: 20, height: 14, rx: 1 };
        for (const [name, value] of Object.entries(dimensions)) shape.setAttribute(name, String(value));
        shape.setAttribute("fill", symbol.fill ?? "none");
        shape.setAttribute("fill-opacity", String(symbol.fillOpacity * opacity));
        shape.setAttribute("stroke", symbol.stroke);
        shape.setAttribute("stroke-opacity", String(symbol.strokeOpacity * opacity));
        shape.setAttribute("stroke-width", String(Math.min(symbol.strokeWidth, 6)));
        shape.setAttribute("stroke-linecap", "round");
        shape.setAttribute("stroke-linejoin", "round");
        svg.append(shape);
        return svg;
    }

    /**
     * Draw the raster owner's color ramp over a transparency checkerboard.
     * @param {LayerLegend} legend Raster gradient and text alternative.
     * @param {number} opacity Effective layer opacity.
     * @return {HTMLSpanElement} Decorative gradient strip.
     */
    #buildGradient(legend, opacity) {
        const background = this.documentContext.createElement("span");
        background.className = "map-layer-legend-gradient";
        background.setAttribute("aria-hidden", "true");
        const ramp = this.documentContext.createElement("span");
        ramp.style.background = legend.gradient;
        ramp.style.opacity = String(opacity);
        background.append(ramp);
        return background;
    }

    /**
     * Build an expandable class list or raster range; fixed symbols need no extra row.
     *
     * @param {Object} layer Layer identity, legend and effective opacity.
     * @param {Map<string,Element>} focusTargets Controls retained across style updates.
     * @return {HTMLDetailsElement|null} Legend details, preserving open state and keyboard focus.
     */
    #buildLegend(layer, focusTargets) {
        const legend = layer.legend;
        const opacity = layer.effectiveOpacity ?? layer.opacity;
        if (legend?.kind !== "gradient" && !legend?.entries?.length) {
            this.legends.delete(layer.key);
            return null;
        }
        const details = this.documentContext.createElement("details");
        details.className = "map-layer-legend";
        details.open = this.legends.get(layer.key)?.open ?? false;
        this.legends.set(layer.key, details);
        const summary = this.documentContext.createElement("summary");
        summary.textContent = "Legend";
        summary.dataset.layerKey = layer.key;
        summary.dataset.layerAction = "legend";
        summary.setAttribute("aria-label", `Legend for ${layer.label}`);
        this.#rememberFocusTarget(focusTargets, summary);
        const field = this.documentContext.createElement("span");
        field.className = "map-layer-legend-field";
        field.textContent = typeof legend.label === "string" ? legend.label : "";
        details.append(summary, field);
        if (legend.kind === "gradient") {
            const ramp = this.#buildGradient(legend, opacity);
            ramp.title = legend.description;
            const labels = this.documentContext.createElement("div");
            labels.className = "map-layer-legend-values";
            for (const [index, value] of legend.labels.entries()) {
                const text = this.documentContext.createElement("span");
                const caption = this.documentContext.createElement("span");
                caption.className = "map-layer-legend-value-label";
                caption.textContent = ["Minimum", "Midpoint", "Maximum"][index];
                const number = this.documentContext.createElement("span");
                number.textContent = String(value);
                text.append(caption, number);
                labels.append(text);
            }
            details.append(ramp, labels);
            return details;
        }
        const list = this.documentContext.createElement("ul");
        list.className = "map-layer-legend-list";
        for (const entry of legend.entries) {
            const item = this.documentContext.createElement("li");
            const swatch = this.documentContext.createElement("span");
            swatch.className = "map-layer-legend-swatch";
            swatch.append(this.#buildSymbol(entry.symbol, opacity));
            swatch.setAttribute("aria-hidden", "true");
            const text = this.documentContext.createElement("span");
            text.textContent = entry.label;
            item.append(swatch, text);
            list.append(item);
        }
        details.append(list);
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
