/** Saved visitor choices and their effective availability in the browser. */

/**
 * @typedef {Object} VisitorControlChoices
 * @property {boolean} inspectAndSelect Allow inspection and selection tools as a group.
 * @property {boolean} rasterValues Allow raster-value picking.
 * @property {boolean} featurePicking Allow vector and drawing feature picking.
 * @property {boolean} histogramBox Allow drawing or placing a histogram sampling box.
 * @property {boolean} lasso Allow freehand feature selection.
 * @property {boolean} workspacePanels Allow workspace panels as a group.
 * @property {boolean} catalog Allow visitors to open Catalog.
 * @property {boolean} mapContents Allow visitors to open Map contents.
 * @property {boolean} styleEditing Allow visitors to change layer and chart appearance.
 * @property {boolean} runModels Allow visitors to start runs of the selected models.
 */

/** @typedef {{catalog:boolean,mapContents:boolean}} VisitorInitialPanels */

/**
 * @typedef {Object} VisitorControls
 * @property {1} version Visitor-settings schema version within saved-map v5.
 * @property {Readonly<Partial<VisitorControlChoices>>} choices Stored availability choices.
 * @property {Readonly<Partial<VisitorInitialPanels>>} [initialPanels] Initial disclosure,
 * independent of availability. Missing entries in an explicit configuration are collapsed.
 * @property {readonly string[]} [modelIds] Recipe identifiers selected by the publisher,
 * including unavailable models and choices retained while Run models is off.
 */

export const VISITOR_CONTROLS_VERSION = 1;

/** Stable capability identifiers and the ancestors that can disable them. */
export const VISITOR_CONTROL_PARENTS = Object.freeze({
    inspectAndSelect: null,
    rasterValues: "inspectAndSelect",
    featurePicking: "inspectAndSelect",
    histogramBox: "inspectAndSelect",
    lasso: "inspectAndSelect",
    workspacePanels: null,
    catalog: "workspacePanels",
    mapContents: "workspacePanels",
    styleEditing: null,
    runModels: null,
});

/**
 * Return the choices to show in the publishing form, including checked children of a disabled parent.
 * Maps without settings and new forms start with styling, inspection and Map contents available,
 * and Catalog unavailable, preserving the earlier published-viewer profile.
 * A missing choice in an explicit configuration is off until the author enables it.
 * @param {Readonly<VisitorControls>} [settings] Validated choices from one saved map.
 * @return {Readonly<VisitorControlChoices>} Stored choices expanded for the current viewer.
 */
export function visitorControlChoices(settings) {
    return Object.freeze(Object.fromEntries(Object.keys(VISITOR_CONTROL_PARENTS).map(id =>
        [id, settings === undefined ? id !== "catalog" : settings.choices[id] === true]
    )));
}

/**
 * Resolve which visitor capabilities may be used without changing any stored choices.
 * A capability has to be enabled along with every ancestor. Pan is always available.
 * @param {Readonly<VisitorControls>} [settings] Validated choices from one saved map.
 * @return {Readonly<VisitorControlChoices & {allowedModelIds:readonly string[]|null}>}
 * Effective controls and recipe IDs for new runs. A map without settings offers all
 * installed models (null). An explicit profile offers only the selected IDs.
 */
export function resolveVisitorControls(settings) {
    const choices = visitorControlChoices(settings);
    const available = Object.fromEntries(Object.keys(VISITOR_CONTROL_PARENTS).map(id => {
        let ancestor = id;
        while (ancestor !== null && choices[ancestor]) ancestor = VISITOR_CONTROL_PARENTS[ancestor];
        return [id, ancestor === null];
    }));
    const selectedIds = available.runModels ? settings?.modelIds ?? [] : [];
    return Object.freeze({ ...available, allowedModelIds: settings === undefined ? null : selectedIds });
}

/**
 * Return initial panel disclosures without applying availability or browser preferences.
 * Unconfigured maps open Map contents. Explicit settings collapse omitted entries.
 * @param {Readonly<VisitorControls>} [settings] Validated settings from one saved map.
 * @return {Readonly<VisitorInitialPanels>} Initial open choices, including unavailable panels.
 */
export function visitorInitialPanels(settings) {
    return Object.freeze({
        catalog: settings?.initialPanels?.catalog === true,
        mapContents: settings === undefined || settings.initialPanels?.mapContents === true,
    });
}
