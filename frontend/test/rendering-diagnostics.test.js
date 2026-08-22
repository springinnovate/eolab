import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRenderingDiagnosticsViewModel,
  buildRenderingDiagnosticsViewModel,
  buildUnavailableRenderingDiagnosticsViewModel,
  formatDiagnosticBytes,
  formatDiagnosticSeconds,
  formatDiagnosticUptime,
  loadRenderingDiagnostics,
  parseRenderingDiagnostics,
  RENDERING_DIAGNOSTICS_COLLAPSED_POLL_MILLISECONDS,
  RENDERING_DIAGNOSTICS_EXPANDED_POLL_MILLISECONDS,
  RenderingDiagnosticsPoller,
} from "../src/rendering-diagnostics.js";

const READY_DIAGNOSTICS_DOCUMENT = {
  state: "ready",
  observedAt: "2026-08-21T20:15:30Z",
  metrics: {
    heap: {
      usedBytes: 768 * 1024 ** 2,
      committedBytes: 2 * 1024 ** 3,
      maxBytes: 4 * 1024 ** 3,
      usedPercent: 18.75,
    },
    cpu: { processLoadPercent: 21.34 },
    garbageCollection: { count: 13, seconds: 0.238 },
    threads: { live: 44 },
    uptimeSeconds: 93780,
    requests: {
      activeGetMap: 2,
      concurrencyLimit: 4,
      completedGetMap: 1234,
      latestGetMapSeconds: 0.842,
      recentGetMapFailures: 2,
      recentWindowSize: 67,
    },
  },
};

test("rendering diagnostics parser keeps only its browser-safe contract", () => {
  const diagnostics = parseRenderingDiagnostics({
    ...READY_DIAGNOSTICS_DOCUMENT,
    internalUrl: "http://geoserver:8080/geoserver",
    metrics: {
      ...READY_DIAGNOSTICS_DOCUMENT.metrics,
      exceptionMessage: "secret upstream detail",
    },
  });

  assert.deepEqual(diagnostics, READY_DIAGNOSTICS_DOCUMENT);
  assert.equal(Object.hasOwn(diagnostics, "internalUrl"), false);
  assert.equal(Object.hasOwn(diagnostics.metrics, "exceptionMessage"), false);
});

test("rendering diagnostics parser accepts the unavailable variant", () => {
  assert.deepEqual(
    parseRenderingDiagnostics({
      state: "unavailable",
      observedAt: "2026-08-21T20:15:30+00:00",
      metrics: null,
    }),
    {
      state: "unavailable",
      observedAt: "2026-08-21T20:15:30+00:00",
      metrics: null,
    },
  );
});

test("rendering diagnostics parser rejects malformed or partial metrics", () => {
  const invalidDocuments = [
    { ...READY_DIAGNOSTICS_DOCUMENT, state: "warming" },
    { ...READY_DIAGNOSTICS_DOCUMENT, observedAt: "yesterday" },
    {
      ...READY_DIAGNOSTICS_DOCUMENT,
      state: "unavailable",
    },
    { ...READY_DIAGNOSTICS_DOCUMENT, metrics: null },
    {
      ...READY_DIAGNOSTICS_DOCUMENT,
      metrics: {
        ...READY_DIAGNOSTICS_DOCUMENT.metrics,
        cpu: { processLoadPercent: NaN },
      },
    },
    {
      ...READY_DIAGNOSTICS_DOCUMENT,
      metrics: {
        ...READY_DIAGNOSTICS_DOCUMENT.metrics,
        heap: {
          ...READY_DIAGNOSTICS_DOCUMENT.metrics.heap,
          usedBytes: 0.5,
        },
      },
    },
    {
      ...READY_DIAGNOSTICS_DOCUMENT,
      metrics: {
        ...READY_DIAGNOSTICS_DOCUMENT.metrics,
        heap: {
          usedBytes: 4 * 1024 ** 3,
          committedBytes: 2 * 1024 ** 3,
          maxBytes: 1024 ** 3,
          usedPercent: 100,
        },
      },
    },
    {
      ...READY_DIAGNOSTICS_DOCUMENT,
      metrics: {
        ...READY_DIAGNOSTICS_DOCUMENT.metrics,
        requests: {
          ...READY_DIAGNOSTICS_DOCUMENT.metrics.requests,
          recentGetMapFailures: 2,
          recentWindowSize: 1,
        },
      },
    },
    {
      ...READY_DIAGNOSTICS_DOCUMENT,
      metrics: {
        ...READY_DIAGNOSTICS_DOCUMENT.metrics,
        requests: {
          ...READY_DIAGNOSTICS_DOCUMENT.metrics.requests,
          completedGetMap: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    },
  ];

  for (const document of invalidDocuments) {
    assert.throws(() => parseRenderingDiagnostics(document));
  }
});

test("loadRenderingDiagnostics requests and validates the safe summary", async () => {
  const abortController = new AbortController();
  const requests = [];
  const diagnostics = await loadRenderingDiagnostics(
    abortController.signal,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify(READY_DIAGNOSTICS_DOCUMENT), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.deepEqual(diagnostics, READY_DIAGNOSTICS_DOCUMENT);
  assert.deepEqual(requests, [
    {
      url: "/api/rendering/diagnostics",
      options: {
        headers: { Accept: "application/json" },
        signal: abortController.signal,
      },
    },
  ]);
});

test("loadRenderingDiagnostics rejects unavailable and malformed responses", async () => {
  const abortController = new AbortController();
  await assert.rejects(
    loadRenderingDiagnostics(
      abortController.signal,
      async () => new Response("", { status: 503 }),
    ),
    /returned 503/,
  );
  await assert.rejects(
    loadRenderingDiagnostics(
      abortController.signal,
      async () => new Response(JSON.stringify({ state: "ready" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

test("rendering diagnostics view model gives every state visible text", () => {
  for (const [state, label] of [
    ["ready", "Ready"],
    ["busy", "Busy"],
    ["degraded", "Degraded"],
  ]) {
    const viewModel = buildRenderingDiagnosticsViewModel({
      ...READY_DIAGNOSTICS_DOCUMENT,
      state,
    });
    assert.equal(viewModel.stateClass, `is-${state}`);
    assert.equal(viewModel.statusText, `Rendering: ${label}`);
  }

  const unavailable = buildRenderingDiagnosticsViewModel({
    state: "unavailable",
    observedAt: "2026-08-21T20:15:30Z",
    metrics: null,
  });
  assert.equal(unavailable.stateClass, "is-unavailable");
  assert.equal(unavailable.statusText, "Rendering: Unavailable");
  assert.equal(unavailable.values.heap, "Not available");
  assert.equal(unavailable.observedAtVerb, "Checked");
});

test("rendering diagnostics view model names units and metric origins", () => {
  const viewModel = buildRenderingDiagnosticsViewModel(
    READY_DIAGNOSTICS_DOCUMENT,
  );

  assert.deepEqual(viewModel, {
    state: "ready",
    stateClass: "is-ready",
    statusText: "Rendering: Ready",
    observedAt: "2026-08-21T20:15:30Z",
    observedAtText: "2026-08-21 20:15:30 UTC",
    observedAtVerb: "Sampled",
    values: {
      heap: "768 MiB used / 2 GiB committed / 4 GiB max (18.8%)",
      cpu: "21.3%",
      requests: "2 active · render limit 4 · 1,234 completed",
      latestGetMap: "842 ms",
      failures: "2 / 67 recent GetMaps",
      garbageCollection: "13 collections · 238 ms total",
      threads: "44 live",
      uptime: "1 d 2 h",
    },
  });
});

test("generic unavailability never displays stale metric values", () => {
  assert.deepEqual(buildUnavailableRenderingDiagnosticsViewModel(), {
    state: "unavailable",
    stateClass: "is-unavailable",
    statusText: "Rendering: Unavailable",
    observedAt: null,
    observedAtText: null,
    observedAtVerb: null,
    values: {
      heap: "Not available",
      cpu: "Not available",
      requests: "Not available",
      latestGetMap: "Not available",
      failures: "Not available",
      garbageCollection: "Not available",
      threads: "Not available",
      uptime: "Not available",
    },
  });
});

test("diagnostics DOM state replaces values without repeating announcements", () => {
  const elements = createDiagnosticsElements();
  const ready = buildRenderingDiagnosticsViewModel(
    READY_DIAGNOSTICS_DOCUMENT,
  );
  applyRenderingDiagnosticsViewModel(elements, ready);

  assert.equal(elements.disclosure.classList.contains("is-ready"), true);
  assert.equal(elements.stateText.textContent, "Rendering: Ready");
  assert.equal(elements.stateAnnouncement.textContent, "Rendering: Ready");
  assert.equal(elements.values.heap.textContent, ready.values.heap);
  assert.equal(elements.observed.hidden, false);
  assert.equal(elements.observedAt.dateTime, ready.observedAt);

  const busy = buildRenderingDiagnosticsViewModel({
    ...READY_DIAGNOSTICS_DOCUMENT,
    state: "busy",
  });
  applyRenderingDiagnosticsViewModel(elements, busy);
  assert.equal(elements.disclosure.classList.contains("is-ready"), false);
  assert.equal(elements.disclosure.classList.contains("is-busy"), true);
  assert.equal(elements.stateAnnouncement.textContent, "Rendering: Busy");

  elements.stateAnnouncement.textContent = "announcement unchanged";
  applyRenderingDiagnosticsViewModel(elements, busy);
  assert.equal(
    elements.stateAnnouncement.textContent,
    "announcement unchanged",
  );

  const unavailable = buildUnavailableRenderingDiagnosticsViewModel();
  applyRenderingDiagnosticsViewModel(elements, unavailable);
  assert.equal(elements.disclosure.classList.contains("is-ready"), false);
  assert.equal(elements.disclosure.classList.contains("is-unavailable"), true);
  assert.equal(elements.stateText.textContent, "Rendering: Unavailable");
  assert.equal(elements.values.heap.textContent, "Not available");
  assert.equal(elements.observed.hidden, true);
  assert.equal(elements.observedAt.textContent, "");
  assert.equal(Object.hasOwn(elements.observedAt, "dateTime"), false);
});

test("diagnostic formatters always show explicit units", () => {
  assert.equal(formatDiagnosticBytes(0), "0 B");
  assert.equal(formatDiagnosticBytes(1024), "1 KiB");
  assert.equal(formatDiagnosticBytes(1536), "1.5 KiB");
  assert.equal(formatDiagnosticBytes(4 * 1024 ** 3), "4 GiB");

  assert.equal(formatDiagnosticSeconds(0.0005), "0.5 ms");
  assert.equal(formatDiagnosticSeconds(0.842), "842 ms");
  assert.equal(formatDiagnosticSeconds(1.425), "1.43 s");
  assert.equal(formatDiagnosticSeconds(60), "1 min");
  assert.equal(formatDiagnosticSeconds(61.5), "1 min 1.5 s");

  assert.equal(formatDiagnosticUptime(45), "45 s");
  assert.equal(formatDiagnosticUptime(125), "2 min 5 s");
  assert.equal(formatDiagnosticUptime(7380), "2 h 3 min");
  assert.equal(formatDiagnosticUptime(93780), "1 d 2 h");
});

test("diagnostics poll immediately, slowly while collapsed, and quickly while open", async () => {
  const clock = createFakeClock();
  const requests = [];
  const results = [];
  const poller = new RenderingDiagnosticsPoller(
    async (signal) => {
      requests.push(signal);
      return READY_DIAGNOSTICS_DOCUMENT;
    },
    (diagnostics) => results.push(diagnostics),
    () => assert.fail("Unexpected unavailable state"),
    { clock },
  );

  poller.setMode({ pageVisible: true, expanded: false });
  await flushPromises();
  assert.equal(requests.length, 1);
  assert.equal(results.length, 1);
  assert.equal(
    clock.nextTimerAt(),
    RENDERING_DIAGNOSTICS_COLLAPSED_POLL_MILLISECONDS,
  );

  clock.advanceTo(RENDERING_DIAGNOSTICS_COLLAPSED_POLL_MILLISECONDS);
  await flushPromises();
  assert.equal(requests.length, 2);

  poller.setMode({ pageVisible: true, expanded: true });
  await flushPromises();
  assert.equal(requests.length, 3);
  assert.equal(
    clock.nextTimerAt(),
    RENDERING_DIAGNOSTICS_COLLAPSED_POLL_MILLISECONDS +
      RENDERING_DIAGNOSTICS_EXPANDED_POLL_MILLISECONDS,
  );
});

test("hidden diagnostics abort work and refresh once visible again", async () => {
  const requests = [];
  const results = [];
  const resolvers = [];
  const poller = new RenderingDiagnosticsPoller(
    (signal) => new Promise((resolve) => {
      requests.push(signal);
      resolvers.push(resolve);
    }),
    (diagnostics) => results.push(diagnostics),
    () => assert.fail("Unexpected unavailable state"),
  );

  poller.setMode({ pageVisible: true, expanded: true });
  poller.setMode({ pageVisible: false, expanded: true });
  assert.equal(requests[0].aborted, true);
  poller.setMode({ pageVisible: true, expanded: true });
  assert.equal(requests.length, 1);

  resolvers[0](READY_DIAGNOSTICS_DOCUMENT);
  await flushPromises();
  assert.deepEqual(results, []);
  assert.equal(requests.length, 2);

  poller.stop();
  assert.equal(requests[1].aborted, true);
});

test("opening diagnostics reuses an in-flight current request", async () => {
  const requests = [];
  const resolvers = [];
  const results = [];
  const poller = new RenderingDiagnosticsPoller(
    (signal) => new Promise((resolve) => {
      requests.push(signal);
      resolvers.push(resolve);
    }),
    (diagnostics) => results.push(diagnostics),
    () => assert.fail("Unexpected unavailable state"),
  );

  poller.setMode({ pageVisible: true, expanded: false });
  poller.setMode({ pageVisible: true, expanded: true });
  assert.equal(requests.length, 1);

  resolvers[0](READY_DIAGNOSTICS_DOCUMENT);
  await flushPromises();
  assert.equal(results.length, 1);
  assert.equal(requests.length, 1);
  poller.stop();
});

test("diagnostics report request failures and continue polling", async () => {
  const clock = createFakeClock();
  let unavailableCount = 0;
  const poller = new RenderingDiagnosticsPoller(
    async () => {
      throw new Error("metrics unavailable");
    },
    () => assert.fail("Unexpected diagnostics"),
    () => {
      unavailableCount += 1;
    },
    { clock },
  );

  poller.setMode({ pageVisible: true, expanded: true });
  await flushPromises();
  assert.equal(unavailableCount, 1);
  assert.equal(
    clock.nextTimerAt(),
    RENDERING_DIAGNOSTICS_EXPANDED_POLL_MILLISECONDS,
  );
});

function createFakeClock() {
  return {
    time: 0,
    nextTimerId: 1,
    timers: new Map(),
    setTimeout(callback, delay) {
      const timerId = this.nextTimerId++;
      this.timers.set(timerId, { callback, at: this.time + delay });
      return timerId;
    },
    clearTimeout(timerId) {
      this.timers.delete(timerId);
    },
    advanceTo(time) {
      this.time = time;
      for (const [timerId, timer] of this.timers) {
        if (timer.at <= time) {
          this.timers.delete(timerId);
          timer.callback();
        }
      }
    },
    nextTimerAt() {
      return Math.min(...[...this.timers.values()].map(({ at }) => at));
    },
  };
}

function createDiagnosticsElements() {
  const classNames = new Set();
  const element = (textContent = "") => ({
    textContent,
    hidden: false,
    removeAttribute(name) {
      delete this[name === "datetime" ? "dateTime" : name];
    },
  });
  return {
    disclosure: {
      classList: {
        add(...names) {
          for (const name of names) classNames.add(name);
        },
        remove(...names) {
          for (const name of names) classNames.delete(name);
        },
        contains(name) {
          return classNames.has(name);
        },
      },
    },
    stateText: element("Rendering: Checking"),
    stateAnnouncement: element(),
    observed: element(),
    observedVerb: element(),
    observedAt: element(),
    values: {
      heap: element(),
      cpu: element(),
      requests: element(),
      latestGetMap: element(),
      failures: element(),
      garbageCollection: element(),
      threads: element(),
      uptime: element(),
    },
  };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
