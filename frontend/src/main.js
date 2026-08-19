import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  CatalogFootprintController,
  CatalogSearchClient,
  createDebouncedAction,
  findPaginationLink,
} from "./catalog.js";
import "./style.css";

let scanPollTimeout = null;

/**
 * Browser-safe application settings loaded from the backend.
 *
 * @typedef {Object} AppGlobalConfiguration
 * @property {string} appTitle Application title.
 * @property {string} appSubtitle Application subtitle.
 * @property {string} appVersion Deployed application version.
 * @property {string} catalogUrl Browser-facing STAC catalog URL.
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
    headers: { Accept: "application/json" },
  });

  if (!configurationResponse.ok) {
    throw new Error(
      `Runtime configuration returned ${configurationResponse.status}`,
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
    maxZoom: 22,
  }).setView(
    [
      appGlobalConfiguration.initialView.latitude,
      appGlobalConfiguration.initialView.longitude,
    ],
    appGlobalConfiguration.initialView.zoom,
  );

  L.control.zoom({ position: "bottomleft" }).addTo(leafletMap);
  L.tileLayer(appGlobalConfiguration.basemap.url, {
    attribution: appGlobalConfiguration.basemap.attribution,
    maxZoom: 22,
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
      `${appGlobalConfiguration.appTitle} interactive map`,
    );
  document
    .querySelector("#control-panel")
    .setAttribute("aria-label", `${appGlobalConfiguration.appTitle} controls`);
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
 * Creates a selected or preview Leaflet layer for one STAC Item.
 *
 * @param {Object} item STAC Item.
 * @param {string} visualState Either selected or preview.
 * @return {L.GeoJSON} Leaflet footprint layer.
 */
function createCatalogFootprintLayer(item, visualState) {
  return L.geoJSON(item, {
    style: { className: `catalog-footprint is-${visualState}` },
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
    headers: { Accept: "application/json" },
  });
  if (!collectionsResponse.ok) {
    throw new Error(`STAC Collections returned ${collectionsResponse.status}`);
  }
  const collectionsDocument = await collectionsResponse.json();
  if (!Array.isArray(collectionsDocument.collections)) {
    throw new Error("STAC Collections response has no collections array");
  }
  return collectionsDocument;
}

/**
 * Connects catalog search, paging, selection, and refresh controls.
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
  const catalogSearchInput = document.querySelector("#catalog-search");
  const refreshCatalogButton = document.querySelector("#refresh-catalog");
  const previousPageButton = document.querySelector(
    "#previous-catalog-page",
  );
  const nextPageButton = document.querySelector("#next-catalog-page");
  const pageStatusElement = document.querySelector("#catalog-page-status");
  const catalogUrl = appGlobalConfiguration.catalogUrl.replace(/\/$/, "");
  const searchClient = new CatalogSearchClient(catalogUrl);
  const footprintController = new CatalogFootprintController(
    leafletMap,
    createCatalogFootprintLayer,
  );
  const catalogState = {
    collectionsDocument: null,
    loadSequence: 0,
    nextLink: null,
    pageNumber: 1,
    previousLink: null,
    selectedButton: null,
  };

  /**
   * Displays one successful Item Search page.
   *
   * @param {Object} itemCollection STAC ItemCollection response.
   * @return {void}
   */
  function renderCatalogPage(itemCollection) {
    footprintController.clear();
    catalogState.selectedButton = null;
    catalogResultsElement.replaceChildren();
    catalogState.nextLink = findPaginationLink(itemCollection, ["next"]);
    catalogState.previousLink = findPaginationLink(itemCollection, ["prev"]);
    previousPageButton.disabled = catalogState.previousLink === null;
    nextPageButton.disabled = catalogState.nextLink === null;
    pageStatusElement.textContent = `Page ${catalogState.pageNumber}`;

    const returnedItemCount = itemCollection.features.length;
    const matchedItemCount = itemCollection.numberMatched;
    const itemCountLabel =
      Number.isInteger(matchedItemCount) && matchedItemCount > returnedItemCount
        ? `${returnedItemCount} of ${matchedItemCount} items on this page`
        : `${returnedItemCount} items on this page`;
    const collections = catalogState.collectionsDocument.collections;
    const collectionLabel =
      collections.length === 1
        ? (collections[0].title ?? collections[0].id)
        : `${collections.length} collections`;

    systemStateElement.classList.add("is-connected");
    systemStateTextElement.textContent = `Catalog connected · ${itemCountLabel}`;
    catalogMessageElement.textContent = catalogSearchInput.value.trim()
      ? "Matching records were returned from the complete STAC catalog."
      : "Records were returned from the deployed STAC catalog.";
    catalogSummaryElement.textContent = `${collectionLabel} · ${itemCountLabel}`;

    const pageBounds = L.geoJSON(itemCollection).getBounds();
    if (pageBounds.isValid()) {
      leafletMap.fitBounds(pageBounds.pad(0.15), { maxZoom: 8 });
    }

    for (const item of itemCollection.features) {
      const itemButton = document.createElement("button");
      itemButton.className = "catalog-result";
      itemButton.type = "button";
      itemButton.setAttribute("aria-pressed", "false");

      const itemTitle = document.createElement("strong");
      itemTitle.textContent = item.properties.title ?? item.id;
      const itemDescription = document.createElement("span");
      itemDescription.textContent = item.properties.description ?? item.id;
      const itemDate = document.createElement("small");
      itemDate.textContent = item.properties.datetime ?? "Datetime unavailable";

      itemButton.append(itemTitle, itemDescription, itemDate);
      itemButton.addEventListener("click", () => {
        if (catalogState.selectedButton !== null) {
          catalogState.selectedButton.classList.remove("is-selected");
          catalogState.selectedButton.setAttribute("aria-pressed", "false");
        }
        catalogState.selectedButton = itemButton;
        itemButton.classList.add("is-selected");
        itemButton.setAttribute("aria-pressed", "true");
        footprintController.select(item);
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

    if (returnedItemCount === 0) {
      const emptyCatalogMessage = document.createElement("p");
      emptyCatalogMessage.className = "catalog-empty";
      emptyCatalogMessage.textContent = catalogSearchInput.value.trim()
        ? `No Items matched “${catalogSearchInput.value.trim()}”.`
        : "The catalog is connected but has no Items.";
      catalogResultsElement.append(emptyCatalogMessage);
    }
  }

  /**
   * Loads either the first search page or a supplied STAC pagination link.
   *
   * @param {Object|null} paginationLink Provider link to follow.
   * @param {number} pageChange Relative page-number change.
   * @param {boolean} reloadCollections Whether to refresh Collection metadata.
   * @return {Promise<void>} Resolves when the active request is displayed.
   */
  async function loadCatalogPage(
    paginationLink = null,
    pageChange = 0,
    reloadCollections = false,
  ) {
    const loadSequence = ++catalogState.loadSequence;
    systemStateElement.classList.remove("is-connected", "is-warning");
    systemStateTextElement.textContent = "Searching catalog";
    catalogMessageElement.textContent =
      "Requesting Collections and Items from the STAC API.";
    catalogSummaryElement.textContent = "Loading catalog contents";
    refreshCatalogButton.disabled = true;
    previousPageButton.disabled = true;
    nextPageButton.disabled = true;

    try {
      const collectionsRequest =
        reloadCollections || catalogState.collectionsDocument === null
          ? loadCatalogCollections(catalogUrl)
          : Promise.resolve(catalogState.collectionsDocument);
      const itemsRequest =
        paginationLink === null
          ? searchClient.search(catalogSearchInput.value)
          : searchClient.follow(paginationLink);
      const [collectionsDocument, itemCollection] = await Promise.all([
        collectionsRequest,
        itemsRequest,
      ]);
      if (loadSequence !== catalogState.loadSequence || itemCollection === null) {
        return;
      }
      catalogState.collectionsDocument = collectionsDocument;
      catalogState.pageNumber =
        paginationLink === null ? 1 : catalogState.pageNumber + pageChange;
      renderCatalogPage(itemCollection);
    } catch (catalogError) {
      if (loadSequence !== catalogState.loadSequence) {
        return;
      }
      footprintController.clear();
      catalogResultsElement.replaceChildren();
      catalogState.nextLink = null;
      catalogState.previousLink = null;
      systemStateElement.classList.add("is-warning");
      systemStateTextElement.textContent = "Catalog unavailable";
      catalogMessageElement.textContent =
        "Check the catalog services and try again.";
      catalogSummaryElement.textContent = catalogError.message;
    } finally {
      if (loadSequence === catalogState.loadSequence) {
        refreshCatalogButton.disabled = false;
        previousPageButton.disabled = catalogState.previousLink === null;
        nextPageButton.disabled = catalogState.nextLink === null;
      }
    }
  }

  const scheduleCatalogSearch = createDebouncedAction(
    loadCatalogPage.bind(null, null, 0, false),
    300,
    window,
  );
  catalogSearchInput.addEventListener("input", scheduleCatalogSearch);
  refreshCatalogButton.addEventListener(
    "click",
    loadCatalogPage.bind(null, null, 0, true),
  );
  previousPageButton.addEventListener("click", () => {
    if (catalogState.previousLink !== null) {
      loadCatalogPage(catalogState.previousLink, -1, false);
    }
  });
  nextPageButton.addEventListener("click", () => {
    if (catalogState.nextLink !== null) {
      loadCatalogPage(catalogState.nextLink, 1, false);
    }
  });

  await loadCatalogPage(null, 0, true);
  return loadCatalogPage.bind(null, null, 0, true);
}

/**
 * Displays the current mounted-directory scan state.
 *
 * @param {Object} scanStatus Scan progress returned by the backend.
 * @return {void}
 */
function renderScanStatus(scanStatus) {
  const startScanButton = document.querySelector("#start-scan");
  const scanStatusElement = document.querySelector("#scan-status");
  const scanProgressElement = document.querySelector("#scan-progress");
  const scanCountsElement = document.querySelector("#scan-counts");
  const scanErrorsElement = document.querySelector("#scan-errors");
  const isRunning = ["discovering", "scanning"].includes(scanStatus.state);

  startScanButton.disabled = isRunning;
  startScanButton.textContent = isRunning ? "Scanning…" : "Scan directory";
  scanProgressElement.hidden = scanStatus.state === "not_started";
  scanProgressElement.max = Math.max(scanStatus.discovered, 1);
  scanProgressElement.value = scanStatus.processed;
  scanCountsElement.textContent =
    scanStatus.state === "not_started"
      ? ""
      : `${scanStatus.discovered} discovered · ${scanStatus.processed} processed · ` +
        `${scanStatus.indexed} indexed · ${scanStatus.failed} failed`;

  const statusMessages = {
    not_started: "No scan has been started.",
    discovering: "Discovering GeoTIFF files in the mounted directory.",
    scanning: scanStatus.currentFile
      ? `Processing ${scanStatus.currentFile}`
      : "Preparing discovered GeoTIFF files.",
    completed: "Scan completed. The catalog has been refreshed.",
    failed: "The scan stopped before it could complete.",
  };
  scanStatusElement.textContent =
    statusMessages[scanStatus.state] ?? `Unknown scan state: ${scanStatus.state}`;

  scanErrorsElement.replaceChildren();
  for (const scanError of scanStatus.errors) {
    const errorItem = document.createElement("li");
    errorItem.textContent = scanError.path
      ? `${scanError.path}: ${scanError.error}`
      : scanError.error;
    scanErrorsElement.append(errorItem);
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
    headers: { Accept: "application/json" },
  });
  if (!scanResponse.ok) {
    throw new Error(`Scan status returned ${scanResponse.status}`);
  }

  const scanStatus = await scanResponse.json();
  renderScanStatus(scanStatus);
  if (["discovering", "scanning"].includes(scanStatus.state)) {
    scanPollTimeout = window.setTimeout(
      pollScan.bind(null, refreshCatalog, true),
      750,
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
    const startResponse = await fetch("/api/scans", {
      method: "POST",
      headers: { Accept: "application/json" },
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
 * @return {void}
 */
function initializeWorkspaceTabs() {
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

    for (const candidateTabButton of workspaceTabButtons) {
      const isSelectedTab = candidateTabButton === selectedTabButton;
      candidateTabButton.classList.toggle("is-active", isSelectedTab);
      candidateTabButton.setAttribute(
        "aria-selected",
        String(isSelectedTab),
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
 * @return {void}
 */
function initializeControlPanel(leafletMap) {
  const controlPanelElement = document.querySelector("#control-panel");
  const openPanelButton = document.querySelector("#open-panel");

  /**
   * Sets whether the control panel is collapsed.
   *
   * @param {boolean} isCollapsed Whether the panel should be collapsed.
   * @return {void}
   */
  function setControlPanelCollapsed(isCollapsed) {
    controlPanelElement.classList.toggle("is-collapsed", isCollapsed);
    openPanelButton.hidden = !isCollapsed;
    window.setTimeout(() => leafletMap.invalidateSize(), 240);
  }

  document
    .querySelector("#collapse-panel")
    .addEventListener("click", setControlPanelCollapsed.bind(null, true));
  openPanelButton.addEventListener(
    "click",
    setControlPanelCollapsed.bind(null, false),
  );
}

/**
 * Starts the browser application from its runtime contract.
 *
 * @return {Promise<void>} Resolves after the interface is initialized.
 */
async function startApplication() {
  const appGlobalConfiguration = await loadAppGlobalConfiguration();
  applyAppGlobalConfiguration(appGlobalConfiguration);
  const leafletMap = initializeMap(appGlobalConfiguration);
  initializeWorkspaceTabs();
  initializeControlPanel(leafletMap);
  const refreshCatalog = await initializeCatalog(
    appGlobalConfiguration,
    leafletMap,
  );
  await initializeScanner(refreshCatalog);
}

startApplication();
