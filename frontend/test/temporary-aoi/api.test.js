import assert from "node:assert/strict";
import test from "node:test";

import {
  TemporaryAoiApiClient,
  TemporaryAoiHttpError,
  validateTemporaryAoiBounds,
  validateTemporaryAoiGeometry,
  validateTemporaryAoiUploadResponse,
} from "../../src/temporary-aoi/api.js";

const READY_AOI = {
  id: "aoi_01Jopaque",
  state: "ready",
  filename: "planning.gpkg",
  selectedDataset: "planning_limits",
  expiresAt: "2030-01-01T00:30:00Z",
  bbox: [-123, 48, -122, 49],
  geometry: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [-122.5, 48.5] },
      },
    ],
  },
};

const SELECTION_REQUIRED_AOI = {
  id: "aoi_01Jpending",
  state: "selectionRequired",
  filename: "planning.gpkg",
  selectedDataset: null,
  expiresAt: "2030-01-01T00:30:00Z",
  choices: [
    { id: "choice_a", label: "planning_limits" },
    { id: "choice_b", label: "survey_area" },
  ],
};

/**
 * Create a Blob with the browser File name contract used by FormData.
 *
 * @param {string} name Display filename.
 * @return {Blob} Named upload blob.
 */
function createUpload(name) {
  const upload = new Blob(["bounded fixture"], { type: "application/zip" });
  Object.defineProperty(upload, "name", { value: name });
  return upload;
}

/** Minimal event target for an observable upload-request fixture. */
class FakeRequestEvents {
  /** Create an event target without listeners. */
  constructor() {
    this.listeners = new Map();
  }

  /**
   * Attach one request event listener.
   *
   * @param {string} type Event type.
   * @param {(event: Object) => void} listener Event receiver.
   * @return {void}
   */
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(listener);
  }

  /**
   * Emit one inspectable request event.
   *
   * @param {string} type Event type.
   * @param {Object} [event={}] Event payload.
   * @return {void}
   */
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

/** Inspectable XMLHttpRequest-compatible upload fixture. */
class FakeUploadRequest extends FakeRequestEvents {
  /** Create a pending request with an independent upload event target. */
  constructor() {
    super();
    this.upload = new FakeRequestEvents();
    this.headers = new Map();
    this.method = null;
    this.url = null;
    this.body = null;
    this.status = 0;
    this.responseText = "";
    this.responseContentType = null;
  }

  /**
   * Record the request method and URL.
   *
   * @param {string} method HTTP method.
   * @param {string} url Same-origin request URL.
   * @return {void}
   */
  open(method, url) {
    this.method = method;
    this.url = url;
  }

  /**
   * Record one explicit request header.
   *
   * @param {string} name Header name.
   * @param {string} value Header value.
   * @return {void}
   */
  setRequestHeader(name, value) {
    this.headers.set(name, value);
  }

  /**
   * Return the configured response content type.
   *
   * @param {string} name Response header name.
   * @return {string|null} Header value when available.
   */
  getResponseHeader(name) {
    return name.toLowerCase() === "content-type"
      ? this.responseContentType
      : null;
  }

  /**
   * Record the strict multipart body.
   *
   * @param {FormData} body Multipart upload body.
   * @return {void}
   */
  send(body) {
    this.body = body;
  }

  /**
   * Complete the request with one JSON response.
   *
   * @param {number} status HTTP response status.
   * @param {Object} document JSON response document.
   * @return {void}
   */
  complete(status, document) {
    this.status = status;
    this.responseText = JSON.stringify(document);
    this.responseContentType = "application/json";
    this.emit("load");
  }
}

test("temporary AOI upload reports observable file-byte progress", async () => {
  const request = new FakeUploadRequest();
  const client = new TemporaryAoiApiClient(
    async () => {
      throw new Error("Fetch fallback should not run.");
    },
    () => request,
  );
  const file = createUpload("planning.zip");
  const progress = [];

  const result = client.upload(
    file,
    "aoi_current",
    (update) => progress.push(update),
  );
  request.upload.emit("progress", {
    lengthComputable: true,
    loaded: 25,
    total: 100,
  });
  request.upload.emit("load");
  request.complete(201, READY_AOI);

  assert.deepEqual(await result, READY_AOI);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/temporary-aois");
  assert.equal(request.headers.get("Accept"), "application/json");
  assert.equal(request.headers.has("Content-Type"), false);
  assert.equal(request.body.get("replacementId"), "aoi_current");
  assert.deepEqual(progress, [
    { loadedBytes: 0, totalBytes: file.size, uploadComplete: false },
    {
      loadedBytes: Math.round(file.size * 0.25),
      totalBytes: file.size,
      uploadComplete: false,
    },
    {
      loadedBytes: file.size,
      totalBytes: file.size,
      uploadComplete: true,
    },
  ]);
});

test("observable upload progress preserves actionable service failures", async () => {
  const request = new FakeUploadRequest();
  const client = new TemporaryAoiApiClient(globalThis.fetch, () => request);

  const result = client.upload(createUpload("too-large.zip"));
  request.upload.emit("load");
  request.complete(413, {
    detail: "The ZIP archive expands beyond the configured limit.",
  });

  await assert.rejects(result, (error) => {
    assert.equal(error instanceof TemporaryAoiHttpError, true);
    assert.equal(error.status, 413);
    assert.match(error.message, /expands beyond/);
    return true;
  });
});

test("temporary AOI upload sends bounded multipart fields without overriding its content type", async () => {
  const requests = [];
  const client = new TemporaryAoiApiClient(async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(READY_AOI), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(
    await client.upload(createUpload("planning.zip"), "aoi_current"),
    READY_AOI,
  );
  assert.equal(requests[0].url, "/api/temporary-aois");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(requests[0].options.headers, { Accept: "application/json" });
  assert.equal(requests[0].options.body instanceof FormData, true);
  assert.equal(requests[0].options.body.get("file").name, "planning.zip");
  assert.equal(requests[0].options.body.get("replacementId"), "aoi_current");
  assert.deepEqual(
    [...requests[0].options.body.keys()],
    ["file", "replacementId"],
  );
});

test("temporary AOI upload preserves the explicit multi-dataset choice step", async () => {
  const client = new TemporaryAoiApiClient(async () => new Response(
    JSON.stringify(SELECTION_REQUIRED_AOI),
    { status: 202, headers: { "Content-Type": "application/json" } },
  ));

  assert.deepEqual(
    await client.upload(createUpload("planning.gpkg")),
    SELECTION_REQUIRED_AOI,
  );
});

test("dataset selection sends only opaque identifiers and validates ready geometry", async () => {
  const requests = [];
  const client = new TemporaryAoiApiClient(async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(READY_AOI), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(
    await client.selectDataset("aoi/pending", "choice_b"),
    READY_AOI,
  );
  assert.deepEqual(requests, [
    {
      url: "/api/temporary-aois/aoi%2Fpending/selection",
      options: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ choiceId: "choice_b" }),
      },
    },
  ]);
});

test("temporary AOI removal is idempotent for expired identifiers", async () => {
  const requests = [];
  const client = new TemporaryAoiApiClient(async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: 404 });
  });

  await client.remove("expired/aoi");

  assert.deepEqual(requests, [
    {
      url: "/api/temporary-aois/expired%2Faoi",
      options: {
        method: "DELETE",
        headers: { Accept: "application/json" },
      },
    },
  ]);
});

test("temporary AOI requests preserve actionable FastAPI errors and status", async () => {
  const client = new TemporaryAoiApiClient(async () => new Response(
    JSON.stringify({ detail: "The ZIP archive expands beyond the limit." }),
    { status: 413, headers: { "Content-Type": "application/json" } },
  ));

  await assert.rejects(
    client.upload(createUpload("large.zip")),
    (error) => {
      assert.equal(error instanceof TemporaryAoiHttpError, true);
      assert.equal(error.status, 413);
      assert.match(error.message, /expands beyond the limit/);
      return true;
    },
  );
});

test("browser geometry rejects malformed, noncanonical, and unbounded responses", () => {
  assert.throws(
    () => validateTemporaryAoiBounds([-181, 48, -122, 49]),
    /canonical WGS 84/,
  );
  assert.throws(
    () => validateTemporaryAoiGeometry({
      ...READY_AOI.geometry,
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [200, 48.5] },
        },
      ],
    }),
    /canonical WGS 84/,
  );
  assert.throws(
    () => validateTemporaryAoiGeometry({
      type: "FeatureCollection",
      features: [],
    }),
    /must contain a feature/,
  );
  assert.throws(
    () => validateTemporaryAoiUploadResponse({
      ...SELECTION_REQUIRED_AOI,
      choices: [
        { id: "duplicate", label: "first" },
        { id: "duplicate", label: "second" },
      ],
    }),
    /must be unique/,
  );
});
