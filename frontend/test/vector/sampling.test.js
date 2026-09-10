import test from "node:test";
import assert from "node:assert/strict";
import { VectorSamplingController, vectorSelectionReview } from "../../src/vector/sampling.js";

const filter = { enabled: true, match: "all", rules: [{field:"iso3",operator:"eq",value:"PER"}] };
const ready = { id:"A".repeat(32), filter, filename:"Countries", selectedDataset:"countries", expiresAt:"2099-01-01T00:00:00Z",
    bbox:[-81,-19,-68,0], matched:1, total:200, geometry:{type:"FeatureCollection",features:[]} };
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function fixture(createArea=async()=>structuredClone(ready)) {
    const events=[], timers=new Map(); let serial=0;
    let targets=[{key:"countries",label:"Countries",item:{collection:"vectors",id:"countries"},filter}];
    const view={bind(h){this.handlers=h;},render(s){this.state=s;},unbind(){}};
    const controller=new VectorSamplingController({view,getTargets:()=>targets,createArea,
        removeArea:async id=>events.push(["remove",id]),onActivate:a=>events.push(["activate",a.id]),
        onInvalidate:id=>events.push(["invalidate",id]),onEditFilter:key=>events.push(["filter",key]),
        clock:{setTimeout(fn){timers.set(++serial,fn);return serial;},clearTimeout(id){timers.delete(id);}}});
    return {controller,view,events,timers,change(next){targets=next;controller.refresh();}};
}
test("filtered country activates complete geometry and invalidates on applied filter changes",async()=>{
    const h=fixture();await h.controller.use();
    assert.equal(h.view.state.phase,"active");assert.deepEqual(h.events,[["activate",ready.id]]);
    assert.match(h.view.state.filterSummary,/iso3 equals "PER"/);
    h.change([{...h.view.state.targets[0],filter:{...filter,rules:[]}}]);await flush();
    assert.deepEqual(h.events.slice(1),[["invalidate",ready.id],["remove",ready.id]]);
    assert.equal(h.view.state.area,null);assert.match(h.view.state.message,/filter changed/);
});
test("late extraction is discarded after source removal without activating stale geometry",async()=>{
    let resolve;const h=fixture(()=>new Promise(done=>{resolve=done;}));
    const promise=h.controller.use();await flush();h.change([]);resolve(ready);await promise;
    assert.deepEqual(h.events,[["remove",ready.id]]);assert.equal(h.view.state.area,null);
});
test("near-global selection requires two meaningful confirmations and permits editing the filter",async()=>{
    const world={...ready,bbox:[-180,-85,180,85],matched:200,filter:{...filter,rules:[]}};
    const h=fixture(async()=>world);await h.controller.use();
    assert.equal(h.view.state.phase,"review");assert.equal(h.events.length,0);
    h.view.handlers.onFilter();assert.deepEqual(h.events,[["filter","countries"]]);
    h.controller.confirm();assert.equal(h.view.state.phase,"confirm");assert.equal(h.events.length,1);
    h.controller.confirm();assert.equal(h.view.state.phase,"active");assert.equal(h.events.at(-1)[0],"activate");
    [...h.timers.values()][0]();assert.match(h.view.state.message,/expired/);
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
    h.controller.activate(area.id, true);
    assert.deepEqual(h.events, [["activate", ready.id]]);
});

test("successive committed selections serialize reads and release late identities before replacement", async () => {
    const reads = [];
    const h = fixture((_item, candidate, signal) => new Promise(resolve => reads.push({ candidate, signal, resolve })));
    const first = h.controller.use({ analysis: true }); await flush();
    const secondFilter = { ...filter, rules: [{ field: "iso3", operator: "eq", value: "CAN" }] };
    const second = h.controller.use({ filter: secondFilter, analysis: true }); await flush();
    assert.equal(reads.length, 1); assert.equal(reads[0].signal.aborted, false);
    reads[0].resolve(ready); await flush();
    assert.equal(reads.length, 2); assert.deepEqual(h.events, [["remove", ready.id]]);
    const replacement = { ...ready, id: "B".repeat(32), filter: secondFilter };
    reads[1].resolve(replacement);
    assert.equal(await first, null); assert.equal((await second).id, replacement.id);
    h.controller.activate(ready.id, true); assert.equal(h.events.length, 1);
    h.controller.activate(replacement.id, true); assert.deepEqual(h.events.at(-1), ["activate", replacement.id]);
});

test("cancelled analysis extraction reclaims its eventual AOI and never activates it", async () => {
    let resolve;
    const h = fixture(() => new Promise(done => { resolve = done; }));
    const pending = h.controller.use({ analysis: true }); await flush();
    h.controller.invalidate("Selection cancelled"); resolve(ready);
    assert.equal(await pending, null); assert.deepEqual(h.events, [["remove", ready.id]]);
    assert.equal(h.view.state.area, null);
});
