import assert from "node:assert/strict";
import test from "node:test";

import {
    CatalogMapActionRegistry,
    CatalogVectorAssessmentCache,
} from "../src/catalog-map-actions.js";

/** Build one Catalog Item with a stable composite identity. */
function createItem(id) {
    return {
        collection: "mounted",
        id,
        assets: { data: {} },
        properties: { title: `${id} title` },
    };
}

test("pending map actions follow their Item across selection changes", () => {
    const registry = new CatalogMapActionRegistry();
    const first = createItem("first");
    const equivalentFirst = createItem("first");
    const second = createItem("second");
    const firstAction = registry.begin(first, "Adding to map…", "Publishing");
    const secondAction = registry.begin(second, "Adding to map…", "Preparing");

    assert.equal(registry.get(equivalentFirst), firstAction);
    assert.equal(registry.get(second), secondAction);
    assert.throws(
        () => registry.begin(first, "Adding to map…", "Duplicate"),
        /already pending/
    );

    assert.equal(registry.finish(secondAction), true);
    assert.equal(registry.get(second), null);
    assert.equal(registry.finish(firstAction), true);
    assert.equal(registry.get(first), null);
});

test("an obsolete token cannot finish a replacement action", () => {
    const registry = new CatalogMapActionRegistry();
    const item = createItem("raster");
    const firstAction = registry.begin(item, "Adding to map…", "Publishing");

    assert.equal(registry.finish(firstAction), true);
    const replacement = registry.begin(item, "Adding…", "Publishing");

    assert.equal(registry.finish(firstAction), false);
    assert.equal(registry.get(item), replacement);
});

test("vector assessments survive one equivalent Catalog reload", () => {
    const assessments = new CatalogVectorAssessmentCache();
    const requestedItem = {
        collection: "eolab-mounted-vectors",
        id: "geopackage-a",
        assets: { data: {} },
        properties: { title: "Original" },
    };
    const reloadedItem = {
        ...requestedItem,
        properties: { title: "Reloaded" },
    };
    const assessment = {
        ...requestedItem,
        properties: {
            title: "Assessed",
            "eolab:vector_rendering": {
                policy: "vector-v1",
                eligible: true,
            },
        },
    };

    assessments.record(requestedItem, assessment);

    assert.equal(assessments.apply(reloadedItem), true);
    assert.deepEqual(reloadedItem.properties, {
        title: "Reloaded",
        "eolab:vector_rendering": {
            policy: "vector-v1",
            eligible: true,
        },
    });
    assert.equal(assessments.apply({ ...reloadedItem }), false);
});

test("a new Catalog request discards older transient vector assessments", () => {
    const assessments = new CatalogVectorAssessmentCache();
    const requestedItem = {
        collection: "eolab-mounted-vectors",
        id: "geopackage-a",
        properties: {},
    };
    assessments.record(requestedItem, {
        ...requestedItem,
        properties: {
            "eolab:vector_rendering": {
                policy: "vector-v1",
                eligible: true,
            },
        },
    });
    assessments.clear();

    assert.equal(assessments.apply({ ...requestedItem, properties: {} }), false);
});
