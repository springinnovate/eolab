import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalogSearch,
  buildCatalogSearchRequest,
  CatalogSearchClient,
  CatalogSearchSyntaxError,
  getCatalogSearchTokens,
  NONSPATIAL_COLLECTION_ID,
} from "../src/catalog.js";
import {
  applyCatalogSearchSuggestion,
  getCatalogSearchSuggestions,
  getCatalogSearchTokenRange,
} from "../src/catalog-search-suggestions.js";

test("category matches supplied labels exactly through a standard array predicate", () => {
  assert.deepEqual(buildCatalogSearch('category:"Coastal Protection"'), {
    filter: { op: "a_contains", args: [{ property: "eolab_categories" }, ["coastal protection"]] },
    datetime: null,
  });
  assert.deepEqual(buildCatalogSearch("category:risk").filter.args[1], ["risk"]);
  assert.deepEqual(buildCatalogSearch("category:Flood_10%").filter.args[1], ["flood_10%"]);
});

test("study, risk and status values use ordinary text instead of dedicated filters", () => {
  for (const term of ["paper-009", "flood", "partial_or_processed", "10.1234/example-flood-study"]) {
    assert.deepEqual(buildCatalogSearch(term).filter.args.at(-1), {
      op: "like", args: [
        { op: "casei", args: [{ property: "eolab_metadata_text" }] },
        { op: "casei", args: [`%${term.replaceAll("_", "\\_")}%`] },
      ],
    });
  }
  for (const query of ["study:paper-009", "risk:Flood", 'status:"Partial match"']) {
    assert.throws(() => buildCatalogSearch(query), /Unsupported Catalog filter:/);
  }
});

test("quoted labels preserve escaped quotes and whitespace without changing filenames", () => {
  assert.deepEqual(
    buildCatalogSearch('category:' + JSON.stringify('Coastal "protection"')).filter.args[1],
    ['coastal "protection"'],
  );
  const query = 'Z:\\data\\flood.tif category:"Coastal protection"';
  assert.deepEqual(getCatalogSearchTokens(query).map(({ text }) => text), [
    "Z:\\data\\flood.tif", 'category:"Coastal protection"',
  ]);
  assert.equal(buildCatalogSearch(query).filter.op, "and");
});

test("curated filter input rejects missing values, malformed quotes and repetition", () => {
  for (const query of [
    "category:", 'category:""', 'category:"   "', 'category:"Coastal protection',
    'category:"Coastal protection"suffix', 'category:coastal"', "category:a category:b",
  ]) assert.throws(() => buildCatalogSearch(query), CatalogSearchSyntaxError, query);
});

test("curated search preserves AND terms, type and observation interval semantics", () => {
  const request = buildCatalogSearchRequest(
    'forest 2020 category:Water flood partial_or_processed date:2020 type:vector',
    20,
  );
  assert.equal(request.limit, 20);
  assert.equal(request["filter-lang"], "cql2-json");
  assert.equal(request.datetime, "2020-01-01T00:00:00Z/2020-12-31T23:59:59.999999Z");
  const predicates = request.filter.args;
  assert.equal(request.filter.op, "and");
  assert.equal(predicates.length, 7);
  assert.deepEqual(predicates[0].args.at(-1), {
    op: "like", args: [
      { op: "casei", args: [{ property: "eolab_metadata_text" }] },
      { op: "casei", args: ["%forest%"] },
    ],
  });
  assert.deepEqual(predicates.at(-1), {
    op: "or", args: [
      { op: "isnull", args: [{ property: "eolab_time_basis" }] },
      { op: "<>", args: [{ property: "eolab_time_basis" }, "source-modified"] },
    ],
  });
  assert.equal(buildCatalogSearch("2020").datetime, null);
});

test("standalone nonspatial filtering uses catalog identity without map state", () => {
  assert.deepEqual(buildCatalogSearch("type:nonspatial").filter, {
    op: "=", args: [{ property: "collection" }, NONSPATIAL_COLLECTION_ID],
  });
});

test("suggestions keep quoted values together and replace only their complete token", () => {
  const query = 'forest category:"Coastal protection" flood';
  const caret = query.indexOf("protection") + 2;
  const range = getCatalogSearchTokenRange(query, caret);
  assert.equal(range.text, 'category:"Coastal protection"');
  assert.deepEqual(getCatalogSearchSuggestions(query, caret).map(({ field }) => field), ["category"]);
  assert.deepEqual(applyCatalogSearchSuggestion(query, caret, { token: "category:" }), {
    value: "forest category: flood", caretPosition: 16,
  });
  assert.equal(getCatalogSearchTokenRange('category:"Coastal ', 18).text, 'category:"Coastal ');
});

test("curated requests retain server counts and use provider pagination", async () => {
  const requests = [];
  const client = new CatalogSearchClient("/stac", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      type: "FeatureCollection", features: [], numberMatched: 23, links: [],
    }), { headers: { "X-EOLab-Number-Matched-Estimated": "false" } });
  });
  const result = await client.search('category:"Coastal protection"');
  assert.equal(result.numberMatched, 23);
  await client.follow({
    rel: "next", href: "/stac/search", method: "POST",
    body: { ...buildCatalogSearchRequest('category:"Coastal protection"', 20), token: "next:parent-item" },
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    ...buildCatalogSearchRequest('category:"Coastal protection"', 20), token: "next:parent-item",
  });
});

test("replacing a curated search aborts the previous request", async () => {
  const calls = [];
  const client = new CatalogSearchClient("/stac", (url, options) => new Promise((resolve) => {
    calls.push({ options, resolve });
  }));
  const previous = client.search("older study");
  const latest = client.search("newer study");
  assert.equal(calls[0].options.signal.aborted, true);
  for (const call of calls) call.resolve(new Response(JSON.stringify({
    type: "FeatureCollection", features: [], numberMatched: 0, links: [],
  }), { headers: { "X-EOLab-Number-Matched-Estimated": "false" } }));
  assert.equal(await previous, null);
  assert.equal((await latest).numberMatched, 0);
});
