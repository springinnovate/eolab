/** Geometry of a freehand lasso in the map container's pixel coordinates. */

/** @typedef {{x:number,y:number}} MapPixel */

/**
 * Find where the movement first touches one previously drawn edge.
 * @param {MapPixel} start Last sampled pointer position.
 * @param {MapPixel} end Distinct new pointer position.
 * @param {MapPixel} a Start of the drawn edge.
 * @param {MapPixel} b End of the drawn edge.
 * @return {{fraction:number,point:MapPixel}|null} Contact and fraction along
 *     the movement, or null for disjoint segments. A shared span starts at
 *     the first point reached along the movement.
 */
function firstEdgeContact(start, end, a, b) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const edgeX = b.x - a.x, edgeY = b.y - a.y;
    const offsetX = a.x - start.x, offsetY = a.y - start.y;
    const determinant = dx * edgeY - dy * edgeX;
    const offsetCrossMovement = offsetX * dy - offsetY * dx;
    if (determinant === 0) {
        if (offsetCrossMovement !== 0) return null;
        // Measure along the dominant axis of the collinear movement.
        const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        const travel = end[axis] - start[axis];
        const fromA = (a[axis] - start[axis]) / travel;
        const fromB = (b[axis] - start[axis]) / travel;
        const entry = Math.min(fromA, fromB);
        if (entry > 1 || Math.max(fromA, fromB) < 0) return null;
        if (entry < 0) return {fraction:0, point:start};
        return {fraction:entry, point:fromA <= fromB ? a : b};
    }
    const fraction = (offsetX * edgeY - offsetY * edgeX) / determinant;
    const alongEdge = offsetCrossMovement / determinant;
    if (fraction < 0 || fraction > 1 || alongEdge < 0 || alongEdge > 1) return null;
    if (alongEdge === 0) return {fraction, point:a};
    if (alongEdge === 1) return {fraction, point:b};
    return {fraction, point:{x:start.x + fraction * dx, y:start.y + fraction * dy}};
}

/**
 * Return the loop completed by the pointer's first contact with its own stroke.
 * @param {MapPixel[]} points Sampled stroke in drawing order, ending at the start of the movement.
 * @param {MapPixel} end Next pointer position.
 * @return {MapPixel[]|null} Loop vertices starting at the contact, with no
 *     repeated closing vertex, or null if no nonadjacent edge was touched.
 */
export function findLassoLoop(points, end) {
    const start = points.at(-1);
    if (points.length < 3 || (start.x === end.x && start.y === end.y)) return null;
    let nearest = null;
    let firstVertex = 0;
    for (let i = 0; i < points.length - 2; i++) {
        const contact = firstEdgeContact(start, end, points[i], points[i + 1]);
        if (contact && (!nearest || contact.fraction < nearest.fraction)) {
            nearest = contact;
            firstVertex = contact.point === points[i + 1] ? i + 2 : i + 1;
        }
    }
    return nearest ? [nearest.point, ...points.slice(firstVertex)] : null;
}

/**
 * Check whether closing the drawn loop encloses any map area.
 * @param {MapPixel[]} points Loop vertices without the repeated closing vertex.
 * @return {boolean} True for a ring with nonzero signed area.
 */
export function lassoEnclosesArea(points) {
    let twiceArea = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1], origin = points[0];
        twiceArea += (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
    }
    return twiceArea !== 0;
}
