/** Present curated Catalog annotations and links without crossing feature boundaries. */

/** @typedef {null|boolean|number|string|JsonValue[]|Object<string, JsonValue>} JsonValue */
/**
 * @typedef {Object} CatalogPublication
 * @property {string} id Supplied publication identifier.
 * @property {string} title Publication title.
 * @property {string|null} [doi] Paper DOI name, separate from the dataset DOI.
 * @property {string|null} [citation] Supplied citation.
 * @property {string|null} [url] Public HTTP(S) reference.
 * @property {string[]} authors Ordered supplied author names.
 * @property {number|null} [year] Publication year.
 * @property {string[]} notes Supplied publication notes.
 * @property {Object<string, JsonValue>} annotations Additional public annotations.
 */
/**
 * @typedef {Object} CatalogCuratedMetadata
 * @property {1} version Public annotation contract version.
 * @property {string|null} [title] Display title mirrored into standard STAC metadata.
 * @property {string|null} [description] Description mirrored into standard metadata.
 * @property {string[]} keywords Supplied keywords.
 * @property {string|null} [license] License name or identifier.
 * @property {string|null} [attribution] Attribution text.
 * @property {string|null} [doi] Dataset or file DOI name.
 * @property {string|null} [citation] Dataset or file citation.
 * @property {string[]} categories Supplied categories.
 * @property {string[]} risks Supplied risks.
 * @property {string[]} statuses Supplied association/readiness labels.
 * @property {string[]} study_ids Associated study identifiers.
 * @property {string|null} [study_time] Supplied study period, separate from Item time.
 * @property {CatalogPublication[]} publications Associated publications.
 * @property {Object<string, JsonValue>} annotations Additional public annotations.
 */
/**
 * @typedef {Object} CatalogReference
 * @property {string} href Safe browser destination.
 * @property {string} label Visible action text.
 * @property {boolean} external Whether to open a separate tab.
 * @property {string} [accessibleLabel] Context for otherwise repeated link text.
 */

const CONTEXT_ANNOTATIONS = new Set([
    "objective", "objectives", "study_objective", "study_objectives",
    "location", "study_location", "method", "methods", "study_methods",
    "findings", "main_findings", "study_summary",
]);
const EVIDENCE_ANNOTATIONS = new Set([
    "evidence", "limitations", "relationship", "relationship_notes",
    "threshold", "thresholds", "threshold_notes", "reconciliation",
    "reconciliation_evidence", "match_evidence", "reconciliation_notes",
]);

/**
 * Return an HTTP(S) destination safe to assign to a browser link.
 * This is the navigation boundary; rejected values remain visible as plain text.
 * @param {string} value Supplied external reference.
 * @return {string|null} Original URL, or null for an unsafe/non-HTTP reference.
 */
export function safeCatalogHttpReference(value) {
    if (!/^https?:\/\//i.test(value) || /[\\\s\u0000-\u001f]/u.test(value)) return null;
    try {
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:")
            && url.hostname !== "" && url.username === "" && url.password === ""
            ? value : null;
    } catch {
        return null;
    }
}

/**
 * Build a DOI resolver link without interpreting the DOI as a URL or markup.
 * @param {string} doi Supplied DOI name.
 * @return {string} HTTPS DOI resolver URL with path components encoded.
 */
export function catalogDoiReference(doi) {
    return "https://doi.org/" + doi.split("/").map(encodeURIComponent).join("/");
}

/**
 * Return the published file action for one Item Asset.
 * Catalog links carry only collection/Item/Asset identity. Directory geodatabases
 * have no download action because the attachment endpoint serves files.
 * @param {{collection:string,id:string}} item Owning Catalog identity.
 * @param {string} assetKey Asset key in that Item.
 * @param {{href:string,type?:string,"eolab:access"?:{kind:string}}} asset Public Asset.
 * @return {CatalogReference|null} File action, or null when none is supported.
 */
export function catalogAssetReference(item, assetKey, asset) {
    const access = asset["eolab:access"]?.kind;
    if (access === "catalog") {
        if (asset.type?.split(";")[0].trim() === "application/vnd.esri.file-geodatabase") {
            return null;
        }
        const query = new URLSearchParams({
            collection: item.collection, item: item.id, asset: assetKey,
        });
        return {
            href: "/api/catalog/asset?" + query.toString(),
            label: "Download file",
            external: false,
        };
    }
    const href = safeCatalogHttpReference(asset.href);
    return href === null ? null : { href, label: "Open source", external: true };
}

/**
 * Create an accessible link for an already approved browser destination.
 * @param {Document} documentContext Owning document.
 * @param {CatalogReference} reference Safe link and user-facing label.
 * @return {HTMLAnchorElement} Link that keeps external sources in a separate tab.
 */
export function createCatalogReferenceLink(documentContext, reference) {
    const link = documentContext.createElement("a");
    link.className = "catalog-reference";
    link.textContent = reference.label;
    link.href = reference.href;
    if (reference.accessibleLabel) link.setAttribute("aria-label", reference.accessibleLabel);
    if (reference.external) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
    }
    return link;
}

/**
 * Make an annotation key readable without changing its associated value.
 * @param {string} key Original annotation key.
 * @return {string} Spaced label retaining abbreviations and original wording.
 */
function annotationLabel(key) {
    const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Render all JSON annotation values as text or nested semantic lists.
 * Null, false, zero and empty collections remain distinct and visible.
 * @param {Document} documentContext Owning document.
 * @param {JsonValue} value Supplied public annotation value.
 * @return {HTMLElement} Safe value content.
 */
function createAnnotationValue(documentContext, value) {
    if (Array.isArray(value) && value.length > 0) {
        const list = documentContext.createElement("ul");
        list.className = "catalog-annotation-list";
        for (const entry of value) {
            const row = documentContext.createElement("li");
            row.append(createAnnotationValue(documentContext, entry));
            list.append(row);
        }
        return list;
    }
    if (value !== null && !Array.isArray(value) && typeof value === "object"
        && Object.keys(value).length > 0) {
        return createAnnotationList(documentContext, Object.entries(value));
    }
    const text = documentContext.createElement("span");
    text.className = "catalog-annotation-value";
    text.textContent = value === null ? "Not provided"
        : value === "" ? '""'
        : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (typeof value === "string") {
        const href = safeCatalogHttpReference(value);
        if (href !== null) return createCatalogReferenceLink(documentContext, {
            href, label: value, external: true,
        });
    }
    return text;
}

/**
 * Render named annotations, including nested values, without losing their scope.
 * @param {Document} documentContext Owning document.
 * @param {Array<[string, JsonValue]>} entries Ordered annotation pairs.
 * @return {HTMLDListElement} Labeled annotation values.
 */
function createAnnotationList(documentContext, entries) {
    const list = documentContext.createElement("dl");
    list.className = "catalog-metadata catalog-annotations";
    for (const [key, value] of entries) {
        const term = documentContext.createElement("dt");
        term.textContent = annotationLabel(key);
        term.title = key;
        const description = documentContext.createElement("dd");
        description.append(createAnnotationValue(documentContext, value));
        list.append(term, description);
    }
    return list;
}

/**
 * Append a titled section only when it has supplied values.
 * @param {HTMLElement} parent Container for one Item or Asset's annotations.
 * @param {string} title Section title.
 * @param {Array<[string, JsonValue]>} entries Supplied annotations.
 * @param {number} headingLevel Heading level within the inspector.
 * @return {void}
 */
function appendAnnotationSection(parent, title, entries, headingLevel) {
    if (entries.length === 0) return;
    const section = parent.ownerDocument.createElement("section");
    section.className = "catalog-curated-section";
    const heading = parent.ownerDocument.createElement("h" + headingLevel);
    heading.textContent = title;
    section.append(heading, createAnnotationList(parent.ownerDocument, entries));
    parent.append(section);
}

/**
 * Render one publication with its own citation, notes and additional annotations.
 * @param {Document} documentContext Owning document.
 * @param {CatalogPublication} publication Supplied publication record.
 * @param {number} headingLevel Heading level for its title.
 * @return {HTMLElement} Publication card with safe source references.
 */
function createPublicationCard(documentContext, publication, headingLevel) {
    const article = documentContext.createElement("article");
    article.className = "catalog-publication";
    const heading = documentContext.createElement("h" + headingLevel);
    heading.textContent = publication.title;
    article.append(heading);
    const entries = [];
    if (publication.authors.length > 0) entries.push(["Authors", publication.authors]);
    if (publication.year != null) entries.push(["Publication year", publication.year]);
    if (publication.citation != null) entries.push(["Citation", publication.citation]);
    if (entries.length > 0) article.append(createAnnotationList(documentContext, entries));
    if (publication.doi != null) article.append(createCatalogReferenceLink(documentContext, {
        href: catalogDoiReference(publication.doi),
        label: "Paper DOI: " + publication.doi, external: true,
    }));
    if (publication.url != null) {
        const href = safeCatalogHttpReference(publication.url);
        if (href !== null) article.append(createCatalogReferenceLink(documentContext, {
            href, label: "Open publication", external: true,
            accessibleLabel: "Open publication: " + publication.title,
        }));
        else article.append(createAnnotationList(documentContext, [["Publication reference", publication.url]]));
    }
    if (publication.notes.length > 0) {
        article.append(createAnnotationList(documentContext, [["Publication notes", publication.notes]]));
    }
    if (Object.keys(publication.annotations).length > 0) {
        article.append(createAnnotationList(documentContext, Object.entries(publication.annotations)));
    }
    article.append(createAnnotationList(documentContext, [["Publication ID", publication.id]]));
    return article;
}

/**
 * Show an Item or Asset's curated study information in the existing inspector.
 * Titles/descriptions are rendered by the caller once. This component never
 * fetches papers, reads source files, or changes analysis/rendering availability.
 * @param {CatalogCuratedMetadata} metadata Validated public annotation envelope.
 * @param {Object} options DOM and scope supplied by the existing inspector.
 * @param {Document} [options.documentContext=document] Owning document.
 * @param {"dataset"|"file"} [options.scope="dataset"] Scope for DOI/citation labels.
 * @param {number} [options.headingLevel=4] Section heading level.
 * @return {HTMLDivElement} Study sections retaining every public annotation.
 */
export function createCuratedMetadataView(metadata, {
    documentContext = document, scope = "dataset", headingLevel = 4,
} = {}) {
    const root = documentContext.createElement("div");
    root.className = "catalog-curated";
    const context = [];
    for (const [key, label] of [
        ["statuses", "Evidence status"], ["categories", "Categories"],
        ["risks", "Risks"], ["study_ids", "Study IDs"], ["keywords", "Keywords"],
    ]) {
        if (metadata[key].length > 0) context.push([label, metadata[key]]);
    }
    for (const [key, label] of [
        ["study_time", "Study period"], ["license", "License"], ["attribution", "Attribution"],
        ["citation", scope === "dataset" ? "Dataset citation" : "File citation"],
    ]) {
        if (metadata[key] != null) context.push([label, metadata[key]]);
    }
    const annotations = Object.entries(metadata.annotations);
    const contextAnnotations = [], evidenceAnnotations = [], otherAnnotations = [];
    for (const entry of annotations) {
        const normalizedKey = entry[0].toLowerCase().replace(/[ -]+/g, "_");
        const group = CONTEXT_ANNOTATIONS.has(normalizedKey) ? contextAnnotations
            : EVIDENCE_ANNOTATIONS.has(normalizedKey) ? evidenceAnnotations : otherAnnotations;
        group.push(entry);
    }
    appendAnnotationSection(root, scope === "dataset" ? "Study and dataset context" : "About this file",
        context.concat(contextAnnotations), headingLevel);
    if (metadata.doi != null) root.append(createCatalogReferenceLink(documentContext, {
        href: catalogDoiReference(metadata.doi),
        label: (scope === "dataset" ? "Dataset DOI: " : "File DOI: ") + metadata.doi,
        external: true,
    }));
    if (metadata.publications.length > 0) {
        const section = documentContext.createElement("section");
        section.className = "catalog-curated-section";
        const heading = documentContext.createElement("h" + headingLevel);
        heading.textContent = "Source publications";
        section.append(heading);
        for (const publication of metadata.publications) {
            section.append(createPublicationCard(documentContext, publication, Math.min(6, headingLevel + 1)));
        }
        root.append(section);
    }
    appendAnnotationSection(root, "Evidence and limitations", evidenceAnnotations, headingLevel);
    appendAnnotationSection(root, "Additional annotations", otherAnnotations, headingLevel);
    return root;
}
