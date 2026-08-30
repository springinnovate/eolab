/** Compact Catalog result rows with independent map and details actions. */

/**
 * Create one stable row; state updates never replace its focused controls.
 *
 * @param {Object} options Row identity, presentation, and interaction boundaries.
 * @param {Object} options.item Catalog Item represented by the row.
 * @param {Object} options.presentation Filename and source/layer context.
 * @param {string} options.id Unique DOM ID prefix for this result instance.
 * @param {Function} options.onDetails Open only this Item's inspector.
 * @param {Function} options.onMapAction Add/remove this Item without navigation.
 * @param {Function} options.onPreview Preview the Item footprint.
 * @param {Function} options.onClearPreview Clear the transient footprint.
 * @param {Document} [options.documentContext=document] Owning document.
 * @return {Object} Row element, details control, Item, and state renderer.
 */
export function createCatalogResultView({
    item, presentation, id, onDetails, onMapAction, onPreview, onClearPreview,
    documentContext = document,
}) {
    const element = documentContext.createElement("div");
    element.className = "catalog-result";
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", presentation.fullTitle);

    const title = documentContext.createElement("strong");
    title.className = "catalog-result-name";
    title.textContent = presentation.filename;
    title.title = presentation.fullTitle;
    element.append(title);
    if (presentation.context !== null) {
        const context = documentContext.createElement("span");
        context.className = "catalog-result-context";
        context.textContent = presentation.context;
        element.append(context);
    }
    if (presentation.datasetType !== null) {
        const type = documentContext.createElement("small");
        type.className = "catalog-result-type";
        type.textContent = presentation.datasetType;
        element.append(type);
    }

    const actions = documentContext.createElement("div");
    actions.className = "catalog-result-actions";
    const onMap = documentContext.createElement("span");
    onMap.className = "catalog-on-map catalog-result-on-map";
    onMap.hidden = true;
    onMap.title = "This Item is on the map, even when its layer is hidden.";
    const checkmark = documentContext.createElement("span");
    checkmark.setAttribute("aria-hidden", "true");
    checkmark.textContent = "✓";
    const onMapLabel = documentContext.createElement("span");
    onMapLabel.textContent = "On map";
    onMap.append(checkmark, onMapLabel);

    const mapButton = documentContext.createElement("button");
    mapButton.className = "secondary-button catalog-result-map-action";
    mapButton.type = "button";
    mapButton.setAttribute("aria-describedby", `${id}-status`);
    mapButton.addEventListener("click", () => onMapAction(item));

    const detailsButton = documentContext.createElement("button");
    detailsButton.className = "catalog-result-details";
    detailsButton.type = "button";
    detailsButton.textContent = "More details";
    detailsButton.setAttribute("aria-label", presentation.accessibleLabel);
    detailsButton.setAttribute("aria-controls", "catalog-item-inspector");
    detailsButton.setAttribute("aria-pressed", "false");
    detailsButton.addEventListener("click", () => onDetails(item, detailsButton));
    actions.append(onMap, mapButton, detailsButton);

    const status = documentContext.createElement("p");
    status.id = `${id}-status`;
    status.className = "catalog-result-status visually-hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    element.append(actions, status);

    element.addEventListener("pointerenter", () => onPreview(item));
    element.addEventListener("pointerleave", onClearPreview);
    element.addEventListener("focusin", () => onPreview(item));
    element.addEventListener("focusout", (event) => {
        if (!element.contains(event.relatedTarget)) onClearPreview();
    });

    return {
        item, element, detailsButton,
        /**
         * Mirror this Item's state without selecting it or moving focus.
         *
         * @param {Object} state Supported kind, membership, pending action,
         * and optional {message,isError} feedback for this Item only.
         * @return {void}
         */
        update({ supported, retained, pendingAction, feedback }) {
            onMap.hidden = !retained;
            mapButton.hidden = !supported;
            mapButton.disabled = pendingAction !== null;
            mapButton.classList.toggle("is-retained", retained);
            mapButton.setAttribute("aria-busy", String(pendingAction !== null));
            mapButton.textContent = pendingAction !== null
                ? pendingAction.buttonText.startsWith("Adding")
                    ? "Adding..." : pendingAction.buttonText
                : retained ? "Remove" : "Add to map";
            const actionLabel = pendingAction !== null
                ? pendingAction.buttonText
                : retained ? "Remove from map" : "Add to map";
            mapButton.setAttribute("aria-label", `${actionLabel}: ${presentation.fullTitle}`);
            const message = pendingAction?.statusText ?? feedback?.message ?? "";
            status.classList.toggle("visually-hidden", pendingAction !== null || feedback?.isError !== true);
            if (status.textContent !== message) status.textContent = message;
        },
    };
}
