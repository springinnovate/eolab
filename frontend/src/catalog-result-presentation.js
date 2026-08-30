/**
 * Compact presentation rules for Catalog search results.
 *
 * Search results expose the file identity and only the context needed to
 * distinguish nearby Items. Complete STAC metadata remains in the item
 * inspector.
 */

/**
 * Normalize one optional Catalog label to a non-empty string.
 *
 * @param {unknown} value Candidate label from Item metadata or a type lookup.
 * @return {string|null} Trimmed text, or null for blank or non-string values.
 */
function optionalLabel(value) {
    return typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : null;
}

/**
 * Return the basename of a Catalog path using either path separator.
 *
 * @param {string} path Source path or standalone title; may end in separators.
 * @return {string} Final path segment after normalizing separators and removing
 * trailing separators; an empty string when no segment remains.
 */
function basename(path) {
    const normalizedPath = path.replaceAll("\\", "/").replace(/\/+$/, "");
    return normalizedPath.split("/").at(-1) ?? normalizedPath;
}

/**
 * Convert a path slug into compact readable context.
 *
 * @param {string} segment One directory name or hazard slug from a source path.
 * @return {string} Trimmed text with runs of hyphens and underscores replaced
 * by single spaces; an empty string when the segment contains only separators
 * or whitespace.
 */
function formatReadablePathSegment(segment) {
    return segment.replaceAll(/[-_]+/g, " ").trim();
}

/**
 * Find the source filename and optional vector layer encoded by one Item.
 *
 * @param {Object} item STAC Item with optional id, properties.title,
 * properties["eolab:layer_name"], and asset titles used to recover its identity.
 * @return {{sourcePath:string,fullTitle:string,layerName:string|null}} Identity
 * with sourcePath suitable for filename extraction, fullTitle preserving the
 * Item title (falling back to its id or "Untitled dataset"), and layerName from
 * explicit metadata or the title suffix, or null when neither supplies one.
 */
function getCatalogSourceIdentity(item) {
    const itemTitle = optionalLabel(item.properties?.title);
    const itemIdentifier = optionalLabel(item.id) ?? "Untitled dataset";
    const fullTitle = itemTitle ?? itemIdentifier;
    const titleParts = fullTitle.split(" — ");
    const titlePath = titleParts[0];
    const layerName = optionalLabel(item.properties?.["eolab:layer_name"])
        ?? optionalLabel(titleParts.length > 1 ? titleParts.at(-1) : null);

    let sourcePath = titlePath;
    if (layerName !== null) {
        const assetTitle = Object.values(item.assets ?? {})
            .map((asset) => optionalLabel(asset?.title))
            .find((title) => title !== null);
        if (assetTitle !== undefined) {
            sourcePath = assetTitle;
        } else {
            const pathSegments = sourcePath.replaceAll("\\", "/").split("/");
            if (
                pathSegments.length > 1
                && pathSegments.at(-1) === layerName
                && /\.(?:gdb|gpkg)$/i.test(pathSegments.at(-2))
            ) {
                sourcePath = pathSegments.slice(0, -1).join("/");
            }
        }
    }
    return { sourcePath, fullTitle, layerName };
}

/**
 * Derive concise directory context for one source path.
 *
 * @param {string} sourcePath Source path using forward or backward separators.
 * @return {string|null} Readable hazard and historic/future context from the
 * nearest matching ancestor, otherwise the readable immediate parent folder,
 * or null when the path has no parent segment.
 */
function getCatalogPathContext(sourcePath) {
    const pathSegments = sourcePath
        .replaceAll("\\", "/")
        .split("/")
        .filter((segment) => segment !== "");
    if (pathSegments.length < 2) {
        return null;
    }
    const parentSegments = pathSegments.slice(0, -1);
    for (const segment of parentSegments.toReversed()) {
        const hazardPeriod = segment.match(/^(.+?)-(historic|future)(?:-|$)/i);
        if (hazardPeriod !== null) {
            return `${formatReadablePathSegment(hazardPeriod[1])} · ${hazardPeriod[2].toLowerCase()}`;
        }
    }
    return formatReadablePathSegment(parentSegments.at(-1));
}

/**
 * Build the compact and accessible identity for one Catalog result.
 *
 * @param {Object} item STAC Item whose optional title, id, vector layer name,
 * and asset titles identify the source file and its directory context.
 * @param {string|undefined} datasetType Display label from the mounted dataset
 * type lookup, such as "Raster" or "Vector"; undefined for an unknown type.
 * @return {{filename:string,context:string|null,datasetType:string|null,
 * fullTitle:string,accessibleLabel:string}} Presentation containing the source
 * basename, optional layer or directory context, normalized type label, full
 * Item title (or its fallback), and an accessible details-action label that
 * retains the full source identity when the visible filename is abbreviated.
 */
export function buildCatalogResultPresentation(item, datasetType) {
    const { sourcePath, fullTitle, layerName } = getCatalogSourceIdentity(item);
    const filename = basename(sourcePath);
    const context = layerName === null
        ? getCatalogPathContext(sourcePath)
        : `Layer: ${layerName}`;
    const normalizedDatasetType = optionalLabel(datasetType);
    const accessibleParts = [filename, context, normalizedDatasetType]
        .filter((part) => part !== null);
    if (fullTitle !== filename) {
        accessibleParts.push(`Source: ${fullTitle}`);
    }
    return {
        filename,
        context,
        datasetType: normalizedDatasetType,
        fullTitle,
        accessibleLabel: `More details for ${accessibleParts.join(", ")}`
    };
}

/**
 * Format the concise count shown immediately above Catalog results.
 *
 * @param {Object} itemCollection Validated STAC ItemCollection response.
 * @param {number} itemCollection.numberMatched Matched-Item count to display.
 * @param {boolean} [itemCollection.numberMatchedEstimated=false] Whether the
 * count is an estimate rather than an exact match count.
 * @return {string} Locale-formatted count followed by "result" or "results",
 * with " (est.)" after the number when the count is estimated.
 */
export function formatCatalogResultCount(itemCollection) {
    const resultCount = itemCollection.numberMatched;
    const noun = resultCount === 1 ? "result" : "results";
    const estimate = itemCollection.numberMatchedEstimated ? " (est.)" : "";
    return `${resultCount.toLocaleString()}${estimate} ${noun}`;
}
