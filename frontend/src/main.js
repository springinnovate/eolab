import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
    buildCatalogItemDetails,
    CatalogFootprintController,
    CatalogResultStream,
    CatalogSearchClient,
    createDebouncedAction,
    formatCatalogItemCount,
    formatScanTiming,
    formatScanStatusSummary,
    MOUNTED_GEOTIFF_COLLECTION_ID,
    MOUNTED_DATASET_TYPES,
} from "./catalog.js";
import {
    CatalogRasterLayerController,
    loadWmsCapabilities,
    publishCatalogRaster,
} from "./rendering.js";
import "./style.css";

const CATALOG_SEARCH_DEBOUNCE_MILLISECONDS = 300;
const CATALOG_LOAD_ROOT_MARGIN = "300px 0px";
const CONTROL_PANEL_TRANSITION_MILLISECONDS = 240;
const RENDERING_RETRY_MILLISECONDS = 5000;
const RENDERING_MONITOR_MILLISECONDS = 60000;

let scanPollTimeout = null;

/**
 * Browser-safe application settings loaded from the backend.
 *
 * @typedef {Object} AppGlobalConfiguration
 * @property {string} appTitle Application title.
 * @property {string} appSubtitle Application subtitle.
 * @property {string} appVersion Deployed application version.
 * @property {string} catalogUrl Browser-facing STAC catalog URL.
 * @property {string} wmsUrl Browser-facing WMS endpoint.
 * @property {string} scanDisplayPathPrefix User-facing root for mounted files.
 * @property {{url: string, attribution: string}} basemap Basemap settings.
 * @property {{latitude: number, longitude: number, zoom: number}} initialView Initial map view.
 */

/**
 * Loads the browser-safe application settings.
 *
 * @return {Promise<AppGlobalConfiguration>} The application settings.
 * @throws {Error} If the settings endpoint does not return a successful response.
 */
async function loadAppGlobalConfiguration() {
    const configurationResponse = await fetch("/api/config", {
        headers: { Accept: "application/json" }
    });

    if (!configurationResponse.ok) {
        throw new Error(
            `Runtime configuration returned ${configurationResponse.status}`
        );
    }

    return configurationResponse.json();
}

/**
 * Creates the Leaflet map from the application settings.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {L.Map} The initialized Leaflet map.
 */
function initializeMap(appGlobalConfiguration) {
    const leafletMap = L.map("map", {
        zoomControl: false,
        minZoom: 0,
        maxZoom: 22
    }).setView(
        [
            appGlobalConfiguration.initialView.latitude,
            appGlobalConfiguration.initialView.longitude
        ],
        appGlobalConfiguration.initialView.zoom
    );

    L.control.zoom({ position: "bottomleft" }).addTo(leafletMap);
    L.tileLayer(appGlobalConfiguration.basemap.url, {
        attribution: appGlobalConfiguration.basemap.attribution,
        maxZoom: 22
    }).addTo(leafletMap);

    const mapPositionElement = document.querySelector("#map-position");

    /**
     * Displays a geographic position reported by Leaflet.
     *
     * @param {{latlng: L.LatLng}} mapPositionEvent Leaflet position event.
     * @return {void}
     */
    function updateMapPosition(mapPositionEvent) {
        mapPositionElement.textContent =
            `${mapPositionEvent.latlng.lat.toFixed(3)}, ` +
            mapPositionEvent.latlng.lng.toFixed(3);
    }

    updateMapPosition({ latlng: leafletMap.getCenter() });
    leafletMap.on("mousemove", updateMapPosition);

    return leafletMap;
}

/**
 * Applies application identity and catalog state to the interface.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {void}
 */
function applyAppGlobalConfiguration(appGlobalConfiguration) {
    document.title = appGlobalConfiguration.appTitle;
    document.querySelector("#app-title").textContent =
        appGlobalConfiguration.appTitle;
    document.querySelector("#app-subtitle").textContent =
        appGlobalConfiguration.appSubtitle;
    document.querySelector("#app-version").textContent =
        appGlobalConfiguration.appVersion;
    document
        .querySelector("#map")
        .setAttribute(
            "aria-label",
            `${appGlobalConfiguration.appTitle} interactive map`
        );
    document
        .querySelector("#control-panel")
        .setAttribute(
            "aria-label",
            `${appGlobalConfiguration.appTitle} controls`
        );
    document.querySelector("#open-panel").textContent =
        `Open ${appGlobalConfiguration.appTitle}`;

    const systemStateElement = document.querySelector("#system-state");
    const systemStateTextElement = document.querySelector("#system-state-text");
    const catalogLinkElement = document.querySelector("#catalog-link");

    systemStateElement.classList.remove("is-connected", "is-warning");
    systemStateTextElement.textContent = "Connecting to catalog";
    catalogLinkElement.href = appGlobalConfiguration.catalogUrl;
}

/**
 * Reports GeoServer readiness independently from Catalog availability.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {void}
 */
function initializeRendering(appGlobalConfiguration) {
    const renderingStateElement = document.querySelector("#rendering-state");
    const renderingStateTextElement = document.querySelector(
        "#rendering-state-text"
    );
    const capabilitiesLinkElement = document.querySelector(
        "#wms-capabilities-link"
    );
    let renderingServiceWasReady = false;

    /** Monitor WMS, retrying more frequently while it is unavailable. */
    async function checkRenderingService() {
        try {
            capabilitiesLinkElement.href = await loadWmsCapabilities(
                appGlobalConfiguration.wmsUrl
            );
            capabilitiesLinkElement.hidden = false;
            renderingStateElement.classList.remove("is-warning");
            renderingStateElement.classList.add("is-connected");
            if (!renderingServiceWasReady) {
                renderingStateTextElement.textContent =
                    "Rendering service ready";
            }
            renderingServiceWasReady = true;
            window.setTimeout(
                checkRenderingService,
                RENDERING_MONITOR_MILLISECONDS
            );
        } catch {
            capabilitiesLinkElement.hidden = true;
            if (
                renderingServiceWasReady ||
                !renderingStateElement.classList.contains("is-warning")
            ) {
                renderingStateElement.classList.remove("is-connected");
                renderingStateElement.classList.add("is-warning");
                renderingStateTextElement.textContent =
                    "Rendering service unavailable";
            }
            renderingServiceWasReady = false;
            window.setTimeout(
                checkRenderingService,
                RENDERING_RETRY_MILLISECONDS
            );
        }
    }

    void checkRenderingService();
}

/**
 * Creates a selected or preview Leaflet layer for one STAC Item.
 *
 * @param {Object} item STAC Item.
 * @param {string} visualState Either selected or preview.
 * @return {L.GeoJSON} Leaflet footprint layer.
 */
function createCatalogFootprintLayer(item, visualState) {
    return L.geoJSON(item, {
        style: { className: `catalog-footprint is-${visualState}` }
    });
}

/**
 * Loads and validates the catalog's STAC Collections document.
 *
 * @param {string} catalogUrl Browser-facing STAC root URL.
 * @return {Promise<Object>} Validated Collections response.
 */
async function loadCatalogCollections(catalogUrl) {
    const collectionsResponse = await fetch(`${catalogUrl}/collections`, {
        headers: { Accept: "application/json" }
    });
    if (!collectionsResponse.ok) {
        throw new Error(
            `STAC Collections returned ${collectionsResponse.status}`
        );
    }
    const collectionsDocument = await collectionsResponse.json();
    if (!Array.isArray(collectionsDocument.collections)) {
        throw new Error("STAC Collections response has no collections array");
    }
    return collectionsDocument;
}

/**
 * Creates a semantic metadata list whose labels are application display text
 * and whose values come from the selected STAC Item and Collection.
 *
 * @param {{label: string, value: string}[]} metadata Inspector metadata.
 * @return {HTMLDListElement} Definition list containing the metadata.
 */
function createCatalogMetadataList(metadata) {
    const metadataList = document.createElement("dl");
    metadataList.className = "catalog-metadata";
    for (const metadataEntry of metadata) {
        const metadataTerm = document.createElement("dt");
        metadataTerm.textContent = metadataEntry.label;
        const metadataDescription = document.createElement("dd");
        metadataDescription.textContent = metadataEntry.value;
        metadataList.append(metadataTerm, metadataDescription);
    }
    return metadataList;
}

/**
 * Displays the selected STAC Item in the inspector.
 *
 * @param {Object|null} item Selected STAC Item, or null for the empty state.
 * @param {Object[]} collections STAC Collections available to the Catalog.
 * @param {string} scanDisplayPathPrefix User-facing root for mounted files.
 * @return {void}
 */
function renderCatalogItemInspector(
    item,
    collections,
    scanDisplayPathPrefix
) {
    const inspectorHeading = document.querySelector(
        "#catalog-inspector-heading"
    );
    const inspectorContent = document.querySelector(
        "#catalog-inspector-content"
    );
    const inspectorStatus = document.querySelector(
        "#catalog-inspector-status"
    );
    inspectorContent.replaceChildren();

    // Render the empty state when no Item is selected.
    if (item === null) {
        inspectorHeading.textContent = "Item inspector";
        const emptyInspector = document.createElement("div");
        emptyInspector.className = "catalog-inspector-empty";
        const emptyHeading = document.createElement("strong");
        emptyHeading.textContent = "No item selected";
        const emptyMessage = document.createElement("p");
        emptyMessage.textContent =
            "Select a Catalog result to inspect its metadata.";
        emptyInspector.append(emptyHeading, emptyMessage);
        inspectorContent.append(emptyInspector);
        inspectorStatus.textContent = "No Catalog Item is selected.";
        return;
    }

    // Render the Item's identity, description, and core metadata.
    const inspector = buildCatalogItemDetails(
        item,
        collections,
        scanDisplayPathPrefix
    );
    inspectorHeading.textContent = inspector.title;
    if (inspector.description !== null) {
        const description = document.createElement("p");
        description.className = "catalog-inspector-description";
        description.textContent = inspector.description;
        inspectorContent.append(description);
    }
    inspectorContent.append(createCatalogMetadataList(inspector.metadata));

    if (inspector.fields.length > 0) {
        const fieldsHeading = document.createElement("h4");
        fieldsHeading.textContent = "Fields";
        inspectorContent.append(
            fieldsHeading,
            createCatalogMetadataList(inspector.fields)
        );
    }

    // Introduce the Item's Asset records or their empty state.
    const assetsHeading = document.createElement("h4");
    assetsHeading.textContent = "Assets";
    inspectorContent.append(assetsHeading);
    if (inspector.assets.length === 0) {
        const noAssetsMessage = document.createElement("p");
        noAssetsMessage.className = "catalog-inspector-note";
        noAssetsMessage.textContent = "No Assets are recorded for this Item.";
        inspectorContent.append(noAssetsMessage);
    }

    // Render the metadata for each Asset.
    for (const asset of inspector.assets) {
        const assetCard = document.createElement("article");
        assetCard.className = "catalog-asset";
        const assetHeading = document.createElement("h5");
        assetHeading.textContent = asset.title;
        const assetKey = document.createElement("p");
        assetKey.className = "catalog-asset-key";
        assetKey.textContent = `Asset key: ${asset.key}`;
        assetCard.append(
            assetHeading,
            assetKey,
            createCatalogMetadataList(asset.metadata)
        );

        // Render Raster extension band metadata when the Asset supplies it.
        if (asset.bands.length > 0) {
            const bandsHeading = document.createElement("strong");
            bandsHeading.className = "catalog-bands-heading";
            bandsHeading.textContent = "Raster bands";
            const bandList = document.createElement("ul");
            bandList.className = "catalog-band-list";
            for (const band of asset.bands) {
                const bandItem = document.createElement("li");
                const bandHeading = document.createElement("strong");
                bandHeading.textContent = band.title;
                const bandDetails = document.createElement("span");
                bandDetails.textContent = band.metadata
                    .map(
                        (metadataEntry) =>
                            `${metadataEntry.label}: ${metadataEntry.value}`
                    )
                    .join(" · ");
                bandItem.append(bandHeading, bandDetails);
                bandList.append(bandItem);
            }
            assetCard.append(bandsHeading, bandList);
        }
        inspectorContent.append(assetCard);
    }

    // Announce the selected Item to assistive technologies.
    inspectorStatus.textContent = `Showing details for ${inspector.title}.`;
}

/**
 * Connects Catalog search, progressive loading, selection, and refresh controls.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @return {Promise<Function>} Function that reloads the active catalog search.
 */
async function initializeCatalog(appGlobalConfiguration, leafletMap) {
    const systemStateElement = document.querySelector("#system-state");
    const systemStateTextElement = document.querySelector("#system-state-text");
    const catalogMessageElement = document.querySelector("#catalog-message");
    const catalogSummaryElement = document.querySelector("#catalog-summary");
    const catalogResultsElement = document.querySelector("#catalog-results");
    const catalogResultsScrollElement = document.querySelector(
        "#catalog-results-scroll"
    );
    const catalogSearchInput = document.querySelector("#catalog-search");
    const refreshCatalogButton = document.querySelector("#refresh-catalog");
    const streamStatusElement = document.querySelector(
        "#catalog-stream-status"
    );
    const retryPageButton = document.querySelector("#retry-catalog-page");
    const loadSentinelElement = document.querySelector(
        "#catalog-load-sentinel"
    );
    const streamAnnouncementElement = document.querySelector(
        "#catalog-stream-announcement"
    );
    const catalogMapActionsElement = document.querySelector(
        "#catalog-map-actions"
    );
    const catalogLayerToggle = document.querySelector(
        "#toggle-catalog-layer"
    );
    const catalogLayerStatus = document.querySelector(
        "#catalog-layer-status"
    );
    const catalogUrl = appGlobalConfiguration.catalogUrl.replace(/\/$/, "");
    const resultStream = new CatalogResultStream(
        new CatalogSearchClient(catalogUrl)
    );
    const footprintController = new CatalogFootprintController(
        leafletMap,
        createCatalogFootprintLayer
    );
    const rasterLayerController = new CatalogRasterLayerController(
        leafletMap,
        publishCatalogRaster,
        (publishedRaster) => {
            const [west, south, east, north] = publishedRaster.bbox;
            const rasterLayer = L.tileLayer.wms(
                appGlobalConfiguration.wmsUrl,
                {
                    layers: publishedRaster.layerName,
                    format: "image/png",
                    transparent: true,
                    version: "1.3.0",
                    bounds: [
                        [south, west],
                        [north, east]
                    ]
                }
            );
            rasterLayer.once("tileerror", () => {
                if (rasterLayerController.activeLayer === rasterLayer) {
                    catalogLayerStatus.textContent =
                        "Map tiles could not be rendered.";
                }
            });
            return rasterLayer;
        }
    );
    const catalogState = {
        collectionsDocument: null,
        loadedItemCount: 0,
        searchSequence: 0,
        searchText: "",
        selectedButton: null,
        selectedItem: null
    };

    /** Show the map action only for the selected mounted GeoTIFF. */
    function updateCatalogMapAction(item) {
        const canRender =
            item?.collection === MOUNTED_GEOTIFF_COLLECTION_ID;
        catalogMapActionsElement.hidden = !canRender;
        catalogMapActionsElement.setAttribute("aria-busy", "false");
        catalogLayerToggle.disabled = false;
        catalogLayerToggle.textContent = "View on map";
        catalogLayerStatus.textContent = "";
    }

    /** Clears the selected result, footprint, and inspector together. */
    function clearCatalogSelection() {
        footprintController.clear();
        rasterLayerController.clear();
        catalogState.selectedButton = null;
        catalogState.selectedItem = null;
        updateCatalogMapAction(null);
        renderCatalogItemInspector(
            null,
            catalogState.collectionsDocument?.collections ?? [],
            appGlobalConfiguration.scanDisplayPathPrefix
        );
    }

    /**
     * Appends one successful Item Search page to the active result stream.
     *
     * @param {Object} itemCollection STAC ItemCollection response.
     * @param {boolean} fitMap Whether to fit the map to this page.
     * @return {void}
     */
    function appendCatalogPage(itemCollection, fitMap) {
        const returnedItemCount = itemCollection.features.length;
        catalogState.loadedItemCount += returnedItemCount;
        const isFiltered = catalogState.searchText.trim() !== "";
        const itemCountLabel = formatCatalogItemCount(
            itemCollection,
            catalogState.loadedItemCount,
            isFiltered
        );
        const collections = catalogState.collectionsDocument.collections;
        const collectionLabel =
            collections.length === 1
                ? (collections[0].title ?? collections[0].id)
                : `${collections.length} collections`;

        systemStateElement.classList.add("is-connected");
        systemStateTextElement.textContent = `Catalog connected · ${itemCountLabel}`;
        catalogMessageElement.textContent = isFiltered
            ? "Matching records were returned from the complete STAC catalog."
            : "Records were returned from the deployed STAC catalog.";
        catalogSummaryElement.textContent = `${collectionLabel} · ${itemCountLabel}`;

        if (fitMap) {
            const pageBounds = L.geoJSON(itemCollection).getBounds();
            if (pageBounds.isValid()) {
                leafletMap.fitBounds(pageBounds.pad(0.15), { maxZoom: 8 });
            }
        }

        for (const item of itemCollection.features) {
            const itemButton = document.createElement("button");
            itemButton.className = "catalog-result";
            itemButton.type = "button";
            itemButton.setAttribute("aria-pressed", "false");

            const itemTitle = document.createElement("strong");
            itemTitle.textContent = item.properties.title ?? item.id;
            const itemDescription = document.createElement("span");
            itemDescription.textContent =
                item.properties.description ?? item.id;
            const itemSummary = document.createElement("small");
            const datasetType = MOUNTED_DATASET_TYPES.get(item.collection);
            const itemDatetime =
                item.properties.datetime ?? "Datetime unavailable";
            itemSummary.textContent = datasetType === undefined
                ? itemDatetime
                : `${datasetType} · ${itemDatetime}`;

            itemButton.append(itemTitle, itemDescription, itemSummary);
            itemButton.addEventListener("click", () => {
                const selectionChanged = catalogState.selectedItem !== item;
                if (catalogState.selectedButton !== null) {
                    catalogState.selectedButton.classList.remove("is-selected");
                    catalogState.selectedButton.setAttribute(
                        "aria-pressed",
                        "false"
                    );
                }
                if (selectionChanged) {
                    rasterLayerController.clear();
                }
                catalogState.selectedButton = itemButton;
                catalogState.selectedItem = item;
                itemButton.classList.add("is-selected");
                itemButton.setAttribute("aria-pressed", "true");
                footprintController.select(item);
                renderCatalogItemInspector(
                    item,
                    catalogState.collectionsDocument.collections,
                    appGlobalConfiguration.scanDisplayPathPrefix
                );
                if (selectionChanged) {
                    updateCatalogMapAction(item);
                }
            });
            itemButton.addEventListener("pointerenter", () => {
                footprintController.preview(item);
            });
            itemButton.addEventListener("pointerleave", () => {
                footprintController.clearPreview();
            });
            itemButton.addEventListener("focus", () => {
                footprintController.preview(item);
            });
            itemButton.addEventListener("blur", () => {
                footprintController.clearPreview();
            });
            catalogResultsElement.append(itemButton);
        }

        if (catalogState.loadedItemCount === 0) {
            const emptyCatalogMessage = document.createElement("p");
            emptyCatalogMessage.className = "catalog-empty";
            emptyCatalogMessage.textContent = catalogState.searchText.trim()
                ? `No Items matched “${catalogState.searchText.trim()}”.`
                : "The catalog is connected but has no Items.";
            catalogResultsElement.append(emptyCatalogMessage);
        }

        if (!fitMap) {
            streamAnnouncementElement.textContent =
                `${returnedItemCount.toLocaleString()} additional Items loaded. ` +
                `${catalogState.loadedItemCount.toLocaleString()} Items shown.`;
        }
    }

    /** Prepare one page ahead, then watch for the user to reach it. */
    async function prefetchNextCatalogPage() {
        const searchSequence = catalogState.searchSequence;
        retryPageButton.hidden = true;
        streamStatusElement.textContent = "Preparing more Catalog Items…";
        try {
            const bufferedPage = await resultStream.prefetchNextPage();
            if (
                searchSequence !== catalogState.searchSequence ||
                bufferedPage === null
            ) {
                return;
            }
            streamStatusElement.textContent =
                "More Items are ready as you scroll.";
            if (!resultStream.isLoading) {
                pageObserver.observe(loadSentinelElement);
            }
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            pageObserver.unobserve(loadSentinelElement);
            streamStatusElement.textContent =
                `Additional Items could not be prepared: ${catalogError.message}`;
            retryPageButton.hidden = false;
        }
    }

    /** Prepare another page or display the end of the active stream. */
    function observeNextCatalogPage() {
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        if (!resultStream.hasNextPage) {
            streamStatusElement.textContent = "End of results.";
            return;
        }
        void prefetchNextCatalogPage();
    }

    /** Start a new search and replace every result from the previous stream. */
    async function loadCatalog(reloadCollections = false) {
        const searchSequence = ++catalogState.searchSequence;
        catalogState.searchText = catalogSearchInput.value;
        catalogState.loadedItemCount = 0;
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        clearCatalogSelection();
        catalogResultsElement.replaceChildren();
        catalogResultsElement.setAttribute("aria-busy", "true");
        systemStateElement.classList.remove("is-connected", "is-warning");
        systemStateTextElement.textContent = "Searching catalog";
        catalogMessageElement.textContent =
            "Requesting Collections and Items from the STAC API.";
        catalogSummaryElement.textContent = "Loading catalog contents";
        streamStatusElement.textContent = "Loading Catalog Items…";
        refreshCatalogButton.disabled = true;

        try {
            const collectionsRequest =
                reloadCollections || catalogState.collectionsDocument === null
                    ? loadCatalogCollections(catalogUrl)
                    : Promise.resolve(catalogState.collectionsDocument);
            const [collectionsDocument, itemCollection] = await Promise.all([
                collectionsRequest,
                resultStream.restart(catalogState.searchText)
            ]);
            if (
                searchSequence !== catalogState.searchSequence ||
                itemCollection === null
            ) {
                return;
            }
            catalogState.collectionsDocument = collectionsDocument;
            appendCatalogPage(itemCollection, true);
            observeNextCatalogPage();
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            systemStateElement.classList.add("is-warning");
            systemStateTextElement.textContent = "Catalog unavailable";
            catalogMessageElement.textContent =
                "Check the catalog services and try again.";
            catalogSummaryElement.textContent = catalogError.message;
            streamStatusElement.textContent = "Catalog search failed.";
        } finally {
            if (searchSequence === catalogState.searchSequence) {
                catalogResultsElement.setAttribute("aria-busy", "false");
                refreshCatalogButton.disabled = false;
            }
        }
    }

    /** Append the provider's next page while retaining existing results. */
    async function loadNextCatalogPage() {
        if (resultStream.isLoading || !resultStream.hasNextPage) {
            return;
        }

        const searchSequence = catalogState.searchSequence;
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        streamStatusElement.textContent = "Loading more Catalog Items…";
        catalogResultsElement.setAttribute("aria-busy", "true");
        try {
            const itemCollection = await resultStream.loadNextPage();
            if (
                searchSequence !== catalogState.searchSequence ||
                itemCollection === null
            ) {
                return;
            }
            appendCatalogPage(itemCollection, false);
            observeNextCatalogPage();
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            streamStatusElement.textContent =
                `Additional Items could not be loaded: ${catalogError.message}`;
            retryPageButton.hidden = false;
        } finally {
            if (searchSequence === catalogState.searchSequence) {
                catalogResultsElement.setAttribute("aria-busy", "false");
            }
        }
    }

    const pageObserver = new IntersectionObserver(
        (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                void loadNextCatalogPage();
            }
        },
        {
            root: catalogResultsScrollElement,
            rootMargin: CATALOG_LOAD_ROOT_MARGIN,
        }
    );

    const scheduleCatalogSearch = createDebouncedAction(
        loadCatalog.bind(null, false),
        CATALOG_SEARCH_DEBOUNCE_MILLISECONDS,
        window
    );
    catalogSearchInput.addEventListener("input", scheduleCatalogSearch);
    refreshCatalogButton.addEventListener(
        "click",
        loadCatalog.bind(null, true)
    );
    retryPageButton.addEventListener("click", prefetchNextCatalogPage);
    catalogLayerToggle.addEventListener("click", async () => {
        const selectedItem = catalogState.selectedItem;
        if (rasterLayerController.activeLayer !== null) {
            rasterLayerController.clear();
            catalogLayerToggle.textContent = "View on map";
            catalogLayerStatus.textContent = "Raster removed from the map.";
            return;
        }

        catalogMapActionsElement.setAttribute("aria-busy", "true");
        catalogLayerToggle.disabled = true;
        catalogLayerToggle.textContent = "Adding to map…";
        catalogLayerStatus.textContent = "Preparing the selected raster.";
        try {
            const publishedRaster = await rasterLayerController.show(
                selectedItem
            );
            if (
                publishedRaster === null ||
                catalogState.selectedItem !== selectedItem
            ) {
                return;
            }
            catalogLayerToggle.textContent = "Remove from map";
            catalogLayerStatus.textContent = "Raster displayed on the map.";
        } catch (renderingError) {
            if (catalogState.selectedItem === selectedItem) {
                catalogLayerToggle.textContent = "View on map";
                catalogLayerStatus.textContent = renderingError.message;
            }
        } finally {
            if (catalogState.selectedItem === selectedItem) {
                catalogMapActionsElement.setAttribute("aria-busy", "false");
                catalogLayerToggle.disabled = false;
            }
        }
    });

    await loadCatalog(true);
    return loadCatalog.bind(null, true);
}

/**
 * Displays the current mounted-directory scan state.
 *
 * @param {Object} scanStatus Scan progress returned by the backend.
 * @return {void}
 */
function renderScanStatus(scanStatus) {
    const startScanButton = document.querySelector("#start-scan");
    const scanStatusDisclosureElement = document.querySelector(
        "#scan-status-disclosure"
    );
    const scanStatusSummaryElement = document.querySelector(
        "#scan-status-summary"
    );
    const scanStatusElement = document.querySelector("#scan-status");
    const scanProgressElement = document.querySelector("#scan-progress");
    const scanCountsElement = document.querySelector("#scan-counts");
    const scanTimingElement = document.querySelector("#scan-timing");
    const scanTimingValuesElement = document.querySelector(
        "#scan-timing-values"
    );
    const scanErrorsDisclosureElement = document.querySelector(
        "#scan-errors-disclosure"
    );
    const scanErrorsSummaryElement = document.querySelector(
        "#scan-errors-summary"
    );
    const scanErrorsElement = document.querySelector("#scan-errors");
    const isRunning = ["discovering", "scanning"].includes(scanStatus.state);
    const wasRunning = scanStatusDisclosureElement.dataset.running === "true";

    startScanButton.disabled = isRunning;
    startScanButton.textContent = isRunning ? "Scanning…" : "Scan directories";
    scanStatusSummaryElement.textContent = formatScanStatusSummary(scanStatus);
    // Set the default only when a scan starts or stops so polling does not
    // override a user's disclosure choice during the same run.
    if (isRunning !== wasRunning) {
        scanStatusDisclosureElement.open = isRunning;
    }
    scanStatusDisclosureElement.dataset.running = String(isRunning);
    scanProgressElement.hidden = scanStatus.state === "not_started";
    scanProgressElement.max = Math.max(scanStatus.discovered, 1);
    scanProgressElement.value = scanStatus.processed;
    const newlyCataloged = scanStatus.indexed - scanStatus.alreadyInCatalog;
    scanCountsElement.textContent =
        scanStatus.state === "not_started"
            ? ""
            : `${scanStatus.discovered.toLocaleString()} discovered · ` +
              `${scanStatus.processed.toLocaleString()} processed · ` +
              `${newlyCataloged.toLocaleString()} newly cataloged · ` +
              `${scanStatus.alreadyInCatalog.toLocaleString()} ` +
              `already in catalog · ` +
              `${scanStatus.failed.toLocaleString()} failed`;

    scanTimingElement.hidden = scanStatus.state === "not_started";
    scanTimingValuesElement.replaceChildren();
    for (const timingRow of formatScanTiming(
        scanStatus.timing,
        scanStatus.workerCount,
        scanStatus.writerCount,
        scanStatus.batchSize
    )) {
        const timingLabel = document.createElement("dt");
        timingLabel.textContent = timingRow.label;
        const timingValue = document.createElement("dd");
        timingValue.textContent = timingRow.value;
        scanTimingValuesElement.append(timingLabel, timingValue);
    }

    const statusMessages = {
        not_started: "No scan has been started.",
        discovering:
            "Discovering geospatial datasets in the mounted directories.",
        scanning: scanStatus.currentFile
            ? `Latest file: ${scanStatus.currentFile}`
            : "Preparing discovered geospatial datasets.",
        completed: "Scan completed. The catalog has been refreshed.",
        failed: "The scan stopped before it could complete."
    };
    scanStatusElement.textContent =
        statusMessages[scanStatus.state] ??
        `Unknown scan state: ${scanStatus.state}`;

    scanErrorsDisclosureElement.hidden =
        scanStatus.state === "not_started" || scanStatus.errors.length === 0;
    scanErrorsSummaryElement.textContent = scanStatus.errorsTruncated
        ? `Error details (${scanStatus.errors.length.toLocaleString()} shown)`
        : `Error details (${scanStatus.errors.length.toLocaleString()})`;
    scanErrorsElement.replaceChildren();
    for (const scanError of scanStatus.errors) {
        const errorItem = document.createElement("li");
        errorItem.textContent = scanError.path
            ? `${scanError.path}: ${scanError.error}`
            : scanError.error;
        scanErrorsElement.append(errorItem);
    }
    if (scanStatus.errorsTruncated) {
        const truncatedErrorsMessage = document.createElement("li");
        truncatedErrorsMessage.textContent =
            "Additional file failures are not shown.";
        scanErrorsElement.append(truncatedErrorsMessage);
    }
}

/**
 * Polls scan progress until the current scan finishes.
 *
 * @param {Function} refreshCatalog Reloads the active Catalog search.
 * @param {boolean} refreshWhenComplete Whether completion should refresh STAC.
 * @return {Promise<void>} Resolves after the current status is displayed.
 */
async function pollScan(refreshCatalog, refreshWhenComplete) {
    const scanResponse = await fetch("/api/scans/current", {
        headers: { Accept: "application/json" }
    });
    if (!scanResponse.ok) {
        throw new Error(`Scan status returned ${scanResponse.status}`);
    }

    const scanStatus = await scanResponse.json();
    renderScanStatus(scanStatus);
    if (["discovering", "scanning"].includes(scanStatus.state)) {
        scanPollTimeout = window.setTimeout(
            pollScan.bind(null, refreshCatalog, true),
            750
        );
    } else if (refreshWhenComplete && scanStatus.state === "completed") {
        await refreshCatalog();
    }
}

/**
 * Starts a mounted-directory scan from the Catalog panel.
 *
 * @param {Function} refreshCatalog Reloads the active Catalog search.
 * @return {Promise<void>} Resolves after polling has been scheduled.
 */
async function startScan(refreshCatalog) {
    try {
        if (scanPollTimeout !== null) {
            window.clearTimeout(scanPollTimeout);
        }
        document.querySelector("#scan-status-disclosure").open = true;
        document.querySelector("#scan-errors-disclosure").open = false;
        const startResponse = await fetch("/api/scans", {
            method: "POST",
            headers: { Accept: "application/json" }
        });
        if (!startResponse.ok && startResponse.status !== 409) {
            throw new Error(`Starting scan returned ${startResponse.status}`);
        }
        await pollScan(refreshCatalog, true);
    } catch (scanError) {
        document.querySelector("#start-scan").disabled = false;
        document.querySelector("#scan-status").textContent = scanError.message;
    }
}

/**
 * Connects the mounted-directory scanner controls.
 *
 * @param {Function} refreshCatalog Reloads the active Catalog search.
 * @return {Promise<void>} Resolves after current scan state is displayed.
 */
async function initializeScanner(refreshCatalog) {
    document
        .querySelector("#start-scan")
        .addEventListener("click", startScan.bind(null, refreshCatalog));
    await pollScan(refreshCatalog, false);
}

/**
 * Enables selection among the workspace tabs.
 *
 * @param {Function} setCatalogWorkspaceExpanded Sets the Catalog layout state.
 * @return {void}
 */
function initializeWorkspaceTabs(setCatalogWorkspaceExpanded) {
    const workspaceTabButtons = document.querySelectorAll(".tab-button");
    const workspaceTabPanels = document.querySelectorAll(".tab-panel");

    /**
     * Selects the workspace tab that received a click.
     *
     * @param {MouseEvent} tabSelectionEvent Tab click event.
     * @return {void}
     */
    function selectWorkspaceTab(tabSelectionEvent) {
        const selectedTabButton = tabSelectionEvent.currentTarget;
        const selectedPanelName = selectedTabButton.dataset.panel;
        if (selectedPanelName !== "catalog") {
            setCatalogWorkspaceExpanded(false);
        }

        for (const candidateTabButton of workspaceTabButtons) {
            const isSelectedTab = candidateTabButton === selectedTabButton;
            candidateTabButton.classList.toggle("is-active", isSelectedTab);
            candidateTabButton.setAttribute(
                "aria-selected",
                String(isSelectedTab)
            );
        }

        for (const candidateTabPanel of workspaceTabPanels) {
            const isSelectedPanel =
                candidateTabPanel.id === `panel-${selectedPanelName}`;
            candidateTabPanel.classList.toggle("is-active", isSelectedPanel);
            candidateTabPanel.hidden = !isSelectedPanel;
        }
    }

    for (const workspaceTabButton of workspaceTabButtons) {
        workspaceTabButton.addEventListener("click", selectWorkspaceTab);
    }
}

/**
 * Enables collapsing and reopening the control panel.
 *
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @return {Function} Sets whether the Catalog workspace is expanded.
 */
function initializeControlPanel(leafletMap) {
    const appElement = document.querySelector("#app");
    const controlPanelElement = document.querySelector("#control-panel");
    const openPanelButton = document.querySelector("#open-panel");
    const catalogWorkspaceToggle = document.querySelector(
        "#toggle-catalog-workspace"
    );
    const catalogInspector = document.querySelector(
        "#catalog-item-inspector"
    );
    let catalogWorkspaceIsExpanded = false;

    /**
     * Sets whether the Catalog uses the expanded workspace.
     *
     * @param {boolean} isExpanded Whether the workspace is expanded.
     * @return {void}
     */
    function setCatalogWorkspaceExpanded(isExpanded) {
        if (isExpanded === catalogWorkspaceIsExpanded) {
            return;
        }
        catalogWorkspaceIsExpanded = isExpanded;
        appElement.classList.toggle("is-catalog-workspace", isExpanded);
        catalogWorkspaceToggle.setAttribute(
            "aria-expanded",
            String(isExpanded)
        );
        catalogWorkspaceToggle.textContent = isExpanded
            ? "Return to map"
            : "Expand catalog";
        catalogInspector.setAttribute("aria-hidden", String(!isExpanded));
        window.setTimeout(
            () => leafletMap.invalidateSize(),
            CONTROL_PANEL_TRANSITION_MILLISECONDS
        );
    }

    /**
     * Sets whether the control panel is collapsed.
     *
     * @param {boolean} isCollapsed Whether the panel should be collapsed.
     * @return {void}
     */
    function setControlPanelCollapsed(isCollapsed) {
        const catalogWorkspaceWasExpanded = catalogWorkspaceIsExpanded;
        if (isCollapsed) {
            setCatalogWorkspaceExpanded(false);
        }
        controlPanelElement.classList.toggle("is-collapsed", isCollapsed);
        openPanelButton.hidden = !isCollapsed;
        if (!catalogWorkspaceWasExpanded) {
            window.setTimeout(
                () => leafletMap.invalidateSize(),
                CONTROL_PANEL_TRANSITION_MILLISECONDS
            );
        }
    }

    catalogWorkspaceToggle.addEventListener("click", () => {
        setCatalogWorkspaceExpanded(!catalogWorkspaceIsExpanded);
    });
    document.addEventListener("keydown", (keyboardEvent) => {
        if (keyboardEvent.key === "Escape" && catalogWorkspaceIsExpanded) {
            keyboardEvent.preventDefault();
            setCatalogWorkspaceExpanded(false);
            catalogWorkspaceToggle.focus();
        }
    });
    document
        .querySelector("#collapse-panel")
        .addEventListener("click", setControlPanelCollapsed.bind(null, true));
    openPanelButton.addEventListener(
        "click",
        setControlPanelCollapsed.bind(null, false)
    );
    return setCatalogWorkspaceExpanded;
}

/**
 * Starts the browser application from its runtime contract.
 *
 * @return {Promise<void>} Resolves after the interface is initialized.
 */
async function startApplication() {
    const appGlobalConfiguration = await loadAppGlobalConfiguration();
    applyAppGlobalConfiguration(appGlobalConfiguration);
    initializeRendering(appGlobalConfiguration);
    const leafletMap = initializeMap(appGlobalConfiguration);
    const setCatalogWorkspaceExpanded = initializeControlPanel(leafletMap);
    initializeWorkspaceTabs(setCatalogWorkspaceExpanded);
    const refreshCatalog = await initializeCatalog(
        appGlobalConfiguration,
        leafletMap
    );
    await initializeScanner(refreshCatalog);
}

startApplication();
