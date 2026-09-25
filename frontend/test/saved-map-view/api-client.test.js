import assert from "node:assert/strict";
import test from "node:test";
import { SavedMapApiClient, namedMapSlugFromPath, editableMapSlugFromPath, suggestMapLinkName } from "../../src/saved-map-view/api-client.js";
import { createSavedMapView } from "../../src/saved-map-view/model.js";

const view = createSavedMapView({
  viewer: { version: "0.6.0", origin: "https://viewer.example" },
  createdAt: "2026-09-23T00:00:00Z", viewport: { center: { latitude: 0, longitude: 0 }, zoom: 2 },
  basemap: "none", layers: [],
});
const record = { slug: "amazon", title: "Amazon", subtitle: "Priorities", view };

test("admin editing uses a separate authenticated API, fixed slug and revision", async () => {
  const calls = [];
  const client = new SavedMapApiClient(async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify({ ...record, revision: options.method === "PUT" ? 2 : 1 }));
  });
  assert.equal(editableMapSlugFromPath("/admin-eolab/maps/amazon/edit"), "amazon");
  assert.equal(editableMapSlugFromPath("/maps/amazon"), null);
  assert.equal(editableMapSlugFromPath("/?edit=amazon"), null);
  assert.equal((await client.getForEditing("amazon")).revision, 1);
  assert.equal((await client.update("amazon", { ...record, slug: "cannot-rename", revision: 1 })).revision, 2);
  assert.equal(calls[0].url, "/api/admin/saved-maps/amazon");
  assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].headers["X-EOLab-Admin"], "1");
  assert.equal(JSON.parse(calls[1].body).slug, "amazon");
  assert.equal(JSON.parse(calls[1].body).revision, 1);
  const malformed = new SavedMapApiClient(async () => new Response(JSON.stringify(record)));
  await assert.rejects(malformed.getForEditing("amazon"), /revision/);
  await assert.rejects(client.update("amazon", record), /Reload/);
});

test("browser fetch is called without rebinding its receiver to the API client", async () => {
  const client = new SavedMapApiClient(function (url) {
    assert.equal(this, undefined);
    assert.equal(url, "/api/saved-maps/amazon");
    return Promise.resolve(new Response(JSON.stringify(record)));
  });
  assert.deepEqual(await client.get("amazon"), record);
});

test("publish and retrieve preserve headings and provider ID through the same-site API", async () => {
  const calls = [];
  const client = new SavedMapApiClient(async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(record), { status: options.method === "POST" ? 201 : 200 });
  });
  assert.deepEqual(await client.create(record), record);
  assert.deepEqual(await client.get("amazon"), record);
  assert.equal(calls[0].url, "/api/saved-maps");
  assert.equal(calls[0].headers["X-EOLab-Saved-Maps"], "1");
  assert.deepEqual(JSON.parse(calls[0].body), record);
  assert.equal(calls[1].url, "/api/saved-maps/amazon");
  assert.equal(calls[1].cache, "no-store");
});

test("invalid names never request paths and malformed named routes stay in viewer mode", async () => {
  const client = new SavedMapApiClient(() => assert.fail("must not fetch"));
  for (const slug of ["", "a/b", "../secret", "Upper", "bad--name", "x".repeat(81)]) {
    await assert.rejects(client.get(slug), /Link name/);
  }
  assert.equal(namedMapSlugFromPath("/"), null);
  assert.equal(namedMapSlugFromPath("/maps/amazon/"), "amazon");
  assert.equal(namedMapSlugFromPath("/maps/"), "");
  assert.equal(namedMapSlugFromPath("/maps/a/b"), "a/b");
  assert.equal(suggestMapLinkName("  Per\u00fa & Brazil!  "), "peru-brazil");
});

test("duplicate, missing, full and unavailable responses retain actionable errors", async () => {
  for (const status of [404, 409, 503]) {
    const client = new SavedMapApiClient(async () => new Response(JSON.stringify({ detail: `Problem ${status}` }), { status }));
    await assert.rejects(client.get("amazon"), new RegExp(`Problem ${status}`));
  }
  const invalid = new SavedMapApiClient(async () => new Response("<html>proxy error</html>", { status: 502 }));
  await assert.rejects(invalid.get("amazon"), /unreadable response/);
});

test("retrieval rejects oversized responses, wrong identities and invalid documents", async () => {
  for (const [body, error] of [
    ["x".repeat(530000), /size limit/],
    [JSON.stringify({ ...record, slug: "other" }), /different map/],
    [JSON.stringify({ ...record, view: { ...view, basemap: "https://secret-key.example" } }), /basemap/],
  ]) {
    const client = new SavedMapApiClient(async () => new Response(body));
    await assert.rejects(client.get("amazon"), error);
  }
});
