/** Project Catalog map-action state into the inspector's existing controls. */

import { formatCatalogVisualizationReason } from "./catalog.js";

/**
 * Update inspector controls without replacing nodes or repeating live messages.
 *
 * The caller supplies the currently selected Item and its action state. This
 * view owns no selection, publication, map membership, or event listeners.
 * @param {Object} elements Existing inspector DOM controls.
 * @param {HTMLElement} elements.container Map-action group with busy state.
 * @param {HTMLButtonElement} elements.toggle Add/Remove control.
 * @param {HTMLButtonElement} elements.style Style shortcut.
 * @param {HTMLButtonElement} elements.zoom Zoom shortcut.
 * @param {HTMLElement} elements.onMap Retained-membership indicator.
 * @param {HTMLElement} elements.actionStatus Accessible action feedback.
 * @param {HTMLElement} elements.layerStatus Rendering assessment and membership explanation.
 * @param {Object|null} item Currently selected Catalog Item.
 * @param {import("./catalog-map-actions.js").CatalogMapActionState} state Current per-Item action state.
 * @return {void}
 */
export function renderCatalogMapAction(elements, item, state) {
    const { visualization, supported, retained, canZoom, pendingAction, feedback } = state;
    const isTemporal = visualization?.metadata?.temporal === true;
    elements.container.hidden = !supported;
    elements.container.setAttribute("aria-busy", String(pendingAction !== null));
    elements.toggle.disabled = pendingAction !== null;
    elements.toggle.hidden = false;
    elements.style.hidden = !retained;
    elements.style.disabled = pendingAction !== null;
    elements.zoom.hidden = !retained;
    elements.zoom.disabled = pendingAction !== null || !canZoom;
    elements.zoom.title = canZoom ? "Zoom to this item's bounding box."
        : "Zoom unavailable: this item has no usable bounding box.";
    const actionStatus = pendingAction?.statusText ?? feedback?.message ?? "";
    if (elements.actionStatus.textContent !== actionStatus) {
        elements.actionStatus.textContent = actionStatus;
    }
    elements.onMap.hidden = !retained;
    elements.toggle.classList.toggle("catalog-add-action", !retained);
    elements.toggle.textContent = pendingAction?.buttonText ?? (
        retained ? isTemporal ? "Remove first view" : "Remove from map" : "Add to map"
    );
    elements.layerStatus.textContent = [
        formatCatalogVisualizationReason(item, visualization?.metadata?.reason),
        retained
            ? isTemporal
                ? "The first view of this dataset is on the map."
                : visualization?.kind === "vector"
                ? "This vector is on the map."
                : "This raster is on the map."
            : "",
        isTemporal ? "Add another view using this dataset's controls in Map layers." : "",
    ].filter((message) => message !== "").join(" ");
}
