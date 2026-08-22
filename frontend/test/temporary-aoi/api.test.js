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
