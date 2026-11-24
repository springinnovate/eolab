import {
    createCuratedMetadataView, catalogAssetReference, createCatalogReferenceLink,
    catalogReferenceIdentity, createCatalogDisclosure,
} from "./catalog-curated-metadata.js";
import { captureMapViewportArea, rasterSamplingAreaBounds, viewFilter, waitingForPolygonLayer } from "./selected-area.js";
import { MapFeatureHover } from "./map-feature-hover.js";
import { findVectorLayerAtPointer } from "./vector/feature-hover.js";
import { getFeatureInfoViewport } from "./vector/feature-info-viewport.js";
import { annotationSummaryPolygons, filterAnnotationPolygons } from "./annotations/summary-area.js";
import { applySpatialFilter, SpatialFilterViews } from "./vector/spatial-filter.js";
import { VectorSelectionOverlay } from "./vector/selection-overlay.js";
import { MapInteractionTools } from "./map-interaction-tools.js";
import { resolveVisitorControls, visitorInitialPanels, VISITOR_CONTROLS_VERSION } from "./visitor-controls.js";
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
    formatScanReconciliation,
    formatScanProgressCounts,
    formatScanTiming,
    formatScanStatusSummary,
    getCatalogVisualization,
    MOUNTED_DATASET_TYPES,
    TEMPORAL_COLLECTION_ID,
} from "./catalog.js";
import { CatalogSearchSuggestions } from "./catalog-search-suggestions.js";
import { AnnotationPanelView } from "./annotations/panel-view.js";
import { AnnotationController } from "./annotations/controller.js";
import { DrawingSourceApi } from "./annotations/source-api.js";
import "./annotations/style.css";
import { AnnotationSessionsController } from "./annotation-sessions/controller.js";
import "./annotation-sessions/style.css";
import { CatalogVisualizationCoordinator } from "./catalog-visualization.js";
import { initializeCatalogPaneControls } from "./catalog-pane-controller.js";
import { CatalogScanControls } from "./catalog-scan-controls.js";
import { getCatalogItemKey } from "./catalog-item-identity.js";
import {
    buildCatalogResultPresentation,
    formatCatalogResultCount,
} from "./catalog-result-presentation.js";
import { createCatalogResultView } from "./catalog-result-view.js";
import { EomapLayoutController } from "./eomap-layout-controller.js";
import { bindPanelFadeSettings } from "./panel-fade-settings.js";
import { MapInspectionController } from "./map-inspection-controller.js";
import {
    applyCatalogSystemState,
    renderScanLocations,
    synchronizeScanDisclosureState,
} from "./catalog-system-state.js";
import {
    createSingleWorldMap,
    getCatalogItemMapBounds,
    getSingleWorldMapBounds,
    formatSingleWorldPosition
} from "./map.js";
import { addMapPlaceSearch } from "./map-place-search.js";
import { addMapCoordinateGuide } from "./map-coordinate-guide.js";
import { MapLayerStyleEditor } from "./map-layers/style-editor.js";
import { MapLayerController } from "./map-layers/controller.js";
import { MapLayerStackView } from "./map-layers/layer-stack-view.js";
import { MapPolygonGroups } from "./map-layers/polygon-groups.js";
import { OnMapLegend } from "./map-layers/on-map-legend.js";
import { LeafletLayerSet } from "./map-layers/leaflet-layer-set.js";
import { CompositeMapPlanClient } from "./map-layers/composite-api.js";
import {
    CompositeLeafletRenderer,
} from "./map-layers/composite-leaflet-renderer.js";
import { addMapRenderStatus } from "./map-layers/map-render-status.js";
import {
    catalogItemsMatch,
    CatalogMapActions,
} from "./catalog-map-actions.js";
import { renderCatalogMapAction } from "./catalog-map-action-view.js";
import { initializeRasterViewer } from "./raster/raster-viewer.js";
import { TemporalScrubber } from "./raster/temporal-scrubber.js";
import { RasterControlsView } from "./raster/controls-view.js";
import { loadTemporalTimes } from "./raster/temporal-api.js";
import { loadSamplingBoxPreview } from "./raster/analysis-api.js";
import { RasterSeriesCalculations } from "./processing/raster-series-calculations.js";
import { RasterSeriesController } from "./raster/series.js";
import { RasterSeriesView } from "./raster/series-view.js";
import { RasterResultLocator } from "./raster/series-locator.js";
import { isCanonicalWgs84Position } from "./raster/geometry.js";
import "./raster/series.css";
import { RasterCursorValuesView } from "./raster/cursor-values-view.js";
import { SavedMapViewCatalogClient } from "./saved-map-view/catalog-client.js";
import { SavedMapViewController } from "./saved-map-view/controller.js";
import { SavedMapApiClient, namedMapSlugFromPath, editableMapSlugFromPath, MAP_LINK_NAME_PATTERN } from "./saved-map-view/api-client.js";
import { SavedMapViewDomView } from "./saved-map-view/dom-view.js";
import { createSavedMapLeafletViewport } from "./saved-map-view/leaflet-viewport.js";
import { SavedMapViewLocalStorage } from "./saved-map-view/local-storage.js";
import { PlanningController } from "./planning/controller.js";
import { PlanningView } from "./planning/view.js";
import { PlanningApiClient } from "./planning/api.js";
import "./planning/style.css";
import { VectorFeatureInspectorController } from "./vector/feature-inspector.js";
import { VectorFeatureProfileController } from "./vector/feature-profile.js";
import {
    validateVectorFeatureFocus,
} from "./vector/inspection-observation.js";
import { VectorFilterControls } from "./vector/filter-controls.js";
import { VectorFieldCalculator } from "./vector/field-calculator.js";
import { EMPTY_VECTOR_FILTER, vectorFilterSummary } from "./vector/filter.js";
import { createVectorMapLayerAdapter } from "./vector/map-layer-adapter.js";
import { PolygonGeometryEditor } from "./vector/geometry-editor.js";
import "./vector/geometry-editor.css";
import { UploadsDialog } from "./uploads/dialog.js";
import { getUpload, getRasterUpload } from "./uploads/api.js";
import { VectorStyleControls } from "./vector/style-controls.js";
import { VectorTimeSeriesController } from "./vector/time-series.js";
import { VectorSamplingController, createVectorSamplingArea } from "./vector/sampling.js";
import { VectorSamplingView } from "./vector/sampling-view.js";
import { ModelsController } from "./models/controller.js";
import { describeRasterSource } from "./raster/source-api.js";
import { ModelOutputLayers } from "./model-output-preview/controller.js";
import { createArtifactPreviewLayer } from "./model-output-preview/leaflet.js";
import { labeledRasterSource } from "./raster-source.js";
import { ModelsView } from "./models/view.js";
import "./models/style.css";
import { ProcessingApiClient } from "./processing/api.js";
import { CalculationRequests } from "./processing/calculation-requests.js";
import { CalculationSessionStorage } from "./processing/calculation-session.js";
import { ProcessingJobs } from "./processing/jobs.js";
import { RasterClipsController } from "./processing/raster-clips-controller.js";
import { RasterClipsView } from "./processing/raster-clips-view.js";
import { RasterDownloadSheet } from "./processing/raster-download-sheet.js";
import { PendingSubmissionStorage } from "./processing/pending-submission.js";

/** Describe a calculation input using its original source identity and map label.
 * @param {Object} item Catalog Item or original-source descriptor.
 * @param {string} [label] Map-specific display name; defaults to the catalog title.
 * @return {Object} Source identity and presentation label.
 * @throws {TypeError} If the source identity or label is invalid.
 */
function describeCalculationSource(item, label = item.label ?? item.properties?.title ?? item.id) {
    return labeledRasterSource(item, label);
}

/** Access session storage without making restricted browsers lose the map. @return {Storage|null} Storage or unavailable. */
function browserSessionStorage() {
    try { return globalThis.sessionStorage; } catch { return null; }
}
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

/** Presentation mode only; API permissions and source authorization are unchanged.
 * Read the named-map URL before choosing authoring or recipient controls.
 * @type {string|null}
 */
const editableMapSlug = editableMapSlugFromPath(globalThis.location.pathname);
const namedMapSlug = editableMapSlug ?? namedMapSlugFromPath(globalThis.location.pathname);
/** @type {boolean} Named maps and older shared links use recipient controls. */
const isSharedViewer = editableMapSlug === null && (namedMapSlug !== null || new URL(globalThis.location.href).searchParams.get("viewer") === "shared");
/** @type {Object|null} Public basemap selection interface supplied by the map owner. */
let basemapControl = null;

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
 * @property {import("./basemap-control.js").BasemapConfiguration} basemap Background tile settings.
 * @property {{apiKey:string}} [placeSearch] Browser-visible MapTiler credentials for submitted place searches.
 * @property {{latitude: number, longitude: number, zoom: number}} initialView Initial map view.
 */

/**
 * Load application settings and establish the private browser identity.
 * Startup awaits this same-origin response before enabling feature requests.
 *
 * @return {Promise<AppGlobalConfiguration>} The application settings.
 * @throws {Error} If the settings endpoint does not return a successful response.
 */
async function loadAppGlobalConfiguration() {
    const configurationResponse = await fetch("/api/config", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
    });

    if (!configurationResponse.ok) {
        throw new Error(
            `Runtime configuration returned ${configurationResponse.status}`
        );
    }

    return configurationResponse.json();
}

/**
 * Keep the first-sample instruction in the map's available space. With the sidebar open,
 * the existing sample-area control reserves room at the desktop map edge or in the compact toolbar.
 * @param {L.Map} map Map containing the unobstructed placement for a collapsed sidebar.
 * @return {void}
 */
function placeFirstSampleHint(map) {
    const hint = document.querySelector("#raster-first-sample-hint");
    const tool = document.querySelector("#raster-sampling-tool");
    const sidebarOpen = !document.querySelector("#control-panel").inert;
    const chooserVisible = !tool.closest("[hidden]");
    const host = sidebarOpen && chooserVisible ? tool : map.getContainer();
    if (hint.parentElement !== host) host.append(hint);
}

/**
 * Float the sample-area chooser with the desktop map navigation controls. On smaller
 * screens the workspace drawers cover the map, so keep it in their measured toolbar.
 * @param {L.Map} map Map whose controls share the visible viewport.
 * @return {void}
 */
function placeSamplingTool(map) {
    const tool = document.querySelector("#raster-sampling-tool");
    const toolbar = tool.parentElement;
    const desktop = window.matchMedia("(min-width: 1200px)");
    const control = L.control({position: "bottomleft"});
    /** @return {HTMLElement} Map control containing the existing chooser and its inputs. */
    control.onAdd = () => {
        const slot = L.DomUtil.create("div", "map-sampling-control");
        L.DomEvent.disableClickPropagation(slot);
        L.DomEvent.disableScrollPropagation(slot);
        L.DomEvent.on(slot, "mousemove keydown", L.DomEvent.stopPropagation);
        slot.append(tool);
        return slot;
    };
    /** Return the chooser to the toolbar when the map releases its control. @return {void} */
    control.onRemove = () => {
        L.DomEvent.off(control.getContainer());
        toolbar.prepend(tool);
    };

    /** Move the chooser between layouts and retain focus on its active control. @return {void} */
    function updatePlacement() {
        const focused = tool.contains(document.activeElement) ? document.activeElement : null;
        if (desktop.matches) control.addTo(map);
        else control.remove();
        placeFirstSampleHint(map);
        focused?.focus({preventScroll: true});
    }
    updatePlacement();
    desktop.addEventListener("change", updatePlacement);
    map.once("unload", () => desktop.removeEventListener("change", updatePlacement));
}

/**
 * Create the map and supply the floating panels that cover its canvas.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {ReturnType<typeof createSingleWorldMap>} The initialized application map.
 */
function initializeMap(appGlobalConfiguration) {
    const panels = [document.getElementById("control-panel"), document.getElementById("map-inspection")];
    const leafletMap = createSingleWorldMap(L, appGlobalConfiguration, control => { basemapControl = control; }, panels);
    addMapCoordinateGuide(L, leafletMap);
    placeSamplingTool(leafletMap);

    const mapPositionElement = document.querySelector("#map-position");
    leafletMap.getContainer().append(mapPositionElement);

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

    updateMapPosition({ latlng: leafletMap.visibleView.getCenter() });
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
    applyMapHeading(appGlobalConfiguration.appTitle, appGlobalConfiguration.appSubtitle);
    document.querySelector("#app-version").textContent = appGlobalConfiguration.appVersion;
    const catalogLinkElement = document.querySelector("#catalog-link");
    applyCatalogSystemState(
        {
            disclosure: document.querySelector("#system-state"),
            stateText: document.querySelector("#system-state-text"),
            stateAnnouncement: document.querySelector("#catalog-state-announcement")
        },
        "Catalog: connecting"
    );
    renderScanLocations(document.querySelector("#scan-locations"), appGlobalConfiguration.scanDisplayPaths);
    catalogLinkElement.href = appGlobalConfiguration.catalogUrl;
}

/**
 * Set map titles and accessible names, hiding an omitted optional subtitle.
 * @param {string} title Site title or published map title.
 * @param {string} subtitle Site subtitle or the creator's optional subtitle.
 * @return {void}
 */
function applyMapHeading(title, subtitle) {
    document.title = title;
    document.querySelector("#app-title").textContent =
        title;
    document.querySelector("#app-title").title =
        title;
    document.querySelector("#app-subtitle").textContent =
        subtitle;
    document.querySelector("#app-subtitle").title =
        subtitle;
    document.querySelector("#app-subtitle").hidden = !subtitle;
    document
        .querySelector("#map")
        .setAttribute(
            "aria-label",
            `${title} interactive map`
        );
    document
        .querySelector("#control-panel")
        .setAttribute(
            "aria-label",
            `${title} controls`
        );
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
 * Display curated study evidence, supporting files and technical details for the selected Item.
 * The same pane serves Catalog results and retained/shared map layers; supplied
 * publications and annotations never control map or analysis availability.
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
    const inspectorContext = document.querySelector("#catalog-item-context");
    inspectorContent.replaceChildren();

    // Render the empty state when no Item is selected.
    if (item === null) {
        inspectorHeading.textContent = "Selected item";
        inspectorHeading.removeAttribute("title");
        inspectorContext.textContent = "";
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
    const presentation = buildCatalogResultPresentation(
        item,
        MOUNTED_DATASET_TYPES.get(item.collection)
    );
    inspectorHeading.textContent = presentation.filename;
    inspectorHeading.title = presentation.fullTitle;
    inspectorContext.textContent = [presentation.datasetType, presentation.context]
        .filter((label) => label !== null)
        .join(" · ");
    if (inspector.description !== null) {
        const description = document.createElement("p");
        description.className = "catalog-inspector-description";
        description.textContent = inspector.description;
        inspectorContent.append(description);
    }
    const curated = item.properties["eolab:metadata"];
    // Data actions own their destinations even when a citation repeats the URL.
    const dataReferenceOwners = new Map();
    for (const asset of inspector.assets ?? []) {
        const sourceAsset = item.assets[asset.key];
        if (!sourceAsset.roles?.includes("data")) continue;
        const reference = catalogAssetReference(item, asset.key, sourceAsset);
        if (reference?.external !== true) continue;
        const identity = catalogReferenceIdentity(reference.href);
        if (!dataReferenceOwners.has(identity)) dataReferenceOwners.set(identity, asset.key);
    }
    const references = new Set(dataReferenceOwners.keys());
    if (curated) inspectorContent.append(createCuratedMetadataView(curated, {
        section: "context", references,
    }));
    // Reserve canonical source links before checking duplicate Asset references.
    const sourceReferences = curated ? createCuratedMetadataView(curated, {
        section: "references", references,
    }) : null;
    const technicalDetails = curated
        ? createCatalogDisclosure(document, "Technical details") : document.createElement("div");
    technicalDetails.append(createCatalogMetadataList([
        { label: "Item title", value: inspector.title },
        ...inspector.metadata,
    ]));
    if (inspector.fields.length > 0) {
        const fieldsHeading = document.createElement("h4");
        fieldsHeading.textContent = "Fields";
        technicalDetails.append(fieldsHeading, createCatalogMetadataList(inspector.fields));
    }

    if (!curated) inspectorContent.append(technicalDetails);

    // Announce selection without changing the independent map or analysis actions.
    inspectorStatus.textContent = `Selected item: ${inspector.title}.`;
    if (inspector.assets !== null) {
        const assetsHeading = document.createElement("h4");
        assetsHeading.textContent = "Data and supporting files";
        inspectorContent.append(assetsHeading);
        if (inspector.assets.length === 0) {
            const noAssetsMessage = document.createElement("p");
            noAssetsMessage.className = "catalog-inspector-note";
            noAssetsMessage.textContent = "No files are recorded for this dataset.";
            inspectorContent.append(noAssetsMessage);
        }
    }

    for (const asset of inspector.assets ?? []) {
        const sourceAsset = item.assets[asset.key];
        const assetCurated = sourceAsset["eolab:metadata"];
        const reference = catalogAssetReference(item, asset.key, sourceAsset);
        const referenceIdentity = reference?.external === true
            ? catalogReferenceIdentity(reference.href) : null;
        const repeatedReference = referenceIdentity !== null
            && references.has(referenceIdentity)
            && dataReferenceOwners.get(referenceIdentity) !== asset.key;
        const assetCard = document.createElement("article");
        assetCard.className = "catalog-asset";
        const assetHeading = document.createElement("h5");
        assetHeading.textContent = asset.title;
        assetCard.append(assetHeading);
        if (reference !== null && !repeatedReference) {
            const link = createCatalogReferenceLink(document, reference);
            link.setAttribute("aria-label", reference.label + ": " + asset.title);
            assetCard.append(link);
            if (reference.external) references.add(catalogReferenceIdentity(reference.href));
        }
        const assetDescription = assetCurated ? assetCurated.description : sourceAsset.description;
        if (assetDescription != null) {
            const description = document.createElement("p");
            description.className = "catalog-inspector-description";
            description.textContent = assetDescription;
            assetCard.append(description);
        }
        if (assetCurated) assetCard.append(createCuratedMetadataView(assetCurated, {
            scope: "file", headingLevel: 6, section: "context", references,
        }));
        const fileDetails = curated
            ? createCatalogDisclosure(document, "File details") : document.createElement("div");
        fileDetails.append(createCatalogMetadataList([
            { label: "Asset key", value: asset.key },
            ...(repeatedReference ? [{ label: "Source reference", value: reference.href }] : []),
            ...asset.metadata,
        ]));
        if (assetCurated) fileDetails.append(createCuratedMetadataView(assetCurated, {
            scope: "file", headingLevel: 6, section: "references", references,
        }));
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
                    .map((metadataEntry) => `${metadataEntry.label}: ${metadataEntry.value}`)
                    .join(" · ");
                bandItem.append(bandHeading, bandDetails);
                bandList.append(bandItem);
            }
            fileDetails.append(bandsHeading, bandList);
        }
        assetCard.append(fileDetails);
        // Keep every Asset record available without repeating a source action.
        (repeatedReference ? technicalDetails : inspectorContent).append(assetCard);
    }
    if (sourceReferences !== null) inspectorContent.append(sourceReferences);
    if (curated) inspectorContent.append(technicalDetails);

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
 * @param {MapInspectionController} mapInspection Shared map-side tools.
 * @param {() => void} [onRenderingWorkspaceRequested=() => {}] Reveals Map
 * layers after a successful catalog addition or an explicit shared-layer request.
 * @param {() => void} [onCatalogWorkspaceRequested=() => {}] Reveals Catalog
 * when retained-layer details are requested.
 * @param {() => void} [onLayoutChange=() => {}] Updates map size after editing-mode layout changes.
 * @param {(options:import("./eomap-layout-controller.js").WorkspacePanelOptions)=>void}
 * [onWorkspaceOptionsChange=() => {}] Applies visitor panel choices before restoring sources.
 * @return {Promise<Function>} Function that reloads the active catalog search.
 * @throws {TypeError} If the rendering-workspace callback is not callable.
 */
async function initializeCatalog(
    appGlobalConfiguration,
    leafletMap,
    onRasterViewerReady = () => {},
    catalogPaneControls,
    mapInspection,
    onRenderingWorkspaceRequested = () => {},
    onCatalogWorkspaceRequested = () => {},
    onLayoutChange = () => {},
    onWorkspaceOptionsChange = () => {}
) {
    if (
        typeof onRenderingWorkspaceRequested !== "function" ||
        typeof onCatalogWorkspaceRequested !== "function" ||
        typeof onLayoutChange !== "function"
    ) {
        throw new TypeError(
            "Workspace presentation callbacks must be callable"
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
    new CatalogSearchSuggestions(document);
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
    const catalogLayerStyle = document.querySelector("#style-catalog-layer");
    const catalogLayerZoom = document.querySelector("#zoom-catalog-layer");
    const catalogOnMap = document.querySelector("#catalog-on-map");
    const catalogMapActionStatus = document.querySelector(
        "#catalog-map-action-status"
    );
    const catalogLayerStatus = document.querySelector(
        "#catalog-layer-status"
    );
    const mapLayerRenderingAnnouncement = document.querySelector(
        "#map-layer-rendering-announcement"
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
        resultViews: new Map(),
        searchSequence: 0,
        searchText: "",
        selectedButton: null,
        selectedItem: null,
        // Generation token: filter/search changes invalidate older async
        // Surprise responses so they cannot select an Item from stale criteria.
        surpriseRequestGeneration: 0,
    };

    const catalogMapActions = new CatalogMapActions({
        removalTarget: item => catalogVisualization.removalTarget(item),
        prepare: item => catalogVisualization.prepare(item),
        show: item => catalogVisualization.show(item),
        remove: item => catalogVisualization.remove(item, true),
        getBounds: getCatalogItemMapBounds,
        openStyle: (_key, item) => layerStyleEditor.open(rasterVisualization.temporalLayerKey(item) ?? mapLayerController.findLayerKey(item)),
        zoomToBounds: bounds => leafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 9 }),
        onPrepared: (item, visualization) => {
            if (!catalogItemsMatch(catalogState.selectedItem, item)) return;
            catalogMapActions.applyAssessment(catalogState.selectedItem);
            if (visualization?.kind === "raster" && !visualization.metadata.temporal) {
                rasterVisualization.activateAnalysis(catalogState.selectedItem);
            }
            renderCatalogItemInspector(
                catalogState.selectedItem,
                catalogState.collectionsDocument.collections,
                appGlobalConfiguration.scanDisplayPathPrefix
            );
        },
        onRemoved: (item, kind) => {
            if (kind === "raster" && !getCatalogVisualization(item).metadata.temporal && catalogItemsMatch(catalogState.selectedItem, item)) {
                rasterVisualization.activateAnalysis(item);
            }
        },
        onAdded: onRenderingWorkspaceRequested,
        onChange: refreshCatalogMapAction,
    });
    const catalogMapActionElements = {
        container: catalogMapActionsElement,
        toggle: catalogLayerToggle,
        style: catalogLayerStyle,
        zoom: catalogLayerZoom,
        onMap: catalogOnMap,
        actionStatus: catalogMapActionStatus,
        layerStatus: catalogLayerStatus,
    };

    /**
     * Report one layer-specific tile failure in Map contents.
     *
     * @param {string} message User-facing raster tile failure.
     * @param {Object} item Affected Catalog Item.
     * @return {void}
     */
    function reportMapTileError(message, item) {
        if (catalogItemsMatch(catalogState.selectedItem, item)) {
            catalogLayerStatus.textContent = message;
            mapLayerRenderingAnnouncement.textContent = message;
        }
    }

    /**
     * Refresh result rows and the inspector from each Item's own map state.
     *
     * @return {void}
     */
    function refreshCatalogMapAction() {
        for (const view of catalogState.resultViews.values()) {
            view.update(catalogMapActions.state(view.item));
        }
        updateCatalogMapAction(catalogState.selectedItem);
    }

    let annotations = null;
    let annotationSessions = null;
    /** @type {Promise<void>} Device polygons ready before saved layers are restored. */
    let annotationsReady;
    let visitorAvailability = resolveVisitorControls(isSharedViewer
        ? { version: VISITOR_CONTROLS_VERSION, choices: {} } : undefined);
    /** @type {Readonly<import("./map-interaction-tools.js").MapPointerActions>} */
    let mapPointerActions = { rasterValues: false, featurePicking: false, histogramBox: false };
    let mapLayerEditing = false;
    let rasterVisualization = null;
    let rasterSeries = null;
    /** List each retained temporal dataset once, independent of its displayed observations.
     * @param {Object[]} layers Map layer snapshots.
     * @return {Object[]} Path-free dataset choices for analysis controls.
     */
    const temporalDatasets = layers => [...new Map(layers.filter(layer => layer.source?.collectionId === TEMPORAL_COLLECTION_ID)
        .map(({source, sourceName, label}) => [source.itemId, {key: getCatalogItemKey({collection: source.collectionId, id: source.itemId}),
            collectionId: source.collectionId, itemId: source.itemId, label: sourceName ?? label}])).values()];
    let models = null;
    let modelArea = null;
    let modelAreaDescription = "";
    let rasterSeriesArea = null;
    let rasterSeriesAreaLabel = "";
    let pixelPoint = null;
    /** Send selected map areas to raster-stack plotting and map-linked model setup.
     * @param {Object|null} area Path-free Processing area.
     * @param {string} label Selection description. @return {void}
     */
    const updateRasterSeriesArea = (area, label) => {
        modelArea = area ? structuredClone(area) : null; modelAreaDescription = label;
        models?.refreshMapArea();
        rasterSeriesArea = area; rasterSeriesAreaLabel = label;
        rasterSeries?.setArea(area, label);
    };
    let layerStyleEditor = null;
    let outputLayers = null;
    let savedMapViewController = null;
    let planning = null;
    let vectorFeatureInspector = null;
    let mapFeatureHover = null;
    let mapInteractionTools = null;
    let vectorFilterControls = null;
    let refreshSpatialFilters = null;
    let polygonGeometryEditor = null;
    let drawingEditing = false;
    let vectorFieldCalculator = null;
    let vectorSampling = null;
    let summarySampling = null;
    let polygonGroups = null;
    let selectingMapClick = false;
    let rasterClickSelected = false;
    let latestHistogramPresentation = null;
    const mapLayerStackView = new MapLayerStackView(document, { allowRemoval: !isSharedViewer });
    let rasterClips = null;
    const mapLegend = new OnMapLegend(L, leafletMap, {
        toggleButton: document.querySelector("#toggle-map-legend"),
        onRestoreRequested: () => mapInspection.showToolActions(),
        onInclusion: (key, included) => mapLayerController.setLegendIncluded(key, included),
        onChange: () => savedMapViewController?.scheduleRemember(),
    });
    const mapRenderStatus = addMapRenderStatus(
        L, leafletMap, () => {
            compositeLeafletRenderer.retryFailedTiles();
            leafletLayers.retryFailedTiles();
        },
    );
    const timelineRoot = document.querySelector("#temporal-scrubber");
    L.DomEvent.disableClickPropagation(timelineRoot);
    L.DomEvent.disableScrollPropagation(timelineRoot);
    const timeline = new TemporalScrubber(timelineRoot, {
        selectTime: (key, time) => rasterVisualization.selectTemporalTime(key, time),
        selectMonth: (key, month, edge) => rasterVisualization.selectTemporalMonth(key, month, edge),
        prepare: async (key, time, signal) => {
            const frame = await rasterVisualization.prepareTemporalFrame(key, time, signal);
            if (!frame) return null;
            await leafletLayers.prepareLayer(key, frame.descriptor, signal);
            return frame.show;
        },
    });
    leafletMap.once("unload", () => timeline.destroy());
    /** Present tile progress and tell the timeline which publications are actually on screen.
     * @param {import("./map-layers/tile-recovery.js").MapTileStatus} status Current viewport progress.
     * @param {string[]} displayed Names of fully drawn layers.
     * @return {void}
     */
    function presentMapStatus(status, displayed) {
        mapRenderStatus.update(status);
        timeline.setMapStatus(status, displayed);
    }
    const compositeLeafletRenderer = new CompositeLeafletRenderer({
        leaflet: L,
        leafletMap,
        client: new CompositeMapPlanClient(),
        onStatus: presentMapStatus,
    });
    const leafletLayers = new LeafletLayerSet(leafletMap, compositeLeafletRenderer, {
        onStatus: presentMapStatus,
        onLayerStatus: (key, status) => mapLayerController.updateTileStatus(key, status),
    });
    const mapLayerController = new MapLayerController({
        leafletMap,
        view: mapLayerStackView,
        leafletLayers,
        onLayersChange: (layers, change) => {
            mapLegend.update(layers);
            timeline.setLayers(layers);
            planning?.refreshMapLayers();
            if (change?.kind === "opacity") {
                layerStyleEditor?.refresh();
                mapFeatureHover?.hide();
                savedMapViewController?.scheduleRemember();
                return;
            }
            const calculationLayers = layers.filter(layer => layer.capabilities?.calculations);
            rasterClips?.syncLayerDownloads(calculationLayers);
            refreshCatalogMapAction();
            mapInteractionTools?.refresh();
            if (polygonGeometryEditor?.key && !layers.some(layer => layer.key === polygonGeometryEditor.key)) {
                polygonGeometryEditor.close();
            }
            annotations?.observeLayerOrder(layers);
            refreshSpatialFilters?.();
            rasterSeries?.updateAvailableRasters(calculationLayers, temporalDatasets(layers));
            rasterVisualization?.syncVisibleLayers();
            layerStyleEditor?.refresh();
            vectorFeatureInspector?.syncVisibleLayers();
            mapFeatureHover?.hide();
            vectorFilterControls?.refresh();
            vectorFieldCalculator?.refresh();
            vectorSampling?.refresh();
            summarySampling?.refresh();
            polygonGroups?.updateLayers(getPolygonTargets().map(({key, label}) => ({key, label})));
            models?.refreshMapLayers();
            if (!layers.some((layer) =>
                layer.capabilities?.statistics && layer.visible
            )) {
                rasterClickSelected = false;
                mapInspection.setClickResult("histogram", null);
                mapInspection.closeHistogram(false);
            }
            savedMapViewController?.scheduleRemember();
        },
        onOrderChange: layers => { annotations?.observeLayerOrder(layers, true); mapFeatureHover?.hide(); },
        onItemZoom: zoomRetainedMapLayer,
        onItemInfo: inspectRetainedMapLayer,
        restoreRemovedLayer: async (snapshot, isCurrent) => snapshot.local?.kind === "model-output-preview"
            ? outputLayers.restore(snapshot, isCurrent).then(() => {
                if (isCurrent()) mapLayerController.reorder(snapshot.key, Math.min(snapshot.index, mapLayerController.snapshots().length - 1));
            }) : snapshot.local?.kind === "temporal" ? restoreRemovedTemporal(snapshot, isCurrent)
            : snapshot.local?.kind === "uploaded-vector" ? restoreUploadedVector(snapshot, isCurrent)
            : snapshot.local?.kind === "uploaded-raster" ? restoreUploadedRaster(snapshot, isCurrent)
            : snapshot.item === null ? annotations.restoreRemovedLayer(snapshot, isCurrent)
            : catalogVisualization.restoreRemovedLayer(snapshot, identity => catalogItemClient.get(identity), isCurrent),
    });
    const processingApi = new ProcessingApiClient();
    const processingJobs = new ProcessingJobs(processingApi);
    outputLayers = new ModelOutputLayers({
        api: processingApi,
        onRunObserved: job => processingJobs.accept(job),
        onUnavailable: key => savedMapViewController?.retainUnavailableLayer(key),
        addRaster: (source, lifecycle, presentation) => rasterVisualization.showSource(source, lifecycle, presentation),
        addVector: (source, lifecycle, presentation) => addGeneratedVector(source, lifecycle, presentation),
        addLayer: (source, adapter) => mapLayerController.addLocal(source, adapter),
        updateLayer: (key, presentation) => mapLayerController.updateLocalPresentation(key, presentation),
        removeLayer: key => mapLayerController.removeKey(key),
        refreshLayers: () => mapLayerController.render(),
        createLayer: (key, data, appearance) => createArtifactPreviewLayer(L, leafletMap, key, data, appearance, document),
        openRun: id => { models.open(); void models.showRun(id); },
        onChange: () => {
            models?.render();
            for (const notice of document.querySelectorAll("[data-private-result-notice]")) notice.hidden = !outputLayers?.layers.size;
        },
    });
    /** Choose enabled raster candidates for one query without consulting renderers.
     * Source extents are a conservative screen; missing/unknown extents remain candidates.
     * Non-box areas keep all enabled candidates for the authoritative source reader.
     * @param {Object|null} area Neutral Processing area.
     * @return {Object[]} Top-first labeled original-source identities.
     */
    function enabledRasterSources(area) {
        const bounds = rasterSamplingAreaBounds(area);
        return mapLayerController.snapshots().filter(
            /** @param {Object} layer Composed raster map choice. @return {boolean} Enabled candidate. */
            layer => {
                if (!layer.capabilities?.calculations || !layer.visible) return false;
                if (!bounds) return true;
                const bbox = layer.bounds;
                const extent = Array.isArray(bbox) && bbox.length === 6 ? [bbox[0], bbox[1], bbox[3], bbox[4]] : bbox;
                if (!Array.isArray(extent) || extent.length !== 4 || !extent.every(Number.isFinite)) return true;
                const [west, south, east, north] = extent;
                if (Math.abs(west) > 180 || Math.abs(east) > 180 || south < -90 || north > 90 || south > north) return true;
                if (north < bounds.south || south > bounds.north) return false;
                return west <= east ? west <= bounds.east && east >= bounds.west
                    : west <= bounds.east || east >= bounds.west;
            }
        ).map(/** @param {Object} layer Raster candidate. @return {Object} Source identity. */
            layer => describeCalculationSource(layer.source, layer.label));
    }
    /** Read raster clip inputs independently of rendering eligibility.
     * @return {{sources:Object[],area:Object|null,pixelPoint:{longitude:number,latitude:number}|null}} Current Processing context.
     */
    const processingContext = () => {
        const area = rasterVisualization?.getSelectedArea() ?? null;
        return {
            sources: mapLayerController.snapshots().filter(layer => layer.capabilities?.calculations)
                .map(layer => describeCalculationSource(layer.source, layer.label)),
            area: area?.kind === "polygonArea" ? null : area,
            pixelPoint,
        };
    };
    const rasterControls = new RasterControlsView(document);
    let activeSamplingTool = null;
    let statisticsSamplingContext = null;
    /** Present the appropriate area choices without changing widget visibility or the selected area. @return {void} */
    const updateSamplingControls = () => {
        const statistics = activeSamplingTool === "raster-series";
        document.querySelector("#raster-sampling-area-controls").hidden = statistics;
        document.querySelector("#raster-series-area-controls").hidden = !statistics;
        const slot = document.querySelector(statistics ? "#raster-series-box-controls" : "#raster-histogram-box-controls");
        const boxControls = document.querySelector("#raster-map-box-controls");
        if (boxControls.parentElement !== slot) slot.append(boxControls);
        rasterControls.setSamplingAreaContext(statistics ? statisticsSamplingContext : null);
    };
    /** Reflect tool-owned scope in the shared controls without changing calculation inputs.
     * @param {string} tool Sampling workflow name.
     * @param {{source:string,scope:string,usesSamplingBox:boolean}} context Display context from its view.
     * @return {void}
     */
    const presentSamplingContext = (tool, context) => {
        mapInspection.setToolContext(tool, context);
        if (tool === "raster-series") statisticsSamplingContext = context;
        if (activeSamplingTool === tool) updateSamplingControls();
    };
    mapInspection.subscribeActiveTool(tool => {
        activeSamplingTool = tool;
        updateSamplingControls();
    });
    /** Focus shared area choices without switching tools or starting calculations. @return {void} */
    const editProcessingArea = () => {
        rasterControls.openSamplingControls();
    };
    const calculationRequests = new CalculationRequests({
        api: processingApi, jobs: processingJobs, storage: new CalculationSessionStorage(browserSessionStorage()),
        onActivity: area => rasterVisualization?.setSamplingActivity(area),
    });
    const rasterAreaSeries = new RasterSeriesCalculations({ requests: calculationRequests, api: processingApi, readBoxPreview: loadSamplingBoxPreview });
    const resultLocator = new RasterResultLocator(document, L, appGlobalConfiguration.basemap);
    rasterSeries = new RasterSeriesController({
        areaStatistics: rasterAreaSeries,
        getTemporalItem: source => catalogItemClient.get({collection: source.collectionId, id: source.itemId}),
        onOpenArea: editProcessingArea,
        onAreaChoice: choice => {
            if (choice === "vector") void summarySampling.use();
            else {
                summarySampling.invalidate("");
                if (choice === "selection") rasterVisualization.selectSamplingBox();
                else rasterVisualization.selectWholeRaster();
            }
        },
        view: new RasterSeriesView(document, {
            locator: resultLocator,
            onContextChange: context => presentSamplingContext("raster-series", context),
        }),
        onClose: () => { mapInspection.hideRasterSeries(); leafletMap.getContainer().focus(); },
    });
    rasterSeries.setMapSamplingBoxAvailable(visitorAvailability.histogramBox);
    rasterClips = new RasterClipsController({
        api: processingApi, jobs: processingJobs, view: new RasterClipsView(document, {
            onContextChange: context => presentSamplingContext("raster-clips", context),
        }),
        layerView: new RasterDownloadSheet({
            document, map: leafletMap.getContainer(), list: mapLayerStackView.list, scrollContainer: mapLayerStackView.scrollContainer,
            getButton: key => mapLayerStackView.getDownloadButton(key),
        }),
        storage: new PendingSubmissionStorage(browserSessionStorage()),
        getContext: processingContext,
        getQuerySources: enabledRasterSources,
        onOpen: () => {
            mapInspection.showRasterClips();
            mapInspection.highlightActiveTool();
        },
        onClose: () => mapInspection.hideRasterClips(),
        onEditArea: editProcessingArea,
    });
    mapInspection.subscribeActiveTool(tool => rasterClips.setActive(tool === "raster-clips"));
    mapLayerController.onDownload = (key) => {
        const layer = mapLayerController.snapshots().find(item => item.key === key);
        if (!layer?.capabilities?.calculations) return;
        const bounds = leafletMap.getBounds();
        let viewport = null, viewportError = "";
        try {
            viewport = captureMapViewportArea({west:bounds.getWest(), east:bounds.getEast(), south:bounds.getSouth(), north:bounds.getNorth()});
        } catch (error) { viewportError = error.message; }
        rasterClips.toggleLayer(key, describeCalculationSource(layer.source, layer.label),
            {viewport, viewportError, selection: rasterVisualization?.getSelectedArea()});
    };
    mapLayerController.onCalculate = (key) => {
        const record = mapLayerController.getRecord(key);
        if (record) {
            rasterSeries.selectSource(describeCalculationSource(mapLayerController.snapshots().find(layer => layer.key === key).source, record.entry.label), undefined, key);
            mapInspection.showRasterSeries();
        }
    };
    void rasterClips.start();

    rasterVisualization = initializeRasterViewer({
        wmsUrl: appGlobalConfiguration.wmsUrl,
        leafletMap,
        getMapCenter: leafletMap.visibleView.getCenter,
        leaflet: L,
        onTileError: reportMapTileError,
        inspectionInitiallyEnabled: !isSharedViewer,
        onCalculateRequested: (item, area, label, key) => {
            rasterSeries.selectSource(describeCalculationSource(item, label), area, key);
            mapInspection.showRasterSeries();
        },
        onSamplingAreaChange: (area, {waitingForPolygons, invalidatedArea}) => {
            // A drawing reference belongs to this histogram selection and is released with it.
            if (area?.kind === "polygonArea" || invalidatedArea?.kind === "polygonArea" ||
                (waitingForPolygons && vectorSampling?.getSelectedTarget()?.item === null)) return;
            rasterClips.setSelection(area);
            updateRasterSeriesArea(area, area?.kind === "catalogSelection" ? "Selected polygons" : ["selectedArea", "samplingBox"].includes(area?.kind) ? "Sampling box" : "Sample area");
        },
        onSamplingMethodChange: method => {
            if (method === "vector") void vectorSampling.use();
            else vectorSampling.invalidate("");
        },
        onHistogramRequested: () => mapInspection.showHistogram(null, {
            activate: !selectingMapClick && !["raster-series", "raster-clips", "models"].includes(mapInspection.activeTool),
        }),
        onHistogramChange: snapshot => {
            latestHistogramPresentation = snapshot;
            mapInspection.setToolContext("histogram", snapshot === null ? null : { source: snapshot.source, scope: snapshot.scope });
            if (rasterClickSelected) mapInspection.setClickResult("histogram", snapshot);
        },
        onStyleRequested: (key) => layerStyleEditor?.open(key),
        onTemporalInfo: inspectRetainedMapLayer,
        onBivariateRenderingChange: (selectedKeys) =>
            mapLayerController.setIndividualRendering(selectedKeys),
    }, {
        controlsView: rasterControls,
        mapLayerController,
        cursorValuesView: new RasterCursorValuesView(),
        getTemporalItem: identity => catalogItemClient.get(identity),
    });
    mapInspection.subscribeActiveTool(tool => rasterVisualization.setFirstSampleHintEnabled(tool === null));
    const vectorMapLayerAdapter = createVectorMapLayerAdapter({
        onFilterChange: record => {
            if (mapLayerController.getRecord(record.entry.key) === record) mapLayerController.render();
        },
        leaflet: L,
        leafletMap,
        wmsUrl: appGlobalConfiguration.wmsUrl,
        onTileError: reportMapTileError,
    });
    /**
     * Give edit gestures to the current layer editor and restore the chosen tool on exit.
     * @param {boolean} editing Whether a drawing or a vector draft has the map.
     * @return {void}
     */
    function setLayerEditingMode(editing) {
        mapLayerEditing = editing;
        document.querySelector("main").classList.toggle("is-editing-map-layer", editing);
        mapInteractionTools?.setEditing(editing);
        onLayoutChange();
    }
    polygonGeometryEditor = new PolygonGeometryEditor({leaflet: L, map: leafletMap,
        onEditingChange: (editing, key) => {
            document.querySelector("main").classList.toggle("is-editing-vector-geometry", editing);
            setLayerEditingMode(editing);
            if (!editing && mapLayerController.getRecord(key)) mapLayerController.render({key, action: "edit-geometry"});
        },
    });
    /**
     * Prepare and install the admitted copy at the original view key.
     * @param {Object} previous Retained vector that started the edit.
     * @param {import("./uploads/api.js").VectorUpload} upload Newly admitted private source.
     * @param {AbortSignal} signal Cancellation when the editor or retained view closes.
     * @return {Promise<void>} Completion when the existing row shows the saved copy.
     * @throws {Error} If the source cannot be shown or the retained view has changed.
     * @throws {DOMException} If the editor closes before attachment.
     */
    async function showEditedVector(previous, upload, signal) {
        const key = previous.entry.key;
        const source = {...upload, kind: "upload"};
        const publication = await vectorMapLayerAdapter.publish(source);
        signal.throwIfAborted();
        if (mapLayerController.getRecord(key) !== previous) throw new Error("The saved file is in Your uploads.");
        const {label, visible, opacity, customName} = previous.entry;
        const staged = mapLayerController.stageLocal({
            key, label, visible, opacity, customName, sourceName: upload.name, upload: source,
            publication, isCustom: true, isDuplicate: true, canAddView: true,
        }, vectorMapLayerAdapter, previous);
        try {
            await vectorMapLayerAdapter.prepareGeometryReplacement(staged.record, previous, signal);
            if (!mapLayerController.replaceStagedLayer(previous, staged)) throw new Error("The saved file is in Your uploads.");
        } finally {
            if (mapLayerController.getRecord(key) !== staged.record) vectorMapLayerAdapter.discardStaged(staged.record);
        }
        mapLayerStackView.announceStatus(`Saved changes to ${label}.`);
    }
    mapLayerController.onEditGeometry = key => {
        const record = mapLayerController.getRecord(key);
        if (record?.adapter !== vectorMapLayerAdapter || !vectorMapLayerAdapter.canEditGeometry(record)) return;
        if (drawingEditing || polygonGeometryEditor.key) {
            mapLayerStackView.setStatus("Finish or cancel the current polygon edit first.");
            return;
        }
        if (!record.entry.visible) {
            mapLayerStackView.setStatus("Show the layer on the map before editing its geometry.");
            return;
        }
        const {selection} = vectorMapLayerAdapter.describeSource(record);
        const filter = vectorMapLayerAdapter.exportFilterState(record);
        polygonGeometryEditor.open({
            key, label: record.entry.label, source: {...selection, filter},
            isCurrent: () => mapLayerController.getRecord(key) === record &&
                JSON.stringify(vectorMapLayerAdapter.exportFilterState(record)) === JSON.stringify(filter),
            showSavedCopy: (upload, signal) => showEditedVector(record, upload, signal),
        });
    };
    vectorFieldCalculator = new VectorFieldCalculator({document, getTarget: key => {
        const record = mapLayerController.getRecord(key);
        if (!record || record.adapter !== vectorMapLayerAdapter || !record.entry.isCustom) return null;
        const source = record.adapter.describeSource(record);
        return {identity: record, label: record.entry.label, source: source.source, fields: source.fields,
            calculatedFields: record.adapter.exportCalculatedFields(record),
            removalError: name => record.adapter.getCalculatedFieldRemovalError(record, name),
            displayWarning: record.adapter.getCalculatedFieldDisplayWarning(record),
            retryDisplay: signal => record.adapter.retryCalculatedFieldRendering(record, signal),
            apply: (result, signal) => record.adapter.installCalculatedFields(record, result, signal)};
    }});
    mapLayerController.onCalculateFields = key => vectorFieldCalculator.open(key);
    /** Find every retained vector or raster view of this browser's uploaded file.
     * @param {string} uploadId Stored upload identity.
     * @return {string[]} View keys in map drawing order.
     */
    function getUploadedLayerKeys(uploadId) {
        const vectors = mapLayerController.retainedRecords.filter(record => record.adapter === vectorMapLayerAdapter &&
            record.adapter.describeSource(record).source.uploadId === uploadId).map(record => record.entry.key);
        return [...vectors, ...mapLayerController.snapshots().filter(layer => layer.source?.kind === "uploadedRaster" &&
            layer.source.uploadId === uploadId).map(layer => layer.key)];
    }
    /** Publish an admitted upload and add it with the ordinary vector controls.
     * An upload already on the map keeps its current appearance.
     * @param {import("./uploads/api.js").VectorUpload} upload This browser's stored polygon layer.
     * @return {Promise<void>} Completion after the layer joins the map.
     * @throws {Error} If publication or map construction fails.
     */
    async function addUploadedVector(upload) {
        if (getUploadedLayerKeys(upload.id).length) return;
        const source = { ...upload, kind: "upload" };
        const publication = await vectorMapLayerAdapter.publish(source);
        const record = mapLayerController.addLocal({
            key: `local:upload:${upload.id}`, label: upload.name, sourceName: upload.name,
            upload: source, publication, canAddView: true, isCustom: true,
        }, vectorMapLayerAdapter);
        onRenderingWorkspaceRequested();
        vectorMapLayerAdapter.added(record);
        mapLayerStackView.announceStatus(`${upload.name} added to map.`);
    }
    /** Describe and display an owned raster through ordinary tiles, style and analysis.
     * Reopening, Undo and additional views recheck ownership and availability.
     * @param {import("./uploads/api.js").UploadSummary} upload Available raster file.
     * @param {Object} [presentation={}] Restored key, appearance, visibility and current-request callback.
     * @return {Promise<Object|null>} Retained raster record, or null after supersession.
     * @throws {Error} If metadata, publication or display fails.
     */
    async function addUploadedRaster(upload, presentation = {}) {
        const source = {kind: "uploadedRaster", uploadId: upload.id};
        const metadata = await describeRasterSource(source);
        if (presentation.isCurrent?.() === false) return null;
        if (!metadata.bounds) throw new Error("This raster cannot be placed on the map. Choose a GeoTIFF with a valid geographic extent.");
        const raster = {source, version: metadata.version, label: upload.name, bbox: metadata.bounds,
            capabilities: {pixels: metadata.capabilities.pixels.supported, statistics: metadata.capabilities.statistics.supported,
                calculations: true, modelInput: true}};
        const record = await rasterVisualization.showSource(raster, {
            /** Open the file manager for this private source. @return {void} */
            info: uploadsDialog === null ? undefined : () => { void uploadsDialog.open(); },
            /** Capture the original upload identity and ordinary raster style for Undo.
             * @param {Object} appearance Current raster style.
             * @return {Object} Private restoration descriptor without bytes or credentials.
             */
            copy: appearance => ({kind: "uploaded-raster", uploadId: upload.id, appearance}),
            /** Removing a map view keeps its uploaded file. @return {void} */
            removed: () => {},
        }, {sourceName: upload.name, canAddView: true, ...presentation});
        if (record) {
            onRenderingWorkspaceRequested();
            mapLayerStackView.announceStatus(`${upload.name} added to map.`);
        }
        return record;
    }
    /** Restore a removed raster upload or create an additional view with its appearance.
     * @param {import("./map-layers/controller.js").RemovedMapLayer} snapshot Removed private view.
     * @param {()=>boolean} isCurrent Whether the map action still wants this view.
     * @return {Promise<void>} Completion after ownership is checked and the view is restored.
     * @throws {Error} If the upload is unavailable or restoration fails.
     */
    async function restoreUploadedRaster(snapshot, isCurrent) {
        const upload = await getRasterUpload(snapshot.local.uploadId);
        const record = await addUploadedRaster(upload, {key: snapshot.key, label: snapshot.label,
            customName: snapshot.customName, visible: snapshot.visible, opacity: snapshot.opacity,
            isCustom: snapshot.isCustom, appearance: snapshot.local.appearance, isCurrent});
        if (record) mapLayerController.reorder(snapshot.key, Math.min(snapshot.index, mapLayerController.snapshots().length - 1));
    }
    /** Display a generated vector through the same adapter as catalog layers and uploads.
     * The run owner supplies lifecycle actions; this composition function connects them.
     * @param {import("./vector/api.js").RunArtifactVectorSource} source Authorized original file metadata.
     * @param {Object} lifecycle Run detail, removal and restoration callbacks.
     * @param {Object} presentation Layer identity, appearance, filter and current-request check.
     * @return {Promise<Object|null>} Retained vector record, or null after cancellation.
     * @throws {Error} If publication, restoration or map construction fails.
     */
    async function addGeneratedVector(source, lifecycle, presentation) {
        const publication = await vectorMapLayerAdapter.publish(source);
        if (!presentation.isCurrent()) return null;
        const record = mapLayerController.addLocal({isCustom: true, ...presentation, vector: source, publication, lifecycle,
            visible: false, canAddView: true}, vectorMapLayerAdapter);
        const isCurrent = () => presentation.isCurrent() && mapLayerController.getRecord(presentation.key) === record;
        try {
            if (presentation.calculatedFields?.length) await vectorMapLayerAdapter.restoreCalculatedFields(record, presentation.calculatedFields, presentation.signal);
            if (!isCurrent()) return null;
            if (presentation.appearance) await vectorMapLayerAdapter.restoreSavedState(record, presentation.appearance);
            if (!isCurrent()) return null;
            if (presentation.filter) await vectorMapLayerAdapter.applyFilterState(record, presentation.filter);
            if (!isCurrent()) return null;
            mapLayerController.setVisible(presentation.key, presentation.visible);
            vectorMapLayerAdapter.added(record);
            onRenderingWorkspaceRequested();
            return record;
        } catch (error) {
            if (!isCurrent()) return null;
            if (mapLayerController.getRecord(presentation.key) === record) mapLayerController.removeKey(presentation.key);
            throw error;
        } finally {
            if (!presentation.isCurrent() && mapLayerController.getRecord(presentation.key) === record) mapLayerController.removeKey(presentation.key);
        }
    }
    /** Restore an upload view using its captured appearance and immutable source.
     * The WMS endpoint authorizes each request for the restored layer.
     * @param {import("./map-layers/controller.js").RemovedMapLayer} snapshot Removed upload and presentation.
     * @param {()=>boolean} isCurrent Whether restoration still belongs to the current action.
     * @return {void}
     * @throws {Error} If the layer can no longer be added to this map.
     */
    function restoreUploadedVector(snapshot, isCurrent) {
        if (!isCurrent()) return;
        const { upload, publication } = snapshot.local;
        mapLayerController.addLocal({
            key: snapshot.key, label: snapshot.label, sourceName: upload.name,
            customName: snapshot.customName, visible: snapshot.visible, opacity: snapshot.opacity,
            upload, publication, restore: snapshot.local, canAddView: true, isCustom: snapshot.isCustom,
        }, vectorMapLayerAdapter);
        mapLayerController.reorder(snapshot.key, Math.min(snapshot.index, mapLayerController.snapshots().length - 1));
    }
    /** Restore a saved upload's appearance without showing an unfiltered layer.
     * Metadata is fetched with this browser's cookie; the saved ID grants no access.
     * @param {Object} layer Saved upload identity and presentation.
     * @param {()=>boolean} isCurrent Whether this map restoration is still active.
     * @return {Promise<string|null>} Restored map key, or null after supersession.
     * @throws {Error} If the upload is unavailable or its saved appearance cannot be applied.
     */
    async function restoreSavedUpload(layer, isCurrent) {
        if (layer.style.kind === "raster") {
            const upload = await getRasterUpload(layer.uploadId);
            const record = await addUploadedRaster(upload, {key: `local:view:${globalThis.crypto.randomUUID()}`,
                customName: layer.customName, visible: layer.visible, opacity: layer.opacity,
                isCustom: layer.isCustom ?? true, appearance: layer.style, isCurrent});
            return record?.entry.key ?? null;
        }
        const upload = { ...await getUpload(layer.uploadId), kind: "upload" };
        const publication = await vectorMapLayerAdapter.publish(upload);
        if (!isCurrent()) return null;
        const key = `local:view:${globalThis.crypto.randomUUID()}`;
        const record = mapLayerController.addLocal({
            key, label: upload.name, sourceName: upload.name, customName: layer.customName,
            upload, publication, visible: false, opacity: layer.opacity, canAddView: true, isCustom: layer.isCustom ?? true,
            isDuplicate: layer.isDuplicate,
        }, vectorMapLayerAdapter);
        /** Check that asynchronous restoration still owns this map layer. @return {boolean} */
        const stillRetained = () => isCurrent() && mapLayerController.getRecord(key) === record;
        try {
            await vectorMapLayerAdapter.restoreCalculatedFields(record, layer.calculatedFields);
            if (!stillRetained()) return null;
            await vectorMapLayerAdapter.applyStyle(record, layer.style.definition);
            if (!stillRetained()) return null;
            if (layer.filter) await vectorMapLayerAdapter.applyFilterState(record, layer.filter);
            if (!stillRetained()) return null;
            mapLayerController.setVisible(key, layer.visible);
            return key;
        } catch (error) {
            if (!stillRetained()) return null;
            if (mapLayerController.getRecord(key) === record) mapLayerController.removeKey(key);
            throw error;
        } finally {
            if (!isCurrent() && mapLayerController.getRecord(key) === record) mapLayerController.removeKey(key);
        }
    }
    /** Remove every view of a deleted upload and forget its map-removal Undo.
     * Accepted Processing jobs keep their server-owned source until they finish.
     * @param {string} uploadId Upload successfully deleted by the server.
     * @return {void}
     */
    function removeDeletedUpload(uploadId) {
        mapLayerController.forgetUnavailableRemoval(snapshot => snapshot.local?.kind === "uploaded-vector" && snapshot.local.upload.id === uploadId ||
            snapshot.local?.kind === "uploaded-raster" && snapshot.local.uploadId === uploadId);
        for (const key of getUploadedLayerKeys(uploadId)) mapLayerController.removeKey(key);
    }
    let uploadsDialog = null;
    if (!isSharedViewer) {
        uploadsDialog = new UploadsDialog({
            document, appTitle: appGlobalConfiguration.appTitle,
            addToMap: async upload => {
                if (getUploadedLayerKeys(upload.id).length) return;
                if (upload.kind === "raster") await addUploadedRaster(await getRasterUpload(upload.id));
                else await addUploadedVector(await getUpload(upload.id));
            },
            isOnMap: id => getUploadedLayerKeys(id).length > 0,
            removeFromMap: id => { for (const key of getUploadedLayerKeys(id)) mapLayerController.removeKey(key); },
            onDeleted: removeDeletedUpload,
        });
        void uploadsDialog.refreshUsage();
    }
    /** List every retained polygon view with an identity independent of its name and visibility.
     * @param {boolean} [withCounts=false] Include the human-readable counts shown by the polygon picker.
     * @return {Object[]} Current source, filter, committed polygons and known whole-layer count.
     */
    function spatialPolygonLayers(withCounts = false) {
        return getSamplingPolygonTargets().map(layer => {
            const record = mapLayerController.getRecord(layer.key);
            const id = record.filterViewId ??= (layer.key.startsWith("local:annotation:")
                ? layer.key.slice("local:annotation:".length) : crypto.randomUUID());
            if (!withCounts) return {...layer, id};
            const status = record.adapter.describeFilter?.(record).status;
            const total = layer.polygons?.length;
            const description = status || (total === undefined ? "" : `${filterAnnotationPolygons(layer.polygons, layer.filter).length} of ${total} polygons`);
            return {...layer, id, count: description};
        });
    }
    const spatialViews = new SpatialFilterViews({layers: spatialPolygonLayers, drawingGeometry: annotationSummaryPolygons,
        refresh: () => refreshSpatialFilters(), upload: polygons => processingApi.uploadPolygonArea(polygons), discard: id => processingApi.discardPolygonArea(id)});
    const drawingFilterAttempts = new Map();
    /** Apply field and spatial conditions to committed drawings without disturbing the editing draft.
     * @param {string} key Drawing view to filter.
     * @param {Object} candidate Rule builder state.
     * @param {()=>boolean} [current] Whether a source change that triggered this refresh is still current.
     * @return {Promise<Object|null>} Applied rules, or null after replacement or removal.
     * @throws {Error} If the polygon source cannot be read.
     */
    async function applyDrawingFilter(key, candidate, current) {
        const attempt = Symbol();
        drawingFilterAttempts.set(key, attempt);
        const layers = spatialPolygonLayers();
        const target = layers.find(view => view.key === key);
        if (!target) return null;
        const captured = await spatialViews.bind(key, candidate, layers);
        const spatial = captured.enabled && captured.rules.some(rule => rule.operator === "intersects");
        if (spatial) {
            const original = await spatialViews.drawing(target, EMPTY_VECTOR_FILTER);
            const properties = target.polygons.map(({name, note}) => ({name, note}));
            const positions = await applySpatialFilter("drawings", {target: original, filter: captured, properties});
            captured.matchingIds = positions.map(index => target.polygons[index].id);
        }
        const editor = annotations.filterTarget(key);
        if (!editor || drawingFilterAttempts.get(key) !== attempt || (current && !current())) return null;
        if (spatial && !current) spatialViews.trackSources(key, captured, layers);
        editor.apply(captured);
        return captured;
    }
    let modelFilterControls = null;
    /** @type {symbol} Distinguish explicit statistics-area edits from passive map-filter updates. */
    const statisticsAreaFilterIntent = Symbol("statistics-area-filter");
    vectorFilterControls = new VectorFilterControls({
        inspection: mapInspection,
        getPolygonLayers: key => spatialPolygonLayers(true).filter(layer => layer.key !== key)
            .map(({id, label, count}) => ({id, label, count})),
        drawPolygon: () => new Promise(resolve => annotations.drawPrivatePolygon(key =>
            resolve(key ? spatialPolygonLayers().find(layer => layer.key === key)?.id ?? null : null))),
        onZoom: ([west, south, east, north]) => leafletMap.fitBounds(
            L.latLngBounds([[south, west], [north, east]]).pad(0.15), {padding: [24, 24], maxZoom: 14}),
        getTarget: (key) => {
            const annotation = annotations?.filterTarget(key);
            const record = mapLayerController.getRecord(key);
            if (annotation) return {...annotation,
                filter: record?.requestedSpatialFilter ?? annotation.filter,
                status: record?.spatialFilterError ?? annotation.status,
                cancelPending: () => drawingFilterAttempts.delete(key),
                apply: candidate => {
                    if (record) {
                        delete record.requestedSpatialFilter;
                        delete record.spatialFilterError;
                    }
                    return applyDrawingFilter(key, candidate);
                }};
            if (record === null || record.adapter !== vectorMapLayerAdapter) return null;
            return {
                key, label: record.entry.label,
                fields: record.adapter.describeSource(record).fields,
                source: record.adapter.describeSource(record).selection ?? record.adapter.describeSource(record).source,
                ...record.adapter.describeFilter(record),
                ...(record.requestedSpatialFilter ? {filter: record.requestedSpatialFilter} : {}),
                /** Commit the map view's filter while retaining any captured statistics polygons.
                 * @param {Object} candidate Complete field conditions.
                 * @param {unknown} context Opaque caller context; statistics-area edits commit their own explicit intent.
                 * @return {Promise<Object|null>} Accepted rules, or null when superseded.
                 * @throws {Error} If the vector owner cannot apply these conditions.
                 */
                apply: async (candidate, context) => {
                    const release = context === statisticsAreaFilterIntent ? null : rasterSeries.preserveCapturedVectorArea();
                    const attempt = Symbol();
                    record.filterEdit = attempt;
                    try {
                        const filter = candidate.rules.some(rule => rule.operator === "intersects") ? await spatialViews.bind(key, candidate) : candidate;
                        if (record.filterEdit !== attempt || mapLayerController.getRecord(key) !== record) return null;
                        delete record.requestedSpatialFilter;
                        delete record.spatialFilterError;
                        return await record.adapter.applyFilterState(record, filter);
                    }
                    finally { release?.(); }
                },
                cancelPending: () => {
                    delete record.filterEdit;
                    record.adapter.cancelPendingFilter(record);
                },
            };
        },
    });
    leafletMap.on("movestart", () => vectorFilterControls.cancelZoom("Map moved. Zoom again to find filtered features."));
    mapLayerController.onFilter = key => vectorFilterControls.open(key);
    const vectorSamplingOverlay = new VectorSelectionOverlay(leafletMap, L);
    /** Share the active polygon's display outline with the single-raster thumbnail.
     * @param {Object} area Prepared selection with optional geographic bounds.
     * @return {Promise<void>} The available display geometry has been delivered.
     */
    const showSamplingOutline = async area => {
        resultLocator.setPolygon(area);
        const geometry = await vectorSamplingOverlay.load(area);
        if (geometry) resultLocator.setPolygon(area, geometry);
    };
    /** Read polygon choices for Models, histogram and summary controls.
     * Visibility and WMS publication do not determine numerical selection.
     * @return {Array<{key:string,label:string,sourceOrigin:"catalog"|"upload"|"runArtifact",item:import("./vector/sampling.js").VectorSamplingSource,
     * fields:import("./vector/map-layer-adapter.js").VectorSourceDescription["fields"],
     * filter:ReturnType<typeof import("./vector/filter.js").normalizeVectorFilter>}>}
     * Retained source identities, immutable fields and applied filter snapshots.
     */
    const getPolygonTargets = () => mapLayerController.retainedRecords
        .filter(record => record.adapter === vectorMapLayerAdapter)
        .flatMap(record => {
            const source = record.adapter.describeSource(record);
            return source.geometryKind === "polygon" ? [{
                key: record.entry.key, label: record.entry.label, sourceOrigin: source.origin,
                item: source.source.kind === "runArtifact" ? source.selection : source.source,
                fields: source.fields, scalarFields: source.scalarFields, numericFields: source.numericFields,
                selection: source.selection, filter: record.adapter.exportFilterState(record),
            }] : [];
        });
    /** List retained source layers and committed drawings for the polygon pickers.
     * @return {Object[]} Independent vector descriptors and drawing snapshots.
     */
    const getSamplingPolygonTargets = () => [...getPolygonTargets(), ...(annotations?.summaryTargets() ?? [])];
    /** Prepare an original vector selection or upload the matching saved drawing geometry.
     * @param {import("./vector/sampling.js").VectorSamplingSource|null} item Original vector identity, or null for a drawing.
     * @param {Object} filter Applied field conditions.
     * @param {AbortSignal} signal Cancellation of a superseded vector read.
     * @param {Object} target Committed layer snapshot.
     * @return {Promise<Object>} Area descriptor or private reference and feature counts.
     * @throws {Error} If preparation fails or no drawing polygons match the filter.
     */
    const createPolygonSamplingArea = async (item, filter, signal, target) => {
        if (item) return createVectorSamplingArea(item, filter, signal);
        const polygons = annotationSummaryPolygons(target.polygons, filter);
        if (!polygons.length) throw new Error("No polygons match this filter. Add a polygon or change the conditions.");
        // Let the upload reply settle so the owner can release a superseded reference.
        const area = await processingApi.uploadPolygonArea(polygons);
        if (!signal.aborted) resultLocator.setPolygon(area, {type: "GeometryCollection", geometries: polygons});
        return { ...area, label: target.label, total: target.polygons.length, filter };
    };
    /** Release the private reference owned by a superseded picker selection.
     * @param {Object} area Prepared polygon area.
     * @return {void}
     */
    const releasePolygonSamplingArea = area => {
        if (area.polygonArea) void processingApi.discardPolygonArea(area.polygonArea.id).catch(() => {});
    };
    models = new ModelsController({
        api: processingApi, jobs: processingJobs, view: new ModelsView(document), storage: browserSessionStorage(),
        getCatalogItem: (source, signal) => catalogItemClient.get({collection: source.collectionId, id: source.itemId}, signal),
        loadTemporalTimes,
        showOutput: (job, file) => outputLayers.show(job, file),
        outputState: (jobId, artifactId, file) => outputLayers.state(jobId, artifactId, file),
        /** Capture run displays before their source access is revoked.
         * @param {string} id Model run identity.
         * @return {Object[]} Existing map-layer restoration snapshots in display order.
         * @throws {Error} If an owner cannot capture its layer for restoration.
         */
        captureRunLayers: id => mapLayerController.snapshots().filter(layer => layer.group?.id === id)
            .map(layer => mapLayerController.captureLayerSnapshot(layer.key)),
        /** Restore deleted-run displays with the ordinary layer restoration path.
         * @param {Object[]} snapshots Presentations captured before run deletion.
         * @param {()=>boolean} isCurrent Whether the restored run remains available.
         * @return {Promise<void>} Completion after attempting every captured layer.
         * @throws {Error} If any layer cannot be restored; successful restores remain visible.
         */
        restoreRunLayers: async (snapshots, isCurrent) => {
            const errors = [];
            for (const snapshot of snapshots) {
                if (!isCurrent()) break;
                try { await mapLayerController.restoreLayerSnapshot(snapshot, isCurrent); }
                catch (error) { errors.push(error.message); }
            }
            if (errors.length) throw new Error(errors.join(" "));
        },
        onRunChange: job => {
            outputLayers.updateRun(job);
            if (job.status === "deleted") mapLayerController.forgetUnavailableRemoval(snapshot => snapshot.local?.jobId === job.jobId);
        },
        /** Supply original-source choices and current map areas independently of rendering.
         * @param {Object} [options] Additional input choices requested by model setup.
         * @param {boolean} [options.includeDrawnPolygons=false] Include detached, filtered snapshots of committed polygon layers.
         * @return {Object} Original raster and vector choices, polygon groups, drawings, area and map bounds.
         */
        getContext: ({includeDrawnPolygons = false} = {}) => {
            const viewport = leafletMap.getBounds();
            const layers = mapLayerController.snapshots();
            return {
                rasters: layers.filter(layer => layer.capabilities?.modelInput)
                    .map(layer => ({...describeCalculationSource(layer.source, layer.label), visible: layer.visible})),
                temporalDatasets: temporalDatasets(layers),
                vectors: getPolygonTargets().map(target => ({...target.item, key: target.key, label: target.label, sourceOrigin: target.sourceOrigin, filter: target.filter, fields: target.fields,
                    scalarFields: target.scalarFields, numericFields: target.numericFields,
                    selection: {...target.selection, filter: target.filter}, allSelection: {...target.selection, filter: EMPTY_VECTOR_FILTER}})),
                polygonGroups: polygonGroups?.snapshot() ?? [],
                drawnPolygonLayers: includeDrawnPolygons ? (annotations?.summaryTargets() ?? []).map(target => ({
                    key: target.key, label: target.label, total: target.polygons.length,
                    polygons: annotationSummaryPolygons(target.polygons, target.filter),
                })) : [],
                area: modelArea, areaDescription: modelAreaDescription,
                viewportBounds: {west: viewport.getWest(), south: viewport.getSouth(), east: viewport.getEast(), north: viewport.getNorth()},
            };
        },
        /** Read selected features without requiring a display layer.
         * @param {import("./vector/sampling.js").VectorSamplingSource & {filter:Object}} source Original vector identity and captured filter.
         * @param {AbortSignal} signal Cancellation of an obsolete setup selection.
         * @return {Promise<Object>} Selection descriptor and matched/total feature counts.
         */
        prepareVector: (source, signal) => createVectorSamplingArea(
            source, source.filter ?? EMPTY_VECTOR_FILTER, signal),
        /** Open the existing rule editor inside setup using the chosen map layer's fields.
         * @param {Object} request Inline host, source, predicate and model-owned callbacks.
         * @return {void}
         */
        editVectorFilter: request => {
            modelFilterControls?.destroy();
            const target = {key: request.key, label: request.source.label, source: request.source,
                fields: request.source.fields ?? [], filter: request.filter};
            modelFilterControls = new VectorFilterControls({host: request.host, inspection: mapInspection,
                getPolygonLayers: key => spatialPolygonLayers(true).filter(layer => layer.key !== key)
                    .map(({id, label, count}) => ({id, label, count})),
                getTarget: key => key === target.key && request.isCurrent() ? target : null});
            modelFilterControls.open(request.key, {filter: request.filter, apply: async candidate => request.apply(await spatialViews.bind(request.key, candidate)), complete: request.complete, cancel: request.cancel,
                applyLabel: "Apply filter", filterLabel: "Selected features", onClose: request.close,
                help: "Change the filter for this map item and every tool input using it. Create a copy to use a different filter.",
            });
        },
        closeVectorFilter: () => modelFilterControls?.close(),
        /** Store a checked selection's filter on its map view, then update rendering.
         * Models receives the shared filter immediately and reports display failures separately.
         * @param {Object} source Vector choice with its Map contents key.
         * @param {Object} area Checked source/predicate and matched/total feature counts.
         * @return {Promise<Object|null>} Applied filter, or null when superseded.
         * @throws {Error} If the layer was removed or its map filter cannot be applied.
         */
        applyMapFilter: (source, area) => {
            const record = mapLayerController.getRecord(source.key);
            if (!record || record.adapter !== vectorMapLayerAdapter) throw new Error("The vector dataset is no longer in Map contents.");
            return record.adapter.applyCheckedFilter(record, area.selection.filter,
                {matched: area.matched, total: area.total, complete: true});
        },
        onOpen: () => mapInspection.showModels(),
        onViewLabel: label => mapInspection.setToolContext("models", { source: label, scope: "" }),
        onClose: () => { mapInspection.hideModels(); leafletMap.getContainer().focus(); },
    });
    if (!isSharedViewer && editableMapSlug === null) {
        polygonGroups = new MapPolygonGroups(document.querySelector("#map-polygon-groups"), {
            storage: new SavedMapViewLocalStorage(undefined, "eolab.polygon-groups.v1"),
            onChange: () => models.refreshMapLayers(),
        });
        polygonGroups.updateLayers(getPolygonTargets().map(({key, label}) => ({key, label})));
    }
    mapInspection.subscribeActiveTool(tool => models.setActive(tool === "models"));
    models.start();
    mapLayerController.onGroupAction = async id => {
        models.open();
        await models.showRun(id);
        if (models.state.selectedRun === id) models.requestRunDeletion();
    };
    leafletMap.on("moveend resize", () => models.refreshMapArea());
    refreshSpatialFilters = () => {
        const targets = mapLayerController.retainedRecords.flatMap(record => {
            const key = record.entry.key;
            const drawing = annotations?.filterTarget(key);
            if (!drawing && record.adapter !== vectorMapLayerAdapter) return [];
            const filter = record.requestedSpatialFilter ?? drawing?.filter ?? record.adapter.exportFilterState(record);
            return [{key, filter, update: async (requested, current) => {
                try {
                    if (drawing) {
                        delete record.spatialFilterError;
                        await applyDrawingFilter(key, requested, current);
                    } else {
                        const captured = await spatialViews.bind(key, requested);
                        if (!current() || !mapLayerController.getRecord(key)) return;
                        if (!record.spatialFilterError && JSON.stringify(record.adapter.exportFilterState(record)) === JSON.stringify(captured)) return;
                        delete record.spatialFilterError;
                        await record.adapter.applyFilterState(record, captured);
                    }
                    if (current()) delete record.requestedSpatialFilter;
                } catch (error) {
                    if (!current() || !mapLayerController.getRecord(key)) return;
                    record.requestedSpatialFilter = viewFilter(requested);
                    record.spatialFilterError = error.message;
                    const empty = waitingForPolygonLayer(requested);
                    if (drawing) drawing.apply(empty);
                    else await record.adapter.applyFilterState(record, empty).catch(() => {
                        if (current()) record.adapter.hideUnavailableFilter(record, empty);
                    });
                }
            }}];
        });
        spatialViews.follow(targets);
    };
    vectorSampling = new VectorSamplingController({
        view: new VectorSamplingView(document, {
            polygonAreaHelp: "For calculations, choose this layer in Raster statistics. For clips, choose a sampling box or a Catalog or uploaded polygon layer.",
        }),
        getTargets: getSamplingPolygonTargets,
        createArea: createPolygonSamplingArea,
        releaseArea: releasePolygonSamplingArea,
        onEditFilter: key => vectorFilterControls.open(key),
        onSelectionState: selection => {
            if (selection.phase !== "reading" || vectorSampling?.getSelectedTarget()?.item) {
                rasterSeries.setVectorSelectionState({...selection, explicit: false}, "map");
            }
        },
        /** Adopt filtered polygons through the interactive histogram lifecycle.
         * @param {Object} area Authoritative vector descriptor or private polygon reference and selection metadata.
         * @return {void}
         */
        onActivate: area => {
            if (area.selection) void showSamplingOutline(area);
            const label = `${area.label} · ${area.matched} of ${area.total} features`;
            rasterVisualization.setVectorSelection({ ...area, label });
        },
        onInvalidate: selection => {
            if (selection) {
                vectorSamplingOverlay.clear();
                modelArea = null; modelAreaDescription = "";
                models.refreshMapArea();
            }
            rasterVisualization.setVectorSelection(null);
            if (selection) rasterSeries.invalidateArea({kind: "catalogSelection", catalogSelection: selection}, "map");
        },
    });
    summarySampling = new VectorSamplingController({
        view: new VectorSamplingView(document, { root: "#raster-series-vector-area" }),
        getTargets: getSamplingPolygonTargets,
        createArea: createPolygonSamplingArea,
        releaseArea: releasePolygonSamplingArea,
        onEditFilter: key => vectorFilterControls.open(key, null, {
            // Editing the statistics area's filter is an explicit new area choice.
            // Map-origin edits keep the existing background calculation untouched.
            applyContext: statisticsAreaFilterIntent,
            onApplied: () => rasterSeries.chooseArea("vector"),
        }),
        onSelectionState: selection => rasterSeries.setVectorSelectionState(selection),
        onActivate: area => {
            const label = `${area.label} · ${area.matched} of ${area.total} features`;
            if (area.selection) void showSamplingOutline(area);
            else vectorSamplingOverlay.clear();
            updateRasterSeriesArea(area.polygonArea ? {kind: "polygonArea", polygonArea: area.polygonArea}
                : {kind: "catalogSelection", catalogSelection: area.selection}, label);
            rasterSeries.setVectorSamplingArea({ selection: area.selection, polygonArea: area.polygonArea, label });
        },
        onInvalidate: (selection, area) => {
            rasterSeries.invalidateArea(area.polygonArea ? {kind: "polygonArea", polygonArea: area.polygonArea}
                : {kind: "catalogSelection", catalogSelection: selection});
        },
    });
    const vectorStyleControls = new VectorStyleControls();
    layerStyleEditor = new MapLayerStyleEditor({
        mapLayers: mapLayerController, rasterViewer: rasterVisualization,
        inspection: mapInspection,
        vectorStyleControls,
        onFilterRequested: (key) => vectorFilterControls.open(key),
        getVectorStyleTarget: (key) => {
            const preview = outputLayers.layers.get(key);
            if (preview?.kind === "vector" && !preview.ordinary) return {key, style: preview.appearance, fields: [], canFilter: false,
                notice: "Style this result preview. The downloaded file stays unchanged.",
                apply: async style => outputLayers.applyAppearance(key, style)};
            const record = mapLayerController.getRecord(key);
            if (record === null || record.adapter !== vectorMapLayerAdapter) {
                return null;
            }
            return {
                key,
                ...record.adapter.describeStyle(record),
                fields: record.adapter.describeSource(record).fields,
                summarize: (field) =>
                    record.adapter.summarizeCategories(record, field),
                classify: (field, method, classCount) =>
                    record.adapter.classifyNumbers(record, field, method, classCount),
                apply: async (style) => {
                    const applied = await record.adapter.applyStyle(record, style);
                    mapLayerController.render();
                    return applied;
                },
            };
        },
    });
    mapLayerController.onStyle = key => {
        if (!annotations?.openControls(key, "style")) layerStyleEditor.open(key);
        mapInspection.highlightActiveTool();
    };
    rasterVisualization.syncVisibleLayers();
    const catalogVisualization = new CatalogVisualizationCoordinator(
        rasterVisualization,
        mapLayerController,
        vectorMapLayerAdapter
    );
    const catalogItemClient = new SavedMapViewCatalogClient(catalogUrl);
    /** Restore a temporal view with its requested key, position and style.
     * @param {Object} snapshot Removed map-layer snapshot.
     * @param {()=>boolean} isCurrent Whether restoration still belongs to the current action.
     * @return {Promise<void>} Completion after the view is retained.
     * @throws {Error} If its Catalog dataset cannot be retrieved.
     */
    async function restoreRemovedTemporal(snapshot, isCurrent) {
        const layer = snapshot.local.layer;
        const {collectionId, itemId, variable, time} = layer.temporalSource;
        const item = await catalogItemClient.get({collection: collectionId, id: itemId});
        const record = await rasterVisualization.showTemporal(item, {variable, time}, {
            key: snapshot.key, appearance: layer.style, visible: layer.visible,
            opacity: layer.opacity, customName: layer.customName, isCustom: snapshot.isCustom, isCurrent,
        });
        if (record && isCurrent()) mapLayerController.reorder(snapshot.key, Math.min(snapshot.index, mapLayerController.snapshots().length - 1));
    }
    savedMapViewController = new SavedMapViewController({
        view: new SavedMapViewDomView(),
        viewport: createSavedMapLeafletViewport(leafletMap.visibleView),
        mapLayers: mapLayerController,
        catalogVisualization,
        catalogItems: catalogItemClient,
        viewerVersion: appGlobalConfiguration.appVersion,
        viewerOrigin: globalThis.location.origin,
        storage: isSharedViewer || editableMapSlug !== null ? null : new SavedMapViewLocalStorage(),
        restoreSharedMap: isSharedViewer,
        publicationApi: new SavedMapApiClient(),
        namedMapSlug,
        editPublishedMap: editableMapSlug !== null,
        allowPublishing: !isSharedViewer && editableMapSlug === null,
        publicationDefaults: { title: appGlobalConfiguration.appTitle, subtitle: "" },
        applyMapHeading,
        applyVisitorControls: settings => {
            visitorAvailability = resolveVisitorControls(settings);
            onWorkspaceOptionsChange({
                allowCatalog: visitorAvailability.catalog,
                allowMapContents: visitorAvailability.mapContents,
                initialState: visitorInitialPanels(settings),
            });
            const { rasterValues, histogramBox } = visitorAvailability;
            rasterVisualization.setMapInspectionAvailability({ rasterValues, histogramBox });
            rasterSeries.setMapSamplingBoxAvailable(histogramBox);
            mapInteractionTools?.setAvailability(visitorAvailability);
        },
        basemap: basemapControl,
        mapLegend,
        initialViewport: {
            center: {
                latitude: appGlobalConfiguration.initialView.latitude,
                longitude: appGlobalConfiguration.initialView.longitude,
            },
            zoom: appGlobalConfiguration.initialView.zoom,
        },
        /** Clear replaceable map views after their source owners finish startup.
         * @param {()=>boolean} isCurrent Whether this map restoration is still active.
         * @return {Promise<void>} Completion after current-view cleanup, or supersession.
         */
        beforeRestore: async isCurrent => {
            await annotationsReady;
            await annotations.prepareDrawingMapRestore(isCurrent);
            if (!isCurrent()) return;
            clearCatalogSelection();
            for (const layer of mapLayerController.snapshots()) {
                if (layer.source?.kind === "uploadedRaster") mapLayerController.removeKey(layer.key);
            }
            for (const record of mapLayerController.retainedRecords) {
                if (record.adapter === vectorMapLayerAdapter && record.entry.item === null) {
                    mapLayerController.removeKey(record.entry.key);
                }
            }
        },
        exportUpload: record => {
            const raster = mapLayerController.snapshots().find(layer => layer.key === record.entry.key)?.source;
            if (raster?.kind === "uploadedRaster") return {
                uploadId: raster.uploadId, visible: record.entry.visible, opacity: record.entry.opacity,
                ...(record.entry.customName ? {customName: record.entry.customName} : {}),
                style: record.adapter.exportSavedState(record),
            };
            if (record.adapter !== vectorMapLayerAdapter || record.entry.item !== null) return null;
            if (!record.adapter.describeSource(record).source.uploadId) return null;
            return {
                uploadId: record.adapter.describeSource(record).source.uploadId,
                ...(record.isDuplicate ? {isDuplicate: true} : {}),
                visible: record.entry.visible, opacity: record.entry.opacity,
                customName: record.entry.customName ?? [...record.entry.label].slice(0, 160).join(""),
                style: record.adapter.exportSavedState(record),
                filter: record.adapter.exportFilterState(record),
                calculatedFields: record.adapter.exportCalculatedFields(record),
            };
        },
        restoreUpload: restoreSavedUpload,
        exportArtifact: record => {
            if (record.adapter !== vectorMapLayerAdapter) return null;
            const source = record.adapter.describeSource(record);
            if (source.source.kind !== "runArtifact") return null;
            const {jobId, artifactId} = source.source;
            return {runArtifact: {jobId, artifactId, layerName: source.selection.layerName},
                visible: record.entry.visible, opacity: record.entry.opacity,
                customName: record.entry.customName ?? [...record.entry.label].slice(0, 160).join(""),
                style: record.adapter.exportSavedState(record), filter: record.adapter.exportFilterState(record),
                calculatedFields: record.adapter.exportCalculatedFields(record)};
        },
        restoreArtifact: async (layer, isCurrent) => {
            const key = `local:view:${globalThis.crypto.randomUUID()}`;
            await outputLayers.restore({...layer, key, local: {kind: "model-output-preview", ...layer.runArtifact,
                appearance: layer.style, filter: layer.filter, calculatedFields: layer.calculatedFields}}, isCurrent);
            return isCurrent() && mapLayerController.getRecord(key) ? key : null;
        },
        exportTemporal: record => rasterVisualization.exportTemporal(record),
        restoreTemporal: async (layer, isCurrent) => {
            const {collectionId, itemId} = layer.temporalSource;
            const item = await catalogItemClient.get({collection: collectionId, id: itemId});
            return rasterVisualization.restoreTemporal(layer, item, isCurrent);
        },
        exportAnnotation: record => {
            if (record.adapter === vectorMapLayerAdapter) return null;
            if (outputLayers.ownsLayer(record.entry.key)) return null;
            const sharedAnnotation = annotationSessions?.getMapReference(record.state.id);
            if (!sharedAnnotation) return null;
            const { outline, weight, fillOpacity, labels } = record.adapter.exportSavedState(record).style;
            return { sharedAnnotation, visible: record.entry.visible, opacity: record.entry.opacity,
                appearance: { outline, weight, fillOpacity, labels } };
        },
        restoreAnnotation: async (layer, isCurrent) => {
            const id = await annotationSessions.openMapReference(layer.sharedAnnotation, isCurrent);
            return id && isCurrent() ? annotations.restoreMapAppearance(id, layer) : null;
        },
        exportDrawing: record => annotations?.exportDrawingLayer(record.entry.key) ?? null,
        stageDrawing: (layer, isCurrent) => annotations.stageDrawingLayer(layer, isCurrent),
    });
    if (!isSharedViewer) {
        planning = new PlanningController({
            api: new PlanningApiClient(),
            view: new PlanningView(document),
            /** List custom Catalog polygons and local drawings through their source owners.
             * @return {Object[]} Detached choices from the current ordinary map views.
             */
            getLayerChoices: () => [...mapLayerController.retainedRecords.flatMap(record => {
                if (!record.entry.isCustom || record.adapter !== vectorMapLayerAdapter) return [];
                const source = record.adapter.describeSource(record);
                if (source.origin !== "catalog" || source.geometryKind !== "polygon") return [];
                const calculated = new Set(record.adapter.exportCalculatedFields(record).map(field => field.name));
                const filter = record.adapter.exportFilterState(record);
                return [{
                    key: record.entry.key, label: record.entry.label,
                    source: {collectionId: source.source.collectionId, itemId: source.source.itemId},
                    idFields: source.fields.filter(field => !calculated.has(field.name)
                        && ["str", "string", "int", "int16", "int32", "int64"].includes(field.type.toLowerCase().split(":")[0])),
                    filterSummary: vectorFilterSummary(filter ?? EMPTY_VECTOR_FILTER),
                }];
            }), ...(annotations?.drawingLayers() ?? []).map(layer => ({
                key: layer.key, label: layer.label,
                source: {localLayerId: layer.localLayerId, ...(layer.drawingLayerId ? {drawingLayerId: layer.drawingLayerId} : {})},
                builtInId: "id", idFields: [{name: "id", type: "str"}], featureCount: layer.polygonCount,
                filterSummary: vectorFilterSummary(layer.filter),
            }))],
            /** Persist drawings before a tool retains their reusable source references.
             * @param {string[]} keys Selected live map layers.
             * @return {Promise<void>} Completion after every selected drawing's committed edits are saved.
             */
            prepareLayers: async keys => {
                const drawings = new Set((annotations?.drawingLayers() ?? []).map(layer => layer.key));
                for (const key of keys) if (drawings.has(key)) await annotations.ensureDrawingSource(key);
            },
            exportLayer: key => savedMapViewController.exportLayer(key),
            /** Restore each durable view once, then bind it to its fresh map key.
             * @param {Object[]} layers Saved view IDs and ordinary layer definitions.
             * @param {()=>boolean} isCurrent Whether this tool is still being opened.
             * @return {Promise<Object[]>} View IDs paired with restored keys or failures.
             */
            restoreLayers: async (layers, isCurrent) => {
                await annotationsReady;
                const restored = await savedMapViewController.restoreLayers(layers.map(layer => layer.definition), isCurrent);
                return restored.map((result, index) => ({id: layers[index].id, ...result}));
            },
            editLayerFilter: key => vectorFilterControls.open(key),
            onOpen: () => mapInspection.showPlanning(),
            onClose: () => { mapInspection.hidePlanning(); leafletMap.getContainer().focus(); },
        });
        mapInspection.subscribeActiveTool(tool => planning.setActive(tool === "planning"));
    } else document.querySelector("#open-planning").hidden = true;
    leafletMap.on("moveend", () =>
        savedMapViewController?.scheduleRemember()
    );
    leafletMap.on("basemapchange", () => savedMapViewController?.scheduleRemember());
    rasterSeries.setArea(rasterSeriesArea, rasterSeriesAreaLabel);
    void rasterSeries.start();
    rasterSeries.updateAvailableRasters(mapLayerController.snapshots().filter(layer => layer.capabilities?.calculations),
        temporalDatasets(mapLayerController.snapshots()));
    mapInspection.subscribeActiveTool(tool => rasterSeries.updateSamplingForPanelVisibility(tool === "raster-series"));
    for (const id of ["open-raster-series", "open-raster-series-dock"]) {
        document.querySelector(`#${id}`).addEventListener("click",
            /** Reopen the combined raster summary with its retained inputs and results.
             * @return {void}
             */
            () => {
                mapInspection.showRasterSeries();
            });
    }
    const vectorTimeSeries = new VectorTimeSeriesController({
        describeStatisticsSource: describeVectorStatisticsSource,
        onOpenFeature: index => {
            if (index !== null) vectorFeatureInspector.showResult(index);
            openFeaturePlot();
        },
        onVisibilityChange: (visible, moveFocus) => {
            if (visible) mapInspection.showVectorTimeSeries();
            else mapInspection.hideVectorTimeSeries(moveFocus);
        },
        onPresentationChange: (identity) =>
            mapInspection.setVectorTimeSeriesIdentity(identity),
        /**
         * Highlight the original inspection result and fit its geographic bounds.
         * @param {import("./vector/inspection-observation.js").VectorInspectionObservation["focus"]} focus
         * Map focus from the inspected feature.
         * @param {number} index Position in the inspector sample used by the plot.
         * @return {boolean} Whether the map could fit the feature.
         */
        onFeatureZoom: (focus, index) => {
            vectorFeatureInspector.showResult(index);
            return zoomInspectedVectorFeature(focus);
        },
        onNavigateSelection: direction => vectorFeatureInspector.navigateSelection(direction),
    });
    const vectorFeatureProfile = new VectorFeatureProfileController({
        describeStatisticsSource: describeVectorStatisticsSource,
        onCompareFeatures: openFeatureComparison,
        onSelectFeature: index => vectorFeatureInspector.showResult(index),
        onVisibilityChange: (visible, moveFocus) => {
            if (visible) mapInspection.showVectorFeatureProfile();
            else mapInspection.hideVectorFeatureProfile(moveFocus);
        },
        onPresentationChange: (identity) =>
            mapInspection.setVectorFeatureProfileIdentity(identity),
        onNavigateFeature: (direction) =>
            vectorFeatureInspector?.navigateResult(direction),
        onFeatureZoom: zoomInspectedVectorFeature,
    });
    /** Show the inspector's current feature and keep following its navigation. @return {void} */
    function openFeaturePlot() {
        vectorTimeSeries.close();
        vectorFeatureProfile.open();
    }
    /** Show the returned features together using the current comparison choices. @return {void} */
    function openFeatureComparison() {
        vectorFeatureProfile.close();
        vectorTimeSeries.open();
    }
    /**
     * Find the original layer and numeric fields behind an inspected vector view.
     * @param {string} sourceId Retained vector view identity from an observation.
     * @return {ReturnType<import("./vector/plot-statistics.js").DescribeStatisticsSource>} Path-free source and fields, or null.
     */
    function describeVectorStatisticsSource(sourceId) {
        const record = mapLayerController.getRecord(sourceId);
        if (record?.adapter !== vectorMapLayerAdapter) return null;
        const { selection, numericFields } = record.adapter.describeSource(record);
        return selection ? { selection, fields: numericFields } : null;
    }
    /**
     * Supply the same top-first published vector targets to click and hover queries.
     * @return {import("./vector/feature-info.js").VectorFeatureInspectionTarget[]} Visible targets.
     */
    function visibleVectorInspectionTargets() {
        return mapLayerController.retainedRecords
            .filter((record) =>
                record.entry.visible && record.adapter === vectorMapLayerAdapter && record.adapter.renderingAvailable(record)
            )
            .map((record) => {
                const source = record.adapter.describeSource(record);
                return {
                    sourceId: record.entry.key,
                    label: record.entry.label,
                    opacity: record.entry.opacity,
                    bbox: [...record.publication.bbox],
                    publication: {
                        layerName: record.publication.layerName,
                        styleName: record.publication.styleName,
                        style: record.publication.style,
                        calculatedFields: record.adapter.exportCalculatedFields(record),
                    },
                    geometryKind: source.geometryKind,
                    propertyNames: source.fields.map(({ name }) => name),
                    primaryGeometry: source.primaryGeometry,
                };
            });
    }
    /** Return retained original vector views for selection, including hidden layers.
     * @return {import("./vector/feature-inspector.js").VectorSelectionTarget[]} Path-free sources and applied predicates.
     */
    function retainedVectorInspectionTargets() {
        return mapLayerController.retainedRecords.flatMap(record => {
            if (record.adapter !== vectorMapLayerAdapter) return [];
            const source = record.adapter.describeSource(record);
            return source.selection ? [{key: record.entry.key, label: record.entry.label,
                selection: {...source.selection, filter: record.adapter.exportFilterState(record)}}] : [];
        });
    }
    /**
     * Provide a retained vector view's fields and remember inspector formats, including for hidden views.
     * @param {string} key Opaque identity of the inspected map layer view.
     * @return {import("./vector/feature-field-display.js").FeatureFieldDisplay|null} Settings for a current vector view.
     */
    function describeFeatureFieldDisplay(key) {
        const record = mapLayerController.getRecord(key);
        if (record?.adapter !== vectorMapLayerAdapter) return null;
        const source = record.adapter.describeSource(record);
        const fields = source.fields.map(({name}) => name);
        const numericFields = source.numericFields.map(({name}) => name);
        const fieldNames = new Set(fields);
        const formats = Object.fromEntries(Object.entries(record.fieldFormats ?? {})
            .filter(([field]) => fieldNames.has(field)));
        return {fields, numericFields, formats, apply: fieldFormats => {
            if (mapLayerController.getRecord(key) !== record) return false;
            const currentFields = new Set(record.adapter.describeSource(record).fields.map(({name}) => name));
            if (Object.keys(fieldFormats).some(field => !currentFields.has(field))) return false;
            record.fieldFormats = fieldFormats;
            savedMapViewController.scheduleRemember();
            return true;
        }};
    }
    vectorFeatureInspector = new VectorFeatureInspectorController({
        leaflet: L,
        leafletMap,
        getVisibleTargets: () => visibleVectorInspectionTargets(),
        getSelectionTargets: retainedVectorInspectionTargets,
        onSelectionDisplayChange: display => mapInteractionTools?.setSelectionDisplay(display),
        getFieldDisplay: describeFeatureFieldDisplay,
        wmsUrl: appGlobalConfiguration.wmsUrl,
        onInspectionChange: (visible) => {
            if (visible) mapInspection.showFeatureInspector({ activate: false });
            else {
                mapInspection.hideFeatureInspector();
            }
        },
        onSampleChange: (sample) => {
            vectorTimeSeries.setSample(sample);
            vectorFeatureProfile.setFeatureChoices(sample.observations);
            const returned = sample.observations.length;
            const featureCount = `${returned} feature${returned === 1 ? "" : "s"} returned`;
            const layerCount = new Set(sample.observations.map(observation => observation.sourceId)).size;
            const message = sample.state === "loading"
                ? sample.message
                : sample.state === "ready"
                    ? `${featureCount} across ${layerCount} layer${layerCount === 1 ? "" : "s"}` +
                        (sample.failedLayers ? ` · ${sample.failedLayers} layer${sample.failedLayers === 1 ? "" : "s"} unavailable` : " · Ready")
                    : sample.message;
            mapInspection.setClickResult("feature", {
                state: sample.failedLayers && sample.state !== "loading" ? "error" : sample.state,
                message,
                position: sample.position ?? null,
            });
            mapInspection.setFeatureResultCount(sample.observations.length, {loading: sample.state === "loading"});
        },
        onSelectionNavigationChange: navigation => vectorTimeSeries.setSelectionNavigation(navigation),
        onCurrentObservationChange: (observation, navigation) =>
            vectorFeatureProfile.setCurrentObservation(observation, navigation),
        onFeatureProfileRequested: openFeaturePlot,
        onTimeSeriesRequested: openFeatureComparison,
        onStyleRequested: (sourceId) => layerStyleEditor.open(sourceId),
        onFilterRequested: (sourceId) => vectorFilterControls.open(sourceId),
        onFeatureZoomRequested: zoomInspectedVectorFeature,
    });
    /**
     * Dispatch a completed Leaflet map click to the active inspection actions.
     *
     * @param {{latlng:{lng:number,lat:number},containerPoint?:{x:number,y:number}}}
     * event Leaflet map-click shape.
     * @return {void}
     */
    function exploreMap(event) {
        const { rasterValues, featurePicking, histogramBox } = mapPointerActions;
        if (!rasterValues && !featurePicking && !histogramBox) return;
        mapInspection.beginMapClick(event.latlng);
        rasterClickSelected = false;
        selectingMapClick = true;
        try {
            if (rasterValues || histogramBox) {
                const position = { longitude: event.latlng.lng, latitude: event.latlng.lat };
                const validPosition = isCanonicalWgs84Position(position);
                if (visitorAvailability.rasterValues) {
                    pixelPoint = validPosition ? Object.freeze(position) : null;
                    rasterSeries.setPosition(pixelPoint);
                }
                rasterClickSelected = rasterVisualization.exploreAt(event.latlng, {
                    histogram: histogramBox,
                    onSelected: area => {
                        if (area?.kind === "polygonArea") return;
                        updateRasterSeriesArea(area, area?.kind === "catalogSelection" ? "Selected polygons" : ["selectedArea", "samplingBox"].includes(area?.kind) ? "Sampling box" : "Sample area");
                    },
                });
                if (!rasterClickSelected) {
                    mapInspection.closeHistogram(false);
                    if (histogramBox) {
                        const box = validPosition && mapInspection.activeTool === "raster-series" && rasterSeries.usesMapSamplingBox
                            ? rasterVisualization.selectSamplingBox(event.latlng) : null;
                        updateRasterSeriesArea(box, box ? "Sampling box" : "");
                    }
                }
                mapInspection.setClickResult("histogram", rasterClickSelected ? latestHistogramPresentation : null);
            }
            if (featurePicking) {
                void vectorFeatureInspector.inspect(event);
                annotations?.inspectAt(event.latlng);
            }
            mapInspection.keepVisibleClickResultReadable();
        } finally {
            selectingMapClick = false;
        }
    }
    {
        const annotationPanel = new AnnotationPanelView({ document,
            onOpen: () => mapInspection.showAnnotations(),
            onClose: () => { annotations.clearInspection(); mapInspection.hideAnnotations(); } });
        annotations = new AnnotationController({
            sourceApi: new DrawingSourceApi(),
            panel: annotationPanel,
            mapSlug: namedMapSlug?.length <= 80 && MAP_LINK_NAME_PATTERN.test(namedMapSlug) ? namedMapSlug : null,
            leaflet: L,
            map: leafletMap,
            mapLayers: mapLayerController,
            onShare: id => annotationSessions.shareLayer(id),
            onColor: (id, color) => annotationSessions.setContributorColor(id, color),
            onRenameContributor: id => annotationSessions.editContributorName(id),
            requestEditing: id => {
                if (polygonGeometryEditor.key) {
                    mapLayerStackView.setStatus("Finish or cancel the current polygon edit first.");
                    return false;
                }
                return annotationSessions.requestDrawing(id);
            },
            onCommittedChange: () => { annotationSessions?.committedLayersChanged(); refreshSpatialFilters?.(); vectorSampling.refresh(); summarySampling.refresh(); vectorFilterControls.refresh(); savedMapViewController?.scheduleRemember(); },
            onFilter: key => vectorFilterControls.open(key),
            onHoverInvalidated: () => mapFeatureHover?.hide(),
            onEditingChange: editing => {
                drawingEditing = editing;
                setLayerEditingMode(editing);
            },
        });
        annotationSessions = new AnnotationSessionsController({
            document,
            saveLocalLayers: () => annotations.saveForSharing(),
            createLayer: (name, collection, options) => annotations.restoreSharedContribution(name, collection, options),
            revealLayer: id => { onRenderingWorkspaceRequested(); annotations.revealDrawing(id); },
            drawAfterJoining: id => annotations.beginPolygon(id),
            getLayers: () => annotations.sharableLayers(),
            isLayerOnMap: id => annotations.isLayerOnMap(id),
            present: (id, data) => {
                if (annotations.updateSharedLayer(id, data)) { vectorSampling.refresh(); summarySampling.refresh(); vectorFilterControls.refresh(); }
            },
        });
        annotationsReady = annotationSessions.start({ restoreBindings: false, refreshImmediately: false }).then(async () => {
            await annotations.load({ attachSavedLayers: !isSharedViewer && editableMapSlug === null,
                sharedLayerIds: annotationSessions.bookmarkedLayerIds() });
            vectorSampling.refresh();
            summarySampling.refresh();
        });
        const restoringMap = savedMapViewController.restoreStartupView();
        void Promise.all([annotationsReady, restoringMap]).then(() => {
            annotations.restoreLayerOrder({ useSavedPositions: !isSharedViewer && editableMapSlug === null,
                mapOrderedLayerIds: [...annotationSessions.bookmarkedLayerIds(),
                    ...annotations.drawingLayers().filter(layer => layer.drawingLayerId).map(layer => layer.localLayerId)] });
            void annotationSessions.refresh();
        });
        if (isSharedViewer) await restoringMap;
    }
    mapFeatureHover = new MapFeatureHover(leafletMap, {
        enabled: false,
        findLocalText: event => {
            const hit = annotations.polygonsAt(event.latlng)[0];
            return hit ? `${hit.layerName}\n${hit.polygon.name}${hit.polygon.contributor ? ` — ${hit.polygon.contributor}` : ""}` : null;
        },
        findRemoteText: (event, signal) => findVectorLayerAtPointer({
            targets: visibleVectorInspectionTargets().filter(target => target.opacity > 0),
            viewport: getFeatureInfoViewport(leafletMap, event.containerPoint),
            wmsUrl: appGlobalConfiguration.wmsUrl,
            signal,
        }),
    });
    mapInteractionTools = new MapInteractionTools({
        documentContext: document, map: leafletMap, leaflet: L,
        availability: visitorAvailability,
        editing: mapLayerEditing,
        getTargets: retainedVectorInspectionTargets,
        selectFeatures: (target, polygon, signal) => vectorFeatureInspector.inspectLasso(target, polygon, signal),
        onClearSelection: () => vectorFeatureInspector.clearSelection(),
        onActionsChange: actions => {
            mapPointerActions = actions;
            mapFeatureHover.setEnabled(actions.featurePicking);
            vectorFeatureInspector.setPickingEnabled(actions.featurePicking);
            rasterVisualization.setPixelPickingEnabled(actions.rasterValues);
            rasterVisualization.setSamplingBoxPointerEnabled(actions.histogramBox);
            rasterVisualization.setPointerInspectionEnabled(actions.rasterValues || actions.histogramBox);
        },
    });
    leafletMap.on("unload", () => mapInteractionTools.dispose());
    leafletMap.on("click", exploreMap);
    onRasterViewerReady(rasterVisualization, rasterClips);
    /**
     * Render the selected Item's current map-action state in the inspector.
     *
     * @param {Object|null} item Selected Catalog Item.
     * @return {void}
     */
    function updateCatalogMapAction(item) {
        renderCatalogMapAction(catalogMapActionElements, item, catalogMapActions.state(item));
    }

    /**
     * Clear the selected result, analysis session, footprint, and inspector.
     *
     * @return {void}
     */
    function clearCatalogSelection() {
        if (catalogState.selectedItem !== null) {
            rasterVisualization.deactivateAnalysis(
                catalogState.selectedItem
            );
        }
        catalogState.selectedButton?.classList.remove("is-selected");
        catalogState.selectedButton?.setAttribute("aria-pressed", "false");
        footprintController.clear();
        catalogState.selectedButton = null;
        catalogState.selectedItem = null;
        catalogMapActionStatus.textContent = "";
        updateCatalogMapAction(null);
        renderCatalogItemInspector(
            null,
            catalogState.collectionsDocument?.collections ?? [],
            appGlobalConfiguration.scanDisplayPathPrefix
        );
        catalogPaneControls.showResults();
    }

    /**
     * Select one result, show its footprint until details close, and activate
     * analysis when it is a Catalog raster.
     *
     * @param {Object} item Catalog Item selected from results or discovery.
     * @param {HTMLElement|null} [requestedButton=null] Optional matching result
     * button when the Item is already present in the current page.
     * @return {void}
     */
    function selectCatalogItem(item, requestedButton = null) {
        catalogMapActions.applyAssessment(item);
        const itemButton = requestedButton ??
            catalogState.resultViews.get(getCatalogItemKey(item))?.detailsButton ?? null;
        if (catalogState.selectedButton !== null) {
            catalogState.selectedButton.classList.remove("is-selected");
            catalogState.selectedButton.setAttribute("aria-pressed", "false");
        }
        catalogState.selectedButton = itemButton;
        catalogState.selectedItem = item;
        catalogMapActionStatus.textContent = "";
        itemButton?.classList.add("is-selected");
        itemButton?.setAttribute("aria-pressed", "true");
        footprintController.select(item);
        renderCatalogItemInspector(
            item,
            catalogState.collectionsDocument.collections,
            appGlobalConfiguration.scanDisplayPathPrefix
        );
        const visualization = getCatalogVisualization(item);
        if (visualization?.kind !== "raster" || visualization.metadata.temporal) {
            rasterVisualization.deactivateAnalysis(null);
        } else {
            rasterVisualization.activateAnalysis(item);
        }
        updateCatalogMapAction(item);
        catalogPaneControls.showInspector({
            moveFocus: true, returnFocusTarget: itemButton,
            onDismiss: () => footprintController.clearSelectedFootprint(),
        });
    }

    /**
     * Append one successful Item Search page without changing the map viewport.
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
            const resultCountLabel = formatCatalogResultCount(itemCollection);
            applyCatalogSystemState(
                catalogSystemStateElements,
                `Catalog: connected · ${itemCountLabel}`,
                "is-connected"
            );
            catalogMessageElement.textContent = `${resultCountLabel} available.`;
            catalogSummaryElement.textContent = resultCountLabel;
        }

        for (const item of itemCollection.features) {
            catalogMapActions.applyAssessment(item);
            const presentation = buildCatalogResultPresentation(
                item,
                MOUNTED_DATASET_TYPES.get(item.collection)
            );
            const view = createCatalogResultView({
                item, presentation,
                id: `catalog-result-${catalogState.searchSequence}-${catalogState.resultViews.size}`,
                onDetails: selectCatalogItem,
                onMapAction: item => catalogMapActions.toggle(item),
                onStyle: item => catalogMapActions.style(item),
                onZoom: item => catalogMapActions.zoom(item),
                onPreview: (previewItem) => footprintController.preview(previewItem),
                onClearPreview: () => footprintController.clearPreview(),
            });
            const itemButton = view.detailsButton;
            catalogState.resultViews.set(getCatalogItemKey(item), view);
            if (
                catalogState.selectedItem !== null &&
                getCatalogItemKey(catalogState.selectedItem) ===
                    getCatalogItemKey(item)
            ) {
                catalogState.selectedButton = itemButton;
                itemButton.classList.add("is-selected");
                itemButton.setAttribute("aria-pressed", "true");
            }
            catalogResultsElement.append(view.element);
        }
        refreshCatalogMapAction();

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
        catalogMapActions.clearTransientState();
        catalogState.surpriseRequestGeneration += 1;
        catalogState.searchText = catalogSearchInput.value;
        catalogSearchInput.removeAttribute("aria-invalid");
        catalogSearchError.textContent = "";
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        clearCatalogSelection();
        catalogState.resultViews.clear();
        catalogResultsElement.replaceChildren();
        catalogResultsElement.setAttribute("aria-busy", "true");
        applyCatalogSystemState(
            catalogSystemStateElements,
            "Catalog: searching"
        );
        catalogMessageElement.textContent =
            "Requesting Collections and Items from the STAC API.";
        catalogSummaryElement.textContent = "Loading results...";
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
                catalogSummaryElement.textContent = "Search needs correction";
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
            catalogSummaryElement.textContent = "Catalog unavailable";
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

    /** Reload Catalog results and explicitly refresh retained temporal choices.
     * Server scans admit changed observations; this reload reads that availability.
     * @return {Promise<void>} Completion after results and retained views refresh.
     */
    async function refreshCatalogDatasets() {
        await loadCatalog(true);
        await Promise.all([rasterVisualization.refreshTemporalLayers(), models.loadTemporalDates(undefined, true),
            rasterSeries.loadTemporalItem()]);
    }
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
    refreshCatalogButton.addEventListener("click", refreshCatalogDatasets);
    retryPageButton.addEventListener("click", prefetchNextCatalogPage);
    /**
     * Fit the map to one retained layer through its authoritative Catalog Item.
     *
     * @param {Object|null} item Authoritative retained Catalog Item.
     * @return {boolean} Whether the retained Item could be fitted.
     */
    function zoomRetainedMapLayer(item) {
        return catalogMapActions.zoom(item);
    }

    /**
     * Focus the map on a geometry-neutral selected-feature target.
     *
     * Fit the returned geographic feature bounds with proportional and pixel
     * padding, limiting close zoom for points and tiny features. Missing bounds
     * leave the map unchanged; the inspection click is not the feature location.
     *
     * @param {Object} focus Validated center and optional WGS 84 bounds.
     * @return {boolean} Whether the map accepted the focus target.
     */
    function zoomInspectedVectorFeature(focus) {
        try {
            validateVectorFeatureFocus(focus);
        } catch {
            return false;
        }
        const bounds = focus.bounds;
        if (bounds === null) return false;
        const [west, south, east, north] = bounds;
        leafletMap.fitBounds(
            L.latLngBounds([[south, west], [north, east]]).pad(0.15),
            { padding: [24, 24], maxZoom: 14 }
        );
        return true;
    }

    /**
     * Open Catalog details for one retained layer without coupling its view to
     * Catalog presentation or navigation.
     *
     * @param {Object|null} item Authoritative retained Catalog Item.
     * @return {void}
     */
    function inspectRetainedMapLayer(item) {
        if (item === null) return;
        if (isSharedViewer) {
            renderCatalogItemInspector(item, [], appGlobalConfiguration.scanDisplayPathPrefix);
            catalogPaneControls.showInspector({ moveFocus: true, returnFocusTarget: document.activeElement });
            return;
        }
        onCatalogWorkspaceRequested();
        selectCatalogItem(item);
    }

    catalogLayerZoom.addEventListener("click", () => {
        catalogMapActions.zoom(catalogState.selectedItem);
    });
    catalogLayerStyle.addEventListener("click", () => {
        catalogMapActions.style(catalogState.selectedItem);
    });
    catalogLayerToggle.addEventListener("click", () => {
        void catalogMapActions.toggle(catalogState.selectedItem);
    });
    if (!isSharedViewer || visitorAvailability.catalog) await loadCatalog(true);
    return refreshCatalogDatasets;
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
        completed: "Scan completed.",
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
 * Connects the mounted-directory scanner controls.
 *
 * @param {() => Promise<void>} refreshCatalog Reloads the active Catalog search.
 * @return {Promise<void>} Resolves after a snapshot or recoverable status error.
 */
async function initializeScanner(refreshCatalog) {
    const controls = new CatalogScanControls({
        documentContext: document, windowContext: window,
        renderStatus: renderScanStatus, refreshCatalog,
    });
    await controls.observe();
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
        () => layoutController?.notifyLayoutChange(),
        { detailsDialog: isSharedViewer ? document.querySelector("#shared-layer-details") : null }
    );
    document.querySelector(".map-layer-source-actions").hidden = isSharedViewer;
    if (isSharedViewer || editableMapSlug !== null) {
        document.querySelector("#reset-map-view").hidden = true;
        document.querySelector("#copy-map-link").hidden = true;
        if (isSharedViewer) document.querySelector(".map-layers-empty-state").textContent = "No layers loaded. Reload to retry, or ask the author for a complete map link.";
        if (editableMapSlug !== null) document.querySelector("#published-map-editor").hidden = false;
    } else {
        document.querySelector("#copy-map-link-label").textContent = "Publish map";
        document.querySelector("#copy-map-link").title = "Publish a map for others to explore";
        document.querySelector("#copy-map-link svg").innerHTML =
            '<path d="m12 5-3-1-6 3v14l6-3 6 3 6-3v-6M9 4v14m6-5v8"></path>' +
            '<path d="M15 3h6v6m0-6-8 8"></path>';
    }
    const appGlobalConfiguration = await loadAppGlobalConfiguration();
    applyAppGlobalConfiguration(appGlobalConfiguration);
    bindPanelFadeSettings(document.querySelector("#app"),
        new SavedMapViewLocalStorage(undefined, "eolab.panel-fading.v1"));
    if (!isSharedViewer) initializeRenderingDiagnostics();
    const leafletMap = initializeMap(appGlobalConfiguration);
    layoutController = new EomapLayoutController({
        documentContext: document,
        schedule: window.setTimeout.bind(window),
        invalidateMapSize: () => {
            leafletMap.invalidateSize();
            placeFirstSampleHint(leafletMap);
        },
        allowCatalog: !isSharedViewer,
        allowMapContents: !isSharedViewer,
        allowOperationalStatus: !isSharedViewer,
        workspaceStorage: isSharedViewer || editableMapSlug !== null
            ? null
            : new SavedMapViewLocalStorage(undefined, "eolab.workspace-panels.v1"),
    });
    const mapInspection = new MapInspectionController({
        onLayoutChange: layout => layoutController.setInspectionLayout(layout),
    });
    if (appGlobalConfiguration.placeSearch) {
        addMapPlaceSearch(L, leafletMap, {
            panel: document.querySelector("#map-place-search"),
            toggleButton: document.querySelector("#toggle-place-search"),
            apiKey: appGlobalConfiguration.placeSearch.apiKey,
            storage: new SavedMapViewLocalStorage(undefined, "eolab.place-search-visibility.v1"),
            toMapBounds: getSingleWorldMapBounds,
            onRestoreRequested: () => mapInspection.showToolActions(),
        });
    }
    layoutController.registerPanelActivitySource(document.querySelector("#map-inspection"),
        listener => mapInspection.subscribeClickResultActivity(listener));
    const refreshCatalog = await initializeCatalog(
        appGlobalConfiguration,
        leafletMap,
        () => {},
        catalogPaneControls,
        mapInspection,
        () => layoutController.showWorkspace("map-layers"),
        () => layoutController.showWorkspace("catalog"),
        () => layoutController.notifyLayoutChange(),
        options => layoutController.setWorkspaceOptions(options)
    );
    if (!isSharedViewer) await initializeScanner(refreshCatalog);
}

startApplication();
