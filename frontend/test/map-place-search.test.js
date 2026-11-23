import assert from "node:assert/strict";
import test from "node:test";
import { addMapPlaceSearch } from "../src/map-place-search.js";
import { getSingleWorldMapBounds } from "../src/map.js";
import { createLeafletDouble } from "../test-support/fake-basemap-leaflet.js";

const paris = {
    place_name: "Paris, Île-de-France, France",
    place_type: ["municipality"],
    center: [2.35, 48.86],
    bbox: [2.22, 48.81, 2.47, 48.91],
};
const address = {
    place_name: "350 Fifth Avenue, Manhattan, New York 10118, United States",
    place_type: ["address"],
    geometry: { type: "Point", coordinates: [-73.98566, 40.74844] },
    bbox: [-74.03, 40.66, -73.94, 40.88],
};

/**
 * Mount the real control against the browser, network and map boundaries used in tests.
 * @param {{savedVisibility?:string,fetcher:typeof fetch}} options Stored choice and provider transport.
 * @return {Object} Mounted control, its public UI elements and recorded side effects.
 */
function mountPlaceSearch({ savedVisibility = null, fetcher }) {
    const { leaflet, leafletMap, document, calls } = createLeafletDouble();
    const panel = document.createElement("section");
    const form = document.createElement("form");
    const input = document.createElement("input");
    const submit = document.createElement("button");
    const close = document.createElement("button");
    const toggle = document.createElement("button");
    const status = document.createElement("p");
    const results = document.createElement("ul");
    close.setAttribute("class", "map-panel-collapse");
    status.setAttribute("class", "map-place-search-status");
    results.setAttribute("class", "map-place-search-results");
    form.append(input, submit);
    panel.append(close, form, status, results);
    const choices = [];
    const pins = [];
    const views = [];
    leafletMap.fitBounds = (bounds, options) => views.push({bounds, options});
    leaflet.circleMarker = center => ({
        addTo() {
            const pin = { center, removed: false, remove() { this.removed = true; } };
            pins.push(pin);
            return pin;
        },
    });
    const control = addMapPlaceSearch(leaflet, leafletMap, {
        panel, toggleButton: toggle, apiKey: "test&key/#", fetcher,
        storage: { read: () => savedVisibility, write: value => { choices.push(value); return true; } },
        toMapBounds: getSingleWorldMapBounds,
        onRestoreRequested: () => { calls.restoreMenu = true; },
    });
    return { control, panel, form, input, submit, close, toggle, status, results, choices, pins, views, document, calls };
}

/**
 * Type text without submitting a search.
 * @param {HTMLInputElement} input The search form field.
 * @param {string} value Newly entered text.
 * @return {void}
 */
function typePlace(input, value) {
    input.value = value;
    input.dispatchEvent(new Event("input"));
}

/**
 * Submit a query and give immediate provider responses time to reach the panel.
 * @param {HTMLFormElement} form The place search form.
 * @return {Promise<void>} Completion of the current event-loop turn.
 */
async function submitPlaceSearch(form) {
    const event = new Event("submit", { cancelable: true });
    form.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await new Promise(resolve => setImmediate(resolve));
}

test("submitting shows disambiguated usable places and selecting one fits its bounds", async () => {
    const requests = [];
    const texas = { ...paris, place_name: "Paris, Texas, United States", center: [-95.56, 33.66] };
    const ui = mountPlaceSearch({ fetcher: async (url, options) => {
        requests.push({ url, options });
        return Response.json({ features: [
            paris, texas, { ...paris, center: [2.35, 91] },
            { ...paris, center: ["2.35", 48.86] }, { ...paris, place_name: "" }, paris,
        ] });
    } });
    typePlace(ui.input, "  Paris / Île-de-France  ");
    assert.equal(requests.length, 0);
    await submitPlaceSearch(ui.form);
    assert.equal(requests.length, 1);
    const [{url, options}] = requests;
    assert.equal(url.origin, "https://api.maptiler.com");
    assert.equal(url.pathname, "/geocoding/Paris%20%2F%20%C3%8Ele-de-France.json");
    assert.deepEqual(Object.fromEntries(url.searchParams), {key: "test&key/#", autocomplete: "false", limit: "5"});
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(ui.views.length, 0);
    assert.equal(ui.status.textContent, "2 matching places.");
    const buttons = ui.results.querySelectorAll("button");
    assert.deepEqual(buttons.map(button => button.children.map(child => child.textContent)), [
        [paris.place_name, "City or town"], [texas.place_name, "City or town"],
    ]);
    buttons[0].dispatchEvent(new Event("click"));
    assert.deepEqual(ui.views, [{
        bounds: [[48.81, 2.22], [48.91, 2.47]], options: {padding: [20, 20], maxZoom: 17, animate: false},
    }]);
    assert.equal(ui.status.textContent, `Map zoomed to ${paris.place_name}.`);
    assert.equal(ui.document.activeElement, ui.input);
    assert.equal(ui.pins.length, 0);
});

test("an address zooms to its point and hiding the panel removes its pin", async () => {
    const ui = mountPlaceSearch({ fetcher: async () => Response.json({features: [address]}) });
    typePlace(ui.input, "350 Fifth Avenue");
    await submitPlaceSearch(ui.form);
    ui.results.querySelector("button").dispatchEvent(new Event("click"));
    assert.deepEqual(ui.views[0], {
        bounds: [[40.74844, -73.98566], [40.74844, -73.98566]],
        options: {padding: [20, 20], maxZoom: 17, animate: false},
    });
    assert.deepEqual(ui.pins[0].center, [40.74844, -73.98566]);
    ui.close.dispatchEvent(new Event("click"));
    assert.equal(ui.pins[0].removed, true);
    assert.equal(ui.panel.hidden, true);
    assert.equal(ui.input.value, "");
    assert.equal(ui.calls.restoreMenu, true);
    assert.equal(ui.document.activeElement, ui.toggle);
    assert.equal(ui.toggle.textContent, "Show place search");
    assert.equal(ui.toggle.getAttribute("aria-expanded"), "false");
    assert.deepEqual(ui.choices, ["hidden"]);
});

test("the Tools command restores remembered visibility and focuses the search input", () => {
    const ui = mountPlaceSearch({ savedVisibility: "hidden", fetcher: async () => assert.fail("visibility must not search") });
    assert.equal(ui.panel.hidden, true);
    assert.equal(ui.toggle.hidden, false);
    ui.toggle.dispatchEvent(new Event("click"));
    assert.equal(ui.panel.hidden, false);
    assert.equal(ui.toggle.textContent, "Hide place search");
    assert.equal(ui.toggle.getAttribute("aria-expanded"), "true");
    assert.equal(ui.document.activeElement, ui.input);
    ui.toggle.dispatchEvent(new Event("click"));
    assert.equal(ui.panel.hidden, true);
    assert.deepEqual(ui.choices, ["shown", "hidden"]);
});

test("provider errors allow a retry and a country center uses an area-appropriate zoom", async () => {
    const canada = { place_name: "Canada", center: [-105, 59], place_type: ["country"], bbox: [] };
    const replies = [new Response("", {status: 429}), Response.json({features: []}), Response.json({features: [canada]})];
    const ui = mountPlaceSearch({ fetcher: async () => replies.shift() });
    typePlace(ui.input, "Canada");
    await submitPlaceSearch(ui.form);
    assert.match(ui.status.textContent, /Try again/);
    assert.equal(ui.submit.disabled, false);
    await submitPlaceSearch(ui.form);
    assert.match(ui.status.textContent, /No places found/);
    await submitPlaceSearch(ui.form);
    ui.results.querySelector("button").dispatchEvent(new Event("click"));
    assert.deepEqual(ui.views[0], {
        bounds: [[59, -105], [59, -105]], options: {padding: [20, 20], maxZoom: 5, animate: false},
    });
});

test("editing, hiding and removing the panel cancel searches that could update old results", async () => {
    const requests = [];
    const ui = mountPlaceSearch({ fetcher: (_url, {signal}) => {
        const response = Promise.withResolvers();
        requests.push({ response, signal });
        return response.promise;
    } });
    typePlace(ui.input, "Paris");
    await submitPlaceSearch(ui.form);
    assert.equal(ui.status.textContent, "Searching for places…");
    typePlace(ui.input, "Canada");
    assert.equal(requests[0].signal.aborted, true);
    await submitPlaceSearch(ui.form);
    requests[0].response.resolve(Response.json({features: [paris]}));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.results.hidden, true);
    assert.equal(ui.submit.disabled, true);
    ui.close.dispatchEvent(new Event("click"));
    assert.equal(requests[1].signal.aborted, true);
    ui.toggle.dispatchEvent(new Event("click"));
    typePlace(ui.input, "New York");
    await submitPlaceSearch(ui.form);
    ui.control.remove();
    assert.equal(requests[2].signal.aborted, true);
    assert.equal(ui.toggle.hidden, true);
    for (const {response} of requests.slice(1)) response.resolve(Response.json({features: [address]}));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.results.hidden, true);
    assert.equal(ui.views.length, 0);
});
