import test from "node:test";
import assert from "node:assert/strict";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { RasterSeriesController } from "../../src/raster/series.js";
import { CalculationQueue } from "../../src/processing/calculation-queue.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";

/** @param {number} west Longitude. @return {Object} Valid sampling box. */
const box = west => ({kind:"selectedArea",selectedBounds:{west,south:0,east:west+1,north:1}});
/** @param {string} id Catalog item ID. @return {Object} Retained raster snapshot. */
const source = id => ({key:id,label:"Raster "+id,item:{collection:"catalog",id},visible:true});
/** @return {Promise<void>} Drain queued lifecycle callbacks. */
const flush = async () => { for (let i=0;i<120;i++) await Promise.resolve(); };
/** @return {{promise:Promise,resolve:Function,reject:Function}} Controllable transport response. */
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };

/** Exercise the real queue/executor/job observer against an observable Processing API.
 * @param {Object} [overrides={}] API fault injection.
 * @param {Map} [data=new Map()] Saved recovery record.
 * @return {Object} Controllers, captured requests and explicit clock/job completion.
 */
function fixture(overrides = {}, data = new Map()) {
    const requests=[],plans=new Map(),server=new Map(),timers=new Map();let serial=0,time=0;
    const clock={setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}};
    const grid={nativeBlocks:1,decodedBytes:100,width:10,height:10,crs:"EPSG:4326"};
    const api={
        validateCalculation:async formulas=>{requests.push(["validate",formulas]);return {valid:true};},
        planCalculation:async intent=>{const planId=String(++serial).padStart(32,"0");requests.push(["plan",intent]);plans.set(planId,intent);return {planId,grid,expiresAt:"2099-01-01T00:00:00Z"};},
        discardPlan:async id=>{requests.push(["discard",id]);},
        submitCalculation:async submission=>{
            requests.push(["submit",submission]);
            if(server.has(submission.planId))return server.get(submission.planId);
            const intent=plans.get(submission.planId);
            const job={jobId:submission.planId,operation:"raster.aggregate.v1",status:"running",progress:{phase:"calculating",completedBlocks:0,totalBlocks:1},grid,
                calculations:intent.calculations,sources:{a:intent.source},result:null};
            server.set(job.jobId,job);return job;
        },
        listJobs:async()=>[...server.values()],getJob:async id=>server.get(id),
        cancelJob:async id=>{requests.push(["cancel",id]);const job={...server.get(id),status:"cancelling"};server.set(id,job);return job;},
        ...overrides,
    };
    const storage=new CalculationSessionStorage({getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)});
    const jobs=new ProcessingJobs(api,clock);
    const queue=new CalculationQueue({api,jobs,storage,now:()=>time,requestId:()=>"request-"+String(++serial).padStart(16,"0")});
    const area=new RasterSeriesCalculations({api,queue,clock,now:()=>time});
    const view={bind(actions){this.actions=actions;},render(state){this.state=state;},downloadCsv(csv){this.csv=csv;}};
    const controller=new RasterSeriesController({view,areaStatistics:area,samplePoint:async()=>({inBounds:true,value:1}),onClose(){},onEditArea(){}});
    controller.updateAvailableRasters([source("1"),source("2")]); controller.setArea(box(0),"First box");
    const tick=async()=>{for(const[id,t]of [...timers])if(t.delay===700){timers.delete(id);t.fn();}await flush();};
    const finish=async(status="ready",cacheHit=false)=>{
        const old=[...server.values()].find(job=>["running","cancelling"].includes(job.status));
        assert.ok(old,"an active job exists");
        time+=100;
        server.set(old.jobId,{...old,status,result:status==="ready"?{cacheHit,rows:old.calculations.map((row,i)=>({...row,value:i?"22":"-123.4567890123456789",unit:row.expression.startsWith("areaha")?"ha":null,state:"ok",valueType:"float",aggregates:[]}))}:null,error:status==="failed"?{detail:"Raster unavailable"}:null});
        await jobs.refresh();await flush();return old.jobId;
    };
    const open=async()=>{controller.setMode("area");controller.updateSamplingForPanelVisibility(true);await tick();};
    const close=()=>{area.destroy();queue.executor.destroy();jobs.destroy();};
    return {api,queue,jobs,storage,data,area,controller,view,requests,plans,server,grid,tick,finish,open,close};
}

test("formulas share one job per source, retain exact scalar/unit CSV, and presentation edits do not recalculate",async()=>{
    const h=fixture();h.controller.addFormula("area");await h.open();
    assert.equal(h.requests.filter(([k])=>k==="submit").length,1);
    assert.equal(h.requests.find(([k])=>k==="plan")[1].calculations.length,2);
    await h.finish();await h.finish("ready",true);
    assert.equal(h.area.complete,true);
    assert.equal(h.requests.filter(([k])=>k==="submit").length,2);
    const before=h.requests.length;
    h.view.actions.onOrder("name","reverse");
    h.view.actions.onChartType("scatter");
    h.controller.editFormula(1,{label:"Renamed"});
    h.view.actions.onStatistic(2);
    assert.match(h.view.state.axisLabel,/ha/);
    assert.deepEqual(h.view.state.rows.map(row=>row.rawValue),["22","22"]);
    const csv=h.controller.exportCsv();
    assert.match(csv,/"-123.4567890123456789"/);
    assert.match(csv,/"Renamed","mean\(a\)"/);
    assert.match(csv,/"area"/);
    assert.match(csv,/"job_id"/);
    assert.equal(h.requests.length,before);
    h.close();
});

test("large stacks get one confirmation; cached whole-raster plans need none",async()=>{
    const h=fixture();h.controller.chooseArea("whole");await h.open();
    assert.equal(h.area.confirmation,true);
    assert.equal(h.requests.filter(([k])=>k==="submit").length,0);
    await h.area.calculateRemainingRasters();await flush();await h.finish();await h.finish();
    assert.equal(h.area.confirmation,false);assert.equal(h.area.complete,true);
    h.close();
    const cached=fixture();const original=cached.api.planCalculation;
    cached.api.planCalculation=async intent=>({...await original(intent),cacheHit:true});
    cached.controller.chooseArea("whole");await cached.open();await cached.finish("ready",true);await cached.finish("ready",true);
    assert.equal(cached.area.complete,true);assert.equal(cached.area.confirmation,false);cached.close();
});

test("automatic work budget covers the stack, not just each individual raster",async()=>{
    const h=fixture();h.grid.nativeBlocks=80;await h.open();await h.finish();
    assert.equal(h.area.confirmation,true);
    assert.equal(h.area.results.size,1);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,1);
    await h.area.calculateRemainingRasters();await flush();await h.finish();
    assert.equal(h.area.complete,true);h.close();
});

test("rapid area changes cancel submitted work and never mix old-area rows",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    h.controller.setArea(box(10),"Second");await h.tick();
    assert.ok(h.view.state.previousRows);assert.equal(h.view.state.rows.some(row=>row.state==="value"),false);
    h.controller.setArea(box(20),"Third");await h.tick();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,1);
    await h.finish("cancelled");await flush();
    const planned=h.requests.filter(([kind])=>kind==="plan").at(-1)[1];
    assert.equal(planned.area.selectedBounds.west,20);
    await h.finish();await h.finish();
    assert.equal(h.area.results.size,2);
    for(const result of h.area.results.values())assert.equal(result.intent.area.selectedBounds.west,20);
    h.close();
});

test("leaving area mode drops the pending stack and waits for acknowledged cancellation",async()=>{
    const h=fixture();await h.open();h.controller.setMode("pixel");await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,1);
    await h.finish("cancelled");
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,1);
    assert.equal(h.area.results.size,0);h.close();
});

test("per-raster failure leaves a gap and proceeds to the next raster",async()=>{
    const h=fixture();await h.open();await h.finish("failed");await h.finish();
    assert.equal(h.area.complete,true);
    assert.equal(h.view.state.rows[0].state,"error");
    assert.equal(h.view.state.rows[1].state,"value");
    assert.match(h.controller.exportCsv(),/Raster unavailable/);h.close();
});

test("summary and series take turns without receiving each other's results",async()=>{
    const h=fixture();const snapshots=[];
    const summary=h.queue.createClient("summary",state=>{snapshots.push(state);if(state.isIdle&&state.plan)summary.submit(state.plan.planId);});
    await h.open();
    summary.prepare({source:{collectionId:"catalog",itemId:"summary",label:"Summary"},area:box(0),calculations:[{label:"Mean",expression:"mean(a)"}]});
    await h.finish(); // first series raster finishes
    assert.equal([...h.server.values()].find(job=>job.status==="running").sources.a.itemId,"summary");
    assert.ok(snapshots.every(state=>!state.completedJob||state.completedJob.sources.a.itemId==="summary"));
    await h.finish(); // summary then second series
    assert.equal([...h.server.values()].find(job=>job.status==="running").sources.a.itemId,"2");
    await h.finish();assert.equal(h.area.complete,true);h.close();
});

test("obsolete plan responses are released before new work is submitted",async()=>{
    const h=fixture();const gate=deferred(),original=h.api.planCalculation;
    let first=true;h.api.planCalculation=async intent=>{const plan=await original(intent);if(first){first=false;await gate.promise;}return plan;};
    await h.open();h.controller.setArea(box(30),"New");await h.tick();gate.resolve();await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="discard").length,2); // old plan and submitted new plan
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,1);
    assert.equal([...h.server.values()][0].sources.a.itemId,"1");h.close();
});

test("uncertain submissions keep the original key and cannot leak into summary recovery",async()=>{
    const h=fixture();const submit=h.api.submitCalculation;let lost=true;
    h.api.submitCalculation=async input=>{const job=await submit(input);if(lost){lost=false;throw Error("Connection lost");}return job;};
    await h.open();
    assert.equal(h.area.client.snapshot.recoverable,true);
    const saved=h.storage.read();
    assert.equal(saved.context.client,"raster-series");
    const observed=[];
    h.queue.createClient("summary",state=>observed.push(state));
    await h.area.recover();await flush();
    const submissions=h.requests.filter(([kind])=>kind==="submit");
    assert.equal(submissions.length,2);assert.deepEqual(submissions[0][1],submissions[1][1]);
    assert.ok(observed.every(state=>!state.unfinishedCalculation));
    await h.finish();await h.finish();
    assert.equal(h.area.complete,true);
    assert.equal(h.area.results.size,2);h.close();
});

test("recovery routes a stored series job to its caller, and cancels it without restarting the stack",async()=>{
    const h=fixture();await h.open();const record=h.storage.read(), old=[...h.server.values()][0];h.close();
    const recovered=fixture({},h.data);
    recovered.server.set(old.jobId,old);
    const summary=recovered.queue.createClient("summary",()=>{});
    assert.equal(summary.snapshot.unfinishedCalculation,null);
    assert.deepEqual(recovered.area.client.snapshot.unfinishedCalculation.calculation,record.intent);
    await recovered.area.start();await flush();
    assert.equal(recovered.requests.filter(([kind])=>kind==="cancel").length,1);
    await recovered.finish("cancelled");
    assert.equal(recovered.requests.filter(([kind])=>kind==="submit").length,0);
    assert.equal(recovered.storage.read(),null);recovered.close();
});


test("catalog predicates and annotation uploads remain exact per-raster inputs",async()=>{
    for (const area of [{kind:"catalogSelection",catalogSelection:CATALOG_SELECTION},
        {kind:"polygonArea",polygonArea:{id:"a".repeat(32),sha256:"b".repeat(64)}}]) {
        const h=fixture();h.controller.setArea(area,"Selected polygons");await h.open();
        assert.equal(h.area.confirmation,true);
        await h.area.calculateRemainingRasters();await flush();await h.finish();await h.finish();
        for(const [,intent]of h.requests.filter(([kind])=>kind==="plan"))assert.deepEqual(intent.area,area);
        assert.equal(h.area.complete,true);h.close();
    }
});

test("inline cached completions retain all source positions without queuing extra jobs",async()=>{
    const h=fixture(),plan=h.api.planCalculation,submit=h.api.submitCalculation;
    h.api.planCalculation=async intent=>({...await plan(intent),cacheHit:true});
    h.api.submitCalculation=async input=>{
        const job=await submit(input);
        const ready={...job,status:"ready",result:{cacheHit:true,rows:job.calculations.map(row=>({...row,value:"0",state:"ok",valueType:"float",aggregates:[]}))}};
        h.server.set(job.jobId,ready);return ready;
    };
    h.controller.chooseArea("whole");await h.open();await flush();
    assert.equal(h.area.complete,true);
    assert.deepEqual(h.view.state.rows.map(row=>row.value),[0,0]);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);h.close();
});

test("formula validation and five-formula limit apply before any raster plan",async()=>{
    const h=fixture({validateCalculation:async()=>{throw Error("Unknown function bad");}});
    h.controller.editFormula(1,{expression:"bad(a)"});
    for(let i=0;i<8;i++)h.controller.addFormula("mean");
    assert.equal(h.controller.formulas.length,5);
    await h.open();
    assert.match(h.view.state.message,/Unknown function bad/);
    assert.equal(h.requests.filter(([kind])=>kind==="plan").length,0);h.close();
});

test("closing and reopening a completed area plot preserves its result and completion message",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    const count=h.requests.length;
    h.controller.updateSamplingForPanelVisibility(false);h.controller.updateSamplingForPanelVisibility(true);await h.tick();
    assert.match(h.view.state.message,/Raster series complete/);
    assert.equal(h.requests.length,count);h.close();
});

test("one queued caller can replace and cancel its request without cancelling its peer",async()=>{
    const h=fixture();await h.open();
    const summary=h.queue.createClient("summary",()=>{});
    const intent={source:{collectionId:"catalog",itemId:"summary",label:"Summary"},area:box(0),calculations:[{label:"Sum",expression:"sum(a)"}]};
    summary.prepare(intent);summary.prepare({...intent,area:box(10)});summary.stop();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,0);
    await h.finish();await h.finish();
    assert.ok(h.requests.filter(([kind])=>kind==="plan").every(([,intent])=>intent.source.itemId!=="summary"));
    assert.equal(h.area.complete,true);h.close();
});
