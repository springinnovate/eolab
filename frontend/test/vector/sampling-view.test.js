import test from "node:test";
import assert from "node:assert/strict";
import { VectorSamplingView } from "../../src/vector/sampling-view.js";
import { VectorSamplingController } from "../../src/vector/sampling.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";

test("both vector placements adopt on change and share progress, filter editing and clearing",async()=>{
    const document=new FakeRasterControlDocument();
    const explore=new VectorSamplingView(document);
    const summary=new VectorSamplingView(document,{root:"#raster-series-vector-area"});
    const filter={enabled:true,match:"all",rules:[{field:"iso3",operator:"eq",value:"PER"}]};
    const targets=[{key:"countries",label:"Countries",item:{collectionId:"vectors",itemId:"countries"},filter}];
    const area={selection:CATALOG_SELECTION,filter,bbox:[-180,-85,180,85],matched:253,total:253};
    const events=[];
    let resolve;
    const controller=new VectorSamplingController({view:[explore,summary],getTargets:()=>targets,
        createArea:()=>new Promise(done=>{resolve=done;}),
        onActivate:area=>events.push(["activate",area.selection]),onInvalidate:selection=>events.push(["invalidate",selection]),
        onEditFilter:key=>events.push(["filter",key])});
    assert.equal(summary.elements.layer.value,"countries");
    assert.equal(summary.elements.predicate.textContent,'iso3 equals "PER"');
    assert.equal(resolve,undefined,"populating the dropdown does not prepare polygons");
    summary.elements.filter.dispatchEvent(new Event("click"));
    assert.deepEqual(events,[["filter","countries"]]);
    summary.elements.layer.dispatchEvent(new Event("change"));
    assert.equal(summary.elements.status.classList.contains("is-working"),true);
    assert.equal(summary.root.getAttribute("aria-busy"),"true");
    assert.equal(summary.elements.remove.textContent,"Cancel");
    await Promise.resolve();resolve(area);
    for(let i=0;i<10;i++) await Promise.resolve();
    assert.deepEqual(events.at(-1),["activate",area.selection]);
    assert.equal(summary.elements.status.getAttribute("role"),"status");
    assert.equal(summary.elements.status.classList.contains("is-working"),false);
    assert.equal(explore.elements.status.textContent,summary.elements.status.textContent);
    assert.equal(summary.elements.retry.hidden,true);
    summary.elements.remove.dispatchEvent(new Event("click"));
    assert.equal(explore.elements.remove.hidden,true);assert.equal(summary.elements.remove.hidden,true);
    assert.equal(summary.elements.layer.value,"");
    controller.destroy();summary.elements.filter.dispatchEvent(new Event("click"));
    assert.equal(events.filter(event=>event[0]==="filter").length,1);
});

test("vector controls expose retry only after an actual read failure",async()=>{
    const document=new FakeRasterControlDocument(),view=new VectorSamplingView(document);
    let failed=true;
    const controller=new VectorSamplingController({view,getTargets:()=>[{key:"countries",label:"Countries",item:{},filter:CATALOG_SELECTION.filter}],
        createArea:async()=>{if(failed) throw Error("Selection read failed");return {selection:CATALOG_SELECTION,matched:1,total:200};},
        onActivate(){},onInvalidate(){},onEditFilter(){}});
    await controller.use();
    assert.equal(view.elements.status.getAttribute("role"),"alert");
    assert.match(view.elements.status.textContent,/Selection read failed/);
    assert.equal(view.elements.retry.hidden,false);
    failed=false;view.elements.retry.dispatchEvent(new Event("click"));
    for(let i=0;i<10;i++) await Promise.resolve();
    assert.equal(view.elements.retry.hidden,true);assert.equal(controller.state.phase,"active");
    controller.destroy();
});

test("vector controls explain missing layers without offering an invalid selection",()=>{
    const document=new FakeRasterControlDocument();
    const view=new VectorSamplingView(document,{root:"#raster-series-vector-area"});
    const controller=new VectorSamplingController({view,getTargets:()=>[]});
    assert.match(view.elements.status.textContent,/Add a polygon layer/);
    assert.equal(view.elements.layer.disabled,true);assert.equal(view.elements.filter.disabled,true);
    assert.equal(view.elements.retry.hidden,true);
    controller.destroy();
});
