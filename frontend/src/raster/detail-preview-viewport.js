/** Pure viewport contracts for zoom-adaptive sampled raster detail. */

/**
 * Intersect one Leaflet map rectangle with a canonical raster extent.
 *
 * Leaflet can report wrapped longitude copies outside the canonical world.
 * The rectangle is shifted as one unit around its center before intersection;
 * antimeridian-crossing views cannot be represented by the backend's strict
 * non-wrapping rectangle and therefore return null.
 *
 * @param {Object} mapBounds Leaflet bounds exposing west/south/east/north.
 * @param {number[]} rasterExtent Canonical west, south, east, north extent.
 * @return {{west:number,south:number,east:number,north:number}|null} Positive
 * canonical intersection, or null when the current view cannot refine it.
 */
export function intersectRasterViewport(mapBounds, rasterExtent) {
    let west = Number(mapBounds.getWest());
    let south = Number(mapBounds.getSouth());
    let east = Number(mapBounds.getEast());
    let north = Number(mapBounds.getNorth());
    if (![west, south, east, north].every(Number.isFinite) || west >= east) {
        return null;
    }
    if (east - west >= 360) {
        west = -180;
        east = 180;
    } else {
        const center = (west + east) / 2;
        const worldShift = 360 * Math.floor((center + 180) / 360);
        west -= worldShift;
        east -= worldShift;
        if (west < -180 || east > 180) {
            return null;
        }
    }
    south = Math.max(-90, south);
    north = Math.min(90, north);
    const intersection = {
        west: Math.max(west, rasterExtent[0]),
        south: Math.max(south, rasterExtent[1]),
        east: Math.min(east, rasterExtent[2]),
        north: Math.min(north, rasterExtent[3])
    };
    return intersection.west < intersection.east &&
        intersection.south < intersection.north
        ? intersection
        : null;
}

/**
 * Return whether one map scale is at least one level finer than the base.
 *
 * @param {number} currentZoom Current Leaflet zoom.
 * @param {number} baseZoom Zoom at which the raster extent was initially fit.
 * @return {boolean} Whether current-view refinement should be requested.
 */
export function isRasterDetailZoom(currentZoom, baseZoom) {
    return Number.isFinite(currentZoom) && Number.isFinite(baseZoom) &&
        currentZoom >= baseZoom + 1;
}

/**
 * Encode exact canonical bounds for duplicate and stale-intent detection.
 *
 * @param {{west:number,south:number,east:number,north:number}} bounds Current
 * raster/view intersection.
 * @return {string} Stable exact rectangle identity.
 */
export function rasterViewportKey(bounds) {
    return JSON.stringify([
        bounds.west,
        bounds.south,
        bounds.east,
        bounds.north
    ]);
}
