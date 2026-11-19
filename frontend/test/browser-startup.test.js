import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Run the actual composition startup with feature boundaries replaced by observers.
 * @param {boolean} sharedViewer Whether this is a published-map viewer.
 * @param {number} status Configuration response status.
 * @return {{start:()=>Promise<void>,release:()=>void,calls:Object[]}} Startup and observations.
 */
function startup(sharedViewer, status = 200) {
    const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const configurationStart = source.indexOf("async function loadAppGlobalConfiguration()");
    const configurationEnd = source.indexOf("\n/**", configurationStart);
    const applicationStart = source.indexOf("async function startApplication()");
    const applicationEnd = source.indexOf("\nstartApplication();", applicationStart);
    const calls = [];
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const dependencies = {
        document: {querySelector: selector => ({selector})},
        isSharedViewer: sharedViewer,
        editableMapSlug: null,
        window: {setTimeout},
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
    return {start, release, calls};
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
