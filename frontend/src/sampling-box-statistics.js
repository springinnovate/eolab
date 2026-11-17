/** @typedef {"mean"|"stdev"|{percentAbove:number}} BoxStatistic */
/** @typedef {{method:"exact"|"estimated"|"unavailable",values:{value:number|null,unit:string|null}[]}} SamplingBoxPreview */

/** Read one raster and box for a group of selected statistics.
 * @callback ReadSamplingBoxPreview
 * @param {Object} source Original raster identity.
 * @param {Object} box Validated sampling box.
 * @param {BoxStatistic[]} statistics Descriptors in result order.
 * @param {AbortSignal} signal Cancel when the selected inputs change.
 * @return {Promise<SamplingBoxPreview>} Measurements from a shared window.
 */

/**
 * Describe a built-in box statistic and its equivalent exact Processing formula.
 * The descriptor identifies the calculation even when the user renames its row.
 * @param {unknown} preview Statistic from a preset, threshold editor or saved session.
 * @return {{label:string,expression:string,preview:BoxStatistic,unit?:string}|null} Formula, default name and any unit independent of the source band, or null for an unsupported descriptor.
 */
export function samplingBoxFormula(preview) {
    if (preview === "mean") return {label: "Mean", expression: "mean(a)", preview};
    if (preview === "stdev") return {label: "Standard deviation", expression: "stdev(a)", preview};
    if (preview && typeof preview === "object" && Object.keys(preview).length === 1 && Number.isFinite(preview.percentAbove)) {
        const threshold = preview.percentAbove;
        return {label: `Percent above ${threshold}`, expression: `100 * count(a > ${threshold}) / count(a)`, preview, unit: "%"};
    }
    return null;
}
