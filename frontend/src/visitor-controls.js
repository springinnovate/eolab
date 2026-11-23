/** Saved visitor choices and their effective availability in the browser. */

/**
 * @typedef {Object} VisitorControlChoices
 * @property {boolean} inspectAndSelect Allow inspection and selection tools as a group.
 * @property {boolean} rasterValues Allow raster-value picking.
 * @property {boolean} featurePicking Allow vector and drawing feature picking.
 * @property {boolean} histogramBox Allow drawing or placing a histogram sampling box.
 * @property {boolean} lasso Allow freehand feature selection.
 */

/** @typedef {{version:1,choices:Readonly<Partial<VisitorControlChoices>>}} VisitorControls */

export const VISITOR_CONTROLS_VERSION = 1;

/** Stable capability identifiers and the ancestors that can disable them. */
export const VISITOR_CONTROL_PARENTS = Object.freeze({
    inspectAndSelect: null,
    rasterValues: "inspectAndSelect",
    featurePicking: "inspectAndSelect",
    histogramBox: "inspectAndSelect",
    lasso: "inspectAndSelect",
});

/**
 * Return the choices to show in the publishing form, including checked children of a disabled parent.
 * Maps without settings and new forms start with the familiar full inspection profile.
 * A missing choice in an explicit configuration is off until the author enables it.
 * @param {Readonly<VisitorControls>} [settings] Validated choices from one saved map.
 * @return {Readonly<VisitorControlChoices>} Stored choices expanded for the current viewer.
 */
export function visitorControlChoices(settings) {
    return Object.freeze(Object.fromEntries(Object.keys(VISITOR_CONTROL_PARENTS).map(id =>
        [id, settings === undefined || settings.choices[id] === true]
    )));
}

/**
 * Resolve which inspection capabilities may be used without changing any stored choices.
 * A capability has to be enabled along with every ancestor. Pan is always available.
 * @param {Readonly<VisitorControls>} [settings] Validated choices from one saved map.
 * @return {Readonly<VisitorControlChoices>} Effective capabilities for browser composition.
 */
export function resolveVisitorControls(settings) {
    const choices = visitorControlChoices(settings);
    return Object.freeze(Object.fromEntries(Object.keys(VISITOR_CONTROL_PARENTS).map(id => {
        let ancestor = id;
        while (ancestor !== null && choices[ancestor]) ancestor = VISITOR_CONTROL_PARENTS[ancestor];
        return [id, ancestor === null];
    })));
}
