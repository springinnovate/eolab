/**
 * Compact presentation rules for Catalog search results.
 *
 * Search results expose the file identity and only the context needed to
 * distinguish nearby records. Complete STAC metadata remains in the item
 * inspector.
 */

/** Normalize one optional Catalog label to a non-empty string. */
function optionalLabel(value) {
    return typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : null;
}

/** Return the basename of a Catalog path using either path separator. */
function basename(path) {
    const normalizedPath = path.replaceAll("\\", "/").replace(/\/+$/, "");
    return normalizedPath.split("/").at(-1) ?? normalizedPath;
}

/** Convert a path slug into compact readable context. */
function humanizePathSegment(segment) {
    return segment.replaceAll(/[-_]+/g, " ").trim();
}

/**
 * Find the source filename and optional vector layer encoded by one Item.
 *
 * @param {Object} item STAC Item.
 * @return {{sourcePath:string,fullTitle:string,layerName:string|null}}
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
 * @param {string} sourcePath Catalog-relative source path.
 * @return {string|null} Hazard/time context, parent folder, or null.
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
            return `${humanizePathSegment(hazardPeriod[1])} · ${hazardPeriod[2].toLowerCase()}`;
        }
    }
    return humanizePathSegment(parentSegments.at(-1));
}

/**
 * Build the compact and accessible identity for one Catalog result.
 *
 * @param {Object} item STAC Item.
 * @param {string|undefined} datasetType Known mounted dataset type.
 * @return {{filename:string,context:string|null,datasetType:string|null,
 * fullTitle:string,accessibleLabel:string}}
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
        accessibleLabel: `Open details for ${accessibleParts.join(", ")}`
    };
}

/**
 * Format the concise count shown immediately above Catalog results.
 *
 * @param {Object} itemCollection STAC ItemCollection response.
 * @return {string} Result count with estimate provenance when applicable.
 */
export function formatCatalogResultCount(itemCollection) {
    const resultCount = itemCollection.numberMatched;
    const noun = resultCount === 1 ? "result" : "results";
    const estimate = itemCollection.numberMatchedEstimated ? " (est.)" : "";
    return `${resultCount.toLocaleString()}${estimate} ${noun}`;
}
