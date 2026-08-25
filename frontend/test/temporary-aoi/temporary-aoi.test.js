import assert from "node:assert/strict";
import test from "node:test";

import { TemporaryAoiCoordinator } from "../../src/temporary-aoi/temporary-aoi.js";

const READY_AOI = {
  id: "aoi_ready",
  state: "ready",
  filename: "area.gpkg",
  selectedDataset: "boundary",
  expiresAt: "2030-01-01T01:00:00Z",
  bbox: [-123, 48, -122, 49],
  geometry: { type: "FeatureCollection", features: [] },
};

const REPLACEMENT_AOI = {
  ...READY_AOI,
  id: "aoi_replacement",
  filename: "replacement.zip",
  selectedDataset: "inside/boundary.shp",
};

const PENDING_AOI = {
  id: "aoi_pending",
  state: "selectionRequired",
  filename: "layers.gpkg",
  expiresAt: "2030-01-01T00:30:00Z",
  choices: [
    { id: "choice_one", label: "first" },
    { id: "choice_two", label: "second" },
  ],
};

/**
 * Create the minimal cancelable event used by coordinator handlers.
 *
 * @return {{prevented: boolean, preventDefault: () => void}} Fake event.
 */
function createEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

/**
 * Create an inspectable semantic controls adapter.
 *
 * @return {Object} Fake temporary-AOI controls view.
 */
function createView() {
  return {
    file: new Blob(["file"]),
    choiceId: "choice_two",
    calls: [],
    handlers: null,
    bind(handlers) {
      this.handlers = handlers;
      this.calls.push(["bind"]);
    },
    unbind() {
      this.handlers = null;
      this.calls.push(["unbind"]);
    },
    readFile() {
      return this.file;
    },
    readChoiceId() {
      return this.choiceId;
    },
    renderIdle(message = "") {
      this.calls.push(["idle", message]);
    },
    renderBusy(message) {
      this.calls.push(["busy", message]);
    },
    renderUploadProgress(progress) {
      this.calls.push(["progress", progress]);
    },
    renderSelection(pending) {
      this.calls.push(["selection", pending]);
    },
    renderReady(ready, visible, message) {
      this.calls.push(["ready", ready, visible, message]);
    },
    renderVisibility(visible) {
      this.calls.push(["visibility", visible]);
    },
    renderStatus(message) {
      this.calls.push(["status", message]);
    },
    renderError(error, recovery) {
      this.calls.push(["error", error.message, recovery]);
    },
    focusFile() {
      this.calls.push(["focusFile"]);
    },
  };
}

/**
 * Create an inspectable one-layer controller.
 *
 * @return {Object} Fake temporary-AOI Leaflet lifecycle.
 */
function createLayerController() {
  return {
    isVisible: false,
    calls: [],
    load(ready) {
      this.calls.push(["load", ready]);
      this.isVisible = true;
    },
    show() {
      this.calls.push(["show"]);
      this.isVisible = true;
      return true;
    },
    hide() {
      this.calls.push(["hide"]);
      this.isVisible = false;
      return true;
    },
    zoom() {
      this.calls.push(["zoom"]);
      return true;
    },
    clear() {
      this.calls.push(["clear"]);
      this.isVisible = false;
    },
  };
}

/**
 * Create a deterministic timeout collaborator.
 *
 * @return {Object} Fake clock with inspectable scheduled callbacks.
 */
function createClock() {
  return {
    nextId: 1,
    timers: new Map(),
    setTimeout(callback, delay) {
      const id = this.nextId++;
      this.timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      this.timers.delete(id);
    },
    run(id) {
      const timer = this.timers.get(id);
      this.timers.delete(id);
      timer.callback();
    },
  };
}

/**
 * Create a coordinator with injectable API operations and inspectable adapters.
 *
 * @param {Object} apiClient Fake temporary-AOI API client.
 * @return {{coordinator: TemporaryAoiCoordinator, view: Object,
 * layer: Object, clock: Object}} Coordinator fixture.
 */
function createCoordinator(apiClient) {
  const view = createView();
  const layer = createLayerController();
  const clock = createClock();
  const coordinator = new TemporaryAoiCoordinator({}, {}, {
    apiClient,
    controlsView: view,
    layerController: layer,
    clock,
    now: () => Date.parse("2030-01-01T00:00:00Z"),
  });
  return { clock, coordinator, layer, view };
}

test("upload progress reports bytes and capped approximate server stages", async () => {
  let resolveUpload;
  const fixture = createCoordinator({
    upload(file, _replacementId, onProgress) {
      onProgress({
        loadedBytes: file.size / 2,
        totalBytes: file.size,
        uploadComplete: false,
      });
      onProgress({
        loadedBytes: file.size,
        totalBytes: file.size,
        uploadComplete: true,
      });
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    },
  });

  const upload = fixture.coordinator.handleUpload(createEvent());
  const initialProgress = fixture.view.calls.filter(
    (call) => call[0] === "progress",
  );
  assert.equal(initialProgress[1][1].transferPercent, 50);
  assert.equal(initialProgress[1][1].approximatePercent, 35);
  assert.equal(initialProgress[2][1].transferPercent, 100);
  assert.equal(initialProgress[2][1].approximatePercent, 75);

  const stageTimers = [...fixture.clock.timers.keys()];
  fixture.clock.run(stageTimers[0]);
  fixture.clock.run(stageTimers[1]);
  const stagedProgress = fixture.view.calls.filter(
    (call) => call[0] === "progress",
  );
  assert.equal(stagedProgress.at(-2)[1].approximatePercent, 85);
  assert.match(stagedProgress.at(-2)[1].stageMessage, /validating spatial/);
  assert.equal(stagedProgress.at(-1)[1].approximatePercent, 92);
  assert.match(stagedProgress.at(-1)[1].stageMessage, /WGS 84/);

  resolveUpload(READY_AOI);
  await upload;

  assert.equal(fixture.coordinator.uploadProgressTimers.size, 0);
  assert.equal(fixture.coordinator.activeAoi, READY_AOI);
});

test("single-dataset upload displays and zooms one independent AOI", async () => {
  const uploads = [];
  const fixture = createCoordinator({
    async upload(file, replacementId) {
      uploads.push({ file, replacementId });
      return READY_AOI;
    },
  });

  const event = createEvent();
  await fixture.coordinator.handleUpload(event);

  assert.equal(event.prevented, true);
  assert.deepEqual(uploads, [{ file: fixture.view.file, replacementId: null }]);
  assert.equal(fixture.coordinator.activeAoi, READY_AOI);
  assert.deepEqual(fixture.layer.calls, [["load", READY_AOI]]);
  assert.equal(
    fixture.view.calls.some(
      (call) => call[0] === "ready" && call[1] === READY_AOI && call[2] === true,
    ),
    true,
  );
});

test("multi-dataset upload cannot render until its explicit choice succeeds", async () => {
  const selections = [];
  const fixture = createCoordinator({
    async upload() {
      return PENDING_AOI;
    },
    async selectDataset(id, choiceId) {
      selections.push({ id, choiceId });
      return READY_AOI;
    },
  });

  await fixture.coordinator.handleUpload(createEvent());

  assert.equal(fixture.coordinator.pendingUpload, PENDING_AOI);
  assert.deepEqual(fixture.layer.calls, []);
  assert.equal(
    fixture.view.calls.some((call) => call[0] === "selection"),
    true,
  );

  await fixture.coordinator.handleDatasetSelection(createEvent());

  assert.deepEqual(selections, [
    { id: "aoi_pending", choiceId: "choice_two" },
  ]);
  assert.equal(fixture.coordinator.pendingUpload, null);
  assert.equal(fixture.coordinator.activeAoi, READY_AOI);
  assert.deepEqual(fixture.layer.calls, [["load", READY_AOI]]);
});

test("dataset-selection failure discards invalid pending state and restores old AOI", async () => {
  let uploadCount = 0;
  const fixture = createCoordinator({
    async upload() {
      uploadCount += 1;
      return uploadCount === 1 ? READY_AOI : PENDING_AOI;
    },
    async selectDataset() {
      throw new Error("Selected geometry could not be simplified.");
    },
  });

  await fixture.coordinator.handleUpload(createEvent());
  await fixture.coordinator.handleUpload(createEvent());
  await fixture.coordinator.handleDatasetSelection(createEvent());

  assert.equal(fixture.coordinator.pendingUpload, null);
  assert.equal(fixture.coordinator.activeAoi, READY_AOI);
  assert.equal(
    fixture.view.calls.some(
      (call) => call[0] === "error" &&
        call[1].includes("could not be simplified") &&
        call[2].includes("Upload the file again"),
    ),
    true,
  );
  assert.equal(
    fixture.view.calls.at(-2)[0],
    "ready",
  );
});

test("canceling dataset selection removes pending storage and returns to upload", async () => {
  const removed = [];
  const fixture = createCoordinator({
    async upload() {
      return PENDING_AOI;
    },
    async remove(id) {
      removed.push(id);
    },
  });

  await fixture.coordinator.handleUpload(createEvent());
  await fixture.coordinator.handleCancelSelection(createEvent());

  assert.deepEqual(removed, ["aoi_pending"]);
  assert.equal(fixture.coordinator.pendingUpload, null);
  assert.equal(fixture.coordinator.activeAoi, null);
  assert.deepEqual(fixture.view.calls.at(-1), ["idle", "Pending upload canceled."]);
});

test("failed replacement preserves the active AOI and its map layer", async () => {
  let uploadCount = 0;
  const replacements = [];
  const fixture = createCoordinator({
    async upload(_file, replacementId) {
      replacements.push(replacementId);
      uploadCount += 1;
      if (uploadCount === 2) {
        throw new Error("Replacement has an unsupported CRS.");
      }
      return READY_AOI;
    },
  });

  await fixture.coordinator.handleUpload(createEvent());
  await fixture.coordinator.handleUpload(createEvent());

  assert.deepEqual(replacements, [null, "aoi_ready"]);
  assert.equal(fixture.coordinator.activeAoi, READY_AOI);
  assert.deepEqual(fixture.layer.calls, [["load", READY_AOI]]);
  assert.equal(
    fixture.view.calls.some(
      (call) => call[0] === "error" && call[1].includes("unsupported CRS"),
    ),
    true,
  );
});

test("show, hide, zoom, and removal own only temporary AOI state", async () => {
  const removed = [];
  const fixture = createCoordinator({
    async upload() {
      return READY_AOI;
    },
    async remove(id) {
      removed.push(id);
    },
  });
  await fixture.coordinator.handleUpload(createEvent());

  fixture.coordinator.handleToggleVisibility(createEvent());
  fixture.coordinator.handleToggleVisibility(createEvent());
  fixture.coordinator.handleZoom(createEvent());
  await fixture.coordinator.handleRemove(createEvent());

  assert.deepEqual(
    fixture.layer.calls.map((call) => call[0]),
    ["load", "hide", "show", "zoom", "clear"],
  );
  assert.deepEqual(removed, ["aoi_ready"]);
  assert.equal(fixture.coordinator.activeAoi, null);
  assert.deepEqual(fixture.view.calls.at(-2), ["idle", "Temporary AOI removed."]);
  assert.deepEqual(fixture.view.calls.at(-1), ["focusFile"]);
});

test("expiration removes browser geometry without requiring persisted page state", async () => {
  const fixture = createCoordinator({
    async upload() {
      return READY_AOI;
    },
  });
  await fixture.coordinator.handleUpload(createEvent());
  const expirationTimer = fixture.coordinator.activeExpirationTimer;

  fixture.clock.run(expirationTimer);

  assert.equal(fixture.coordinator.activeAoi, null);
  assert.deepEqual(fixture.layer.calls.at(-1), ["clear"]);
  assert.deepEqual(fixture.view.calls.at(-1), [
    "idle",
    "Temporary AOI expired and was removed from the map.",
  ]);
});

test("destroyed coordinator deletes a successful stale upload response", async () => {
  let resolveUpload;
  const removed = [];
  const fixture = createCoordinator({
    upload() {
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    },
    async remove(id) {
      removed.push(id);
    },
  });

  const upload = fixture.coordinator.handleUpload(createEvent());
  fixture.coordinator.destroy();
  resolveUpload(REPLACEMENT_AOI);
  await upload;

  assert.deepEqual(removed, ["aoi_replacement"]);
  assert.equal(fixture.view.handlers, null);
  assert.equal(fixture.coordinator.activeAoi, null);
});

test("sampling subscribers ignore overlay visibility and follow AOI lifecycle", async () => {
  let uploadCount = 0;
  const fixture = createCoordinator({
    async upload() {
      uploadCount += 1;
      return uploadCount === 1 ? READY_AOI : REPLACEMENT_AOI;
    },
    async remove() {},
  });
  const snapshots = [];
  const unsubscribe = fixture.coordinator.subscribeSamplingArea(
    (temporaryAoi) => snapshots.push(temporaryAoi),
  );

  await fixture.coordinator.handleUpload(createEvent());
  fixture.coordinator.handleToggleVisibility(createEvent());
  fixture.coordinator.handleToggleVisibility(createEvent());
  await fixture.coordinator.handleUpload(createEvent());
  await fixture.coordinator.handleRemove(createEvent());
  unsubscribe();

  assert.equal(snapshots.length, 4);
  assert.equal(snapshots[0], null);
  assert.deepEqual(snapshots[1], {
    id: READY_AOI.id,
    filename: READY_AOI.filename,
    selectedDataset: READY_AOI.selectedDataset,
    expiresAt: READY_AOI.expiresAt,
    bounds: {
      west: READY_AOI.bbox[0],
      south: READY_AOI.bbox[1],
      east: READY_AOI.bbox[2],
      north: READY_AOI.bbox[3],
    },
  });
  assert.equal(Object.isFrozen(snapshots[1]), true);
  assert.equal(Object.isFrozen(snapshots[1].bounds), true);
  assert.equal("geometry" in snapshots[1], false);
  assert.equal(snapshots[2].id, REPLACEMENT_AOI.id);
  assert.equal(snapshots[3], null);
});
