import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    catalogAssetReference, catalogDoiReference, createCatalogReferenceLink,
    createCuratedMetadataView, safeCatalogHttpReference,
} from "../src/catalog-curated-metadata.js";
import { buildCatalogItemDetails, getCatalogVisualization } from "../src/catalog.js";

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
    assert.ok(links.some(link => link.attributes.get("aria-label") === "Open publication: Flood observations and modeled depth"));
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
    const evidence = view.children.find(section => section.children[0]?.textContent === "Evidence and limitations");
    const other = view.children.find(section => section.children[0]?.textContent === "Additional annotations");
    assert.match(evidence.textContent, /Later match explanation/);
    assert.doesNotMatch(evidence.textContent, /Original review/);
    assert.match(other.textContent, /Original review/);
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
