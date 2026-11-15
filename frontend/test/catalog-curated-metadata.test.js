import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    catalogAssetReference, catalogDoiReference, createCatalogReferenceLink,
    createCuratedMetadataView, safeCatalogHttpReference, catalogReferenceIdentity,
    createCatalogDisclosure,
} from "../src/catalog-curated-metadata.js";
import { buildCatalogItemDetails, getCatalogVisualization, MOUNTED_DATASET_TYPES } from "../src/catalog.js";

import { buildCatalogResultPresentation } from "../src/catalog-result-presentation.js";

const records = JSON.parse(readFileSync(
    new URL("../../tests/fixtures/catalog_descriptors/public-items.json", import.meta.url), "utf8",
));

/** Minimal DOM surface that rejects markup insertion at the rendering boundary. */
class TestElement {
    /**
     * Create a text-safe DOM test node.
     * @param {string} tagName Element tag.
     * @param {TestDocument} ownerDocument Owning test document.
     */
    constructor(tagName, ownerDocument) {
        this.tagName = tagName;
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.attributes = new Map();
        this.text = "";
    }
    /** @return {string} Text of this node and its descendants. */
    get textContent() {
        return this.text + this.children.map(child => child.textContent).join("");
    }
    /** @param {string} value Literal node text. */
    set textContent(value) { this.text = value; this.children = []; }
    /**
     * Fail if rendering bypasses text nodes.
     * @param {string} value Attempted markup.
     * @throws {Error} Always, because annotation markup is not supported.
     */
    set innerHTML(value) { throw new Error("Unexpected markup: " + value); }
    /** @param {...TestElement} children Child nodes. @return {void} */
    append(...children) { this.children.push(...children); }
    /** @param {...TestElement} children Replacement children. @return {void} */
    replaceChildren(...children) { this.children = children; this.text = ""; }
    /** @param {string} name Attribute to remove. @return {void} */
    removeAttribute(name) { this.attributes.delete(name); }
    /** @param {string} name Attribute name. @param {string} value Value. @return {void} */
    setAttribute(name, value) { this.attributes.set(name, value); }
}

/** Document implementing only the safe element construction used by the view. */
class TestDocument {
    /** @param {string} tagName Element tag. @return {TestElement} New test node. */
    createElement(tagName) { return new TestElement(tagName, this); }
}

/**
 * Find rendered nodes by element tag.
 * @param {TestElement} root Root node.
 * @param {string} tagName Requested tag.
 * @return {TestElement[]} Matching descendants, including the root.
 */
function elements(root, tagName) {
    return [
        ...(root.tagName === tagName ? [root] : []),
        ...root.children.flatMap(child => elements(child, tagName)),
    ];
}

/**
 * Render a canonical producer envelope in an isolated DOM.
 * @param {Object} metadata Public metadata.
 * @param {"dataset"|"file"} [scope="dataset"] Inspector scope.
 * @return {TestElement} Rendered view.
 */
function render(metadata, scope = "dataset") {
    return createCuratedMetadataView(metadata, { documentContext: new TestDocument(), scope });
}

test("canonical producer fixtures retain Item metadata, publications and annotation values", () => {
    for (const { item } of records) {
        const view = render(item.properties["eolab:metadata"]);
        for (const publication of item.properties["eolab:metadata"].publications) {
            assert.ok(view.textContent.includes(publication.title));
            assert.ok(view.textContent.includes(publication.id));
            for (const author of publication.authors) assert.ok(view.textContent.includes(author));
        }
        for (const id of item.properties["eolab:metadata"].study_ids) assert.ok(view.textContent.includes(id));
        const details = buildCatalogItemDetails(item, [], "/not-public");
        assert.equal(details.title, item.properties.title);
        for (const asset of details.assets) {
            assert.equal(asset.metadata.some(entry => /Location|Original location/.test(entry.label)), false);
        }
    }
    const view = render(records[0].item.properties["eolab:metadata"]);
    for (const value of [
        "Partial match", "Compare observed and modeled depth.", "Missing southern sites",
        "Different temporal aggregation", "false", "0", "Not provided", "row-011", "row-012",
    ]) assert.ok(view.textContent.includes(value), value);
    assert.ok(elements(view, "h4").some(heading => heading.textContent === "Evidence and limitations"));
    const links = elements(view, "a");
    assert.ok(links.some(link => link.textContent.startsWith("Dataset DOI:") && link.href.endsWith("example-flood-dataset")));
    assert.ok(links.some(link => link.textContent.startsWith("Paper DOI:") && link.href.endsWith("example-flood")));
    assert.ok(links.some(link => link.attributes.get("aria-label") === "Read paper: Flood observations and modeled depth"));
});

test("Asset-specific annotations stay with their file and do not inherit Item evidence", () => {
    const item = records[0].item;
    const fileView = render(item.assets.observations["eolab:metadata"], "file");
    assert.match(fileView.textContent, /metres/);
    assert.match(fileView.textContent, /true/);
    assert.match(fileView.textContent, /0/);
    assert.doesNotMatch(fileView.textContent, /Partial match|Missing southern sites|paper-009/);
    assert.doesNotMatch(render(item.properties["eolab:metadata"]).textContent, /Zero is valid|Empty observations/);
});

test("multiple publications preserve their own authors, citations, notes and annotations", () => {
    const metadata = structuredClone(records[0].item.properties["eolab:metadata"]);
    metadata.publications.push({
        id: "paper-010", title: "Second paper", authors: ["C. Researcher"],
        citation: "Second citation", year: null, doi: null, url: null,
        notes: ["Second paper limitation"], annotations: { reviewer: "Second reviewer" },
    });
    const view = render(metadata);
    const papers = elements(view, "article");
    assert.equal(papers.length, 2);
    assert.match(papers[0].textContent, /A. Researcher/);
    assert.doesNotMatch(papers[0].textContent, /Second reviewer/);
    assert.match(papers[1].textContent, /Second citation/);
    assert.match(papers[1].textContent, /Second paper limitation/);
    assert.match(papers[1].textContent, /Second reviewer/);
    assert.match(papers[1].textContent, /Publication IDpaper-010/);
    assert.doesNotMatch(papers[1].textContent, /Publication year|A. Researcher/);
});

test("arbitrary annotations keep nested lists, null, zero, false and empty values", () => {
    const metadata = structuredClone(records[0].item.assets.data["eolab:metadata"]);
    metadata.annotations = {
        mixed: [false, 0, null, "", [], {}, { inner_name: "line one\nline two" }],
        curator_notes: "Original review remains distinct",
        reconciliation_evidence: "Later match explanation",
        download_url: "https://example.org/notes?file=1",
    };
    const view = render(metadata);
    const text = view.textContent;
    for (const value of [
        "false", "0", "Not provided", '""', "[]", "{}", "line one\nline two",
        "Original review remains distinct", "Later match explanation",
    ]) assert.ok(text.includes(value), value);
    assert.ok(elements(view, "dt").some(term => term.textContent === "Inner name" && term.title === "inner_name"));
    const provenance = elements(view, "details").find(detail =>
        detail.children[0].textContent === "Provenance and additional metadata");
    assert.match(provenance.textContent, /Later match explanation/);
    assert.match(provenance.textContent, /Original review/);
    assert.equal(elements(view, "a")[0].href, "https://example.org/notes?file=1");
});

test("annotation and publication markup stays text and unsafe URLs never become links", () => {
    const metadata = structuredClone(records[0].item.properties["eolab:metadata"]);
    const malicious = '<img src=x onerror="alert(1)">';
    metadata.annotations = { note: malicious, unsafe: "javascript:alert(1)" };
    metadata.publications[0].title = malicious;
    metadata.publications[0].url = "javascript:alert(2)";
    metadata.publications[0].notes = [malicious];
    const view = render(metadata);
    assert.ok(view.textContent.includes(malicious));
    assert.ok(view.textContent.includes("javascript:alert(2)"));
    assert.equal(elements(view, "img").length, 0);
    assert.ok(elements(view, "a").every(link => link.href.startsWith("https://")));
    for (const url of [
        "javascript:alert(1)", "data:text/html,test", "file:///private/data.csv",
        "//example.org", "/private/file", "https:example.org", "https://user:secret@example.org",
        "https://example.org\\evil", "https://example.org/\nother", "https://example.org:99999",
    ]) assert.equal(safeCatalogHttpReference(url), null, url);
    for (const url of ["https://example.org/paper?a=1#section", "http://example.org/paper"]) {
        assert.equal(safeCatalogHttpReference(url), url);
    }
});

test("DOI links encode control characters rather than allowing a second URL interpretation", () => {
    assert.equal(
        catalogDoiReference("10.1234/resource?x=<script>#fragment"),
        "https://doi.org/10.1234/resource%3Fx%3D%3Cscript%3E%23fragment",
    );
});

test("local file links use exact Catalog identity and directory geodatabases have no download", () => {
    const item = { collection: "collection/one", id: "item & two" };
    const asset = { href: "file:///private/data.csv", type: "text/csv", "eolab:access": { kind: "catalog" } };
    const reference = catalogAssetReference(item, "notes + methods", asset);
    const url = new URL(reference.href, "https://eolab.example");
    assert.equal(url.pathname, "/api/catalog/asset");
    assert.deepEqual([...url.searchParams], [
        ["collection", item.collection], ["item", item.id], ["asset", "notes + methods"],
    ]);
    assert.equal(reference.label, "Download file");
    assert.equal(reference.external, false);
    assert.equal(catalogAssetReference(item, "data", {
        ...asset, type: "application/vnd.esri.file-geodatabase",
    }), null);
    assert.equal(catalogAssetReference(item, "private", { href: "file:///private/notes" }), null);
});

test("external file links retain safe destinations and accessible new-tab isolation", () => {
    const item = records[0].item;
    const reference = catalogAssetReference(item, "publication", item.assets.publication);
    const link = createCatalogReferenceLink(new TestDocument(), reference);
    assert.equal(link.href, "https://example.org/papers/flood");
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    assert.equal(catalogAssetReference(item, "bad", {
        href: "javascript:alert(1)", "eolab:access": { kind: "external" },
    }), null);
});

test("nonspatial details distinguish source modification from observation and publication dates", () => {
    const item = records.find(record => record.item.geometry === null).item;
    assert.equal(getCatalogVisualization(item), null);
    const details = buildCatalogItemDetails(item, [], "/not-public");
    assert.ok(details.metadata.some(entry => entry.label === "Dataset type" && entry.value === "Nonspatial data"));
    assert.ok(details.metadata.some(entry => entry.label === "Source file modified"));
    assert.equal(details.metadata.some(entry => /Footprint|Bounding box|Raster/.test(entry.label)), false);
    const view = render(item.properties["eolab:metadata"]);
    assert.match(view.textContent, /Publication year2024/);
    assert.match(view.textContent, /Study periodMay to September 2023/);
    assert.doesNotMatch(view.textContent, /2026-11-13/);
    const rasterDetails = buildCatalogItemDetails(records[0].item, [], "/not-public");
    assert.ok(rasterDetails.metadata.some(entry => entry.label === "Observation period"));
});

test("curator evidence labels never authorize or disable existing rendering capabilities", () => {
    for (const status of ["Matched", "Partial match", "Related input", "Unmatched", "Unresolved"]) {
        const item = structuredClone(records[0].item);
        item.properties["eolab:metadata"].statuses = [status];
        assert.match(render(item.properties["eolab:metadata"]).textContent, new RegExp(status));
        assert.deepEqual(getCatalogVisualization(item), { kind: "raster", metadata: {} });
    }
});


test("study design, dataset purpose and limits precede sources while provenance stays optional", () => {
    const metadata = structuredClone(records[0].item.properties["eolab:metadata"]);
    metadata.annotations = {
        evidence_type: "Paired field observations",
        dataset_role: "Observed outcomes for the comparison",
        study_design: "Upstream and downstream sites sampled together",
        limitations: ["No pre-restoration baseline"],
        row_ids: ["source-row-4"],
        reconciliation_evidence: { matched: false, score: 0 },
    };
    const view = render(metadata);
    const summary = view.children.slice(0, 2).map(child => child.textContent).join(" ");
    for (const value of ["Paired field observations", "Observed outcomes", "No pre-restoration baseline"]) {
        assert.ok(summary.includes(value));
    }
    assert.doesNotMatch(summary, /source-row-4|paper-009/);
    const provenance = elements(view, "details").find(detail => detail.textContent.includes("source-row-4"));
    assert.equal(provenance.open, undefined);
    assert.match(provenance.textContent, /false/);
    assert.match(provenance.textContent, /0/);
    const context = createCuratedMetadataView(metadata, { documentContext: new TestDocument(), section: "context" });
    const references = createCuratedMetadataView(metadata, { documentContext: new TestDocument(), section: "references" });
    assert.match(context.textContent, /No pre-restoration baseline/);
    assert.doesNotMatch(context.textContent, /Source publications|source-row-4/);
    assert.match(references.textContent, /Source publications/);
    assert.doesNotMatch(references.textContent, /Paired field observations/);
});

test("publication links deduplicate DOI resolver aliases without losing distinct sources or values", () => {
    const metadata = structuredClone(records[0].item.properties["eolab:metadata"]);
    metadata.publications[0].url = "http://dx.doi.org/10.1234/EXAMPLE-FLOOD";
    metadata.annotations = {
        same_paper: "https://doi.org/10.1234/example-flood",
        repository: "https://example.org/data?version=1",
        second_version: "https://example.org/data?version=2",
        section: "https://example.org/data?version=1#methods",
        nested: ["https://example.org/data?version=1", { link: "https://other.example/data" }],
    };
    const original = structuredClone(metadata);
    const view = render(metadata);
    const links = elements(view, "a");
    const identities = links.map(link => catalogReferenceIdentity(link.href));
    assert.equal(identities.length, new Set(identities).size);
    assert.equal(links.filter(link => /doi.org.*example-flood$/i.test(link.href)).length, 1);
    assert.equal(links.filter(link => link.href.startsWith("https://example.org/data")).length, 3);
    assert.ok(view.textContent.includes(metadata.publications[0].url));
    assert.ok(view.textContent.includes(metadata.annotations.same_paper));
    assert.deepEqual(metadata, original);
});

test("curated files sort semantically after JSON key order changes and preserve every Asset", () => {
    const item = structuredClone(records[0].item);
    const local = { href: "/api/catalog/asset", "eolab:access": { kind: "catalog" } };
    item.assets = {
        provenance: { ...local, title: "A preparation record", type: "application/json", roles: ["metadata"] },
        source: { href: "https://example.org/source", title: "A source", type: "text/html", roles: ["metadata"] },
        notes: { ...local, title: "Study findings and limits (Markdown)", type: "text/markdown", roles: ["metadata"] },
        z_data: { ...local, title: "Z measurements", type: "text/csv", roles: ["data"] },
        a_data: { ...local, title: "A measurements", type: "text/csv", roles: ["data"] },
    };
    const original = structuredClone(item);
    const forward = buildCatalogItemDetails(item, [], "unused").assets.map(asset => asset.key);
    const reversed = structuredClone(item);
    reversed.assets = Object.fromEntries(Object.entries(item.assets).reverse());
    assert.deepEqual(forward, ["a_data", "z_data", "notes", "provenance", "source"]);
    assert.deepEqual(buildCatalogItemDetails(reversed, [], "unused").assets.map(asset => asset.key), forward);
    item.properties["eolab:vector_source"] = { asset_key: "z_data" };
    assert.deepEqual(buildCatalogItemDetails(item, [], "unused").assets.map(asset => asset.key),
        ["z_data", "notes", "a_data", "provenance", "source"]);
    delete item.properties["eolab:vector_source"];
    assert.deepEqual(item, original);
});

/**
 * Exercise the composition root's existing inspector with a minimal DOM.
 * Extract just the two presentation functions to avoid booting unrelated map
 * infrastructure; their production imports and call sites remain unchanged.
 * @param {Object} item Public STAC Item selected through Catalog.
 * @return {TestElement} Actual inspector content produced by the composition root.
 */
function renderInspector(item) {
    const documentContext = new TestDocument();
    const nodes = new Map(["heading", "content", "status"].map(name =>
        [`#catalog-inspector-${name}`, documentContext.createElement("div")]));
    nodes.set("#catalog-item-context", documentContext.createElement("div"));
    documentContext.querySelector = selector => nodes.get(selector);
    const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const start = source.indexOf("function createCatalogMetadataList(");
    const end = source.indexOf("/**\n * Connects Catalog search", start);
    const renderSelected = new Function(
        "document", "buildCatalogItemDetails", "buildCatalogResultPresentation", "MOUNTED_DATASET_TYPES",
        "createCuratedMetadataView", "catalogAssetReference", "createCatalogReferenceLink",
        "catalogReferenceIdentity", "createCatalogDisclosure",
        source.slice(start, end) + "\nreturn renderCatalogItemInspector;",
    )(documentContext, buildCatalogItemDetails, buildCatalogResultPresentation, MOUNTED_DATASET_TYPES,
        createCuratedMetadataView, catalogAssetReference, createCatalogReferenceLink,
        catalogReferenceIdentity, createCatalogDisclosure);
    const priorDocument = globalThis.document;
    globalThis.document = documentContext;
    try {
        renderSelected(item, [], "unused");
    } finally {
        if (priorDocument === undefined) delete globalThis.document;
        else globalThis.document = priorDocument;
    }
    return nodes.get("#catalog-inspector-content");
}

test("actual inspector places downloads before sources and preserves duplicate Asset records in detail", () => {
    const item = structuredClone(records[0].item);
    item.assets.notes = {
        href: "/api/catalog/asset", title: "Study findings and limits (Markdown)",
        type: "text/markdown", roles: ["metadata"], "eolab:access": { kind: "catalog" },
    };
    const original = structuredClone(item);
    const view = renderInspector(item);
    const firstFile = view.children.findIndex(child => child.className === "catalog-asset");
    const sources = view.children.findIndex(child => child.textContent.includes("Source publications"));
    const technical = view.children.at(-1);
    assert.ok(firstFile > 0 && sources > firstFile);
    assert.equal(technical.tagName, "details");
    assert.equal(technical.children[0].textContent, "Technical details");
    assert.match(technical.textContent, /Asset keypublication/);
    assert.match(technical.textContent, /https:\/\/example.org\/papers\/flood/);
    const links = elements(view, "a");
    assert.equal(links.filter(link => link.href === item.assets.publication.href).length, 1);
    assert.ok(links.some(link => link.textContent === "Download file"
        && link.attributes.get("aria-label").includes("Study findings and limits")));
    assert.equal(links.some(link => link.attributes.get("aria-label")?.includes("Study findings and limits")
        && /Read/.test(link.textContent)), false);
    for (const asset of view.children.filter(child => child.className === "catalog-asset")) {
        assert.ok(asset.children.find(child => child.tagName === "details").textContent.includes("Asset key"));
        assert.notEqual(asset.children[1].tagName, "details");
    }
    assert.deepEqual(item, original);
});


test("DOI comparison keeps encoded path delimiters distinct from query and fragment", () => {
    assert.notEqual(catalogReferenceIdentity("https://doi.org/10.1/a%3Fb"),
        catalogReferenceIdentity("https://doi.org/10.1/a?b"));
    assert.notEqual(catalogReferenceIdentity("https://doi.org/10.1/a%23b"),
        catalogReferenceIdentity("https://doi.org/10.1/a#b"));
});

test("a paper has one primary action and retains its alternate DOI in the publication record", () => {
    const view = render(records[0].item.properties["eolab:metadata"]);
    const paper = elements(view, "article")[0];
    const directLinks = paper.children.filter(child => child.tagName === "a");
    assert.equal(directLinks.length, 1);
    assert.equal(directLinks[0].textContent, "Read paper");
    assert.equal(directLinks[0].href, "https://example.org/papers/flood");
    const record = paper.children.find(child => child.tagName === "details");
    assert.ok(elements(record, "a").some(link => link.href === "https://doi.org/10.1234/example-flood"));
});

test("a data Asset keeps its prominent action when its destination also appears in citations", () => {
    const item = structuredClone(records[0].item);
    item.assets.data.href = "https://doi.org/10.1234/example-flood-dataset";
    item.assets.data["eolab:access"] = { kind: "external" };
    const view = renderInspector(item);
    const dataCard = view.children.find(child => child.className === "catalog-asset"
        && child.children[0].textContent === "Flood depth raster");
    assert.ok(dataCard);
    assert.ok(elements(dataCard, "a").some(link => link.href === item.assets.data.href));
    assert.equal(elements(view, "a").filter(link => link.href === item.assets.data.href).length, 1);
});

test("file annotations need only the existing File details disclosure", () => {
    const view = renderInspector(records[0].item);
    const observations = view.children.find(child => child.className === "catalog-asset"
        && child.children[0].textContent === "Supporting observations");
    const details = elements(observations, "details");
    assert.equal(details.length, 1);
    assert.match(details[0].textContent, /metres/);
    assert.match(details[0].textContent, /true/);
});


test("legacy temporal Items keep variables and coverage visible without opening technical detail", () => {
    const item = {
        id: "temperature-history", collection: "eolab-temporal-datasets", geometry: null,
        properties: {
            title: "Monthly temperature", datetime: null,
            "cube:dimensions": { time: { extent: ["2020-01", "2020-03"] } },
            "cube:variables": { temperature: { description: "Temperature", unit: "K" } },
        },
        assets: {
            january: { href: "file:///source/january.tif", roles: ["data"] },
            march: { href: "file:///source/march.tif", roles: ["data"] },
        },
    };
    const view = renderInspector(item);
    assert.equal(elements(view, "details").length, 0);
    assert.match(view.textContent, /VariablesTemperature \(temperature; K\)/);
    assert.match(view.textContent, /Observation times \(UTC\)2020-01/);
    assert.match(view.textContent, /Months with data2/);
});


test("scientific context leads classification and a sole limitations field has one heading", () => {
    const metadata = structuredClone(records[0].item.properties["eolab:metadata"]);
    metadata.annotations = {
        evidence_type: "River connectivity model",
        dataset_role: "Locations used as model inputs",
        limitations: ["Habitat outcomes are in a separate file"],
    };
    const view = render(metadata);
    const context = view.children[0];
    assert.deepEqual(elements(context, "dt").slice(0, 3).map(term => term.textContent),
        ["Evidence type", "Dataset role", "Study period"]);
    const limits = view.children[1];
    assert.equal(limits.children[0].textContent, "Limitations");
    assert.equal(elements(limits, "dt").length, 0);
    assert.match(limits.textContent, /Habitat outcomes are in a separate file/);
    metadata.annotations.evidence = "Two scenarios compared";
    const mixedLimits = render(metadata).children[1];
    assert.equal(mixedLimits.children[0].textContent, "Evidence and limitations");
    assert.deepEqual(elements(mixedLimits, "dt").map(term => term.textContent), ["Limitations", "Evidence"]);
});
