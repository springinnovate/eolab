import assert from "node:assert/strict";
import test from "node:test";
import { CalculationsController } from "../../src/processing/calculations-controller.js";
import { CalculationsView, calculationValue } from "../../src/processing/calculations-view.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const source = { collectionId: "rasters", itemId: "hfp", label: "Human footprint" };
const box = west => ({ kind: "selectedArea", selectedBounds: { west, south: 22, east: west + 1, north: 23 } });
const grid = { width: 100, height: 100, crs: "EPSG:3857", dtype: "float32", transform: [1,0,0,0,-1,0], nativeBlocks: 4, decodedBytes: 10000 };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };

/** Actual shared job store with controlled network transitions and clock. */
function fixture(overrides = {}, data = new Map()) {
    const timers = new Map(); let serial = 0; let id = 0;
    const clock = { setTimeout(fn,delay) { timers.set(++serial,{fn,delay}); return serial; }, clearTimeout(key) { timers.delete(key); } };
    const requests = []; const server = new Map(); const plans = new Map();
    const storage = new CalculationSessionStorage({ getItem: key => data.get(key), setItem: (key,value) => data.set(key,value), removeItem: key => data.delete(key) });
    const api = {
        listJobs: async () => [...server.values()], getJob: async id => server.get(id),
        validateCalculation: async rows => { requests.push(["validate",rows]); return {valid:true}; },
        discardPlan: async id => { requests.push(["discard",id]); },
        planCalculation: async intent => {
            requests.push(["plan", intent]); const planId = String(++id).padStart(32,"0");
            plans.set(planId,intent);
            return {planId, grid, operation:"raster.aggregate.v1", expiresAt:"2099-01-01T00:00:00Z"};
        },
        submitCalculation: async submission => {
            requests.push(["submit",submission]);
            const intent = plans.get(submission.planId) ?? {source,area:box(77),calculations:[{label:"Mean",expression:"mean(a)"}]};
            const jobId = submission.planId;
            const job = {jobId,operation:"raster.aggregate.v1",status:"running", sources:{a:intent.source},calculations:intent.calculations,
                grid,area:{kind:"bounds",bounds:[intent.area.selectedBounds?.west ?? 0,22,(intent.area.selectedBounds?.west ?? 0)+1,23]},progress:{phase:"calculating",completedBlocks:0,totalBlocks:4},result:null};
            server.set(jobId,job); return job;
        },
        cancelJob: async id => { requests.push(["cancel",id]); const job = {...server.get(id),status:"cancelling"}; server.set(id,job); return job; },
        deleteJob: async id => { const job={...server.get(id),status:"deleted",result:null};server.set(id,job);return job; },
        ...overrides,
    };
    const jobs = new ProcessingJobs(api,clock);
    const view = {bind(handlers){this.handlers=handlers;},render(state){this.state=state;},unbind(){}};
    const activity = [];
    const options = {api,jobs,view,storage,getContext:()=>({sources:[source],area:box(77)}),clock,
        onOpen(){},onClose(){},onEditArea(){},onActivity: area=>activity.push(area),requestId:()=>`request-${String(id).padStart(16,"0")}`};
    const controller = new CalculationsController(options);
    const tick = async delay => { const due=[...timers.entries()].filter(([,item])=>item.delay===delay); for(const [key,item]of due){timers.delete(key);item.fn();}await flush(); };
    const finish = async (status="ready",value="12.5") => {
        const old=server.get(controller.record.jobId);
        server.set(old.jobId,{...old,status,result:status==="ready"?{url:`/api/processing/jobs/${old.jobId}/result`,provenanceUrl:`/api/processing/jobs/${old.jobId}/provenance`,rows:[{label:"Mean",expression:"mean(a)",value,valueType:"float",state:"ok",aggregates:[{function:"mean",matchedPixels:8,validPixels:8,invalidArithmeticPixels:0}]}]}:null});
        await jobs.refresh(); await flush();
    };
    const run = async follow => {controller.open();await tick(400);await controller.review();view.handlers.onFollow(!!follow);await controller.review();await controller.run();await flush();};
    return {controller,api,jobs,storage,view,requests,server,plans,tick,finish,run,activity,data,options};
}

test("typing and ordinary box changes validate without planning or job admission", async () => {
    const h=fixture();h.controller.open();h.controller.edit({calculations:[{label:"N",expression:"count(a>10)"}]});
    h.controller.setSelection(box(78));await h.tick(400);
    assert.deepEqual(h.requests.map(r=>r[0]),["validate"]);
    assert.equal(h.view.state.valid,true);
});

test("explicit Run freezes intent, publishes measured progress and inline result", async () => {
    const h=fixture();await h.run(false);
    assert.equal(h.view.state.current.progress.totalBlocks,4);
    assert.deepEqual(h.activity.at(-1),box(77));
    h.controller.setSelection(box(80));assert.equal(h.requests.filter(r=>r[0]==="cancel").length,0);
    await h.finish();assert.equal(h.view.state.result.result.rows[0].value,"12.5");
    assert.equal(h.view.state.resultIsCurrent,false);assert.equal(h.storage.read(),null);
    assert.equal(h.activity.at(-1),null);
});

test("follow clicks cancel old work and retain only the latest area until cancellation completes", async () => {
    const h=fixture();await h.run(true);h.controller.setSelection(box(78));h.controller.setSelection(box(79));
    await h.tick(650);assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);
    assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);
    assert.equal(h.activity.at(-1),null);
    await h.finish("cancelled");
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,2);
    assert.deepEqual(h.controller.record.intent.area,box(79));
    await h.finish();assert.equal(h.view.state.resultIsCurrent,true);
});

test("a stale plan resolving after a newer box never submits and does not strand the latest box", async () => {
    const h=fixture();await h.run(true);await h.finish();
    const old=deferred();let signal;
    const original=h.api.planCalculation;
    h.api.planCalculation=(intent,s)=>{signal=s;return old.promise;};
    h.controller.setSelection(box(78));await h.tick(650);
    h.api.planCalculation=original;h.controller.setSelection(box(79));await h.tick(650);
    assert.ok(signal.aborted);old.resolve({planId:"z".repeat(32)});await flush();
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,2);
    assert.deepEqual(h.controller.record.intent.area,box(79));
});

test("click during submission cancels its eventual accepted job before admitting a replacement", async () => {
    const h=fixture();const acceptance=deferred();const original=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{const job=await original(value);await acceptance.promise;return job;};
    h.controller.open();await h.tick(400);h.view.handlers.onFollow(true);await h.controller.review();void h.controller.run();await flush();
    h.controller.setSelection(box(79));await h.tick(650);
    assert.equal(h.storage.read().cancelRequested,true);
    acceptance.resolve();await flush();assert.equal(h.view.state.current.status,"cancelling");
    h.api.submitCalculation=original;await h.finish("cancelled");
    assert.deepEqual(h.controller.record.intent.area,box(79));
});

test("uncertain submission persists its key and superseded cancellation through reload", async () => {
    const h=fixture();const original=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{await original(value);throw new Error("Response lost");};
    await h.run(true);const saved=h.storage.read();assert.ok(saved.pending);assert.equal(h.view.state.recoverable,true);
    h.controller.destroy();h.api.submitCalculation=original;
    const recovered=new CalculationsController(h.options);await recovered.start();await flush();
    const submissions=h.requests.filter(r=>r[0]==="submit");assert.deepEqual(submissions[0][1],submissions[1][1]);
    assert.equal(recovered.isFollowing,false);assert.equal(h.server.get(saved.pending.planId).status,"cancelling");
});

test("editing formulas or closing pauses follow mode and cancels its job", async () => {
    for(const close of [false,true]){
        const h=fixture();await h.run(true);
        if(close)h.controller.close();else h.controller.edit({calculations:[{label:"Min",expression:"min(a)"}]});
        await flush();assert.equal(h.controller.isFollowing,false);
        assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);
    }
});

test("a completed superseded job cannot replace the prior visible result", async () => {
    const h=fixture();await h.run(true);await h.finish("ready","1");const result=h.view.state.result;
    h.controller.setSelection(box(78));await h.tick(650);
    h.controller.setSelection(box(79));await h.finish("ready","999");
    assert.equal(h.view.state.result.jobId,result.jobId);
    assert.equal(h.view.state.resultIsCurrent,false);
});

test("whole raster and AOI are explicit and never armed by follow checkbox", async () => {
    const h=fixture();h.controller.open();h.controller.chooseArea("whole");h.view.handlers.onFollow(true);
    await h.controller.review();await h.controller.run();await flush();assert.equal(h.controller.isFollowing,false);
    assert.equal(h.controller.record.intent.area.kind,"wholeRaster");
    h.controller.setTemporaryAoi({id:"a".repeat(32)});h.controller.chooseArea("uploaded");await h.controller.review();
    h.controller.setTemporaryAoi(null);assert.equal(h.view.state.plan,null);assert.equal(h.view.state.area,null);
    assert.equal(h.controller.record.intent.area.kind,"wholeRaster");
});

test("capacity refusal pauses follow and errors preserve the last visible result", async () => {
    const h=fixture();await h.run(true);await h.finish();const result=h.view.state.result;
    h.api.planCalculation=async()=>{throw new ProcessingRequestError("Native work limit",422);};
    h.controller.setSelection(box(79));await h.tick(650);
    assert.equal(h.view.state.phase,"error");assert.equal(h.controller.isFollowing,false);
    assert.equal(h.view.state.result,result);assert.match(h.view.state.message,/Native work limit/);
});

for (const [kind, code, message] of [
    ["native blocks", "source_work_too_large", "The selected area's conservative estimate is 1,450 native blocks; the limit is 500 (950 over the limit). Choose a smaller area with an estimate of 500 blocks or fewer."],
    ["decoded bytes", "source_work_too_large", "The selected area requires 3,570 decoded bytes for source values and validity masks; the limit is 3,500 bytes (70 bytes over). Choose a smaller area requiring at most 3,500 decoded bytes."],
    ["AOI geometry", "aoi_too_large", "The selected area's serialized geometry is 240 bytes; the processing limit is 100 bytes (140 bytes over). Simplify the AOI geometry so its processing snapshot is at most 100 bytes, then try again."],
]) {
    test(`${kind} limit details survive the API, follow controller, and panel`, async () => {
        const h = fixture();
        await h.run(true);
        await h.finish();
        const previous = h.view.state.result;
        const client = new ProcessingApiClient(async url => url.endsWith("/jobs")
            ? { ok: true, json: async () => ({ jobs: [] }) }
            : { ok: false, status: 413, json: async () => ({ detail: { code, message } }) });
        h.api.planCalculation = client.planCalculation.bind(client);
        h.controller.setSelection(box(79));
        await h.tick(650);

        assert.equal(h.controller.isFollowing, false);
        assert.equal(h.view.state.message, `${message} Review again to retry.`);
        assert.equal(h.view.state.result, previous);
        assert.equal(h.requests.filter(request => request[0] === "submit").length, 1);
        const document = new FakeRasterControlDocument();
        const view = new CalculationsView(document);
        view.bind(h.view.handlers);
        view.render(h.view.state);
        assert.equal(document.querySelector("#calculations-status").textContent, h.view.state.message);
        assert.equal(view.elements.run.hidden, true);
    });
}

test("unavailable storage refuses submission and expired review requires another estimate", async () => {
    const h=fixture();h.controller.open();await h.controller.review();h.view.state.plan.expiresAt="2000-01-01";
    await h.controller.run();assert.equal(h.requests.filter(r=>r[0]==="submit").length,0);
    await h.controller.review();h.controller.storage=new CalculationSessionStorage(null);await h.controller.run();
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,0);assert.match(h.view.state.message,/storage/);
});

test("shared job polling coalesces concurrent editors and protects accepted jobs", async () => {
    const response=deferred();const h=fixture({listJobs:()=>response.promise});
    const one=h.jobs.refresh();const two=h.jobs.refresh();assert.equal(one,two);
    h.jobs.accept({jobId:"a",status:"queued"});response.resolve([]);await one;
    assert.equal(h.jobs.jobs.length,1);
});

test("late validation cannot overwrite the latest edit", async () => {
    const response=deferred();const h=fixture({validateCalculation:()=>response.promise});
    h.controller.open();await h.tick(400);h.controller.edit({calculations:[{label:"Other",expression:"wrong"}]});
    response.resolve({valid:true});await flush();assert.equal(h.view.state.valid,false);
});

test("inline values keep large counts lossless, explain nulls, and use owned CSV links", async () => {
    assert.equal(calculationValue({value:"9007199254740993",valueType:"integer"}),BigInt("9007199254740993").toLocaleString());
    assert.equal(calculationValue({value:null}),"—");
    const h=fixture();await h.run(false);await h.finish();
    const doc=new FakeRasterControlDocument();const view=new CalculationsView(doc);view.bind(h.view.handlers);view.render(h.view.state);
    const root=doc.querySelector("#calculations-result");
    const text=node=>[node.textContent,...node.children.map(text)].join(" ");
    assert.match(text(root),/12.5/);assert.match(text(root),/Human footprint/);assert.match(text(root),/Cell coverage/);
    const link=root.children.at(-1).children[0];assert.match(link.href,/\/result$/);assert.equal(link.textContent,"Download CSV");
    const field=view.rows[0].expression;field.focus();view.render(h.view.state);assert.equal(doc.activeElement,field);
});

test("ground-area plans and inline results explain fractional coverage and label hectares", async () => {
    const h = fixture(); await h.run(false); await h.finish();
    const groundArea = {ellipsoid:"WGS84",edgeToleranceMetres:0.1,maximumSegmentMetres:10000,estimatedGeometryCells:0,strategy:"rectilinear"};
    const areaGrid = {...grid,groundArea};
    const row = {...h.view.state.result.result.rows[0],label:"Area",expression:"areaha(a == 4)",unit:"ha",
        aggregates:[{function:"areaha",unit:"ha",matchedPixels:8,validPixels:8,invalidArithmeticPixels:0}]};
    const state = {...h.view.state,plan:{grid:areaGrid},
        result:{...h.view.state.result,grid:areaGrid,result:{...h.view.state.result.result,rows:[row]}}};
    const doc = new FakeRasterControlDocument(); const view = new CalculationsView(doc);
    view.bind(h.view.handlers); view.render(state);
    assert.match(view.elements.plan.textContent, /numeric functions select cell centers/);
    assert.match(view.elements.plan.textContent, /WGS84 ellipsoid, hectares, including partial pixels/);
    const text = node => [node.textContent,...node.children.map(text)].join(" ");
    assert.match(text(view.elements.result), /12.5 ha/);
    assert.match(text(view.elements.result), /Area measurement.*0.1 m chord-deviation target/);
    assert.match(text(view.elements.result), /Result unit: ha/);
    assert.match(text(view.elements.result), /numeric functions use pixel centers/);
});

test("area examples insert editable single-raster expressions without submitting jobs", async () => {
    for (const [template, expression] of [["area-threshold","areaha(a > 10)"],["area-class","areaha(a == 4)"]]) {
        const h = fixture(); h.controller.open(); await h.tick(400);
        const doc = new FakeRasterControlDocument(); const view = new CalculationsView(doc);
        view.bind(h.view.handlers); view.render(h.view.state);
        view.elements.template.value = template;
        view.elements.template.dispatchEvent(new Event("change"));
        assert.equal(h.view.state.calculations.at(-1).expression, expression);
        assert.equal(h.requests.some(request => ["plan","submit"].includes(request[0])), false);
    }
});

test("a pending replacement mutes saved values from the first follow click until completion", async () => {
    const h = fixture();
    await h.run(true); await h.finish();
    const doc = new FakeRasterControlDocument();
    const view = new CalculationsView(doc); view.bind(h.view.handlers);
    const render = () => view.render(h.view.state);
    render();
    const result = view.elements.result;
    assert.equal(result.classList.contains("is-previous"), false);
    assert.equal(view.elements["status-summary"].hidden, true);

    h.controller.setSelection(box(78)); render();
    assert.equal(h.view.state.phase, "waiting");
    assert.equal(result.classList.contains("is-previous"), true);
    assert.equal(result.getAttribute("aria-busy"), "true");
    assert.equal(view.elements["status-summary"].textContent, "Calculating new result…");
    const savedCard = result.children[2];
    await h.tick(650); render();
    assert.equal(result.children[2], savedCard, "progress retains the card and its expanded details");
    h.controller.setSelection(box(79)); await h.tick(650); render();
    assert.equal(h.view.state.current.status, "cancelling");
    assert.equal(view.elements["status-summary"].hidden, false, "replacement remains pending while the prior job cancels");
    await h.finish("cancelled"); render();
    assert.equal(result.classList.contains("is-previous"), true);
    await h.finish("ready", "42"); render();
    assert.equal(result.children[2].children[1].textContent, "42");
    assert.equal(result.classList.contains("is-previous"), false);
    assert.equal(result.getAttribute("aria-busy"), "false");
    assert.equal(view.elements["status-summary"].hidden, true);
});

test("rerunning unchanged settings marks the saved result as previous, but reviewing alone does not", async () => {
    const h = fixture(); await h.run(false); await h.finish();
    const doc = new FakeRasterControlDocument();
    const view = new CalculationsView(doc); view.bind(h.view.handlers);
    const response = deferred(); const plan = h.api.planCalculation;
    h.api.planCalculation = () => response.promise;
    const review = h.controller.review(); view.render(h.view.state);
    assert.equal(view.elements["status-summary"].hidden, true);
    assert.equal(view.elements.result.classList.contains("is-previous"), false);
    response.resolve(await plan(h.controller.intent())); await review;
    h.api.planCalculation = plan;
    await h.controller.rerun(); view.render(h.view.state);
    assert.equal(h.view.state.resultIsCurrent, true);
    assert.equal(view.elements.result.classList.contains("is-previous"), true);
    assert.equal(view.elements.result.children[0].textContent, "Previous / saved result");
    assert.equal(view.elements["status-summary"].textContent, "Calculating new result…");
    h.controller.stop(); await flush(); view.render(h.view.state);
    assert.equal(view.elements["status-summary"].hidden, true, "stopping does not promise another result");
    assert.equal(view.elements.result.getAttribute("aria-busy"), "false");
});

test("refused and uncertain replacement requests clear the busy banner while preserving saved results", async () => {
    for (const stage of ["planCalculation", "submitCalculation"]) {
        const h = fixture(); await h.run(true); await h.finish();
        h.api[stage] = async () => { throw new Error("Request failed"); };
        h.controller.setSelection(box(78)); await h.tick(650);
        const doc = new FakeRasterControlDocument();
        const view = new CalculationsView(doc); view.bind(h.view.handlers); view.render(h.view.state);
        assert.equal(view.elements["status-summary"].hidden, true);
        assert.equal(view.elements["status-region"].classList.contains("is-working"), false);
        assert.equal(view.elements.result.classList.contains("is-previous"), true);
        assert.match(view.elements.status.textContent, /Request failed/);
        assert.equal(view.elements.result.getAttribute("aria-busy"), "false");
    }
});

test("calculation API serializes identities, explicit scopes, and useful validation errors", async () => {
    const calls=[];
    const api=new ProcessingApiClient(async(url,options)=>{
        calls.push([url,options]);
        if(url.endsWith("/jobs"))return {ok:true,json:async()=>({jobs:[]})};
        return {ok:false,status:422,json:async()=>({detail:[{msg:"Unknown alias b"}]})};
    });
    await assert.rejects(api.validateCalculation([{label:"N",expression:"sum(b)"}]),/Unknown alias b/);
    assert.deepEqual(JSON.parse(calls[1][1].body),{alias:"a",calculations:[{label:"N",expression:"sum(b)"}]});
    assert.equal(calls[1][1].headers["X-EOLab-Processing"],"1");
});

test("stopping a metadata review leaves the editor usable and ignores its late result", async () => {
    const response=deferred();const h=fixture({planCalculation:()=>response.promise});
    h.controller.open();const review=h.controller.review();h.controller.stop();
    response.resolve({planId:"x".repeat(32)});await review;
    assert.equal(h.view.state.phase,"idle");assert.equal(h.view.state.plan,null);assert.equal(h.view.state.hasWork,false);
});

test("leaving raster coverage pauses follow and cancels rather than relabeling old results", async () => {
    const h=fixture();await h.run(true);h.controller.setSelection(null);await flush();
    assert.equal(h.controller.isFollowing,false);assert.equal(h.view.state.area,null);
    assert.equal(h.requests.filter(r=>r[0]==="cancel").length,1);
});

test("a used review is released after acceptance; failed release is recoverable without resubmitting", async () => {
    const h=fixture({discardPlan:async()=>{throw new Error("Connection lost");}});
    await h.run(false);assert.equal(h.view.state.recoverable,true);
    assert.ok(h.controller.record.releasePlanId);assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);
    h.api.discardPlan=async()=>({discarded:true});h.view.handlers.onRetry();await flush();
    assert.equal(h.controller.record.releasePlanId,null);
    assert.equal(h.requests.filter(r=>r[0]==="submit").length,1);
});
