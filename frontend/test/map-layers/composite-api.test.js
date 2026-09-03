import assert from "node:assert/strict";
import test from "node:test";

import { CompositeMapPlanClient } from "../../src/map-layers/composite-api.js";

test("composite plan client sends one exact top-first plan", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    const planId = "a".repeat(64);
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({
            planId,
            wmsUrl: `/api/map-rendering/plans/${planId}/wms`,
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    try {
        const client = new CompositeMapPlanClient();
        const layers = [{
            layerName: "eolab:first",
            styleName: "vector-point",
            styleDefinition: { geometryKind: "point" },
            opacity: 0.5,
        }];
        const result = await client.create(layers, new AbortController().signal);

        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, "/api/map-rendering/plans");
        assert.deepEqual(JSON.parse(requests[0].options.body), { layers });
        assert.equal(result.planId, planId);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("composite plan client rejects an invalid response contract", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        planId: "not-a-plan",
        wmsUrl: "/geoserver/eolab/wms",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
        await assert.rejects(
            new CompositeMapPlanClient().create([], new AbortController().signal),
            /invalid plan/,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
