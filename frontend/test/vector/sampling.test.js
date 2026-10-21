import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import test from "node:test";
import assert from "node:assert/strict";
import { VectorSamplingController, vectorSelectionReview, createVectorSamplingArea } from "../../src/vector/sampling.js";

const filter = { enabled: true, match: "all", rules: [{field:"iso3",operator:"eq",value:"PER"}] };
const ready = { selection:CATALOG_SELECTION, filter, label:"Countries",
    bbox:[-81,-19,-68,0], matched:1, total:200 };
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function fixture(createArea=async()=>structuredClone(ready)) {
    const events=[], timers=new Map(); let serial=0;
    let targets=[{key:"countries",label:"Countries",item:{collection:"vectors",id:"countries"},filter}];
    const view={bind(h){this.handlers=h;},render(s){this.state=s;},unbind(){}};
    const controller=new VectorSamplingController({view,getTargets:()=>targets,createArea,
        onActivate:a=>events.push(["activate",a.selection]),
        onInvalidate:id=>events.push(["invalidate",id]),onEditFilter:key=>events.push(["filter",key]),
        clock:{setTimeout(fn){timers.set(++serial,fn);return serial;},clearTimeout(id){timers.delete(id);}}});
    return {controller,view,events,timers,change(next){targets=next;controller.refresh();}};
}
test("filtered country activates a direct descriptor and invalidates on applied filter changes",async()=>{
    const h=fixture();await h.controller.use();
    assert.equal(h.view.state.phase,"active");assert.deepEqual(h.events,[["activate",ready.selection]]);
    assert.match(h.view.state.filterSummary,/iso3 equals "PER"/);
    h.change([{...h.view.state.targets[0],filter:{...filter,rules:[]}}]);await flush();
    assert.deepEqual(h.events.slice(1),[["invalidate",ready.selection]]);
    assert.equal(h.view.state.area,null);assert.match(h.view.state.message,/filter changed/);
});
test("late extraction is discarded after source removal without activating a stale descriptor",async()=>{
    let resolve;const h=fixture(()=>new Promise(done=>{resolve=done;}));
    const promise=h.controller.use();await flush();h.change([]);resolve(ready);await promise;
    assert.deepEqual(h.events,[]);assert.equal(h.view.state.area,null);
});
test("near-global selection requires two meaningful confirmations and permits editing the filter",async()=>{
    const world={...ready,bbox:[-180,-85,180,85],matched:200,filter:{...filter,rules:[]}};
    const h=fixture(async()=>world);await h.controller.use();
    assert.equal(h.view.state.phase,"review");assert.equal(h.events.length,0);
    h.view.handlers.onFilter();assert.deepEqual(h.events,[["filter","countries"]]);
    h.controller.confirm();assert.equal(h.view.state.phase,"confirm");assert.equal(h.events.length,1);
    h.controller.confirm();assert.equal(h.view.state.phase,"active");assert.equal(h.events.at(-1)[0],"activate");
    assert.equal(h.timers.size,0); // Catalog selections have no expiry lifecycle.
});
test("empty-selection failure never activates a rectangular or whole-world fallback",async()=>{
    const h=fixture(async()=>{throw Error("No matching polygon features");});await h.controller.use();
    assert.equal(h.view.state.phase,"error");assert.equal(h.events.length,0);
    assert.equal(vectorSelectionReview(ready).large,false);
});

test("explicit analysis uses its committed predicate without envelope confirmations", async () => {
    const selected = { ...filter, rules: [] };
    let seen;
    const h = fixture(async (_item, candidate) => {
        seen = candidate;
        return { ...ready, filter: candidate, bbox: [-180, -85, 180, 85], matched: 200 };
    });
    const area = await h.controller.use({ filter: selected, analysis: true });
    assert.deepEqual(seen, selected); assert.equal(h.view.state.phase, "selected");
    assert.equal(h.events.length, 0);
    h.controller.activate(area.selection, true);
    assert.deepEqual(h.events, [["activate", ready.selection]]);
});

test("successive selections abort obsolete transport and serialize bounded replacement reads", async () => {
    const reads = [];
    const h = fixture((_item, candidate, signal) => new Promise(resolve => reads.push({ candidate, signal, resolve })));
    const first = h.controller.use({ analysis: true }); await flush();
    const secondFilter = { ...filter, rules: [{ field: "iso3", operator: "eq", value: "CAN" }] };
    const second = h.controller.use({ filter: secondFilter, analysis: true }); await flush();
    assert.equal(reads.length, 1); assert.equal(reads[0].signal.aborted, true);
    reads[0].resolve(ready); await flush();
    assert.equal(reads.length, 2); assert.deepEqual(h.events, []);
    const replacement = { ...ready, selection: { ...CATALOG_SELECTION, filter: secondFilter }, filter: secondFilter };
    reads[1].resolve(replacement);
    assert.equal(await first, null); assert.deepEqual((await second).selection, replacement.selection);
    h.controller.activate(ready.selection, true); assert.equal(h.events.length, 0);
    h.controller.activate(replacement.selection, true); assert.deepEqual(h.events.at(-1), ["activate", replacement.selection]);
});

test("cancelled analysis discards its eventual descriptor without activation or storage cleanup", async () => {
    let resolve;
    const h = fixture(() => new Promise(done => { resolve = done; }));
    const pending = h.controller.use({ analysis: true }); await flush();
    h.controller.invalidate("Selection cancelled"); resolve(ready);
    assert.equal(await pending, null); assert.deepEqual(h.events, []);
    assert.equal(h.view.state.area, null);
});

test("catalog and uploaded selections use original source identifiers and the applied filter", async t => {
    for (const source of [{ collectionId: CATALOG_SELECTION.collectionId, itemId: CATALOG_SELECTION.itemId },
        { uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d" }]) {
        const selection = source.uploadId ? { ...source, layerName: "areas", filter } : { ...CATALOG_SELECTION, filter };
        const reply = { ...ready, selection };
        let request;
        t.mock.method(globalThis, "fetch", async (url, options) => {
            request = { url, options };
            return new Response(JSON.stringify(reply));
        });
        const controller = fixture(createVectorSamplingArea);
        controller.change([{ key: "polygons", label: "Selected polygons",
            item: { ...source, key: "polygons", label: "Selected polygons", fields: [{ name: "iso3", type: "str" }], filter: { ...filter, rules: [] } }, filter }]);
        await controller.controller.use({ analysis: true });
        assert.deepEqual(JSON.parse(request.options.body), { ...source, filter });
        assert.equal(request.url, "/api/vector-sampling/areas");
        assert.equal(request.options.headers["X-EOLab-Uploads"], source.uploadId ? "1" : undefined);
        assert.equal(request.options.credentials, "same-origin");
        assert.equal(request.options.cache, "no-store");
        assert.deepEqual(controller.view.state.area.selection, selection);
        controller.controller.activate(selection, true);
        assert.deepEqual(controller.events, [["activate", selection]]);
        controller.change([]);
        assert.deepEqual(controller.events.at(-1), ["invalidate", selection]);
    }
});
