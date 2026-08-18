const CATALOG_PAGE_SIZE = 20;

/**
 * Converts user-entered text into a safe PostgreSQL prefix query.
 *
 * @param {string} searchText Text entered in the Catalog search field.
 * @return {string|null} Advanced STAC free-text query or null for no filter.
 */
export function buildPrefixQuery(searchText) {
  const terms = searchText
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  return terms?.map((term) => `${term}:*`).join(" AND ") ?? null;
}

/**
 * Creates a restartable delayed action.
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
 * Issues standard STAC Item Search requests while cancelling stale work.
 */
export class CatalogSearchClient {
  /**
   * @param {string} catalogUrl Browser-facing STAC root URL.
   * @param {Function} fetchImplementation Fetch-compatible request function.
   */
  constructor(catalogUrl, fetchImplementation = globalThis.fetch) {
    this.catalogUrl = catalogUrl.replace(/\/$/, "");
    this.fetchImplementation = fetchImplementation;
    this.activeAbortController = null;
    this.requestSequence = 0;
  }

  /**
   * Starts the first page of a standard STAC free-text search.
   *
   * @param {string} searchText User-entered search text.
   * @return {Promise<Object|null>} ItemCollection, or null when superseded.
   */
  search(searchText) {
    const searchBody = { limit: CATALOG_PAGE_SIZE };
    const prefixQuery = buildPrefixQuery(searchText);
    if (prefixQuery !== null) {
      searchBody.q = [prefixQuery];
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
