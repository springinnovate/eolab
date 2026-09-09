import assert from "node:assert/strict";
import test from "node:test";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { calculationIntent } from "../../src/processing/calculation-session.js";

const intent={source:{collectionId:"r",itemId:"r1",label:"Raster"},area:{kind:"wholeRaster"},calculations:[{label:"Mean",expression:"mean(a)"}]};
const execution={targetChunkPixels:65536,readWidth:512,readHeight:128,evaluationWidth:512,evaluationHeight:128,readWindows:1};
const grid={width:512,height:128,crs:"EPSG:4326",dtype:"float32",transform:[1,0,0,0,-1,90],nativeBlocks:4,decodedBytes:262144,execution};
const plan={planId:"P".repeat(32),operation:"raster.aggregate.v1",expiresAt:"2099-01-01T00:00:00Z",grid};

test("API transmits opt-in batch tuning and keeps omitted legacy requests compatible",async()=>{
    const bodies=[];
    const api=new ProcessingApiClient(async(path,options)=>{
        if(path.endsWith("/jobs"))return Response.json({jobs:[]});
        bodies.push(JSON.parse(options.body));return Response.json(plan);
    });
    await api.planCalculation(calculationIntent({...intent,targetChunkPixels:65536}));
    await api.planCalculation(calculationIntent(intent));
    assert.equal(bodies[0].targetChunkPixels,65536);
    assert.equal(Object.hasOwn(bodies[1],"targetChunkPixels"),false);
    for(const bad of [0,-1,4194305,1.5,"65536",true]){
        assert.throws(()=>calculationIntent({...intent,targetChunkPixels:bad}),/Batch size/);
    }
});

test("API rejects corrupt execution metadata and durable timing results",async()=>{
    const api=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:
        {...plan,grid:{...grid,execution:{...execution,evaluationWidth:513}}}));
    await assert.rejects(()=>api.planCalculation(intent),/batch dimensions/);
    const result={url:`/api/processing/jobs/${"J".repeat(32)}/result`,provenanceUrl:`/api/processing/jobs/${"J".repeat(32)}/provenance`,rows:[{label:"Mean",expression:"mean(a)",state:"ok",value:"1",valueType:"float",aggregates:[]}]};
    const metrics={execution,readWindows:1,evaluationTiles:1,reducerUpdates:1,readSeconds:1,calculationSeconds:2,resultWriteSeconds:.1,kernelSeconds:4};
    for(const performance of [null,metrics,{...metrics,readSeconds:-1},{...metrics,readWindows:2}]){
        const client=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:
            {jobId:"J".repeat(32),operation:"raster.aggregate.v1",status:"ready",grid,progress:{phase:"ready"},result:{...result,performance}}));
        if(performance===null||performance===metrics)assert.ok(await client.getJob("J".repeat(32)));
        else await assert.rejects(()=>client.getJob("J".repeat(32)),/performance measurements/);
    }
});
