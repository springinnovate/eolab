import assert from "node:assert/strict";
import test from "node:test";

import {
    assessCatalogVector,
    publishCatalogVector,
    VectorRenderingRequestError,
} from "../../src/vector/api.js";

const VECTOR_ITEM = Object.freeze({
    collection: "eolab-mounted-vectors",
    id: "geopackage-0123456789abcdef01234567",
});

test("vector assessment sends only the selected Catalog identity", async () => {
    const requests = [];
    const assessedItem = { ...VECTOR_ITEM, properties: {} };

    assert.deepEqual(await assessCatalogVector(
        VECTOR_ITEM,
        async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify(assessedItem), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
    ), assessedItem);
    assert.deepEqual(requests, [{
        url: "/api/vector-rendering/assessments",
        options: {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                collectionId: VECTOR_ITEM.collection,
                itemId: VECTOR_ITEM.id,
            }),
        },
    }]);
});

test("vector publication validates exact fixed-style WMS metadata", async () => {
    const publication = {
        layerName: `eolab:${VECTOR_ITEM.id}`,
        bbox: [-123, 48, -122, 49],
        geometryKind: "polygon",
        styleName: "vector-polygon",
    };

    assert.deepEqual(await publishCatalogVector(
        VECTOR_ITEM,
        async () => new Response(JSON.stringify(publication), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })
    ), publication);

    await assert.rejects(
        publishCatalogVector(
            VECTOR_ITEM,
            async () => new Response(JSON.stringify({
                ...publication,
                styleName: "dynamic-raster",
            }), { status: 200 })
        ),
        /invalid layer contract/
    );
});

test("vector publication preserves actionable upstream categories", async () => {
    const request = publishCatalogVector(
        VECTOR_ITEM,
        async () => new Response(JSON.stringify({
            detail: {
                category: "configuration",
                message: "The vector style is not initialized.",
            },
        }), { status: 503, headers: { "Content-Type": "application/json" } })
    );

    await assert.rejects(request, (error) => {
        assert.equal(error instanceof VectorRenderingRequestError, true);
        assert.equal(error.category, "configuration");
        assert.equal(error.message, "The vector style is not initialized.");
        return true;
    });
});
