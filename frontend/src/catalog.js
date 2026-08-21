const CATALOG_PAGE_SIZE = 20;
const CATALOG_SUBSTRING_PROPERTIES = [
    "title",
    "description",
    "eolab_datetime_text",
    "eolab_end_datetime_text"
];
export const MOUNTED_GEOTIFF_COLLECTION_ID = "eolab-mounted-geotiffs";
const RASTER_RENDERING_POLICY = "raster-v2";
export const MOUNTED_DATASET_TYPES = new Map([
    [MOUNTED_GEOTIFF_COLLECTION_ID, "Raster"],
    ["eolab-mounted-vectors", "Vector"]
]);

/**
 * Returns the scanner-owned visualization decision for a mounted GeoTIFF.
 *
 * @param {Object|null} item Selected STAC Item.
 * @return {Object|null|undefined} Rendering metadata, null for a non-raster
 * Item, or undefined when the selected raster has not been assessed.
 */
export function getRasterVisualization(item) {
    if (item?.collection !== MOUNTED_GEOTIFF_COLLECTION_ID) {
        return null;
    }
    const renderingMetadata = item.assets.data["eolab:rendering"];
    return renderingMetadata?.policy === RASTER_RENDERING_POLICY
        ? renderingMetadata
        : undefined;
}

/** Format a byte count without implying decimal storage units. */
function formatByteSize(byteCount) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = byteCount;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toLocaleString(undefined, {
        maximumFractionDigits: 1
    })} ${units[unitIndex]}`;
}

/**
 * Formats a duration at a useful precision for a live scan.
 *
 * @param {number} seconds Duration in seconds.
 * @return {string} Human-readable duration.
 */
function formatDuration(seconds) {
    if (seconds < 1) {
        return `${Math.round(seconds * 1000).toLocaleString()} ms`;
    }
    if (seconds < 60) {
        return `${seconds.toFixed(1)} s`;
    }

    const totalSeconds = Math.round(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    return hours === 0
        ? `${minutes}m ${remainingSeconds}s`
        : `${hours}h ${minutes}m ${remainingSeconds}s`;
}

/**
 * Formats the compact mounted-directory scan state.
 *
 * @param {Object} scanStatus Scan progress returned by the backend.
 * @return {string} Human-readable scan summary.
 */
export function formatScanStatusSummary(scanStatus) {
    switch (scanStatus.state) {
        case "not_started":
            return "Scan status: Not started";
        case "discovering":
        case "scanning":
            return "Scan status: In progress";
        case "completed": {
            if (scanStatus.failed === 0) {
                return "Scan status: Complete";
            }
            const errorNoun = scanStatus.failed === 1 ? "error" : "errors";
            return `Scan status: Complete · ${scanStatus.failed.toLocaleString()} dataset ${errorNoun}`;
        }
        case "failed":
            return "Scan status: Failed";
        default:
            throw new Error(`Unknown scan state: ${scanStatus.state}`);
    }
}

/**
 * Formats the performance clocks in a scan-status response.
 *
 * @param {Object} timing Scan timing values in seconds.
 * @param {number} workerCount Number of concurrent metadata processes.
 * @param {number} writerCount Number of concurrent catalog writers.
 * @param {number} batchSize Maximum Items in one catalog write.
 * @return {Object[]} Human-readable timing labels and values.
 */
export function formatScanTiming(timing, workerCount, writerCount, batchSize) {
    return [
        { label: "Elapsed wall time", seconds: timing.elapsedSeconds },
        {
            label: "Catalog inventory",
            seconds: timing.catalogInventorySeconds
        },
        { label: "Dataset discovery", seconds: timing.discoverySeconds },
        {
            label: "Waiting for metadata results",
            seconds: timing.metadataResultWaitSeconds
        },
        {
            label: `Metadata workers (${workerCount}, cumulative)`,
            seconds: timing.metadataWorkerSeconds
        },
        {
            label: "Metadata I/O wait (estimated, cumulative)",
            seconds: timing.metadataIoWaitSeconds
        },
        {
            label: "Metadata processing CPU (cumulative)",
            seconds: timing.metadataProcessingSeconds
        },
        {
            label:
                `Catalog writes (${writerCount} writers, ${batchSize} ` +
                "Items/batch, cumulative)",
            seconds: timing.catalogWriteSeconds
        },
        {
            label: "Search-count refresh",
            seconds: timing.cacheInvalidationSeconds
        }
    ].map(({ label, seconds }) => ({
        label,
        value: formatDuration(seconds)
    }));
}

/**
 * Formats the position and total from a STAC ItemCollection.
 *
 * @param {Object} itemCollection STAC ItemCollection response.
 * @param {number} displayedItemCount Number of Items currently rendered.
 * @param {boolean} isFiltered Whether the Item Search includes a filter.
 * @return {string} Human-readable rendered and matched Item counts.
 */
export function formatCatalogItemCount(
    itemCollection,
    displayedItemCount,
    isFiltered
) {
    const matchedItemCount = itemCollection.numberMatched;
    const qualifier = isFiltered ? "matching " : "";
    const itemNoun = matchedItemCount === 1 ? "Item" : "Items";
    if (displayedItemCount === 0) {
        return `0 ${qualifier}${itemNoun}`;
    }

    const estimatedLabel = itemCollection.numberMatchedEstimated
        ? " (est.)"
        : "";
    return `Showing ${displayedItemCount.toLocaleString()} of ${matchedItemCount.toLocaleString()}${estimatedLabel} ${qualifier}${itemNoun}`;
}

/**
 * Builds a standard CQL2 substring filter for Item text and datetime values.
 * The EOLab queryables expose standard STAC datetime fields as text because
 * pgSTAC's native datetime queryables are timestamps rather than strings.
 *
 * @param {string} searchText Text entered in the Catalog search field.
 * @return {Object|null} CQL2 JSON filter, or null for no filter.
 * @example
 * // "2004" becomes the CQL2 equivalent of:
 * // casei(title) LIKE casei("%2004%")
 * // OR casei(description) LIKE casei("%2004%"), and so on.
 * buildSubstringFilter("2004");
 */
export function buildSubstringFilter(searchText) {
    const normalizedSearchText = searchText.normalize("NFKC").trim();
    if (normalizedSearchText === "") {
        return null;
    }
    const literalPattern = normalizedSearchText
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
    const pattern = { op: "casei", args: [`%${literalPattern}%`] };
    return {
        op: "or",
        args: CATALOG_SUBSTRING_PROPERTIES.map((propertyName) => ({
            op: "like",
            args: [{ op: "casei", args: [{ property: propertyName }] }, pattern]
        }))
    };
}

/**
 * Creates a restartable delayed action for server-backed search. Native search
 * inputs emit each change immediately and do not provide this delay.
 *
 * @param {Function} action Action to invoke after the delay.
 * @param {number} delayMilliseconds Quiet period before invocation.
 * @param {{setTimeout: Function, clearTimeout: Function}} timer Timer provider.
 * @return {Function} Function that restarts the delay whenever it is called.
 */
export function createDebouncedAction(
    action,
    delayMilliseconds,
    timer = globalThis
) {
    let timeoutIdentifier = null;
    return (...actionArguments) => {
        if (timeoutIdentifier !== null) {
            timer.clearTimeout(timeoutIdentifier);
        }
        timeoutIdentifier = timer.setTimeout(() => {
            timeoutIdentifier = null;
            action(...actionArguments);
        }, delayMilliseconds);
    };
}

/**
 * Returns a pagination link from a STAC ItemCollection.
 *
 * @param {Object} itemCollection STAC ItemCollection response.
 * @param {string[]} relations Accepted link relation names.
 * @return {Object|null} Matching STAC link or null when unavailable.
 */
export function findPaginationLink(itemCollection, relations) {
    if (!Array.isArray(itemCollection.links)) {
        return null;
    }
    return (
        itemCollection.links.find((link) => relations.includes(link.rel)) ??
        null
    );
}

/**
 * Builds display details for a STAC Item, including its identity, datetime or
 * datetime range, geometry, bounding box, projection, raster dimensions,
 * Assets, vector fields, and raster bands.
 *
 * @param {Object} item STAC Item selected in the result list.
 * @param {Object[]} collections STAC Collections available to the Catalog.
 * @param {string} scanDisplayPathPrefix User-facing root for mounted files.
 * @return {Object} Text-only metadata grouped for inspector rendering.
 */
export function buildCatalogItemDetails(
    item,
    collections,
    scanDisplayPathPrefix
) {
    const properties = item.properties;
    const collection = collections.find(
        (candidateCollection) => candidateCollection.id === item.collection
    );
    const collectionLabel = collection?.title
        ? `${collection.title} (${item.collection})`
        : item.collection;
    const metadata = [
        { label: "Item ID", value: item.id },
        { label: "Collection", value: collectionLabel }
    ];
    const datasetType = MOUNTED_DATASET_TYPES.get(item.collection);
    if (datasetType !== undefined) {
        metadata.push({ label: "Dataset type", value: datasetType });
    }
    if (properties.datetime === null) {
        metadata.push({
            label: "Item datetime range",
            value: `${properties.start_datetime} – ${properties.end_datetime}`
        });
    } else {
        metadata.push({ label: "Item datetime", value: properties.datetime });
    }
    if (item.geometry !== null) {
        metadata.push({
            label: "Footprint geometry",
            value: item.geometry.type
        });
    }
    if (item.bbox !== undefined) {
        metadata.push({ label: "Bounding box", value: item.bbox.join(", ") });
    }
    if (properties["proj:epsg"] !== undefined) {
        metadata.push({
            label: "Coordinate reference system",
            value: `EPSG:${properties["proj:epsg"]}`
        });
    } else if (properties["proj:wkt2"] !== undefined) {
        metadata.push({
            label: "Coordinate reference system",
            value: properties["proj:wkt2"]
        });
    }
    if (properties["proj:shape"] !== undefined) {
        const [height, width] = properties["proj:shape"];
        metadata.push({
            label: "Raster dimensions",
            value: `${width} × ${height} pixels`
        });
    }
    if (properties["table:row_count"] !== undefined) {
        metadata.push({
            label: "Feature count",
            value: properties["table:row_count"].toLocaleString()
        });
    }
    const primaryGeometryColumn = (properties["table:columns"] ?? []).find(
        (column) => column.name === properties["table:primary_geometry"]
    );
    if (primaryGeometryColumn !== undefined) {
        metadata.push({
            label: "Declared feature geometry type",
            value: primaryGeometryColumn.type
        });
    }

    const fields = (properties["table:columns"] ?? [])
        .filter(
            (column) => column.name !== properties["table:primary_geometry"]
        )
        .map((column) => ({
            label: column.name,
            value: column.type ?? "Not provided"
        }));

    const assets = Object.entries(item.assets).map(([assetKey, asset]) => {
        const isMountedFile =
            datasetType !== undefined && asset.href.startsWith("file:");
        let location = asset.href;
        if (isMountedFile) {
            const separator = scanDisplayPathPrefix.includes("\\") ? "\\" : "/";
            const relativePath = (
                asset.title ??
                properties.title ??
                item.id
            ).replaceAll("/", separator);
            const joiner =
                scanDisplayPathPrefix.endsWith("/") ||
                scanDisplayPathPrefix.endsWith("\\")
                    ? ""
                    : separator;
            location = `${scanDisplayPathPrefix}${joiner}${relativePath}`;
        }
        const assetMetadata = [
            {
                label: isMountedFile ? "Original location" : "Location",
                value: location
            }
        ];
        if (asset.type !== undefined) {
            assetMetadata.push({ label: "Media type", value: asset.type });
        }
        if (asset.roles !== undefined) {
            assetMetadata.push({
                label: "Roles",
                value: asset.roles.join(", ")
            });
        }
        if (asset.updated !== undefined) {
            assetMetadata.push({
                label: "File modified",
                value: asset.updated
            });
        }
        if (asset["file:size"] !== undefined) {
            assetMetadata.push({
                label: "File size",
                value: formatByteSize(asset["file:size"])
            });
        }
        const renderingMetadata = asset["eolab:rendering"];
        if (renderingMetadata !== undefined) {
            assetMetadata.push(
                {
                    label: "Storage profile",
                    value: asset.type.includes("profile=cloud-optimized")
                        ? "Cloud Optimized GeoTIFF"
                        : "GeoTIFF"
                },
                {
                    label: "Block shapes",
                    value: renderingMetadata.block_shapes
                        .map(
                            ([height, width]) =>
                                `${width} × ${height} pixels`
                        )
                        .join(" · ")
                },
                {
                    label: "Overview storage",
                    value: {
                        none: "None",
                        internal: "Internal",
                        external: "External sidecar"
                    }[renderingMetadata.overview_storage]
                },
                {
                    label: "Overview factors",
                    value: renderingMetadata.overview_factors
                        .map((factors, bandIndex) =>
                            factors.length === 0
                                ? `Band ${bandIndex + 1}: None`
                                : `Band ${bandIndex + 1}: ${factors
                                      .map((factor) => `${factor}×`)
                                      .join(", ")}`
                        )
                        .join(" · ")
                },
                {
                    label: "Compression",
                    value: renderingMetadata.compression ?? "None"
                },
                {
                    label: "Estimated full-resolution pixel data",
                    value: formatByteSize(
                        renderingMetadata.estimated_uncompressed_bytes
                    )
                }
            );
        }

        const bands = (asset["raster:bands"] ?? []).map((band, bandIndex) => {
            const bandMetadata = [
                { label: "Data type", value: band.data_type }
            ];
            if (Object.hasOwn(band, "nodata")) {
                bandMetadata.push({
                    label: "Nodata",
                    value: String(band.nodata)
                });
            }
            return { title: `Band ${bandIndex + 1}`, metadata: bandMetadata };
        });

        return {
            key: assetKey,
            title: asset.title ?? assetKey,
            metadata: assetMetadata,
            bands
        };
    });

    return {
        title: properties.title ?? item.id,
        description: properties.description ?? null,
        metadata,
        fields,
        assets
    };
}

/**
 * Issues standard STAC Item Search requests while cancelling stale work.
 */
export class CatalogSearchClient {
    /**
     * @param {string} catalogUrl Browser-facing STAC root URL.
     * @param {Function} fetchImplementation Fetch-compatible request function.
     */
    constructor(catalogUrl, fetchImplementation = globalThis.fetch) {
        this.catalogUrl = catalogUrl.replace(/\/$/, "");
        this.fetchImplementation = fetchImplementation.bind(globalThis);
        this.activeAbortController = null;
        this.requestSequence = 0;
        this.numberMatchedEstimated = null;
    }

    /**
     * Starts the first page of a standard STAC CQL2 substring search.
     *
     * @param {string} searchText User-entered search text.
     * @return {Promise<Object|null>} ItemCollection, or null when superseded.
     */
    search(searchText) {
        this.numberMatchedEstimated = null;
        const searchBody = { limit: CATALOG_PAGE_SIZE };
        const substringFilter = buildSubstringFilter(searchText);
        if (substringFilter !== null) {
            searchBody["filter-lang"] = "cql2-json";
            searchBody.filter = substringFilter;
        }
        return this.request({
            href: `${this.catalogUrl}/search`,
            method: "POST",
            body: searchBody
        });
    }

    /**
     * Follows a STAC pagination link without reconstructing provider tokens.
     *
     * @param {Object} paginationLink STAC next or previous link.
     * @return {Promise<Object|null>} ItemCollection, or null when superseded.
     */
    follow(paginationLink) {
        return this.request(paginationLink);
    }

    /**
     * Executes one GET or POST STAC link.
     *
     * @param {Object} stacLink STAC link containing href and optional request data.
     * @return {Promise<Object|null>} ItemCollection, or null when superseded.
     */
    async request(stacLink) {
        if (typeof stacLink?.href !== "string") {
            throw new TypeError("STAC pagination link has no href");
        }
        const method = (stacLink.method ?? "GET").toUpperCase();
        if (!new Set(["GET", "POST"]).has(method)) {
            throw new TypeError(
                `Unsupported STAC pagination method: ${method}`
            );
        }

        this.activeAbortController?.abort();
        const abortController = new AbortController();
        this.activeAbortController = abortController;
        const requestSequence = ++this.requestSequence;
        const requestHeaders = new Headers(stacLink.headers ?? {});
        requestHeaders.set("Accept", "application/geo+json");
        const requestOptions = {
            method,
            headers: requestHeaders,
            signal: abortController.signal
        };
        if (method === "POST") {
            requestHeaders.set("Content-Type", "application/json");
            requestOptions.body = JSON.stringify(stacLink.body ?? {});
        }

        let searchResponse;
        try {
            searchResponse = await this.fetchImplementation(
                stacLink.href,
                requestOptions
            );
        } catch (requestError) {
            if (abortController.signal.aborted) {
                return null;
            }
            throw requestError;
        }
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        if (!searchResponse.ok) {
            throw new Error(
                `STAC Item Search returned ${searchResponse.status}`
            );
        }

        const itemCollection = await searchResponse.json();
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        if (!Array.isArray(itemCollection.features)) {
            throw new Error("STAC Item Search response has no features array");
        }
        if (
            !Number.isInteger(itemCollection.numberMatched) ||
            itemCollection.numberMatched < itemCollection.features.length
        ) {
            throw new Error(
                "STAC Item Search response has no valid numberMatched"
            );
        }
        const estimateHeader = searchResponse.headers.get(
            "X-EOLab-Number-Matched-Estimated"
        );
        if (estimateHeader !== null) {
            if (estimateHeader !== "true" && estimateHeader !== "false") {
                throw new Error(
                    "Catalog response has an invalid count estimate header"
                );
            }
            this.numberMatchedEstimated = estimateHeader === "true";
        }
        if (this.numberMatchedEstimated === null) {
            throw new Error("Catalog response has no count estimate header");
        }
        itemCollection.numberMatchedEstimated = this.numberMatchedEstimated;
        return itemCollection;
    }
}

/**
 * Tracks one progressively loaded Catalog search and its provider-supplied
 * next-page link.
 */
export class CatalogResultStream {
    /** @param {CatalogSearchClient} searchClient STAC Item Search client. */
    constructor(searchClient) {
        this.searchClient = searchClient;
        this.bufferedPage = null;
        this.prefetchPromise = null;
        this.nextLink = null;
        this.isLoading = false;
        this.searchSequence = 0;
    }

    /** @return {boolean} Whether another provider page is available. */
    get hasNextPage() {
        return (
            this.bufferedPage !== null ||
            this.prefetchPromise !== null ||
            this.nextLink !== null
        );
    }

    /**
     * Replaces the active result stream with a new search.
     *
     * @param {string} searchText User-entered search text.
     * @return {Promise<Object|null>} First ItemCollection, or null if superseded.
     */
    async restart(searchText) {
        const searchSequence = ++this.searchSequence;
        this.bufferedPage = null;
        this.prefetchPromise = null;
        this.nextLink = null;
        this.isLoading = true;
        try {
            const itemCollection = await this.searchClient.search(searchText);
            if (
                searchSequence !== this.searchSequence ||
                itemCollection === null
            ) {
                return null;
            }
            this.nextLink = findPaginationLink(itemCollection, ["next"]);
            return itemCollection;
        } finally {
            if (searchSequence === this.searchSequence) {
                this.isLoading = false;
            }
        }
    }

    /**
     * Fetches and retains the next page without adding it to the displayed list.
     * Concurrent callers share the same provider request.
     *
     * @return {Promise<Object|null>} Buffered ItemCollection, or null when the
     *     stream has ended or the request was superseded.
     */
    async prefetchNextPage() {
        if (this.bufferedPage !== null) {
            return this.bufferedPage;
        }
        if (this.prefetchPromise !== null) {
            return this.prefetchPromise;
        }
        if (this.nextLink === null) {
            return null;
        }

        const searchSequence = this.searchSequence;
        const nextLink = this.nextLink;
        const prefetchPromise = (async () => {
            const itemCollection = await this.searchClient.follow(nextLink);
            if (
                searchSequence !== this.searchSequence ||
                itemCollection === null
            ) {
                return null;
            }
            this.nextLink = findPaginationLink(itemCollection, ["next"]);
            this.bufferedPage = itemCollection;
            return itemCollection;
        })();
        this.prefetchPromise = prefetchPromise;
        try {
            return await prefetchPromise;
        } finally {
            if (
                searchSequence === this.searchSequence &&
                this.prefetchPromise === prefetchPromise
            ) {
                this.prefetchPromise = null;
            }
        }
    }

    /**
     * Takes the prepared next page once, retaining its link when fetching fails.
     *
     * @return {Promise<Object|null>} Next ItemCollection, or null when no load
     *     was needed or the request was superseded.
     */
    async loadNextPage() {
        if (this.isLoading || !this.hasNextPage) {
            return null;
        }

        const searchSequence = this.searchSequence;
        this.isLoading = true;
        try {
            const itemCollection = await this.prefetchNextPage();
            if (
                searchSequence !== this.searchSequence ||
                itemCollection === null
            ) {
                return null;
            }
            this.bufferedPage = null;
            return itemCollection;
        } finally {
            if (searchSequence === this.searchSequence) {
                this.isLoading = false;
            }
        }
    }
}

/**
 * Manages the persistent selected footprint and transient preview footprint.
 */
export class CatalogFootprintController {
    /**
     * @param {Object} leafletMap Leaflet-compatible map.
     * @param {Function} layerFactory Creates a layer for an Item and visual state.
     */
    constructor(leafletMap, layerFactory) {
        this.leafletMap = leafletMap;
        this.layerFactory = layerFactory;
        this.selectedItemKey = null;
        this.selectedLayer = null;
        this.previewLayer = null;
    }

    /**
     * Displays and zooms to the selected Item footprint.
     *
     * @param {Object} item STAC Item selected in the result list.
     * @return {void}
     */
    select(item) {
        this.clearPreview();
        this.removeLayer(this.selectedLayer);
        this.selectedItemKey = this.itemKey(item);
        this.selectedLayer = this.layerFactory(item, "selected").addTo(
            this.leafletMap
        );
        const selectedBounds = this.selectedLayer.getBounds();
        if (selectedBounds.isValid()) {
            this.leafletMap.fitBounds(selectedBounds.pad(0.2), { maxZoom: 9 });
        }
    }

    /**
     * Displays a temporary lighter footprint for a non-selected Item.
     *
     * @param {Object} item STAC Item under pointer or keyboard focus.
     * @return {void}
     */
    preview(item) {
        this.clearPreview();
        if (this.itemKey(item) !== this.selectedItemKey) {
            this.previewLayer = this.layerFactory(item, "preview").addTo(
                this.leafletMap
            );
        }
    }

    /** Removes the temporary preview footprint. */
    clearPreview() {
        this.removeLayer(this.previewLayer);
        this.previewLayer = null;
    }

    /** Removes every Catalog footprint and selection. */
    clear() {
        this.clearPreview();
        this.removeLayer(this.selectedLayer);
        this.selectedLayer = null;
        this.selectedItemKey = null;
    }

    /**
     * @param {Object|null} layer Leaflet-compatible layer.
     * @return {void}
     */
    removeLayer(layer) {
        if (layer !== null) {
            this.leafletMap.removeLayer(layer);
        }
    }

    /**
     * @param {Object} item STAC Item.
     * @return {string} Identifier unique across Collections.
     */
    itemKey(item) {
        return `${item.collection ?? ""}/${item.id}`;
    }
}
