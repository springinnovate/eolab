import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

/**
 * Browser-safe application settings loaded from the backend.
 *
 * @typedef {Object} AppGlobalConfiguration
 * @property {string} appTitle Application title.
 * @property {string} appSubtitle Application subtitle.
 * @property {string} appVersion Deployed application version.
 * @property {string|null} catalogUrl Configured STAC catalog URL.
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
  const catalogMessageElement = document.querySelector("#catalog-message");
  const catalogLinkElement = document.querySelector("#catalog-link");

  if (appGlobalConfiguration.catalogUrl !== null) {
    systemStateElement.classList.add("is-connected");
    systemStateTextElement.textContent = "Catalog endpoint configured";
    catalogMessageElement.textContent =
      "A catalog endpoint is configured. Connectivity and STAC browsing will be added in the next catalog milestone.";
    catalogLinkElement.href = appGlobalConfiguration.catalogUrl;
    catalogLinkElement.textContent = appGlobalConfiguration.catalogUrl;
    catalogLinkElement.hidden = false;
  } else {
    systemStateTextElement.textContent =
      "Viewer online · catalog not configured";
    catalogMessageElement.textContent =
      "Set EOLAB_CATALOG_URL in Coolify when a STAC API is ready. The viewer remains usable without one.";
  }
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
}

startApplication();
