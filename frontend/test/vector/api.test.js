import assert from "node:assert/strict";
import test from "node:test";

import {
    assessCatalogVector,
    publishCatalogVector,
    styleCatalogVector,
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
        style: {
            geometryKind: "polygon",
            fillColor: "#a855f7",
            fillOpacity: 0.38,
            strokeColor: "#581c87",
            strokeOpacity: 1,
            strokeWidth: 2,
            pointSize: null,
            label: null,
        },
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

test("vector styling sends Catalog identity plus complete symbol state", async () => {
    const requests = [];
    const style = {
        geometryKind: "line",
        fillColor: null,
        fillOpacity: null,
        strokeColor: "#f97316",
        strokeOpacity: 0.75,
        strokeWidth: 4,
        pointSize: null,
        label: {
            field: "name",
            fontFamily: "SansSerif",
            fontSize: 12,
            fontWeight: "bold",
            fontColor: "#112233",
            haloColor: "#ffffff",
            haloWidth: 1.5,
            placement: "follow-line",
            minimumZoom: 6,
        },
    };
    const result = {
        styleName:
          "vector-single-0123456789abcdef01234567-89abcdef0123",
        style,
    };

    assert.deepEqual(await styleCatalogVector(
        VECTOR_ITEM,
        style,
        async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        },
    ), result);
    assert.equal(requests[0].url, "/api/vector-rendering/styles");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        collectionId: VECTOR_ITEM.collection,
        itemId: VECTOR_ITEM.id,
        style,
    });
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
