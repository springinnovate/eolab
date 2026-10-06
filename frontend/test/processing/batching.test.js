import assert from "node:assert/strict";
import test from "node:test";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { calculationIntent } from "../../src/processing/calculation-session.js";

const intent={source:{collectionId:"r",itemId:"r1",label:"Raster"},area:{kind:"wholeRaster"},calculations:[{label:"Mean",expression:"mean(a)"}]};
const execution={targetChunkPixels:65536,readWidth:512,readHeight:128,evaluationWidth:512,evaluationHeight:128,readWindows:1};
const grid={width:512,height:128,crs:"EPSG:4326",dtype:"float32",transform:[1,0,0,0,-1,90],nativeBlocks:4,decodedBytes:262144,execution};
const plan={jobId:"P".repeat(32),status:"running",progress:{phase:"calculating"},operation:"raster.aggregate.v1",expiresAt:"2099-01-01T00:00:00Z",grid};

test("API transmits opt-in batch tuning and keeps omitted legacy requests compatible",async()=>{
    const bodies=[];
    const api=new ProcessingApiClient(async(path,options)=>{
        if(path.endsWith("/jobs"))return Response.json({jobs:[]});
        bodies.push(JSON.parse(options.body).items[0]);return Response.json({items:[{index:0,job:plan}]});
    });
    await api.submitCalculation({...calculationIntent({...intent,targetChunkPixels:65536}),requestId:"r".repeat(32)});
    await api.submitCalculation({...calculationIntent(intent),requestId:"s".repeat(32)});
    assert.equal(bodies[0].targetChunkPixels,65536);
    assert.equal(Object.hasOwn(bodies[1],"targetChunkPixels"),false);
    for(const bad of [0,-1,4194305,1.5,"65536",true]){
        assert.throws(()=>calculationIntent({...intent,targetChunkPixels:bad}),/Batch size/);
    }
});

test("API rejects corrupt execution metadata",async()=>{
    const api=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:
        {...plan,grid:{...grid,execution:{...execution,evaluationWidth:513}}}));
    await assert.rejects(()=>api.getJob("P".repeat(32)),/batch dimensions/);

});

test("out-of-coverage pixel calculations accept zero work and reject malformed empty grids",async()=>{
    const emptyExecution={targetChunkPixels:65536,readWidth:1,readHeight:1,evaluationWidth:1,evaluationHeight:1,readWindows:0};
    const emptyGrid={...grid,width:0,height:0,nativeBlocks:0,decodedBytes:0,execution:emptyExecution};
    const identifier="J".repeat(32);
    const emptyJob={jobId:identifier,operation:"raster.aggregate.v1",status:"ready",grid:emptyGrid,progress:{phase:"ready"},
        result:{url:`/api/processing/jobs/${identifier}/result`,provenanceUrl:`/api/processing/jobs/${identifier}/provenance`,
            rows:[{label:"Pixel",expression:"pixelValue(a)",state:"no_valid_data",value:null,valueType:"float",aggregates:[]}]}};
    for(const candidate of [emptyJob,{...emptyJob,operation:"raster.clip.v1"},{...emptyJob,grid:{...emptyGrid,height:1}},
        {...emptyJob,grid:{...emptyGrid,nativeBlocks:1}}]) {
        const client=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:candidate));
        if(candidate===emptyJob)assert.equal((await client.getJob(identifier)).result.rows[0].state,"no_valid_data");
        else await assert.rejects(()=>client.getJob(identifier),/invalid/);
    }
});
