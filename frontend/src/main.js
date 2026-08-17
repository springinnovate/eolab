import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

const fallbackConfig = {
  appTitle: "EOLab",
  appSubtitle: "Catalog-driven Earth observation",
  appVersion: "dev",
  catalogUrl: null,
  basemap: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
  },
  initialView: {
    latitude: 20,
    longitude: 0,
    zoom: 2,
  },
};

async function loadConfig() {
  const response = await fetch("/api/config", {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Runtime configuration returned ${response.status}`);
  }

  return response.json();
}

function initializeMap(config) {
  const map = L.map("map", {
    zoomControl: false,
    minZoom: 0,
    maxZoom: 22,
  }).setView(
    [config.initialView.latitude, config.initialView.longitude],
    config.initialView.zoom,
  );

  L.control.zoom({ position: "bottomleft" }).addTo(map);

  if (config.basemap.url) {
    L.tileLayer(config.basemap.url, {
      attribution: config.basemap.attribution,
      maxZoom: 22,
    }).addTo(map);
  }

  const position = document.querySelector("#map-position");
  const updatePosition = ({ lat, lng }) => {
    position.textContent = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  };

  updatePosition(map.getCenter());
  map.on("mousemove", (event) => updatePosition(event.latlng));

  return map;
}

function applyConfig(config, degraded = false) {
  document.title = config.appTitle;
  document.querySelector("#app-title").textContent = config.appTitle;
  document.querySelector("#app-subtitle").textContent = config.appSubtitle;
  document.querySelector("#app-version").textContent = config.appVersion;

  const state = document.querySelector("#system-state");
  const stateText = document.querySelector("#system-state-text");
  const catalogMessage = document.querySelector("#catalog-message");
  const catalogLink = document.querySelector("#catalog-link");

  if (degraded) {
    state.classList.add("is-warning");
    stateText.textContent = "Using fallback browser configuration";
  } else if (config.catalogUrl) {
    state.classList.add("is-connected");
    stateText.textContent = "Catalog endpoint configured";
  } else {
    stateText.textContent = "Viewer online · catalog not configured";
  }

  if (config.catalogUrl) {
    catalogMessage.textContent = "A catalog endpoint is configured. Connectivity and STAC browsing will be added in the next catalog milestone.";
    catalogLink.href = config.catalogUrl;
    catalogLink.textContent = config.catalogUrl;
    catalogLink.hidden = false;
  } else {
    catalogMessage.textContent = "Set EOLAB_CATALOG_URL in Coolify when a STAC API is ready. The viewer remains usable without one.";
  }
}

function initializeTabs() {
  const buttons = document.querySelectorAll(".tab-button");
  const panels = document.querySelectorAll(".tab-panel");

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const selectedPanel = button.dataset.panel;

      for (const candidate of buttons) {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-selected", String(active));
      }

      for (const panel of panels) {
        const active = panel.id === `panel-${selectedPanel}`;
        panel.classList.toggle("is-active", active);
        panel.hidden = !active;
      }
    });
  }
}

function initializePanelControls(map) {
  const panel = document.querySelector("#control-panel");
  const openButton = document.querySelector("#open-panel");

  document.querySelector("#collapse-panel").addEventListener("click", () => {
    panel.classList.add("is-collapsed");
    openButton.hidden = false;
    window.setTimeout(() => map.invalidateSize(), 240);
  });

  openButton.addEventListener("click", () => {
    panel.classList.remove("is-collapsed");
    openButton.hidden = true;
    window.setTimeout(() => map.invalidateSize(), 240);
  });
}

async function start() {
  let config = fallbackConfig;
  let degraded = false;

  try {
    config = await loadConfig();
  } catch (error) {
    degraded = true;
    console.error(error);
  }

  applyConfig(config, degraded);
  const map = initializeMap(config);
  initializeTabs();
  initializePanelControls(map);
}

start();
