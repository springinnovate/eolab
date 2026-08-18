import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

let catalogFootprints = null;
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
 * Loads STAC Collections and Items and renders their current state.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @return {Promise<void>} Resolves after the catalog request is displayed.
 */
async function refreshCatalog(appGlobalConfiguration, leafletMap) {
  const systemStateElement = document.querySelector("#system-state");
  const systemStateTextElement = document.querySelector("#system-state-text");
  const catalogMessageElement = document.querySelector("#catalog-message");
  const catalogSummaryElement = document.querySelector("#catalog-summary");
  const catalogResultsElement = document.querySelector("#catalog-results");
  const refreshCatalogButton = document.querySelector("#refresh-catalog");

  systemStateElement.classList.remove("is-connected", "is-warning");
  systemStateTextElement.textContent = "Refreshing catalog";
  catalogMessageElement.textContent =
    "Requesting Collections and Items from the STAC API.";
  catalogSummaryElement.textContent = "Loading catalog contents";
  catalogResultsElement.replaceChildren();
  refreshCatalogButton.disabled = true;

  const catalogUrl = appGlobalConfiguration.catalogUrl.replace(/\/$/, "");

  try {
    const [collectionsResponse, itemsResponse] = await Promise.all([
      fetch(`${catalogUrl}/collections`, {
        headers: { Accept: "application/json" },
      }),
      fetch(`${catalogUrl}/search`, {
        method: "POST",
        headers: {
          Accept: "application/geo+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 20 }),
      }),
    ]);

    if (!collectionsResponse.ok) {
      throw new Error(
        `STAC Collections returned ${collectionsResponse.status}`,
      );
    }
    if (!itemsResponse.ok) {
      throw new Error(`STAC Item Search returned ${itemsResponse.status}`);
    }

    const collectionsDocument = await collectionsResponse.json();
    const itemCollection = await itemsResponse.json();
    if (!Array.isArray(collectionsDocument.collections)) {
      throw new Error("STAC Collections response has no collections array");
    }
    if (!Array.isArray(itemCollection.features)) {
      throw new Error("STAC Item Search response has no features array");
    }

    const newCatalogFootprints = L.geoJSON(itemCollection, {
      style: {
        color: "#007ac2",
        fillColor: "#007ac2",
        fillOpacity: 0.16,
        weight: 2,
      },
      onEachFeature(item, footprintLayer) {
        const tooltipContent = document.createElement("span");
        tooltipContent.textContent = item.properties.title ?? item.id;
        footprintLayer.bindTooltip(tooltipContent);
      },
    }).addTo(leafletMap);

    if (catalogFootprints !== null) {
      leafletMap.removeLayer(catalogFootprints);
    }
    catalogFootprints = newCatalogFootprints;

    if (itemCollection.features.length > 0) {
      leafletMap.fitBounds(newCatalogFootprints.getBounds().pad(0.15), {
        maxZoom: 8,
      });
    }

    const itemCountLabel =
      itemCollection.numberMatched > itemCollection.features.length
        ? `${itemCollection.features.length} of ${itemCollection.numberMatched} items shown`
        : `${itemCollection.features.length} items shown`;

    systemStateElement.classList.add("is-connected");
    systemStateTextElement.textContent = `Catalog connected · ${itemCountLabel}`;
    catalogMessageElement.textContent =
      "These records and map footprints were returned by the deployed STAC API.";
    const onlyCollection = collectionsDocument.collections[0];
    const collectionLabel =
      collectionsDocument.collections.length === 1
        ? (onlyCollection.title ?? onlyCollection.id)
        : `${collectionsDocument.collections.length} collections shown`;
    catalogSummaryElement.textContent = `${collectionLabel} · ${itemCountLabel}`;

    for (const item of itemCollection.features) {
      const itemButton = document.createElement("button");
      itemButton.className = "catalog-result";
      itemButton.type = "button";

      const itemTitle = document.createElement("strong");
      itemTitle.textContent = item.properties.title ?? item.id;
      const itemDescription = document.createElement("span");
      itemDescription.textContent = item.properties.description ?? item.id;
      const itemDate = document.createElement("small");
      itemDate.textContent = item.properties.datetime;

      itemButton.append(itemTitle, itemDescription, itemDate);
      itemButton.addEventListener("click", () => {
        leafletMap.fitBounds(L.geoJSON(item).getBounds().pad(0.2), {
          maxZoom: 9,
        });
      });
      catalogResultsElement.append(itemButton);
    }

    if (itemCollection.features.length === 0) {
      const emptyCatalogMessage = document.createElement("p");
      emptyCatalogMessage.className = "catalog-empty";
      emptyCatalogMessage.textContent = "The catalog is connected but has no Items.";
      catalogResultsElement.append(emptyCatalogMessage);
    }
  } catch (catalogError) {
    if (catalogFootprints !== null) {
      leafletMap.removeLayer(catalogFootprints);
      catalogFootprints = null;
    }
    systemStateElement.classList.add("is-warning");
    systemStateTextElement.textContent = "Catalog unavailable";
    catalogMessageElement.textContent =
      "Check the catalog services and try again.";
    catalogSummaryElement.textContent = catalogError.message;
  } finally {
    refreshCatalogButton.disabled = false;
  }
}

/**
 * Connects the Catalog panel controls and performs its initial request.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @return {Promise<void>} Resolves after the initial catalog refresh.
 */
async function initializeCatalog(appGlobalConfiguration, leafletMap) {
  document
    .querySelector("#refresh-catalog")
    .addEventListener(
      "click",
      refreshCatalog.bind(null, appGlobalConfiguration, leafletMap),
    );
  await refreshCatalog(appGlobalConfiguration, leafletMap);
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
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @param {boolean} refreshWhenComplete Whether completion should refresh STAC.
 * @return {Promise<void>} Resolves after the current status is displayed.
 */
async function pollScan(
  appGlobalConfiguration,
  leafletMap,
  refreshWhenComplete,
) {
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
      pollScan.bind(null, appGlobalConfiguration, leafletMap, true),
      750,
    );
  } else if (refreshWhenComplete && scanStatus.state === "completed") {
    await refreshCatalog(appGlobalConfiguration, leafletMap);
  }
}

/**
 * Starts a mounted-directory scan from the Catalog panel.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @return {Promise<void>} Resolves after polling has been scheduled.
 */
async function startScan(appGlobalConfiguration, leafletMap) {
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
    await pollScan(appGlobalConfiguration, leafletMap, true);
  } catch (scanError) {
    document.querySelector("#start-scan").disabled = false;
    document.querySelector("#scan-status").textContent = scanError.message;
  }
}

/**
 * Connects the mounted-directory scanner controls.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @return {Promise<void>} Resolves after current scan state is displayed.
 */
async function initializeScanner(appGlobalConfiguration, leafletMap) {
  document
    .querySelector("#start-scan")
    .addEventListener(
      "click",
      startScan.bind(null, appGlobalConfiguration, leafletMap),
    );
  await pollScan(appGlobalConfiguration, leafletMap, false);
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
  await initializeCatalog(appGlobalConfiguration, leafletMap);
  await initializeScanner(appGlobalConfiguration, leafletMap);
}

startApplication();
