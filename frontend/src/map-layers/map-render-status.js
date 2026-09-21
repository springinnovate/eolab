/** Compact map-layer loading feedback and recovery, separate from analysis. */

/**
 * Add a status control above the map's zoom buttons.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Leaflet map.
 * @param {()=>void} retry Retry failed current tiles or plan preparation.
 * @return {{update:(status:import('./composite-leaflet-renderer.js').MapTileStatus)=>void,remove:()=>void}} Presentation lifecycle.
 */
export function addMapRenderStatus(leaflet, map, retry) {
    const control = leaflet.control({ position: "bottomleft" });
    const doc = map.getContainer().ownerDocument;
    const root = doc.createElement("div");
    root.className = "map-render-status";
    root.hidden = true;
    const message = doc.createElement("span");
    message.setAttribute("role", "status");
    message.setAttribute("aria-atomic", "true");
    const button = doc.createElement("button");
    button.type = "button";
    button.hidden = true;
    root.append(message, button);
    button.addEventListener("click", retry);
    leaflet.DomEvent.disableClickPropagation(root);
    leaflet.DomEvent.disableScrollPropagation(root);
    root.addEventListener("keydown", stopMapKeys);
    /** Return the already-created control DOM. @return {HTMLElement} Status control. */
    control.onAdd = () => root;
    /** Release DOM listeners when Leaflet removes the control. @return {void} */
    control.onRemove = () => {
        button.removeEventListener("click", retry);
        root.removeEventListener("keydown", stopMapKeys);
    };
    control.addTo(map);
    return {
        /**
         * Display tile counts without claiming a time estimate or rendering percentage.
         * @param {import('./composite-leaflet-renderer.js').MapTileStatus} status Current viewport snapshot.
         * @return {void}
         */
        update(status) {
            const { phase, total, loaded, failed } = status;
            root.hidden = phase === "idle";
            root.setAttribute("data-phase", phase);
            const count = total ? ` · ${loaded} of ${total} visible tiles loaded` : "";
            const missing = failed ? ` · ${failed} missing` : "";
            const text = phase === "preparing" ? "Preparing map layers…"
                : phase === "error" ? `Map layers unavailable. ${status.message || "Try again."}`
                : phase === "incomplete" ? `Map layers incomplete${count}${missing}`
                : phase === "complete" ? "Map layers loaded"
                : `${phase === "retrying" ? "Retrying" : "Loading"} map layers…${count}${missing}`;
            if (message.textContent !== text) message.textContent = text;
            button.hidden = !(failed > 0 || phase === "error");
            button.textContent = phase === "error" ? "Retry map layers" : "Retry missing tiles";
        },
        /** Detach the control and its listeners. @return {void} */
        remove() { control.remove(); },
    };
}

/**
 * Keep keyboard activation inside the control from also panning the map.
 * @param {KeyboardEvent} event Control keyboard event.
 * @return {void}
 */
function stopMapKeys(event) { event.stopPropagation(); }
