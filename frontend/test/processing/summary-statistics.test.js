import assert from "node:assert/strict";
import test from "node:test";
import { SummaryStatisticsController, canAutomaticallyCalculate } from "../../src/processing/summary-statistics-controller.js";
import { SummaryStatisticsView } from "../../src/processing/summary-statistics-view.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const source = { collectionId: "rasters", itemId: "hfp", label: "Human footprint" };
const resistance = { collectionId: "rasters", itemId: "resistance", label: "Resistance" };
const box = west => ({ kind: "selectedArea", selectedBounds: { west, south: 22, east: west + 1, north: 23 } });
const grid = { width: 100, height: 100, crs: "EPSG:3857", nativeBlocks: 4, decodedBytes: 10000 };
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

function fixture(overrides = {}, data = new Map(), browserContext = {}) {
    let serial = 0, jobSerial = 0;
    const timers = new Map(), requests = [], server = new Map(), plans = new Map();
    const clock = { setTimeout(fn, delay) { timers.set(++serial, { fn, delay }); return serial; }, clearTimeout(id) { timers.delete(id); } };
    const api = {
        listJobs: async () => [...server.values()], getJob: async id => server.get(id),
        validateCalculation: async rows => { requests.push(["validate", rows]); if (rows.some(row=>row.expression.includes("bad"))) throw Error("Unknown function bad"); return {valid:true}; },
        planCalculation: async intent => { const planId = String(++jobSerial).padStart(32,"0"); requests.push(["plan",intent]); plans.set(planId,intent); return {planId,grid,expiresAt:"2099-01-01T00:00:00Z"}; },
        discardPlan: async id => { requests.push(["discard",id]); },
        submitCalculation: async submission => {
            requests.push(["submit",submission]);
            const intent = plans.get(submission.planId);
            const job = { jobId:submission.planId,operation:"raster.aggregate.v1",status:"running",sources:{a:intent.source},calculations:intent.calculations,
                area:{kind:"bounds",bounds:[77,22,78,23]},grid,createdAt:"2026-09-08T00:00:00Z",progress:{phase:"calculating",totalBlocks:4,completedBlocks:0},result:null };
            server.set(job.jobId,job); return job;
        },
        cancelJob: async id => { requests.push(["cancel",id]);const job={...server.get(id),status:"cancelling"};server.set(id,job);return job; },
        deleteJob: async id => { const job={...server.get(id),status:"deleted",result:null};server.set(id,job);return job; },
        ...overrides,
    };
    const jobs = new ProcessingJobs(api,clock);
    const storage = new CalculationSessionStorage({getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)});
    const document = new FakeRasterControlDocument();
    const view = new SummaryStatisticsView(document, browserContext);
    let controller;
    controller = new SummaryStatisticsController({api,jobs,storage,view,clock,getContext:()=>({sources:[source,resistance],area:box(77)}),
        onOpen:()=>controller.setActive(true),onClose(){},onEditArea(){},requestId:()=>`request-${String(jobSerial).padStart(16,"0")}`});
    const tick = async (delay = 700) => { const due=[...timers.entries()].filter(([,t])=>t.delay===delay);for(const[id,t]of due){timers.delete(id);t.fn();}await flush(); };
    const finish = async (status="ready", values=["12.5"]) => {
        const old=server.get(controller.engine.record.jobId);
        const result=status==="ready"?{url:`/api/processing/jobs/${old.jobId}/result`,provenanceUrl:`/api/processing/jobs/${old.jobId}/provenance`,rows:old.calculations.map((row,i)=>({...row,value:values[i]??values[0],valueType:"float",state:"ok",aggregates:[{function:"mean",matchedPixels:8,validPixels:8,invalidArithmeticPixels:0}]}))}:null;
        server.set(old.jobId,{...old,status,result,error:status==="failed"?{detail:"Scan failed"}:null});
        await jobs.refresh();await flush();
    };
    const open = async()=>{controller.open();await tick();};
    const submits=()=>requests.filter(r=>r[0]==="submit").length;
    return {controller,api,jobs,storage,view,document,requests,server,plans,tick,finish,open,submits,data};
}

test("opening and tab switching preserve cards and do not run native calculations", async()=>{
    const h=fixture();await h.open();assert.equal(h.submits(),0);
    h.controller.setActive(false);h.controller.setActive(true);await h.tick();assert.equal(h.submits(),0);
    const card=h.controller.state.statistics[0];assert.equal(card.valid,true);
    h.controller.request(card.id,"manual");await flush();await h.finish();
    h.controller.setActive(false);h.controller.open();await h.tick();assert.equal(h.submits(),1);
    assert.equal(card.current,true);
});

test("the summary Area selector offers inline vector controls and never calculates the old box while choosing polygons", async()=>{
    const h=fixture(); await h.open();
    const area=h.view.elements.area;
    assert.equal(area.children.find(option=>option.value==="vector").textContent,"Vector layer");
    const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual"); await flush();
    area.value="vector"; area.dispatchEvent(new Event("change")); await flush();
    assert.equal(h.controller.state.area,null);
    assert.equal(h.view.vectorAreaControls.hidden,false);
    assert.equal(h.view.elements["edit-area"].hidden,true);
    assert.ok(h.requests.some(request=>request[0]==="cancel"));
    assert.equal(h.view.cards.get(card.id).run.disabled,true);
    h.controller.setActive(false); h.controller.open(); await h.tick();
    assert.equal(h.controller.state.areaChoice,"vector");
    assert.equal(h.controller.state.area,null);
    assert.equal(h.submits(),1);
});

test("vector selection reviews exact scan size before submission and invalidates results when removed", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    const id="V".repeat(32);
    h.controller.setVectorSamplingArea({id,label:"Countries · 1 of 200 features"});await h.tick();
    assert.equal(h.controller.state.areaChoice,"vector");
    assert.equal(h.view.vectorAreaControls.hidden,false);
    assert.equal(h.submits(),0);
    h.controller.request(card.id,"manual");await flush();
    assert.equal(h.submits(),0);assert.equal(card.manualRequired,true);
    assert.match(h.view.cards.get(card.id).size.textContent,/4 source blocks/);
    assert.equal(h.view.cards.get(card.id).size.hidden,false);
    h.controller.request(card.id,"manual");await flush();assert.equal(h.submits(),1);
    assert.equal(h.view.cards.get(card.id).size.hidden,true);
    assert.deepEqual(h.controller.engine.record.intent.area,{kind:"temporaryAoi",temporaryAoiId:id});
    await h.finish();assert.equal(card.current,true);
    assert.equal(h.view.cards.get(card.id).size.hidden,true);
    h.controller.setSelection(null,false);
    h.controller.invalidateSamplingArea(id);assert.equal(card.current,false);assert.equal(h.controller.state.area,null);
    assert.equal(h.controller.state.areaChoice,"vector");
    assert.equal(h.view.vectorAreaControls.hidden,false);
    assert.equal(h.view.cards.get(card.id).root.classList.contains("is-previous"),true);
});
test("a new card shows calculation controls without an empty value, then displays zero and retains previous results", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    const row=h.view.cards.get(card.id);
    assert.equal(row.valueActions.hidden,true);assert.equal(row.value.textContent,"");
    assert.equal(row.status.textContent,"Ready to calculate");assert.equal(row.run.hidden,false);
    assert.equal(Boolean(row.run.disabled),false);assert.equal(row.statusRow.hidden,false);
    row.run.dispatchEvent(new Event("click"));await flush();
    assert.equal(row.valueActions.hidden,true);assert.equal(row.stop.hidden,false);
    await h.finish("ready",["0"]);
    assert.equal(row.valueActions.hidden,false);assert.equal(row.value.textContent,"0");
    assert.equal(row.copy.disabled,false);assert.equal(row.run.hidden,true);assert.equal(row.statusRow.hidden,true);
    h.controller.editStatistic(card.id,{expression:"max(a)"});
    assert.equal(row.valueActions.hidden,false);assert.equal(row.value.textContent,"0");
    assert.equal(row.root.classList.contains("is-previous"),true);assert.equal(row.copy.disabled,true);
});
test("valid edits debounce, keep formula focus, and put the value in its own card",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    const row=h.view.cards.get(card.id);row.expression.focus();
    h.controller.editStatistic(card.id,{expression:"sum(a)"});assert.equal(h.submits(),0);
    assert.equal(h.document.activeElement,row.expression);await h.tick();assert.equal(h.submits(),1);
    assert.equal(card.pending,true);await h.finish("ready",["42"]);
    assert.equal(card.current,true);assert.equal(row.value.textContent,"42");assert.equal(row.statusRow.hidden,true);
    assert.equal(row.run.hidden,true);assert.equal(h.document.activeElement,row.expression);
    h.controller.editStatistic(card.id,{expression:"bad(a)"});await h.tick();
    assert.equal(h.submits(),1);assert.equal(row.value.textContent,"42");assert.match(row.status.textContent,/Previous value/);
    assert.match(row.status.textContent,/Unknown function/);assert.equal(row.expression.getAttribute("aria-invalid"),"true");
});
test("renaming pending and completed statistics neither cancels nor recalculates",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();const calls=h.requests.length;
    h.controller.editStatistic(card.id,{label:"My summary"});await h.tick();assert.equal(h.requests.length,calls);
    await h.finish();assert.equal(card.current,true);
    h.controller.editStatistic(card.id,{label:""});await h.tick();assert.equal(h.submits(),1);assert.equal(card.current,true);
});
test("previous values are marked as being replaced during validation, planning, and calculation", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();await h.finish();
    const row=h.view.cards.get(card.id);
    h.controller.editStatistic(card.id,{expression:"sum(a)"});
    assert.equal(row.root.classList.contains("is-previous"),true);
    assert.equal(row.status.textContent,"Previous value · Checking formula…");
    assert.equal(row.statusRow.hidden,false);
    assert.equal(row.value.textContent,"12.5");
    await h.tick();
    assert.equal(row.status.textContent,"Previous value · Calculating…");
    await h.finish("ready",["42"]);
    assert.equal(row.root.classList.contains("is-previous"),false);
    assert.equal(row.status.textContent,"");
    assert.equal(row.statusRow.hidden,true);
    assert.equal(row.value.textContent,"42");
    h.controller.editStatistic(card.id,{expression:"bad(a)"});await h.tick();
    assert.equal(row.root.classList.contains("is-previous"),true);
    assert.equal(row.status.textContent,"Previous value · Unknown function bad");
});
test("copy uses exact current values without rounding or units and never submits work", async()=>{
    const copied=[];
    const h=fixture({},new Map(),{clipboard:{writeText:async value=>copied.push(value)}});
    await h.open();const card=h.controller.state.statistics[0],row=h.view.cards.get(card.id);
    assert.equal(row.copy.hidden,true);
    h.controller.request(card.id,"manual");await flush();await h.finish("ready",["9007199254740993"]);
    card.result.row.valueType="integer";card.result.row.unit="ha";h.controller.render();
    const requests=h.requests.length;
    row.copy.dispatchEvent(new Event("click"));await flush();
    assert.deepEqual(copied,["9007199254740993"]);
    assert.equal(row.copyStatus.textContent,"Copied exact value");
    assert.equal(h.requests.length,requests);
    h.controller.editStatistic(card.id,{expression:"sum(a)"});
    assert.equal(row.copy.disabled,true);assert.equal(row.copyStatus.hidden,true);
    await h.view.copyCurrentValue(card.id);assert.equal(copied.length,1);
    await h.tick();await h.finish("ready",["0"]);
    assert.equal(row.copy.disabled,false);await h.view.copyCurrentValue(card.id);
    assert.deepEqual(copied,["9007199254740993","0"]);
    card.result.row.value=null;card.result.row.state="no_valid_data";h.controller.render();
    assert.equal(row.copy.disabled,true);await h.view.copyCurrentValue(card.id);
    assert.equal(copied.length,2);
});
test("one status region beside the value retains manual controls and non-numeric result explanations", async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0],row=h.view.cards.get(card.id);
    const heading=row.root.children[0];
    assert.equal(heading.contains(row.status),true);
    assert.equal(heading.contains(row.run),true);
    assert.equal(row.expression.getAttribute("aria-describedby"),row.status.id);
    assert.equal(row.status.textContent,"Ready to calculate");
    row.run.dispatchEvent(new Event("click"));await flush();
    assert.equal(h.submits(),1);assert.equal(row.stop.hidden,false);
    await h.finish();assert.equal(row.statusRow.hidden,true);
    for (const [state,message] of [
        ["no_matches","No cells matched the condition."],
        ["no_valid_data","No valid cells in this area."],
        ["invalid_arithmetic","Undefined arithmetic; no numeric result."],
        ["overflow","Numeric overflow; no finite result."],
    ]) {
        card.result.row.value=null;card.result.row.state=state;h.controller.render();
        assert.equal(row.status.textContent,message);
        assert.equal(row.statusRow.hidden,false);assert.equal(row.run.hidden,true);
        assert.equal(row.copy.disabled,true);
    }
});
test("unavailable or denied clipboard access exposes exact-value details without throwing", async()=>{
    for (const clipboard of [null,{writeText:async()=>{throw Error("Denied");}}]) {
        const h=fixture({},new Map(),{clipboard});await h.open();const card=h.controller.state.statistics[0];
        h.controller.request(card.id,"manual");await flush();await h.finish();
        const row=h.view.cards.get(card.id);await h.view.copyCurrentValue(card.id);
        assert.match(row.copyStatus.textContent,/Could not copy/);
        assert.equal(row.details.open,true);assert.equal(row.copy.disabled,false);
        assert.equal(h.submits(),1);
    }
});
test("late clipboard feedback cannot label an edited, replaced, removed, or disposed value as copied", async()=>{
    for (const change of ["edit","replace","remove","dispose"]) {
        const writing=deferred();let writes=0;
        const h=fixture({},new Map(),{clipboard:{writeText:()=>{writes++;return writing.promise;}}});
        await h.open();const card=h.controller.state.statistics[0];
        h.controller.request(card.id,"manual");await flush();await h.finish();
        const row=h.view.cards.get(card.id);
        const copying=h.view.copyCurrentValue(card.id);
        await h.view.copyCurrentValue(card.id);assert.equal(writes,1);
        if (change==="remove") h.controller.removeStatistic(card.id);
        else if (change==="dispose") h.view.unbind();
        else {
            h.controller.editStatistic(card.id,{expression:"sum(a)"});
            if (change==="replace") {await h.tick();await h.finish("ready",["42"]);}
        }
        writing.resolve();await copying;
        assert.notEqual(row.copyStatus.textContent,"Copied exact value");
        if (change==="edit") assert.equal(row.copy.disabled,true);
        if (change==="replace") assert.equal(row.copy.disabled,false);
    }
});
test("one invalid formula does not block a valid peer or move values between cards",async()=>{
    const h=fixture();await h.open();h.controller.addStatistic("count");
    const [first,second]=h.controller.state.statistics;
    h.controller.editStatistic(first.id,{expression:"bad(a)"});await h.tick();
    assert.equal(h.submits(),1);assert.equal(first.valid,false);assert.equal(second.pending,true);
    await h.finish("ready",["7"]);assert.equal(first.result,null);assert.equal(second.result.row.value,"7");
});
test("dirty statistics sharing a source use one scan; different sources run sequentially",async()=>{
    const h=fixture();await h.open();h.controller.setAutomatic(false);h.controller.addStatistic("count");await h.tick();
    h.controller.setAutomatic(true);const [a,b]=h.controller.state.statistics;
    h.controller.editStatistic(a.id,{expression:"max(a)"});h.controller.editStatistic(b.id,{expression:"count(a > 2)"});await h.tick();
    assert.equal(h.submits(),1);assert.equal(h.controller.engine.record.intent.calculations.length,2);
    await h.finish("ready",["22","8"]);assert.equal(a.result.row.value,"22");assert.equal(b.result.row.value,"8");
    h.controller.editStatistic(a.id,{expression:"min(a)"});h.controller.editStatistic(b.id,{source:resistance});await h.tick();
    assert.equal(h.submits(),2);await h.finish();assert.equal(h.submits(),3);
    assert.equal(h.controller.engine.record.intent.source.itemId,"resistance");await h.finish();
});
test("duplicate statistic names are valid and are not sent in one duplicate-label request",async()=>{
    const h=fixture();await h.open();h.controller.setAutomatic(false);h.controller.addStatistic("mean");await h.tick();
    for(const card of h.controller.state.statistics) h.controller.request(card.id,"manual");await flush();
    assert.equal(h.controller.engine.record.intent.calculations.length,1);await h.finish();assert.equal(h.submits(),2);await h.finish();
});
test("edits cancel obsolete work and wait for terminal cancellation before replacement",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();await h.finish("ready",["10"]);
    h.controller.editStatistic(card.id,{expression:"max(a)"});await h.tick();
    h.controller.editStatistic(card.id,{expression:"min(a)"});await h.tick();
    assert.equal(h.submits(),2);assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);
    await h.finish("ready",["999"]);assert.equal(card.result.row.value,"10");assert.equal(h.submits(),3);
    await h.finish("ready",["2"]);assert.equal(card.result.row.value,"2");assert.equal(card.current,true);
});
test("late validation cannot enqueue a superseded edit or a removed statistic",async()=>{
    const response=deferred();const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.api.validateCalculation=()=>response.promise;
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();
    h.controller.removeStatistic(card.id);response.resolve({valid:true});await flush();assert.equal(h.submits(),0);
    assert.equal(h.controller.state.statistics.length,0);h.controller.undoRemove();assert.equal(h.controller.state.statistics[0].expression,"sum(a)");
});
test("removing an earlier card preserves peer DOM, value, and formula identity; Undo restores it",async()=>{
    const h=fixture();await h.open();h.controller.addStatistic("count");await h.tick();await h.finish("ready",["7"]);
    const [a,b]=h.controller.state.statistics;const row=h.view.cards.get(b.id);
    const removed=h.view.cards.get(a.id);
    assert.equal(removed.root.children.includes(removed.remove),true);
    assert.equal(removed.remove.children[0].textContent,"Remove this calculation");
    removed.remove.dispatchEvent(new Event("click"));
    assert.equal(h.view.cards.get(b.id),row);assert.equal(row.value.textContent,"7");
    h.controller.undoRemove();assert.equal(h.controller.state.statistics[0].id,a.id);assert.equal(h.view.cards.get(b.id),row);
});
test("manual mode waits for Calculate and accepted manual jobs survive navigation",async()=>{
    const h=fixture();await h.open();h.controller.setAutomatic(false);const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();h.controller.calculateSelection();await h.tick();assert.equal(h.submits(),0);
    h.controller.request(card.id,"manual");h.controller.request(card.id,"manual");await flush();assert.equal(h.submits(),1);
    h.controller.setActive(false);assert.equal(h.requests.filter(r=>r[0]==="cancel").length,0);await h.finish();assert.equal(card.current,true);
});
test("automatic work pauses on navigation and does not restart merely on return",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();h.controller.setActive(false);await flush();
    assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);await h.finish("cancelled");
    h.controller.setActive(true);await h.tick();assert.equal(h.submits(),1);
});
test("large and explicit-area jobs require manual confirmation before submission",async()=>{
    assert.equal(canAutomaticallyCalculate({grid},{area:box(77)}),true);
    assert.equal(canAutomaticallyCalculate({grid:{...grid,decodedBytes:128*1024*1024}},{area:box(77)}),false);
    assert.equal(canAutomaticallyCalculate({grid},{area:{kind:"wholeRaster"}}),false);
    const h=fixture();await h.open();h.controller.chooseArea("whole");await h.tick();const card=h.controller.state.statistics[0];
    assert.equal(h.submits(),0);assert.equal(card.manualRequired,true);assert.equal(h.view.cards.get(card.id).run.hidden,false);
    h.controller.request(card.id,"manual");await flush();assert.equal(h.submits(),1);await h.finish();assert.equal(card.current,true);
});
test("a failed rerun cannot be mistaken for the prior successful job with the same formula",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];h.controller.request(card.id,"manual");await flush();await h.finish();
    h.controller.request(card.id,"manual");await flush();await h.finish("failed");
    assert.match(card.message,/Scan failed/);assert.equal(card.error,true);assert.equal(card.current,false);assert.equal(h.view.cards.get(card.id).run.hidden,false);assert.equal(h.submits(),2);
});
test("uncertain submissions retain the same request identity during recovery",async()=>{
    const h=fixture();await h.open();const original=h.api.submitCalculation;let failed=false;
    h.api.submitCalculation=async submission=>{if(!failed){failed=true;h.requests.push(["uncertain",submission]);throw Error("Connection lost");}return original(submission);};
    const card=h.controller.state.statistics[0];h.controller.request(card.id,"manual");await flush();
    assert.equal(h.controller.state.recoverable,true);const request=h.controller.engine.record.pending.requestId;
    h.controller.engineHandlers.onRetry();await flush();assert.equal(h.requests.find(r=>r[0]==="submit")[1].requestId,request);
    await h.finish();assert.equal(card.current,true);
});
test("exports retain exact integers, null explanations, source, and immutable formula context",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];h.controller.request(card.id,"manual");await flush();await h.finish();
    card.result.row={...card.result.row,value:"9007199254740993",valueType:"integer"};h.controller.render();
    const row=h.view.cards.get(card.id);assert.equal(row.value.textContent,BigInt("9007199254740993").toLocaleString());
    const text=node=>[node.textContent,...node.children.map(text)].join(" ");assert.match(text(row.detailsBody),/Human footprint/);
    assert.match(text(row.detailsBody),/mean\(a\)/);assert.match(row.detailsBody.children.at(-1).children[0].href,/\/result$/);
    card.result.row={...card.result.row,value:null,state:"no_valid_data"};h.controller.render();assert.equal(row.value.textContent,"—");assert.match(text(row.detailsBody),/No valid cells/);
});

test("an accepted manual scan continues in history when Explore changes the shared area",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();h.controller.setActive(false);h.controller.setSelection(box(80));
    assert.equal(h.requests.filter(r=>r[0]==="cancel").length,0);await h.finish();
    assert.equal(card.current,false);assert.equal(h.controller.state.jobs[0].status,"ready");
    h.controller.setActive(true);await h.tick();assert.equal(h.submits(),1);
});
test("clearing a queued automatic request prevents a later validation from running on return",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});h.controller.setActive(false);await h.tick();
    h.controller.setActive(true);await h.tick();assert.equal(h.submits(),0);assert.equal(card.valid,true);
});
test("metadata from an obsolete formula is released before planning its replacement",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];const response=deferred();
    const original=h.api.planCalculation;let first=true;
    h.api.planCalculation=async intent=>{const plan=await original(intent);if(first){first=false;await response.promise;}return plan;};
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();
    h.controller.editStatistic(card.id,{expression:"max(a)"});await h.tick();assert.equal(h.submits(),0);
    response.resolve();await flush();assert.equal(h.submits(),1);assert.equal(h.controller.engine.record.intent.calculations[0].expression,"max(a)");
    const operations=h.requests.map(r=>r[0]);assert.ok(operations.indexOf("discard")<operations.lastIndexOf("plan"));
});
test("unused-plan release failure pauses other automatic cards until an explicit retry",async()=>{
    const h=fixture();await h.open();h.controller.setAutomatic(false);h.controller.addStatistic("count");await h.tick();
    const [a,b]=h.controller.state.statistics;h.controller.setAutomatic(true);
    h.controller.chooseArea("whole");await h.tick();
    h.api.discardPlan=async()=>{throw Error("Release failed");};
    h.controller.chooseArea("selection");await h.tick();assert.equal(h.submits(),0);
    assert.equal(h.controller.engine.blocked,true);assert.equal(a.error,true);
    h.api.discardPlan=async()=>{};h.controller.request(b.id,"manual");await flush();assert.equal(h.submits(),1);
});

test("inspected history refreshes a running job without rewriting the editable cards",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();const jobId=h.controller.engine.record.jobId;
    h.controller.inspect(jobId);assert.equal(h.controller.state.saved.status,"running");
    await h.finish();assert.equal(h.controller.state.saved.status,"ready");assert.equal(h.controller.state.statistics[0],card);
    await h.controller.engine.jobAction(jobId,"delete");await flush();assert.equal(h.controller.state.saved,null);
});
test("reload recovers a manual job into its card without admitting another calculation",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.request(card.id,"manual");await flush();const id=h.controller.engine.record.jobId;h.controller.destroy();
    const restored=fixture({listJobs:async()=>[...h.server.values()],getJob:async id=>h.server.get(id)},h.data);
    await restored.controller.start();assert.equal(restored.submits(),0);assert.equal(restored.controller.engine.record.jobId,id);
    const old=h.server.get(id);h.server.set(id,{...old,status:"ready",result:{url:"/api/processing/jobs/"+id+"/result",provenanceUrl:"/api/processing/jobs/"+id+"/provenance",rows:[{...old.calculations[0],value:"9",valueType:"float",state:"ok",aggregates:[]}]}});
    await restored.jobs.refresh();await flush();assert.equal(restored.controller.state.statistics[0].result.row.value,"9");assert.equal(restored.submits(),0);
});
test("reload cancels recovered automatic work and never resumes sampling on its own",async()=>{
    const h=fixture();await h.open();const card=h.controller.state.statistics[0];
    h.controller.editStatistic(card.id,{expression:"sum(a)"});await h.tick();const id=h.controller.engine.record.jobId;h.controller.destroy();
    const restored=fixture({listJobs:async()=>[...h.server.values()],getJob:async id=>h.server.get(id),cancelJob:async id=>{const job={...h.server.get(id),status:"cancelled"};h.server.set(id,job);return job;}},h.data);
    await restored.controller.start();await flush();await restored.jobs.refresh();await flush();
    assert.equal(h.server.get(id).status,"cancelled");assert.equal(restored.submits(),0);assert.equal(restored.controller.state.statistics[0].result,null);
});
