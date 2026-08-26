/**
 * Browser entry point and application composition root for EOLab.
 *
 * This module initializes the map, Catalog explorer, scanner controls, and
 * rendering diagnostics, then connects those features to the page. Raster
 * domain rules and raster-viewer behavior live under `raster/`; this file only
 * coordinates them with the rest of the application.
 */
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
    buildCatalogItemDetails,
    CatalogFootprintController,
    CatalogResultStream,
    CatalogSearchClient,
    CatalogSearchSyntaxError,
    CatalogSurpriseClient,
    createDebouncedAction,
    formatCatalogItemCount,
    formatCatalogRasterStatus,
    formatScanReconciliation,
    formatScanProgressCounts,
    formatScanTiming,
    formatScanStatusSummary,
    getCatalogVisualization,
    supportsRasterDetailOnlyPreview,
    MOUNTED_DATASET_TYPES,
} from "./catalog.js";
import { CatalogVisualizationCoordinator } from "./catalog-visualization.js";
import { initializeCatalogPaneControls } from "./catalog-pane-controller.js";
import { getCatalogItemKey } from "./catalog-item-identity.js";
import { EomapLayoutController } from "./eomap-layout-controller.js";
import {
    applyCatalogSystemState,
    renderScanLocations,
    synchronizeScanDisclosureState,
} from "./catalog-system-state.js";
import {
    createSingleWorldMap,
    formatSingleWorldPosition
} from "./map.js";
import { MapLayerController } from "./map-layers/controller.js";
import { MapLayerStackView } from "./map-layers/layer-stack-view.js";
import {
    catalogItemsMatch,
    CatalogMapActionRegistry,
    CatalogVisualizationAssessmentCache,
} from "./catalog-map-actions.js";
import { initializeRasterDetailPreview } from "./raster/detail-preview-controller.js";
import {
    formatRasterDetailMapNotice,
    formatRasterDetailPreviewResolution,
    isRasterDetailPreviewProcessing,
} from "./raster/detail-preview-status.js";
import { initializeRasterViewer } from "./raster/raster-viewer.js";
import { createVectorMapLayerAdapter } from "./vector/map-layer-adapter.js";
import { initializeTemporaryAoi } from "./temporary-aoi/temporary-aoi.js";
import {
    applyRenderingDiagnosticsViewModel,
    buildRenderingDiagnosticsViewModel,
    buildUnavailableRenderingDiagnosticsViewModel,
    loadRenderingDiagnostics,
    RenderingDiagnosticsPoller,
} from "./rendering-diagnostics.js";
import "./style.css";

const CATALOG_SEARCH_DEBOUNCE_MILLISECONDS = 300;
const CATALOG_LOAD_ROOT_MARGIN = "300px 0px";

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
 * @property {string[]} scanDisplayPaths User-facing directories scanned recursively.
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
    const leafletMap = createSingleWorldMap(L, appGlobalConfiguration);

    const mapPositionElement = document.querySelector("#map-position");

    /**
     * Displays a geographic position reported by Leaflet.
     *
     * @param {{latlng: L.LatLng}} mapPositionEvent Leaflet position event.
     * @return {void}
     */
    function updateMapPosition(mapPositionEvent) {
        mapPositionElement.textContent = formatSingleWorldPosition(
            mapPositionEvent.latlng
        );
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

    const catalogLinkElement = document.querySelector("#catalog-link");

    applyCatalogSystemState(
        {
            disclosure: document.querySelector("#system-state"),
            stateText: document.querySelector("#system-state-text"),
            stateAnnouncement: document.querySelector(
                "#catalog-state-announcement"
            )
        },
        "Catalog: connecting"
    );
    renderScanLocations(
        document.querySelector("#scan-locations"),
        appGlobalConfiguration.scanDisplayPaths
    );
    catalogLinkElement.href = appGlobalConfiguration.catalogUrl;
}

/**
 * Bind the rendering diagnostics disclosure and visibility-aware poller.
 *
 * @return {void}
 */
function initializeRenderingDiagnostics() {
    const disclosureElement = document.querySelector(
        "#rendering-diagnostics"
    );
    const stateTextElement = document.querySelector("#rendering-state-text");
    const stateAnnouncementElement = document.querySelector(
        "#rendering-state-announcement"
    );
    const observedElement = document.querySelector("#rendering-observed");
    const observedVerbElement = document.querySelector(
        "#rendering-observed-verb"
    );
    const observedAtElement = document.querySelector(
        "#rendering-observed-at"
    );
    const diagnosticsElements = {
        disclosure: disclosureElement,
        stateText: stateTextElement,
        stateAnnouncement: stateAnnouncementElement,
        observed: observedElement,
        observedVerb: observedVerbElement,
        observedAt: observedAtElement,
        values: {
            heap: document.querySelector("#rendering-heap"),
            cpu: document.querySelector("#rendering-cpu"),
            requests: document.querySelector("#rendering-requests"),
            latestGetMap: document.querySelector(
                "#rendering-latest-get-map"
            ),
            failures: document.querySelector("#rendering-failures"),
            garbageCollection: document.querySelector(
                "#rendering-garbage-collection"
            ),
            threads: document.querySelector("#rendering-threads"),
            uptime: document.querySelector("#rendering-uptime")
        }
    };

    const poller = new RenderingDiagnosticsPoller(
        loadRenderingDiagnostics,
        (diagnostics) => {
            applyRenderingDiagnosticsViewModel(
                diagnosticsElements,
                buildRenderingDiagnosticsViewModel(diagnostics)
            );
        },
        () => {
            applyRenderingDiagnosticsViewModel(
                diagnosticsElements,
                buildUnavailableRenderingDiagnosticsViewModel()
            );
        }
    );

    /**
     * Match polling frequency to page visibility and disclosure state.
     *
     * @return {void}
     */
    function synchronizePollingMode() {
        poller.setMode({
            pageVisible: document.visibilityState === "visible",
            expanded: disclosureElement.open
        });
    }

    disclosureElement.addEventListener("toggle", synchronizePollingMode);
    document.addEventListener("visibilitychange", synchronizePollingMode);
    synchronizePollingMode();
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
 * @param {(viewer: import("./raster/raster-viewer.js").RasterViewer) => void}
 * [onRasterViewerReady=() => {}] Receives the raster public boundary before
 * asynchronous catalog loading begins.
 * @param {import("./catalog-pane-controller.js").CatalogPaneControls}
 * catalogPaneControls Catalog-owned progressive inspector presentation.
 * @param {() => void} [onHistogramRequested=() => {}] Reveals the semantic
 * Histograms workspace after an explicit histogram action.
 * @param {() => void} [onRenderingWorkspaceRequested=() => {}] Reveals Map
 * layers when a visualization attempt or low-resolution presentation starts.
 * @return {Promise<Function>} Function that reloads the active catalog search.
 * @throws {TypeError} If the rendering-workspace callback is not callable.
 */
async function initializeCatalog(
    appGlobalConfiguration,
    leafletMap,
    onRasterViewerReady = () => {},
    catalogPaneControls,
    onHistogramRequested = () => {},
    onRenderingWorkspaceRequested = () => {}
) {
    if (typeof onRenderingWorkspaceRequested !== "function") {
        throw new TypeError(
            "Rendering-workspace presentation callback must be callable"
        );
    }
    const catalogSystemStateElements = {
        disclosure: document.querySelector("#system-state"),
        stateText: document.querySelector("#system-state-text"),
        stateAnnouncement: document.querySelector(
            "#catalog-state-announcement"
        )
    };
    const catalogMessageElement = document.querySelector("#catalog-message");
    const catalogSummaryElement = document.querySelector("#catalog-summary");
    const catalogResultsElement = document.querySelector("#catalog-results");
    const catalogResultsScrollElement = document.querySelector(
        "#catalog-results-scroll"
    );
    const catalogSearchInput = document.querySelector("#catalog-search");
    const catalogSearchError = document.querySelector("#catalog-search-error");
    const surpriseCatalogButton = document.querySelector(
        "#surprise-catalog"
    );
    const catalogSurpriseStatus = document.querySelector(
        "#catalog-surprise-status"
    );
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
    const rasterDetailPreviewControls = document.querySelector(
        "#raster-detail-preview-controls"
    );
    const rasterDetailPreviewResolution = document.querySelector(
        "#raster-detail-preview-resolution"
    );
    const rasterDetailMapNotice = document.querySelector(
        "#raster-detail-map-notice"
    );
    const rasterDetailProcessing = document.querySelector(
        "#raster-detail-processing"
    );
    const showRasterDetailPreview = document.querySelector(
        "#show-raster-detail-preview"
    );
    const removeRasterDetailPreview = document.querySelector(
        "#remove-raster-detail-preview"
    );
    const catalogUrl = appGlobalConfiguration.catalogUrl.replace(/\/$/, "");
    const resultStream = new CatalogResultStream(
        new CatalogSearchClient(catalogUrl)
    );
    const surpriseClient = new CatalogSurpriseClient();
    const footprintController = new CatalogFootprintController(
        leafletMap,
        createCatalogFootprintLayer
    );
    const catalogState = {
        collectionsDocument: null,
        resultButtons: new Map(),
        searchSequence: 0,
        searchText: "",
        selectedButton: null,
        selectedItem: null,
        pendingMapActions: new CatalogMapActionRegistry(),
        visualizationAssessments: new CatalogVisualizationAssessmentCache(),
        // Generation token: filter/search changes invalidate older async
        // Surprise responses so they cannot select an Item from stale criteria.
        surpriseRequestGeneration: 0,
    };

    /**
     * Report one layer-specific raster tile failure in the Catalog action.
     *
     * @param {string} message User-facing raster tile failure.
     * @param {Object} item Affected Catalog Item.
     * @return {void}
     */
    function reportMapTileError(message, item) {
        if (catalogItemsMatch(catalogState.selectedItem, item)) {
            catalogLayerStatus.textContent = message;
        }
    }

    /**
     * Refresh the selected Item action from retained and pending state.
     *
     * @return {void}
     */
    function refreshCatalogMapAction() {
        updateCatalogMapAction(catalogState.selectedItem);
    }

    /**
     * Render exact backend-reported sampled-grid dimensions.
     *
     * @param {Object|null} previewState Current sampled-raster session state.
     * @param {"idle"|"loading"|"error"} [baseStatus="idle"] Initial base
     * request lifecycle when no displayed preview exists.
     * @return {void}
     */
    function renderRasterDetailPreviewResolution(
        previewState,
        baseStatus = "idle"
    ) {
        rasterDetailPreviewResolution.textContent =
            formatRasterDetailPreviewResolution(previewState, baseStatus);
        const mapNotice = formatRasterDetailMapNotice(previewState);
        rasterDetailMapNotice.textContent = mapNotice;
        rasterDetailMapNotice.hidden = mapNotice === "";
        const isProcessing = isRasterDetailPreviewProcessing(
            previewState,
            baseStatus
        );
        rasterDetailProcessing.hidden = !isProcessing;
        rasterDetailProcessing.setAttribute(
            "aria-busy",
            String(isProcessing)
        );
    }

    /**
     * Begin one assessment or publication action for a selected Item.
     *
     * @param {Object} item Selected Catalog Item.
     * @param {string} buttonText In-progress action label.
     * @param {string} statusText In-progress status explanation.
     * @return {{item:Object,key:string,buttonText:string,statusText:string}}
     * Identity token for matching completion.
     * @throws {Error} If the Item already owns an in-flight action.
     */
    function beginCatalogMapAction(item, buttonText, statusText) {
        const pendingAction = catalogState.pendingMapActions.begin(
            item,
            buttonText,
            statusText
        );
        updateCatalogMapAction(item);
        return pendingAction;
    }

    /**
     * Finish only the action that still owns the selected Item controls.
     *
     * @param {{item:Object,key:string}} pendingAction Action identity returned
     * at start.
     * @return {void}
     */
    function finishCatalogMapAction(pendingAction) {
        if (!catalogState.pendingMapActions.finish(pendingAction)) {
            return;
        }
        if (catalogItemsMatch(catalogState.selectedItem, pendingAction.item)) {
            updateCatalogMapAction(catalogState.selectedItem);
        }
    }

    const mapLayerController = new MapLayerController({
        leafletMap,
        view: new MapLayerStackView(),
        onLayersChange: refreshCatalogMapAction,
    });
    const rasterVisualization = initializeRasterViewer({
        wmsUrl: appGlobalConfiguration.wmsUrl,
        leafletMap,
        leaflet: L,
        onTileError: reportMapTileError,
        onHistogramRequested,
    }, { mapLayerController });
    const catalogVisualization = new CatalogVisualizationCoordinator(
        rasterVisualization,
        mapLayerController,
        createVectorMapLayerAdapter({
            leaflet: L,
            leafletMap,
            wmsUrl: appGlobalConfiguration.wmsUrl,
            onTileError: reportMapTileError,
        })
    );
    const rasterDetailPreview = initializeRasterDetailPreview({
        leafletMap,
        leaflet: L,
        onChange: () => {
            refreshCatalogMapAction();
            const selectedItem = catalogState.selectedItem;
            const previewState = selectedItem === null
                ? null
                : rasterDetailPreview.getState(selectedItem);
            if (previewState !== null) {
                rasterVisualization.updateSampledInitialStyle(
                    selectedItem,
                    previewState.style
                );
            }
        },
    });
    onRasterViewerReady(rasterVisualization);
    /**
     * Apply the scanner-owned visualization decision to the map action.
     *
     * @param {Object|null} item Selected Catalog Item.
     * @return {void}
     */
    function updateCatalogMapAction(item) {
        const visualization = getCatalogVisualization(item);
        const supportsDetailPreview =
            supportsRasterDetailOnlyPreview(item);
        const isRetained = item !== null && catalogVisualization.contains(item);
        const hasDetailPreview = item !== null &&
            rasterDetailPreview.contains(item);
        const detailPreviewState = item === null
            ? null
            : rasterDetailPreview.getState(item);
        const pendingAction = item === null
            ? null
            : catalogState.pendingMapActions.get(item);
        catalogMapActionsElement.hidden = visualization === null;
        catalogMapActionsElement.setAttribute(
            "aria-busy",
            String(pendingAction !== null)
        );
        catalogLayerToggle.disabled = pendingAction !== null;
        catalogLayerToggle.hidden = false;
        rasterDetailPreviewControls.hidden = !supportsDetailPreview;
        showRasterDetailPreview.disabled = pendingAction !== null;
        showRasterDetailPreview.textContent = pendingAction?.buttonText ??
            (hasDetailPreview
                ? "Update low-resolution rendering"
                : "Use low-resolution rendering");
        removeRasterDetailPreview.hidden = !hasDetailPreview;
        removeRasterDetailPreview.disabled = pendingAction !== null;
        renderRasterDetailPreviewResolution(detailPreviewState);
        catalogLayerToggle.textContent = pendingAction?.buttonText ?? (
            isRetained
                ? "Remove from map layers"
                : "Add to map layers"
        );
        const fullVisualizationReason = visualization?.metadata?.reason ?? "";
        let defaultStatus = visualization?.kind === "vector"
            ? [
                fullVisualizationReason,
                isRetained
                    ? "This vector is already in Map layers."
                    : "",
            ].filter((message) => message !== "").join(" ")
            : formatCatalogRasterStatus(
                fullVisualizationReason,
                isRetained,
                supportsDetailPreview,
                hasDetailPreview
            );
        if (hasDetailPreview) {
            const base = detailPreviewState.basePreview;
            const hasFiniteValues = base.pixelValues.some(
                (value) => value !== null
            );
            if (detailPreviewState.detailStatus === "loading") {
                defaultStatus += " Loading finer current-view detail…";
            } else if (detailPreviewState.detailStatus === "ready") {
                defaultStatus += detailPreviewState.detailPreview.rendering ===
                    "exactSourceWindow"
                    ? " The teal outline contains complete bounded source " +
                        "detail at this map scale."
                    : " The teal outline contains the fixed current-view " +
                        "sample grid; zoom closer for exact bounded detail.";
            } else if (detailPreviewState.detailStatus === "error") {
                defaultStatus += " Current-view refinement failed: " +
                    detailPreviewState.detailError +
                    ". The prior bounded display remains visible.";
            }
            if (!hasFiniteValues) {
                defaultStatus +=
                    " No finite data was found at the bounded base positions.";
            }
        }
        catalogLayerStatus.textContent =
            pendingAction?.statusText ?? defaultStatus;
    }

    /**
     * Clear the selected result, analysis session, footprint, and inspector.
     *
     * @return {void}
     */
    function clearCatalogSelection() {
        if (catalogState.selectedItem !== null) {
            rasterVisualization.removeSampled(catalogState.selectedItem);
            rasterVisualization.deactivateAnalysis(
                catalogState.selectedItem
            );
        }
        rasterDetailPreview.clear();
        catalogState.selectedButton?.classList.remove("is-selected");
        catalogState.selectedButton?.setAttribute("aria-pressed", "false");
        footprintController.clear();
        catalogState.selectedButton = null;
        catalogState.selectedItem = null;
        updateCatalogMapAction(null);
        renderCatalogItemInspector(
            null,
            catalogState.collectionsDocument?.collections ?? [],
            appGlobalConfiguration.scanDisplayPathPrefix
        );
        catalogPaneControls.showResults();
    }

    /**
     * Select one result and activate analysis when it is a Catalog raster.
     *
     * @param {Object} item Catalog Item selected from results or discovery.
     * @param {HTMLElement|null} [requestedButton=null] Optional matching result
     * button when the Item is already present in the current page.
     * @return {void}
     */
    function selectCatalogItem(item, requestedButton = null) {
        if (rasterDetailPreview.contains(item)) {
            rasterDetailPreview.invalidate();
        } else {
            if (catalogState.selectedItem !== null) {
                rasterVisualization.removeSampled(
                    catalogState.selectedItem
                );
            }
            rasterDetailPreview.clear();
        }
        catalogState.visualizationAssessments.apply(item);
        const itemButton = requestedButton ??
            catalogState.resultButtons.get(getCatalogItemKey(item)) ?? null;
        if (catalogState.selectedButton !== null) {
            catalogState.selectedButton.classList.remove("is-selected");
            catalogState.selectedButton.setAttribute("aria-pressed", "false");
        }
        catalogState.selectedButton = itemButton;
        catalogState.selectedItem = item;
        itemButton?.classList.add("is-selected");
        itemButton?.setAttribute("aria-pressed", "true");
        footprintController.select(item);
        renderCatalogItemInspector(
            item,
            catalogState.collectionsDocument.collections,
            appGlobalConfiguration.scanDisplayPathPrefix
        );
        if (getCatalogVisualization(item)?.kind !== "raster") {
            rasterVisualization.deactivateAnalysis(null);
        } else {
            rasterVisualization.activateAnalysis(item);
        }
        updateCatalogMapAction(item);
        catalogPaneControls.showInspector({ moveFocus: true });
    }

    /**
     * Appends one successful Item Search page to the active result stream.
     *
     * @param {Object} itemCollection STAC ItemCollection response.
     * @param {boolean} isInitialPage Whether this starts a new result stream.
     * @return {void}
     */
    function appendCatalogPage(itemCollection, isInitialPage) {
        const returnedItemCount = itemCollection.features.length;
        if (isInitialPage) {
            const isFiltered = catalogState.searchText.trim() !== "";
            const itemCountLabel = formatCatalogItemCount(
                itemCollection,
                isFiltered
            );
            const collections = catalogState.collectionsDocument.collections;
            const collectionLabel =
                collections.length === 1
                    ? (collections[0].title ?? collections[0].id)
                    : `${collections.length} collections`;
            applyCatalogSystemState(
                catalogSystemStateElements,
                `Catalog: connected · ${itemCountLabel}`,
                "is-connected"
            );
            catalogMessageElement.textContent = isFiltered
                ? "Matching records were returned from the complete STAC catalog."
                : "Records were returned from the deployed STAC catalog.";
            catalogSummaryElement.textContent =
                `${collectionLabel} · ${itemCountLabel}`;

            const pageBounds = L.geoJSON(itemCollection).getBounds();
            if (pageBounds.isValid()) {
                leafletMap.fitBounds(pageBounds.pad(0.15), { maxZoom: 8 });
            }
        }

        for (const item of itemCollection.features) {
            catalogState.visualizationAssessments.apply(item);
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
                selectCatalogItem(item, itemButton);
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
            catalogState.resultButtons.set(getCatalogItemKey(item), itemButton);
            if (
                catalogState.selectedItem !== null &&
                getCatalogItemKey(catalogState.selectedItem) ===
                    getCatalogItemKey(item)
            ) {
                catalogState.selectedButton = itemButton;
                itemButton.classList.add("is-selected");
                itemButton.setAttribute("aria-pressed", "true");
            }
            catalogResultsElement.append(itemButton);
        }

        if (catalogResultsElement.childElementCount === 0) {
            const emptyCatalogMessage = document.createElement("p");
            emptyCatalogMessage.className = "catalog-empty";
            emptyCatalogMessage.textContent = catalogState.searchText.trim()
                ? `No Items matched “${catalogState.searchText.trim()}”.`
                : "The catalog is connected but has no Items.";
            catalogResultsElement.append(emptyCatalogMessage);
        }

        if (!isInitialPage) {
            streamAnnouncementElement.textContent =
                `${returnedItemCount.toLocaleString()} additional Items loaded.`;
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
        catalogState.visualizationAssessments.clear();
        catalogState.surpriseRequestGeneration += 1;
        catalogState.searchText = catalogSearchInput.value;
        catalogSearchInput.removeAttribute("aria-invalid");
        catalogSearchError.textContent = "";
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        clearCatalogSelection();
        catalogState.resultButtons.clear();
        catalogResultsElement.replaceChildren();
        catalogResultsElement.setAttribute("aria-busy", "true");
        applyCatalogSystemState(
            catalogSystemStateElements,
            "Catalog: searching"
        );
        catalogMessageElement.textContent =
            "Requesting Collections and Items from the STAC API.";
        catalogSummaryElement.textContent = "Loading catalog contents";
        streamStatusElement.textContent = "Loading Catalog Items…";
        refreshCatalogButton.disabled = true;
        surpriseCatalogButton.disabled = true;
        surpriseCatalogButton.setAttribute("aria-busy", "false");
        catalogSurpriseStatus.textContent = "";

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
            if (catalogError instanceof CatalogSearchSyntaxError) {
                catalogSearchInput.setAttribute("aria-invalid", "true");
                catalogSearchError.textContent = catalogError.message;
                applyCatalogSystemState(
                    catalogSystemStateElements,
                    "Catalog: search needs correction"
                );
                catalogMessageElement.textContent =
                    "Correct the field filter and try again.";
                catalogSummaryElement.textContent = catalogError.message;
                streamStatusElement.textContent = "Catalog search was not sent.";
                return;
            }
            applyCatalogSystemState(
                catalogSystemStateElements,
                "Catalog: unavailable",
                "is-warning"
            );
            catalogMessageElement.textContent =
                "Check the catalog services and try again.";
            catalogSummaryElement.textContent = catalogError.message;
            streamStatusElement.textContent = "Catalog search failed.";
        } finally {
            if (searchSequence === catalogState.searchSequence) {
                catalogResultsElement.setAttribute("aria-busy", "false");
                refreshCatalogButton.disabled = false;
                surpriseCatalogButton.disabled = false;
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
    catalogSearchInput.addEventListener("input", () => {
        // Invalidate immediately rather than waiting for the debounced search.
        catalogState.surpriseRequestGeneration += 1;
        surpriseCatalogButton.disabled = true;
        catalogSurpriseStatus.textContent = "";
        scheduleCatalogSearch();
    });
    surpriseCatalogButton.addEventListener("click", async () => {
        const requestGeneration = ++catalogState.surpriseRequestGeneration;
        surpriseCatalogButton.disabled = true;
        surpriseCatalogButton.setAttribute("aria-busy", "true");
        catalogSurpriseStatus.textContent = "Finding a random match…";
        catalogSearchInput.removeAttribute("aria-invalid");
        catalogSearchError.textContent = "";
        try {
            const item = await surpriseClient.surprise(
                catalogState.searchText,
                catalogState.selectedItem
            );
            if (
                requestGeneration !== catalogState.surpriseRequestGeneration ||
                item === null
            ) {
                return;
            }
            selectCatalogItem(item);
            const itemTitle = item.properties?.title ?? item.id;
            catalogSurpriseStatus.textContent = `Selected ${itemTitle}.`;
        } catch (catalogError) {
            if (requestGeneration !== catalogState.surpriseRequestGeneration) {
                return;
            }
            if (catalogError instanceof CatalogSearchSyntaxError) {
                catalogSearchInput.setAttribute("aria-invalid", "true");
                catalogSearchError.textContent = catalogError.message;
                catalogSurpriseStatus.textContent =
                    "Correct the Catalog search before trying again.";
                return;
            }
            catalogSurpriseStatus.textContent = catalogError.message;
        } finally {
            if (requestGeneration === catalogState.surpriseRequestGeneration) {
                surpriseCatalogButton.disabled = false;
                surpriseCatalogButton.setAttribute("aria-busy", "false");
            }
        }
    });
    refreshCatalogButton.addEventListener(
        "click",
        loadCatalog.bind(null, true)
    );
    retryPageButton.addEventListener("click", prefetchNextCatalogPage);
    /**
     * Add or remove the selected Catalog map layer.
     *
     * Every add attempt refreshes the authoritative visualization assessment
     * before publication. The persisted assessment remains an internal
     * rendering-authorization contract rather than a separate user action.
     *
     * @return {Promise<void>} Completion after the selected action settles.
     */
    async function toggleCatalogLayer() {
        const selectedItem = catalogState.selectedItem;
        const visualization = catalogVisualization.describe(selectedItem);
        const datasetNoun = catalogVisualization.noun(selectedItem);
        if (catalogVisualization.contains(selectedItem)) {
            catalogVisualization.remove(selectedItem);
            if (visualization.kind === "raster") {
                rasterVisualization.activateAnalysis(selectedItem);
            }
            catalogLayerToggle.textContent = "Add to map layers";
            catalogLayerStatus.textContent =
                `${datasetNoun[0].toUpperCase()}${datasetNoun.slice(1)} ` +
                "removed from Map layers.";
            return;
        }

        onRenderingWorkspaceRequested();
        const pendingAction = beginCatalogMapAction(
            selectedItem,
            "Adding to map…",
            `Checking whether the selected ${datasetNoun} can be rendered.`
        );
        try {
            const assessedItem = await catalogVisualization.assess(
                selectedItem
            );
            catalogState.visualizationAssessments.record(
                selectedItem,
                assessedItem
            );
            rasterVisualization.removeSampled(selectedItem);
            rasterDetailPreview.remove(selectedItem);
            if (!catalogItemsMatch(
                catalogState.selectedItem,
                selectedItem
            )) {
                return;
            }
            catalogState.visualizationAssessments.apply(
                catalogState.selectedItem
            );
            const currentItem = catalogState.selectedItem;
            const currentVisualization = catalogVisualization.describe(
                currentItem
            );
            if (currentVisualization?.kind === "raster") {
                rasterVisualization.activateAnalysis(currentItem);
            }
            renderCatalogItemInspector(
                currentItem,
                catalogState.collectionsDocument.collections,
                appGlobalConfiguration.scanDisplayPathPrefix
            );
            if (currentVisualization?.metadata?.eligible !== true) {
                finishCatalogMapAction(pendingAction);
                return;
            }

            const publication = await catalogVisualization.show(
                currentItem
            );
            if (
                publication === null ||
                !catalogItemsMatch(catalogState.selectedItem, selectedItem)
            ) {
                return;
            }
            finishCatalogMapAction(pendingAction);
            catalogLayerToggle.textContent = "Remove from map layers";
            catalogLayerStatus.textContent =
                `${datasetNoun[0].toUpperCase()}${datasetNoun.slice(1)} ` +
                "added to Map layers.";
            onRenderingWorkspaceRequested();
        } catch (visualizationError) {
            if (catalogItemsMatch(catalogState.selectedItem, selectedItem)) {
                finishCatalogMapAction(pendingAction);
                catalogLayerToggle.textContent = "Add to map layers";
                catalogLayerStatus.textContent = visualizationError.message;
            }
        } finally {
            finishCatalogMapAction(pendingAction);
        }
    }
    catalogLayerToggle.addEventListener("click", toggleCatalogLayer);
    showRasterDetailPreview.addEventListener("click", async () => {
        const selectedItem = catalogState.selectedItem;
        const pendingAction = beginCatalogMapAction(
            selectedItem,
            "Sampling raster…",
            "Reading a strictly bounded approximate raster sample grid."
        );
        if (!rasterDetailPreview.contains(selectedItem)) {
            renderRasterDetailPreviewResolution(null, "loading");
        }
        try {
            const preview = await rasterDetailPreview.show(
                selectedItem
            );
            if (
                preview === null ||
                !catalogItemsMatch(catalogState.selectedItem, selectedItem)
            ) {
                return;
            }
            const previewState = rasterDetailPreview.getState(selectedItem);
            rasterVisualization.activateSampled(
                selectedItem,
                previewState.style,
                (style) => rasterDetailPreview.setStyle(selectedItem, style)
            );
            finishCatalogMapAction(pendingAction);
            updateCatalogMapAction(selectedItem);
            onRenderingWorkspaceRequested();
        } catch (previewError) {
            if (
                previewError.name !== "AbortError" &&
                catalogItemsMatch(catalogState.selectedItem, selectedItem)
            ) {
                finishCatalogMapAction(pendingAction);
                catalogLayerStatus.textContent = previewError.message;
                if (!rasterDetailPreview.contains(selectedItem)) {
                    renderRasterDetailPreviewResolution(null, "error");
                }
            }
        } finally {
            finishCatalogMapAction(pendingAction);
        }
    });
    removeRasterDetailPreview.addEventListener("click", () => {
        const selectedItem = catalogState.selectedItem;
        rasterVisualization.removeSampled(selectedItem);
        rasterDetailPreview.remove(selectedItem);
        rasterVisualization.activateAnalysis(selectedItem);
        catalogLayerStatus.textContent =
            "Sampled raster removed from the map.";
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
    const catalogStateDisclosureElement = document.querySelector(
        "#system-state"
    );
    const scanStatusDisclosureElement = document.querySelector(
        "#scan-status-disclosure"
    );
    const scanStatusSummaryElement = document.querySelector(
        "#scan-status-summary"
    );
    const scanStatusElement = document.querySelector("#scan-status");
    const scanProgressElement = document.querySelector("#scan-progress");
    const scanCountsElement = document.querySelector("#scan-counts");
    const scanReconciliationElement = document.querySelector(
        "#scan-reconciliation"
    );
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
    // Set defaults only when a scan starts or stops so polling does not
    // override a user's disclosure choices during the same run.
    synchronizeScanDisclosureState(
        {
            catalogState: catalogStateDisclosureElement,
            scanStatus: scanStatusDisclosureElement
        },
        isRunning,
        wasRunning
    );
    scanStatusDisclosureElement.dataset.running = String(isRunning);
    scanProgressElement.hidden = scanStatus.state === "not_started";
    scanProgressElement.max = Math.max(
        scanStatus.sourceDatasetsDiscovered,
        1
    );
    scanProgressElement.value = scanStatus.sourceDatasetsProcessed;
    scanCountsElement.textContent =
        scanStatus.state === "not_started"
            ? ""
            : formatScanProgressCounts(scanStatus);
    scanReconciliationElement.hidden = scanStatus.state === "not_started";
    scanReconciliationElement.textContent = formatScanReconciliation(
        scanStatus.reconciliation
    );
    scanReconciliationElement.classList.toggle(
        "is-error",
        scanStatus.reconciliation.state === "failed"
    );

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
        not_started: "No scan has run since EOLab started.",
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
 * Starts the browser application from its runtime contract.
 *
 * @return {Promise<void>} Resolves after the interface is initialized.
 */
async function startApplication() {
    /** @type {EomapLayoutController|null} */
    let layoutController = null;
    const catalogPaneControls = initializeCatalogPaneControls(
        document,
        () => layoutController?.notifyLayoutChange()
    );
    const appGlobalConfiguration = await loadAppGlobalConfiguration();
    applyAppGlobalConfiguration(appGlobalConfiguration);
    initializeRenderingDiagnostics();
    const leafletMap = initializeMap(appGlobalConfiguration);
    layoutController = new EomapLayoutController({
        documentContext: document,
        schedule: window.setTimeout.bind(window),
        invalidateMapSize: () => leafletMap.invalidateSize(),
    });
    const temporaryAoi = initializeTemporaryAoi(leafletMap, L);
    const refreshCatalog = await initializeCatalog(
        appGlobalConfiguration,
        leafletMap,
        (rasterViewer) => {
            temporaryAoi.subscribeSamplingArea(
                rasterViewer.setTemporaryAoi
            );
        },
        catalogPaneControls,
        () => layoutController.showWorkspace("histogram"),
        () => layoutController.showWorkspace("map-layers")
    );
    await initializeScanner(refreshCatalog);
}

startApplication();
