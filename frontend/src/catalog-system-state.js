/**
 * Catalog system-state disclosure presentation helpers.
 *
 * The native disclosure owns keyboard and open/close behavior. This module
 * only applies connection state and mirrors changed labels into the dedicated
 * live region so the interactive summary does not also act as a status region.
 */

const CATALOG_STATE_CLASSES = ["is-connected", "is-warning"];

/**
 * Elements updated when the Catalog connection state changes.
 *
 * @typedef {Object} CatalogSystemStateElements
 * @property {HTMLElement} disclosure Catalog details element.
 * @property {HTMLElement} stateText Visible Catalog summary label.
 * @property {HTMLElement} stateAnnouncement Polite live-status region.
 */

/**
 * Applies one Catalog connection state to its disclosure and live region.
 *
 * @param {CatalogSystemStateElements} elements Catalog state elements.
 * @param {string} statusText Complete visible and announced Catalog label.
 * @param {string|null} [stateClass=null] Optional visual state class.
 * @return {void}
 */
export function applyCatalogSystemState(
    elements,
    statusText,
    stateClass = null
) {
    const previousStatusText = elements.stateText.textContent;
    elements.disclosure.classList.remove(...CATALOG_STATE_CLASSES);
    if (stateClass !== null) {
        elements.disclosure.classList.add(stateClass);
    }
    elements.stateText.textContent = statusText;
    if (previousStatusText !== statusText) {
        elements.stateAnnouncement.textContent = statusText;
    }
}

/**
 * Disclosures coordinated when the configured-source scan state changes.
 *
 * @typedef {Object} ScanDisclosureElements
 * @property {HTMLDetailsElement} catalogState Outer Catalog state disclosure.
 * @property {HTMLDetailsElement} scanStatus Nested scan-status disclosure.
 */

/**
 * Reveals a newly running scan without overriding later user choices.
 *
 * @param {ScanDisclosureElements} elements Catalog and scan disclosures.
 * @param {boolean} isRunning Whether the current scan is running.
 * @param {boolean} wasRunning Whether the prior rendered scan was running.
 * @return {void}
 */
export function synchronizeScanDisclosureState(
    elements,
    isRunning,
    wasRunning
) {
    if (isRunning === wasRunning) {
        return;
    }

    elements.scanStatus.open = isRunning;
    if (isRunning) {
        elements.catalogState.open = true;
    }
}

/**
 * Renders the configured user-facing scan sources.
 *
 * @param {HTMLElement} listElement List that owns the scan locations.
 * @param {string[]} scanDisplayPaths User-facing directories scanned recursively.
 * @return {void}
 */
export function renderScanLocations(listElement, scanDisplayPaths) {
    const locationElements = scanDisplayPaths.map((scanDisplayPath) => {
        const locationElement = listElement.ownerDocument.createElement("li");
        locationElement.textContent = scanDisplayPath;
        return locationElement;
    });
    listElement.replaceChildren(...locationElements);
}
