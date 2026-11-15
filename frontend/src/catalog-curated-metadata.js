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
    "findings", "main_findings", "study_summary", "evidence_type", "dataset_role",
    "study_design", "design",
]);
const EVIDENCE_ANNOTATIONS = new Set([
    "evidence", "limitations", "relationship", "relationship_notes",
    "threshold", "thresholds", "threshold_notes",
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
 * Compare safe external destinations without changing the supplied link value.
 * DOI resolver aliases share one identity; other URLs retain path, query and
 * fragment distinctions so separate resources are never hidden by their title.
 * @param {string} href Approved HTTP(S) destination.
 * @return {string} Normalized comparison key used only by the inspector.
 */
export function catalogReferenceIdentity(href) {
    const url = new URL(href);
    if (["doi.org", "dx.doi.org"].includes(url.hostname.toLowerCase())) {
        const doiPath = url.pathname.replace(/%[0-9a-f]{2}/gi, (escape) =>
            String.fromCharCode(parseInt(escape.slice(1), 16))).toLowerCase();
        return JSON.stringify(["doi", doiPath, url.search, url.hash]);
    }
    return url.href;
}

/**
 * Create a native disclosure for optional Catalog detail.
 * @param {Document} documentContext Owning document.
 * @param {string} label Visible and keyboard-accessible summary.
 * @return {HTMLDetailsElement} Initially closed disclosure ready for content.
 */
export function createCatalogDisclosure(documentContext, label) {
    const details = documentContext.createElement("details");
    details.className = "catalog-detail-disclosure";
    const summary = documentContext.createElement("summary");
    summary.textContent = label;
    details.append(summary);
    return details;
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
 * @param {Set<string>} references Destinations already linked in this inspector.
 * @return {HTMLElement} Safe value content.
 */
function createAnnotationValue(documentContext, value, references) {
    if (Array.isArray(value) && value.length > 0) {
        const list = documentContext.createElement("ul");
        list.className = "catalog-annotation-list";
        for (const entry of value) {
            const row = documentContext.createElement("li");
            row.append(createAnnotationValue(documentContext, entry, references));
            list.append(row);
        }
        return list;
    }
    if (value !== null && !Array.isArray(value) && typeof value === "object"
        && Object.keys(value).length > 0) {
        return createAnnotationList(documentContext, Object.entries(value), references);
    }
    const text = documentContext.createElement("span");
    text.className = "catalog-annotation-value";
    text.textContent = value === null ? "Not provided"
        : value === "" ? '""'
        : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (typeof value === "string") {
        const href = safeCatalogHttpReference(value);
        if (href !== null && !references.has(catalogReferenceIdentity(href))) {
            references.add(catalogReferenceIdentity(href));
            return createCatalogReferenceLink(documentContext, {
                href, label: value, external: true,
            });
        }
    }
    return text;
}

/**
 * Render named annotations, including nested values, without losing their scope.
 * @param {Document} documentContext Owning document.
 * @param {Array<[string, JsonValue]>} entries Ordered annotation pairs.
 * @param {Set<string>} references Destinations already linked in this inspector.
 * @return {HTMLDListElement} Labeled annotation values.
 */
function createAnnotationList(documentContext, entries, references) {
    const list = documentContext.createElement("dl");
    list.className = "catalog-metadata catalog-annotations";
    for (const [key, value] of entries) {
        const term = documentContext.createElement("dt");
        term.textContent = annotationLabel(key);
        term.title = key;
        const description = documentContext.createElement("dd");
        description.append(createAnnotationValue(documentContext, value, references));
        list.append(term, description);
    }
    return list;
}

/**
 * Append supplied values under a heading without repeating a matching sole label.
 * @param {HTMLElement} parent Container for one Item or Asset's annotations.
 * @param {string} title Section title.
 * @param {Array<[string, JsonValue]>} entries Supplied annotations.
 * @param {number} headingLevel Heading level within the inspector.
 * @param {Set<string>} references Destinations already linked in this inspector.
 * @return {void}
 */
function appendAnnotationSection(parent, title, entries, headingLevel, references) {
    if (entries.length === 0) return;
    const section = parent.ownerDocument.createElement("section");
    section.className = "catalog-curated-section";
    const heading = parent.ownerDocument.createElement("h" + headingLevel);
    heading.textContent = title;
    if (entries.length === 1 && annotationLabel(entries[0][0]).toLowerCase() === title.toLowerCase()) {
        const content = parent.ownerDocument.createElement("div");
        content.className = "catalog-annotation-content";
        content.append(createAnnotationValue(parent.ownerDocument, entries[0][1], references));
        section.append(heading, content);
    } else {
        section.append(heading, createAnnotationList(parent.ownerDocument, entries, references));
    }
    parent.append(section);
}

/**
 * Render one publication, retaining unique links and keeping record IDs optional.
 * @param {Document} documentContext Owning document.
 * @param {CatalogPublication} publication Supplied publication record.
 * @param {number} headingLevel Heading level for its title.
 * @param {Set<string>} references Destinations already linked in this inspector.
 * @return {HTMLElement} Publication card with safe source references.
 */
function createPublicationCard(documentContext, publication, headingLevel, references) {
    const article = documentContext.createElement("article");
    article.className = "catalog-publication";
    const heading = documentContext.createElement("h" + headingLevel);
    heading.textContent = publication.title;
    article.append(heading);
    const entries = [];
    if (publication.authors.length > 0) entries.push(["Authors", publication.authors]);
    if (publication.year != null) entries.push(["Publication year", publication.year]);
    if (publication.citation != null) entries.push(["Citation", publication.citation]);
    if (entries.length > 0) article.append(createAnnotationList(documentContext, entries, references));
    const doiHref = publication.doi == null ? null : catalogDoiReference(publication.doi);
    const publicationHref = publication.url == null ? null : safeCatalogHttpReference(publication.url);
    const primaryHref = publicationHref ?? doiHref;
    if (primaryHref !== null && !references.has(catalogReferenceIdentity(primaryHref))) {
        article.append(createCatalogReferenceLink(documentContext, {
            href: primaryHref, label: "Read paper", external: true,
            accessibleLabel: "Read paper: " + publication.title,
        }));
        references.add(catalogReferenceIdentity(primaryHref));
    }
    if (publication.notes.length > 0) {
        article.append(createAnnotationList(documentContext, [["Publication notes", publication.notes]], references));
    }
    const detail = createCatalogDisclosure(documentContext, "Publication record");
    detail.append(createAnnotationList(documentContext, [
        ["Publication ID", publication.id],
        ...(publication.url == null ? [] : [["Publication reference", publication.url]]),
        ...Object.entries(publication.annotations),
    ], references));
    if (doiHref !== null) {
        if (!references.has(catalogReferenceIdentity(doiHref))) {
            detail.append(createCatalogReferenceLink(documentContext, {
                href: doiHref, label: "Paper DOI: " + publication.doi, external: true,
            }));
            references.add(catalogReferenceIdentity(doiHref));
        } else {
            detail.append(createAnnotationList(documentContext, [["Paper DOI", publication.doi]], references));
        }
    }
    article.append(detail);
    return article;
}

/**
 * Show supplied study context or references in the existing Catalog inspector.
 * Titles/descriptions are rendered by the caller once. Unknown annotations and
 * dataset provenance remain available in a disclosure; file provenance goes
 * inside the caller's File details disclosure. No source files are fetched.
 * @param {CatalogCuratedMetadata} metadata Validated public annotation envelope.
 * @param {Object} options DOM and scope supplied by the existing inspector.
 * @param {Document} [options.documentContext=document] Owning document.
 * @param {"dataset"|"file"} [options.scope="dataset"] Scope for DOI/citation labels.
 * @param {number} [options.headingLevel=4] Section heading level.
 * @param {"all"|"context"|"references"} [options.section="all"] Sections to render;
 * separate context and references calls let the inspector place files between them.
 * @param {Set<string>} [options.references] Shared destination identities; newly
 * rendered external links are added so repeated references remain plain text.
 * @return {HTMLDivElement} Study sections retaining every supplied annotation.
 */
export function createCuratedMetadataView(metadata, {
    documentContext = document, scope = "dataset", headingLevel = 4,
    section = "all", references = new Set(),
} = {}) {
    const root = documentContext.createElement("div");
    root.className = "catalog-curated";
    const context = [];
    if (metadata.study_time != null) context.push(["Study period", metadata.study_time]);
    for (const [key, label] of [
        ["statuses", "Data status"], ["categories", "Categories"], ["risks", "Risks"],
    ]) {
        if (metadata[key].length > 0) context.push([label, metadata[key]]);
    }
    const contextAnnotations = [], evidenceAnnotations = [], otherAnnotations = [];
    for (const entry of Object.entries(metadata.annotations)) {
        const normalizedKey = entry[0].toLowerCase().replace(/[ -]+/g, "_");
        const group = CONTEXT_ANNOTATIONS.has(normalizedKey) ? contextAnnotations
            : EVIDENCE_ANNOTATIONS.has(normalizedKey) ? evidenceAnnotations : otherAnnotations;
        group.push(entry);
    }
    if (section !== "references") {
        appendAnnotationSection(root, scope === "dataset" ? "Study context" : "About this file",
            contextAnnotations.concat(context), headingLevel, references);
        const evidenceTitle = evidenceAnnotations.length === 1
            && annotationLabel(evidenceAnnotations[0][0]).toLowerCase() === "limitations"
            ? "Limitations" : "Evidence and limitations";
        appendAnnotationSection(root, evidenceTitle, evidenceAnnotations, headingLevel, references);
    }
    if (section === "context") return root;
    const sourceEntries = [];
    for (const [key, label] of [
        ["license", "License"], ["attribution", "Attribution"],
        ["citation", scope === "dataset" ? "Dataset citation" : "File citation"],
    ]) {
        if (metadata[key] != null) sourceEntries.push([label, metadata[key]]);
    }
    appendAnnotationSection(root, "Source and citation", sourceEntries, headingLevel, references);
    if (metadata.doi != null) {
        const href = catalogDoiReference(metadata.doi);
        const label = (scope === "dataset" ? "Dataset DOI: " : "File DOI: ") + metadata.doi;
        if (!references.has(catalogReferenceIdentity(href))) {
            root.append(createCatalogReferenceLink(documentContext, { href, label, external: true }));
            references.add(catalogReferenceIdentity(href));
        } else {
            root.append(createAnnotationList(documentContext, [["DOI", metadata.doi]], references));
        }
    }
    if (metadata.publications.length > 0) {
        const publications = documentContext.createElement("section");
        publications.className = "catalog-curated-section";
        const heading = documentContext.createElement("h" + headingLevel);
        heading.textContent = "Source publications";
        publications.append(heading);
        for (const publication of metadata.publications) {
            publications.append(createPublicationCard(documentContext, publication, Math.min(6, headingLevel + 1), references));
        }
        root.append(publications);
    }
    const provenance = [];
    if (metadata.study_ids.length > 0) provenance.push(["Study IDs", metadata.study_ids]);
    if (metadata.keywords.length > 0) provenance.push(["Keywords", metadata.keywords]);
    provenance.push(...otherAnnotations);
    if (scope === "file") {
        appendAnnotationSection(root, "Additional metadata", provenance, headingLevel, references);
    } else if (provenance.length > 0) {
        const detail = createCatalogDisclosure(documentContext, "Provenance and additional metadata");
        detail.append(createAnnotationList(documentContext, provenance, references));
        root.append(detail);
    }
    return root;
}
