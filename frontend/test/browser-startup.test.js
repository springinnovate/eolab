import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { editableMapSlugFromPath, privateMapEditFromLocation } from "../src/saved-map-view/api-client.js";

/**
 * Run the actual composition startup with feature boundaries replaced by observers.
 * @param {boolean} sharedViewer Whether this is a published-map viewer.
 * @param {number} status Configuration response status.
 * @param {string} [url="https://viewer.example/"] Browser URL before startup.
 * @return {{start:()=>Promise<void>,release:()=>void,calls:Object[],browser:EventTarget,location:URL}}
 * Startup, browser navigation boundary and observations.
 */
function startup(sharedViewer, status = 200, url = "https://viewer.example/") {
    const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const configurationStart = source.indexOf("async function loadAppGlobalConfiguration()");
    const configurationEnd = source.indexOf("\n/**", configurationStart);
    const applicationStart = source.indexOf("async function startApplication()");
    const applicationEnd = source.indexOf("\nstartApplication();", applicationStart);
    const calls = [];
    const location = new URL(url);
    const privateMapEdit = privateMapEditFromLocation(location);
    const browser = Object.assign(new EventTarget(), {
        setTimeout,
        navigator: {},
        location: Object.assign(location, {reload: () => calls.push({reload: location.href})}),
    });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const dependencies = {
        document: {querySelector: selector => ({selector})},
        isSharedViewer: sharedViewer,
        editableMapSlug: privateMapEdit?.slug ?? editableMapSlugFromPath(location.pathname),
        privateMapEdit,
        window: browser,
        fetch: async (url, options) => {
            calls.push({url, options});
            await pending;
            return new Response(JSON.stringify({appTitle: "Test"}), {status});
        },
        initializeCatalogPaneControls: () => ({}),
        applyAppGlobalConfiguration: () => {},
        initializeRenderingDiagnostics: () => {},
        initializeMap: () => ({}),
        EomapLayoutController: class {
            showWorkspace() {}
            /** Exercise the startup connection from the dock to its workspace surface.
             * @param {{selector:string}} panel Selected surface.
             * @param {(listener:(active:boolean)=>void)=>()=>void} subscribe Dock subscription.
             * @return {void}
             */
            registerPanelActivitySource(panel, subscribe) {
                subscribe(active => calls.push({panel: panel.selector, active}));
            }
        },
        bindPanelFadeSettings: () => calls.push({panelSettings: true}),
        SavedMapViewLocalStorage: class {},
        MapInspectionController: class {
            /** Replay initial activity. @param {(active:boolean)=>void} listener Layout listener.
             * @return {()=>void} Disconnect the test source.
             */
            subscribeClickResultActivity(listener) { listener(false); return () => {}; }
        },
        initializeCatalog: async configuration => {
            calls.push({features: configuration});
            return () => {};
        },
        initializeScanner: async () => {},
    };
    const start = new Function(...Object.keys(dependencies),
        `${source.slice(configurationStart, configurationEnd)}\n` +
        `${source.slice(applicationStart, applicationEnd)}\nreturn startApplication;`
    )(...Object.values(dependencies));
    return {start, release, calls, browser, location};
}

for (const sharedViewer of [false, true]) {
    test(`startup awaits uncached same-origin identity before features (shared=${sharedViewer})`, async () => {
        const {start, release, calls} = startup(sharedViewer);
        const running = start();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {url: "/api/config", options: {
            headers: {Accept: "application/json"}, credentials: "same-origin", cache: "no-store",
        }});
        await Promise.resolve();
        assert.equal(calls.length, 1);
        release();
        await running;
        assert.deepEqual(calls.slice(1), [
            {panelSettings: true}, {panel: "#map-inspection", active: false}, {features: {appTitle: "Test"}},
        ]);
    });

    test(`failed identity bootstrap keeps feature controls uninitialized (shared=${sharedViewer})`, async () => {
        const {start, release, calls} = startup(sharedViewer, 503);
        const running = start();
        release();
        await assert.rejects(running, /Runtime configuration returned 503/);
        assert.equal(calls.length, 1);
    });
}

test("two tabs wait for the first configuration response before sending the next request", async () => {
    const first = startup(false);
    const second = startup(true);
    const queues = new Map();
    const locks = {
        /** Queue callbacks from both tabs that request the same exclusive lock.
         * @param {string} name Origin-scoped lock name.
         * @param {()=>Promise<Response>} acquire Request to run while holding the lock.
         * @return {Promise<Response>} Result of this tab's configuration request.
         */
        request(name, acquire) {
            const held = (queues.get(name) ?? Promise.resolve()).then(acquire);
            queues.set(name, held.catch(() => {}));
            return held;
        },
    };
    first.browser.navigator.locks = locks;
    second.browser.navigator.locks = locks;
    const opening = [first.start(), second.start()];
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(first.calls[0]?.url, "/api/config");
        assert.equal(second.calls.length, 0);
        first.release();
        await opening[0];
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(second.calls[0]?.url, "/api/config");
    } finally {
        first.release();
        second.release();
        await Promise.all(opening);
    }
});

for (const [path, sharedViewer, reloads] of [
    ["/maps/survey/edit", false, true],
    [`/maps/survey/edit#${"a".repeat(64)}`, false, true],
    ["/maps/survey", true, false],
    ["/admin-eolab/maps/survey/edit", false, false],
    ["/", false, false],
]) {
    test(`fragment navigation reopens only private editors (${path})`, async () => {
        const {start, release, calls, browser, location} = startup(sharedViewer, 200, `https://viewer.example${path}`);
        const running = start();
        location.hash = "b".repeat(64);
        browser.dispatchEvent(new Event("hashchange"));
        assert.deepEqual(calls.filter(call => "reload" in call), reloads ? [{reload: location.href}] : []);
        release();
        await running;
    });
}
