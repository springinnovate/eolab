import assert from "node:assert/strict";
import test from "node:test";

import {
    CatalogMapActionRegistry,
    CatalogRasterAssessmentCache,
} from "../src/catalog-map-actions.js";

/**
 * Build one Catalog Item with a stable composite identity.
 *
 * @param {string} id Item identifier.
 * @return {Object} Minimal Catalog Item.
 */
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
    const firstAction = registry.begin(
        first,
        "Assessing...",
        "Inspecting the first raster."
    );
    const secondAction = registry.begin(
        second,
        "Adding to map…",
        "Preparing the second raster."
    );

    assert.equal(registry.get(equivalentFirst), firstAction);
    assert.equal(registry.get(second), secondAction);
    assert.throws(
        () => registry.begin(first, "Assessing...", "Duplicate"),
        /already pending/
    );

    assert.equal(registry.finish(secondAction), true);
    assert.equal(registry.get(second), null);
    assert.equal(registry.get(first), firstAction);
    assert.equal(registry.finish(firstAction), true);
    assert.equal(registry.get(first), null);
});

test("an obsolete token cannot finish a replacement action", () => {
    const registry = new CatalogMapActionRegistry();
    const item = createItem("raster");
    const firstAction = registry.begin(item, "Assessing...", "Inspecting");

    assert.equal(registry.finish(firstAction), true);
    const replacement = registry.begin(item, "Adding…", "Preparing");

    assert.equal(registry.finish(firstAction), false);
    assert.equal(registry.get(item), replacement);
});

test("assessment results survive selection changes and equivalent reloads", () => {
    const assessments = new CatalogRasterAssessmentCache();
    const requestedItem = createItem("raster");
    const reloadedItem = createItem("raster");
    const otherItem = createItem("other");
    const assessment = {
        ...createItem("raster"),
        assets: {
            data: {
                href: "file:///scan-source/raster.tif",
                "eolab:rendering": {
                    policy: "raster-v2",
                    eligible: true,
                    reason: null,
                },
            },
        },
        properties: { title: "Authoritative assessment title" },
    };

    assessments.record(requestedItem, assessment);
    assert.equal(
        requestedItem.assets.data["eolab:rendering"],
        assessment.assets.data["eolab:rendering"]
    );
    assert.equal(reloadedItem.assets.data["eolab:rendering"], undefined);
    assert.equal(otherItem.assets.data["eolab:rendering"], undefined);

    assert.equal(assessments.apply(otherItem), false);
    assert.equal(assessments.apply(reloadedItem), true);
    assert.equal(
        reloadedItem.assets.data["eolab:rendering"],
        assessment.assets.data["eolab:rendering"]
    );
    assert.equal(reloadedItem.properties.title, "raster title");
    assert.equal(assessments.apply(createItem("raster")), false);
});

test("newer authoritative Catalog assessments are never overwritten", () => {
    const assessments = new CatalogRasterAssessmentCache();
    const requestedItem = createItem("raster");
    const oldAssessment = {
        ...createItem("raster"),
        assets: {
            data: {
                "eolab:rendering": {
                    policy: "raster-v2",
                    eligible: true,
                },
            },
        },
    };
    const newerItem = {
        ...createItem("raster"),
        assets: {
            data: {
                "eolab:rendering": {
                    policy: "raster-v2",
                    eligible: false,
                    reason: "The rescanned file is no longer eligible.",
                },
            },
        },
    };

    assessments.record(requestedItem, oldAssessment);
    assert.equal(assessments.apply(newerItem), false);
    assert.deepEqual(
        newerItem.assets.data["eolab:rendering"],
        {
            policy: "raster-v2",
            eligible: false,
            reason: "The rescanned file is no longer eligible.",
        }
    );
    assert.equal(assessments.apply(createItem("raster")), false);
});

test("an overlapping legacy-policy result receives the current assessment", () => {
    const assessments = new CatalogRasterAssessmentCache();
    const requestedItem = createItem("raster");
    const currentAssessment = {
        ...createItem("raster"),
        assets: {
            data: {
                "eolab:rendering": {
                    policy: "raster-v2",
                    eligible: true,
                },
            },
        },
    };
    const staleReloadedItem = {
        ...createItem("raster"),
        assets: {
            data: {
                href: "file:///scan-source/raster.tif",
                "eolab:rendering": {
                    policy: "raster-v1",
                    eligible: false,
                },
            },
        },
        properties: { title: "Reloaded Catalog title" },
    };

    assessments.record(requestedItem, currentAssessment);
    assert.equal(assessments.apply(staleReloadedItem), true);
    assert.equal(
        staleReloadedItem.assets.data["eolab:rendering"],
        currentAssessment.assets.data["eolab:rendering"]
    );
    assert.equal(
        staleReloadedItem.assets.data.href,
        "file:///scan-source/raster.tif"
    );
    assert.equal(
        staleReloadedItem.properties.title,
        "Reloaded Catalog title"
    );
});

test("a new Catalog request discards older transient assessments", () => {
    const assessments = new CatalogRasterAssessmentCache();
    const requestedItem = createItem("raster");
    const assessment = {
        ...createItem("raster"),
        assets: {
            data: {
                "eolab:rendering": {
                    policy: "raster-v2",
                    eligible: true,
                },
            },
        },
    };

    assessments.record(requestedItem, assessment);
    assessments.clear();

    const nextGenerationItem = createItem("raster");
    assert.equal(assessments.apply(nextGenerationItem), false);
    assert.equal(
        nextGenerationItem.assets.data["eolab:rendering"],
        undefined
    );
});
