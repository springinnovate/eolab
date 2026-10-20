import test from "node:test";
import assert from "node:assert/strict";
import { calculationIntent, CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { PendingSubmissionStorage } from "../../src/processing/pending-submission.js";
import { ProcessingApiClient } from "../../src/processing/api.js";

/** @return {Object} Valid unfinished submission with a recoverable request key. */
function record() {
    return {intent:{source:{collectionId:"catalog",itemId:"raster",label:"Raster"},
        area:{kind:"wholeRaster"},calculations:[{label:"Sum",expression:"sum(a)"}]},
    jobId:null,pending:{requestId:"request-original-1234"},
    cancelRequested:false,context:{automatic:true}};
}

/** @param {Map} [data=new Map()] Saved records. @return {Object} Browser storage double. */
function storage(data = new Map()) {
    return {get length(){return data.size;},key:index=>[...data.keys()][index]??null,
        getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
}

test("independent records preserve each request key and clearing one cannot clear its peers",()=>{
    const data=new Map(), root=new CalculationSessionStorage(storage(data));
    for(const name of ["summary","raster-series:0","raster-series:49"]) {
        root.forClient(name).write({...record(),pending:{requestId:"request-original-"+name.replace(":","-")}});
    }
    root.forClient("raster-series:0").clear();
    assert.deepEqual(root.savedClientNames(),["summary","raster-series:49"]);
    assert.equal(root.read().pending.requestId,"request-original-summary");
    assert.equal(root.forClient("raster-series:49").read().pending.requestId,"request-original-raster-series-49");
    root.forClient("raster-series:500").write(record());
    assert.deepEqual(root.savedClientNames(),["summary","raster-series:49","raster-series:500"]);
    for (const name of ["raster-series:-1", "raster-series:01", "raster-series:9007199254740992"]) {
        assert.throws(()=>root.forClient(name),/Unsupported/);
    }
    assert.throws(()=>root.forClient("another-user"),/Unsupported/);
});

test("map-query recovery positions are isolated from fixed summary and raster stack records", () => {
    const root = new CalculationSessionStorage(storage());
    for (const client of ["summary", "raster-series:0", "summary-query:0", "summary-query:64"]) {
        root.forClient(client).write({ ...record(), context: { automatic: true, client: client.split(":")[0] } });
    }
    assert.deepEqual(new Set(root.savedClientNames()), new Set(["summary", "raster-series:0", "summary-query:0", "summary-query:64"]));
    root.forClient("summary-query:0").clear();
    assert.ok(root.read()); assert.ok(root.forClient("raster-series:0").read());
    assert.equal(root.forClient("summary-query:64").read().pending.requestId, "request-original-1234");
    for (const client of ["summary-query:-1", "summary-query:01", "summary-query:9007199254740992", "summary-query:other"]) {
        assert.throws(() => root.forClient(client), /Unsupported/);
    }
});

test("legacy summary and series records migrate only to their owner without changing the submission",()=>{
    for(const client of [undefined,"summary","raster-series"]) {
        const data=new Map(), saved=record(), {context,...execution}=saved;
        data.set("eolab.processing.calculation.v1",JSON.stringify({...execution,automatic:context.automatic,...(client?{client}:{})}));
        const root=new CalculationSessionStorage(storage(data));
        const owner=client==="raster-series"?"raster-series:0":"summary";
        assert.deepEqual(root.savedClientNames(),[owner]);
        const scoped=root.forClient(owner), recovered=scoped.read();
        assert.deepEqual(recovered.pending,saved.pending);
        scoped.write(recovered);
        assert.equal(data.has("eolab.processing.calculation.v1"),false);
        assert.equal(data.has("eolab.processing.calculation.v2."+owner),true);
        assert.deepEqual(scoped.read(),recovered);
    }
});

for (const operation of ["clip", "calculation"]) {
    test(`${operation} recovery preserves its vector HTTP request`, async () => {
        const selection = {collectionId: "eolab-mounted-vectors", itemId: "countries", assetKey: "data", layerName: "countries",
            filter: {enabled: false, match: "all", rules: []}};
        const saved = record(), backing = storage(), requests = [];
        saved.intent.area = {kind: "catalogSelection", catalogSelection: selection};
        const requestId = saved.pending.requestId;
        const api = new ProcessingApiClient(async (url, options) => {
            if (url.endsWith("/jobs")) return new Response(JSON.stringify({jobs: []}));
            const payload = JSON.parse(options.body);
            requests.push(url.endsWith("/batch") ? payload.items[0] : payload);
            const job = {jobId: "a".repeat(32), operation: operation === "clip" ? "raster.clip.v1" : "raster.aggregate.v1",
                status: "queued", progress: {}, result: null};
            return new Response(JSON.stringify(url.endsWith("/batch") ? {items: [{index: 0, job}]} : job));
        });
        if (operation === "clip") {
            new PendingSubmissionStorage(backing).write({...saved.intent, requestId, label: "Saved clip"});
            await api.submitClip(new PendingSubmissionStorage(backing).read());
        } else {
            new CalculationSessionStorage(backing).write(saved);
            const restored = new CalculationSessionStorage(backing).read();
            await api.submitCalculation({...restored.intent, requestId: restored.pending.requestId});
        }
        const source = {collectionId: saved.intent.source.collectionId, itemId: saved.intent.source.itemId};
        assert.deepEqual(requests, [{requestId, catalogSelection: selection,
            ...(operation === "clip" ? source : {sources: {a: source}, calculations: saved.intent.calculations})}]);
    });
}

test("failed migration preserves the legacy key and an independent peer record",()=>{
    const data=new Map(), backing=storage(data), root=new CalculationSessionStorage(backing);
    root.forClient("raster-series:1").write(record());
    data.set("eolab.processing.calculation.v1",JSON.stringify({...record(),automatic:true,client:"raster-series"}));
    const owner=root.forClient("raster-series:0"), original=owner.read();
    backing.setItem=()=>{throw Error("Storage full");};
    assert.throws(()=>owner.write(original),/Storage full/);
    assert.deepEqual(owner.read(),original);
    assert.deepEqual(root.savedClientNames(),["raster-series:0","raster-series:1"]);
});

test("malformed and oversized records do not affect valid peer recovery",()=>{
    const data=new Map(), root=new CalculationSessionStorage(storage(data));
    root.write(record());
    data.set("eolab.processing.calculation.v2.raster-series:0","{");
    data.set("eolab.processing.calculation.v2.raster-series:1"," ".repeat(16385));
    assert.deepEqual(root.savedClientNames(),["summary"]);
    assert.throws(()=>root.forClient("raster-series:2").write({...record(),extra:"x".repeat(16384)}),/too large/);
    assert.deepEqual(root.savedClientNames(),["summary"]);
});

test("pixel clicks survive recovery immutably while area-only intent identity remains unchanged",()=>{
    const original=record(), point={longitude:-122.25,latitude:37.75};
    assert.equal(JSON.stringify(calculationIntent({...original.intent,pixelPoint:point})),JSON.stringify(calculationIntent(original.intent)));
    const intent=calculationIntent({...original.intent,pixelPoint:point,calculations:[{label:"Pixel",expression:"pixelValue(a)"}]});
    const root=new CalculationSessionStorage(storage());root.write({...original,intent});
    point.longitude=5;
    assert.deepEqual(root.read().intent.pixelPoint,{longitude:-122.25,latitude:37.75});
    assert.equal(Object.isFrozen(root.read().intent.pixelPoint),true);
    for(const invalid of [{longitude:181,latitude:0},{longitude:0,latitude:NaN},
        {longitude:0,latitude:91},{longitude:"0",latitude:0},{longitude:0,latitude:0,extra:true}]) {
        assert.throws(()=>calculationIntent({...intent,pixelPoint:invalid}),/valid map point/);
    }
});
