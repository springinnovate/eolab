const CATALOG_PAGE_SIZE = 20;

/**
 * Builds a standard CQL2 substring filter for Item titles and descriptions.
 *
 * @param {string} searchText Text entered in the Catalog search field.
 * @return {Object|null} CQL2 JSON filter, or null for no filter.
 * @example
 * // "2004" becomes the CQL2 equivalent of:
 * // casei(title) LIKE casei("%2004%")
 * // OR casei(description) LIKE casei("%2004%")
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
    args: ["title", "description"].map((propertyName) => ({
      op: "like",
      args: [
        { op: "casei", args: [{ property: propertyName }] },
        pattern,
      ],
    })),
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
  timer = globalThis,
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
    itemCollection.links.find((link) => relations.includes(link.rel)) ?? null
  );
}

/**
 * Builds the display model for a STAC Item inspector.
 *
 * @param {Object} item STAC Item selected in the result list.
 * @param {Object[]} collections STAC Collections available to the Catalog.
 * @return {Object} Text-only metadata grouped for inspector rendering.
 */
export function buildCatalogItemDetails(item, collections) {
  const properties = item.properties;
  const collection = collections.find(
    (candidateCollection) => candidateCollection.id === item.collection,
  );
  const collectionLabel = collection?.title
    ? `${collection.title} (${item.collection})`
    : item.collection;
  const metadata = [
    { label: "Item ID", value: item.id },
    { label: "Collection", value: collectionLabel },
  ];

  if (properties.datetime !== null && properties.datetime !== undefined) {
    metadata.push({ label: "Item datetime", value: properties.datetime });
  } else if (
    properties.start_datetime !== undefined &&
    properties.end_datetime !== undefined
  ) {
    metadata.push({
      label: "Item datetime range",
      value: `${properties.start_datetime} – ${properties.end_datetime}`,
    });
  }
  if (item.geometry !== null) {
    metadata.push({ label: "Geometry", value: item.geometry.type });
  }
  if (item.bbox !== undefined) {
    metadata.push({ label: "Bounding box", value: item.bbox.join(", ") });
  }
  if (properties["proj:epsg"] !== undefined) {
    metadata.push({
      label: "Coordinate reference system",
      value: `EPSG:${properties["proj:epsg"]}`,
    });
  } else if (properties["proj:wkt2"] !== undefined) {
    metadata.push({
      label: "Coordinate reference system",
      value: properties["proj:wkt2"],
    });
  }
  if (properties["proj:shape"] !== undefined) {
    const [height, width] = properties["proj:shape"];
    metadata.push({
      label: "Raster dimensions",
      value: `${width} × ${height} pixels`,
    });
  }

  const assets = Object.entries(item.assets).map(([assetKey, asset]) => {
    const assetMetadata = [{ label: "Location", value: asset.href }];
    if (asset.type !== undefined) {
      assetMetadata.push({ label: "Media type", value: asset.type });
    }
    if (asset.roles !== undefined) {
      assetMetadata.push({ label: "Roles", value: asset.roles.join(", ") });
    }
    if (asset.updated !== undefined) {
      assetMetadata.push({ label: "File modified", value: asset.updated });
    }

    const bands = (asset["raster:bands"] ?? []).map((band, bandIndex) => {
      const bandMetadata = [
        { label: "Data type", value: band.data_type },
      ];
      if (Object.hasOwn(band, "nodata")) {
        bandMetadata.push({ label: "Nodata", value: String(band.nodata) });
      }
      return { title: `Band ${bandIndex + 1}`, metadata: bandMetadata };
    });

    return {
      key: assetKey,
      title: asset.title ?? assetKey,
      metadata: assetMetadata,
      bands,
    };
  });

  return {
    title: properties.title ?? item.id,
    description: properties.description ?? null,
    metadata,
    assets,
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
  }

  /**
   * Starts the first page of a standard STAC CQL2 substring search.
   *
   * @param {string} searchText User-entered search text.
   * @return {Promise<Object|null>} ItemCollection, or null when superseded.
   */
  search(searchText) {
    const searchBody = { limit: CATALOG_PAGE_SIZE };
    const substringFilter = buildSubstringFilter(searchText);
    if (substringFilter !== null) {
      searchBody["filter-lang"] = "cql2-json";
      searchBody.filter = substringFilter;
    }
    return this.request({
      href: `${this.catalogUrl}/search`,
      method: "POST",
      body: searchBody,
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
      throw new TypeError(`Unsupported STAC pagination method: ${method}`);
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
      signal: abortController.signal,
    };
    if (method === "POST") {
      requestHeaders.set("Content-Type", "application/json");
      requestOptions.body = JSON.stringify(stacLink.body ?? {});
    }

    let searchResponse;
    try {
      searchResponse = await this.fetchImplementation(
        stacLink.href,
        requestOptions,
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
      throw new Error(`STAC Item Search returned ${searchResponse.status}`);
    }

    const itemCollection = await searchResponse.json();
    if (requestSequence !== this.requestSequence) {
      return null;
    }
    if (!Array.isArray(itemCollection.features)) {
      throw new Error("STAC Item Search response has no features array");
    }
    return itemCollection;
  }
}

/**
 * Owns the explicit compact or expanded Catalog layout state.
 */
export class CatalogWorkspaceController {
  /**
   * @param {HTMLElement} appElement Application layout root.
   * @param {HTMLButtonElement} toggleButton Catalog layout toggle.
   * @param {HTMLElement} inspectorElement Item inspector region.
   * @param {Function} onLayoutChange Called after layout state changes.
   */
  constructor(appElement, toggleButton, inspectorElement, onLayoutChange) {
    this.appElement = appElement;
    this.toggleButton = toggleButton;
    this.inspectorElement = inspectorElement;
    this.onLayoutChange = onLayoutChange;
    this.isExpanded = false;
  }

  /** Switches between the compact panel and expanded Catalog workspace. */
  toggle() {
    this.setExpanded(!this.isExpanded);
  }

  /**
   * @param {boolean} isExpanded Whether the Catalog workspace is expanded.
   * @return {void}
   */
  setExpanded(isExpanded) {
    if (isExpanded === this.isExpanded) {
      return;
    }
    this.isExpanded = isExpanded;
    this.appElement.classList.toggle("is-catalog-workspace", isExpanded);
    this.toggleButton.setAttribute("aria-expanded", String(isExpanded));
    this.toggleButton.textContent = isExpanded
      ? "Return to map"
      : "Expand catalog";
    this.inspectorElement.setAttribute("aria-hidden", String(!isExpanded));
    this.onLayoutChange();
  }

  /**
   * Returns an expanded Catalog to the map layout when Escape is pressed.
   *
   * @param {KeyboardEvent} keyboardEvent Document keyboard event.
   * @return {void}
   */
  handleKeyDown(keyboardEvent) {
    if (keyboardEvent.key === "Escape" && this.isExpanded) {
      keyboardEvent.preventDefault();
      this.setExpanded(false);
      this.toggleButton.focus();
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
      this.leafletMap,
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
        this.leafletMap,
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
