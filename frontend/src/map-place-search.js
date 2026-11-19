/** Find named places and direct the existing map viewport to a selected match. */

import { searchMapTilerPlaces } from "./maptiler-place-search.js";

/** @typedef {import("./maptiler-place-search.js").MapTilerPlace} MapTilerPlace */

const PLACE_TYPES = new Map([
    ["country", { label: "Country", zoom: 5 }],
    ["region", { label: "Region", zoom: 8 }],
    ["subregion", { label: "District", zoom: 10 }],
    ["county", { label: "County", zoom: 10 }],
    ["municipality", { label: "City or town", zoom: 12 }],
    ["locality", { label: "Locality", zoom: 13 }],
    ["municipal_district", { label: "District", zoom: 13 }],
    ["neighbourhood", { label: "Neighborhood", zoom: 14 }],
    ["postal_code", { label: "Postal code", zoom: 14 }],
    ["road", { label: "Street", zoom: 15 }],
    ["poi", { label: "Point of interest", zoom: 16 }],
    ["address", { label: "Address", zoom: 17 }],
]);
const OTHER_PLACE_TYPE = { label: "Place", zoom: 14 };

/**
 * @typedef {Object} PlaceSearchControls
 * @property {HTMLElement} panel Static Find a place section.
 * @property {HTMLButtonElement} toggleButton Show or hide command in the map tools menu.
 * @property {string} apiKey Browser-visible MapTiler key.
 * @property {{read:()=>string|null,write:(value:string)=>boolean}} storage Browser-local panel visibility preference.
 * @property {(bbox:unknown)=>number[][]|null} toMapBounds Convert provider bounds for the single-world map.
 * @property {()=>void} onRestoreRequested Reveal the chooser when the panel's own close button is used.
 * @property {typeof fetch} [fetcher] Optional request transport.
 */

/**
 * Mount the Find a place panel in Leaflet and enable its map tools command.
 * Search text and matches live in the open panel. Only visibility is remembered.
 * Removing the control cancels any request and removes its temporary address pin.
 * @param {typeof import("leaflet")} leaflet Leaflet namespace.
 * @param {import("leaflet").Map} map Existing application map.
 * @param {PlaceSearchControls} controls Configuration and composition boundaries.
 * @return {import("leaflet").Control} The mounted place search control.
 */
export function addMapPlaceSearch(leaflet, map, { panel, toggleButton, apiKey, storage, toMapBounds, onRestoreRequested, fetcher }) {
    const doc = panel.ownerDocument;
    const form = panel.querySelector("form");
    const input = form.querySelector("input");
    const submitButton = form.querySelector("button");
    const closeButton = panel.querySelector(".map-panel-collapse");
    const status = panel.querySelector(".map-place-search-status");
    const results = panel.querySelector(".map-place-search-results");
    const listeners = new AbortController();
    const events = { signal: listeners.signal };
    /** @type {AbortController|null} */
    let pending = null;
    /** @type {import("leaflet").CircleMarker|null} */
    let addressPin = null;

    /** Cancel the previous query and empty its results after an edit or close. @return {void} */
    function clearSearch() {
        pending?.abort();
        pending = null;
        results.replaceChildren();
        results.hidden = true;
        status.textContent = "";
        submitButton.disabled = !input.value.trim();
    }

    /** Remove the address marker from the map. @return {void} */
    function removeAddressPin() {
        addressPin?.remove();
        addressPin = null;
    }

    /**
     * Reflect the panel state in the map and in the tool chooser.
     * @param {boolean} visible Whether the search panel is open.
     * @return {void}
     */
    function renderVisibility(visible) {
        if (!visible) panel.hidePopover();
        panel.hidden = !visible;
        if (visible) panel.showPopover();
        toggleButton.setAttribute("aria-expanded", String(visible));
        toggleButton.textContent = visible ? "Hide place search" : "Show place search";
    }

    /**
     * Apply a user's visibility choice and remember it in this browser.
     * @param {boolean} visible Whether to show the panel and focus its input.
     * @return {void}
     */
    function setVisibility(visible) {
        renderVisibility(visible);
        storage.write(visible ? "shown" : "hidden");
        if (visible) {
            input.focus();
        } else {
            input.value = "";
            clearSearch();
            removeAddressPin();
        }
    }

    /**
     * Fit a place's area or center its point at a zoom suitable for its type.
     * @param {MapTilerPlace} place The chosen search match.
     * @return {void}
     */
    function zoomToPlace(place) {
        const isAddress = place.type === "address";
        const bounds = isAddress ? null : toMapBounds(place.bbox);
        const fitsArea = bounds && (bounds[0][0] !== bounds[1][0] || bounds[0][1] !== bounds[1][1]);
        const type = PLACE_TYPES.get(place.type) ?? OTHER_PLACE_TYPE;
        map.fitBounds(fitsArea ? bounds : [place.center, place.center], {
            padding: [20, 20],
            maxZoom: fitsArea ? 17 : type.zoom,
            animate: false,
        });
        removeAddressPin();
        if (isAddress) {
            addressPin = leaflet.circleMarker(place.center, {
                className: "map-place-search-pin", pane: "markerPane", radius: 7, weight: 2,
                fillOpacity: 1, interactive: false,
            }).addTo(map);
        }
        input.focus();
        results.replaceChildren();
        results.hidden = true;
        status.textContent = `Map zoomed to ${place.label}.`;
    }

    /**
     * Present provider labels as text and let the user choose the intended place.
     * @param {MapTilerPlace[]} places Search matches in provider order.
     * @return {void}
     */
    function showMatches(places) {
        for (const place of places) {
            const row = doc.createElement("li");
            const button = doc.createElement("button");
            button.type = "button";
            const name = doc.createElement("span");
            name.textContent = place.label;
            const type = doc.createElement("small");
            type.textContent = (PLACE_TYPES.get(place.type) ?? OTHER_PLACE_TYPE).label;
            button.append(name, type);
            button.addEventListener("click", () => zoomToPlace(place));
            row.append(button);
            results.append(row);
        }
        results.hidden = places.length === 0;
        status.textContent = places.length
            ? `${places.length} matching ${places.length === 1 ? "place" : "places"}.`
            : "No places found. Try adding a city or country.";
    }

    /**
     * Request matches for the submitted text. Only the current request can update the panel.
     * @param {SubmitEvent} event Place search form submission.
     * @return {Promise<void>} Resolves after updating the current search status.
     */
    async function submitSearch(event) {
        event.preventDefault();
        const query = input.value.trim();
        if (!query || pending) return;
        clearSearch();
        const request = new AbortController();
        pending = request;
        submitButton.disabled = true;
        status.textContent = "Searching for places…";
        try {
            const places = await searchMapTilerPlaces(query, apiKey, request.signal, fetcher);
            if (pending === request) showMatches(places);
        } catch {
            if (pending === request) status.textContent = "Place search is unavailable. Try again.";
        } finally {
            if (pending === request) {
                pending = null;
                submitButton.disabled = false;
            }
        }
    }

    form.addEventListener("submit", submitSearch, events);
    input.addEventListener("input", clearSearch, events);
    toggleButton.addEventListener("click", () => setVisibility(panel.hidden), events);
    closeButton.addEventListener("click", () => {
        setVisibility(false);
        onRestoreRequested();
        toggleButton.focus();
    }, events);
    leaflet.DomEvent.disableClickPropagation(panel);
    leaflet.DomEvent.disableScrollPropagation(panel);
    panel.addEventListener("keydown", event => event.stopPropagation(), events);

    const control = leaflet.control({ position: "bottomleft" });
    /** @return {HTMLElement} The existing place search section to mount in the map. */
    control.onAdd = () => panel;
    /** Cancel search and release the viewport and tool menu when the map unloads. @return {void} */
    control.onRemove = () => {
        listeners.abort();
        clearSearch();
        removeAddressPin();
        toggleButton.hidden = true;
    };
    control.addTo(map);
    renderVisibility(storage.read() !== "hidden");
    toggleButton.hidden = false;
    clearSearch();
    return control;
}
