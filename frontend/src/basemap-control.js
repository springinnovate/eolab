/**
 * Map-background selector. Basemaps stay below data layers and never take part
 * in catalog selection or analysis.
 */

const OUTLINES_URL = new URL("./assets/country-outlines.geojson", import.meta.url);
const ERROR_TILE_URL = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22/%3E";

/**
 * Browser-safe settings for one tiled map background.
 * @typedef {Object} BasemapTileSettings
 * @property {string} url Raster tile URL template containing the tile coordinates.
 * @property {string} attribution HTML credits shown on the map.
 * @property {number} [maxNativeZoom] Highest zoom with source tiles.
 */

/**
 * The detailed background and other tile backgrounds enabled for this site.
 * @typedef {BasemapTileSettings & {
 *   carto?: BasemapTileSettings,
 *   maptiler?: BasemapTileSettings,
 *   maptilerStreets?: BasemapTileSettings
 * }} BasemapConfiguration
 */

/**
 * Show the selected basemap in a native dropdown in the lower-right map corner.
 * The configured detailed map is selected initially. Country outlines are a
 * bundled display asset fetched only when selected; None removes the background.
 *
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Initialized Leaflet map.
 * @param {BasemapConfiguration} configuration Browser-safe tile settings.
 * @param {number[][]} bounds Canonical single-world bounds.
 * @param {typeof fetch} [fetchAsset=globalThis.fetch] Static outline asset reader.
 * @return {Object} Leaflet control with snapshot()/restore(id) for provider IDs;
 * removing it cancels loading and removes its background.
 */
export function addBasemapControl(leaflet, map, configuration, bounds, fetchAsset = globalThis.fetch) {
    const paneName = "eolab-basemap-pane";
    const pane = map.getPane(paneName) ?? map.createPane(paneName);
    pane.style.zIndex = "150";
    pane.style.pointerEvents = "none";

    const tileOptions = [
        { id: "detailed", label: "Detailed", tiles: configuration },
        { id: "maptiler-streets", label: "Street map", tiles: configuration.maptilerStreets },
        { id: "carto", label: "Light (CARTO)", tiles: configuration.carto },
        { id: "maptiler", label: "Satellite (MapTiler)", tiles: configuration.maptiler },
    ].filter(option => option.tiles);
    const options = [
        ...tileOptions,
        { id: "outlines", label: "Country outlines" },
        { id: "none", label: "None" },
    ];

    const layers = new Map();
    let activeLayer = null;
    let pending = null;
    let select, status;
    const control = leaflet.control({ position: "bottomright" });

    /**
     * Create one single-world tile background from its configured provider.
     * @param {BasemapTileSettings} settings Provider settings.
     * @return {Object} Detached Leaflet tile layer.
     */
    function tileBackground(settings) {
        return leaflet.tileLayer(settings.url, {
            attribution: settings.attribution,
            pane: paneName,
            className: "eolab-basemap",
            errorTileUrl: ERROR_TILE_URL,
            maxZoom: 22,
            maxNativeZoom: settings.maxNativeZoom ?? 17,
            noWrap: true,
            bounds,
        });
    }

    /**
     * Report failed tiles on the active MapTiler background without exposing its URL or key.
     * @return {void}
     */
    function reportMapTilerTileError() {
        const name = select.value === "maptiler" ? "Satellite" : "Street map";
        status.hidden = false;
        status.textContent = `Some ${name.toLowerCase()} tiles could not load. Choose another basemap, or select ${name} again to retry. Check the MapTiler key, allowed domains and quota if this continues.`;
    }

    /** Detach the active background and its tile error listener. @return {void} */
    function removeActiveBasemap() {
        if (!activeLayer) return;
        activeLayer.off("tileerror", reportMapTilerTileError);
        map.removeLayer(activeLayer);
        activeLayer = null;
    }

    /**
     * Replace only this control's background, preserving viewport and all data layers.
     * Cancel obsolete outline loads so late responses cannot restore an old choice.
     * @param {string} id Selected option identifier.
     * @return {Promise<void>} Settles after the background is attached or a load error is shown.
     */
    async function selectBasemap(id) {
        pending?.abort();
        pending = null;
        removeActiveBasemap();
        status.textContent = "";
        status.hidden = true;
        select.removeAttribute("aria-busy");
        if (id === "none") return;

        if (!layers.has(id)) {
            if (id === "outlines") {
                const request = new AbortController();
                pending = request;
                status.hidden = false;
                status.textContent = "Loading country outlines…";
                select.setAttribute("aria-busy", "true");
                try {
                    const response = await fetchAsset(OUTLINES_URL, { signal: request.signal });
                    if (!response.ok) throw new Error("Outline asset unavailable");
                    const geometry = await response.json();
                    if (request.signal.aborted) return;
                    layers.set(id, leaflet.geoJSON(geometry, {
                        pane: paneName,
                        interactive: false,
                        attribution: '<a href="https://www.naturalearthdata.com/">Natural Earth</a>',
                        style: { color: "#8a9199", weight: 0.8, opacity: 1, fill: false },
                    }));
                } catch {
                    if (request.signal.aborted) return;
                    select.value = "none";
                    status.textContent = "Country outlines unavailable. Select them again to retry.";
                    return;
                } finally {
                    if (pending === request) {
                        pending = null;
                        select.removeAttribute("aria-busy");
                    }
                }
            } else {
                const { tiles } = tileOptions.find(option => option.id === id);
                layers.set(id, tileBackground(tiles));
            }
        }
        activeLayer = layers.get(id);
        status.textContent = "";
        status.hidden = true;
        if (id === "maptiler" || id === "maptiler-streets") {
            activeLayer.on("tileerror", reportMapTilerTileError);
        }
        activeLayer.addTo(map);
    }

    /** Apply the dropdown's selected background. @return {void} */
    function applySelectedBasemap() {
        void selectBasemap(select.value);
        map.fire("basemapchange");
    }

    /** Read the selected provider ID without including URLs or keys. @return {string} Provider ID. */
    control.snapshot = () => select.value;

    /**
     * Restore a saved provider, or use the default with a visible warning if unavailable.
     * @param {string} id Saved provider ID.
     * @return {Promise<string|null>} Warning for an unavailable provider, otherwise null.
     */
    control.restore = async function restore(id) {
        const available = options.some(option => option.id === id);
        const warning = available ? null : "The saved basemap is unavailable on this site; Detailed was selected instead.";
        select.value = warning ? "detailed" : id;
        await selectBasemap(select.value);
        return warning;
    };

    /**
     * Keep keyboard interaction with the dropdown from panning the map.
     * @param {KeyboardEvent} event Control key event.
     * @return {void}
     */
    function stopMapKeys(event) {
        event.stopPropagation();
    }

    /** Build the basemap selector and its loading or error message. @return {HTMLElement} Map control. */
    control.onAdd = function onAdd() {
        const doc = map.getContainer().ownerDocument;
        const root = doc.createElement("div");
        root.className = "eolab-basemap-control";
        select = doc.createElement("select");
        select.setAttribute("aria-label", "Basemap");
        for (const { id, label } of options) {
            const option = doc.createElement("option");
            option.value = id;
            option.textContent = label;
            select.append(option);
        }
        select.value = "detailed";
        status = doc.createElement("p");
        status.setAttribute("role", "status");
        status.hidden = true;
        root.append(select, status);
        leaflet.DomEvent.disableClickPropagation(root);
        leaflet.DomEvent.disableScrollPropagation(root);
        root.addEventListener("keydown", stopMapKeys);
        select.addEventListener("change", applySelectedBasemap);
        void selectBasemap("detailed");
        return root;
    };

    /** Release pending work, listeners, and the active background. @return {void} */
    control.onRemove = function onRemove() {
        pending?.abort();
        pending = null;
        select.removeEventListener("change", applySelectedBasemap);
        control.getContainer().removeEventListener("keydown", stopMapKeys);
        removeActiveBasemap();
        layers.clear();
    };
    return control.addTo(map);
}
