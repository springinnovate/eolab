/** A retained row as it was drawn. The descriptor and date belong to this specific Leaflet layer.
 * @typedef {{layer:Object,descriptor:Object,observation:{variable:string,time:string,intervalStart?:string}|null}} MapFrame
 */

/** A frame reported to the timeline. An outside-viewport frame has finished without drawing tiles here.
 * @typedef {MapFrame & {outsideViewport?:boolean}} ViewportFrame
 */

/** Show a ready raster in the outgoing grid's position at its configured opacity.
 * In Chromium, removing the drawn grid while its replacement is elsewhere in
 * the pane can expose the basemap for one paint. Position the replacement while
 * it is still hidden so translucent tiles never paint over the previous date.
 * Only already-loaded tiles skip Leaflet's fade, so tiles fetched by a pan still fade in.
 * @param {{getContainer:()=>HTMLElement}} layer Attached incoming Leaflet tile grid.
 * @param {{getContainer:()=>HTMLElement}} [previousLayer] Drawn grid about to be removed from the same pane.
 * @return {void}
 */
export function revealLoadedRasterFrame(layer, previousLayer) {
    const container = layer.getContainer();
    if (previousLayer) container.parentNode.insertBefore(container, previousLayer.getContainer());
    for (const tile of container.querySelectorAll(".leaflet-tile-loaded")) tile.classList.add("map-raster-frame-tile");
    container.hidden = false;
}
