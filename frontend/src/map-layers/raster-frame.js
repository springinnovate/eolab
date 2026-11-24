/** Show a loaded raster frame at its configured layer opacity on the next paint.
 * Leaflet starts loaded tile images transparent. Mark only images already in
 * this grid so tiles fetched by a later pan keep Leaflet's normal fade.
 * @param {{getContainer:()=>HTMLElement}} layer Attached Leaflet tile grid.
 * @return {void}
 */
export function revealLoadedRasterFrame(layer) {
    const container = layer.getContainer();
    for (const tile of container.querySelectorAll(".leaflet-tile-loaded")) tile.classList.add("map-raster-frame-tile");
    container.style.visibility = "";
}
