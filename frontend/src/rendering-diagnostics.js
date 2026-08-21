const RENDERING_DIAGNOSTICS_STATES = Object.freeze(
    new Set(["ready", "busy", "degraded", "unavailable"])
);
const RECENT_GET_MAP_LIMIT = 100;

export const RENDERING_DIAGNOSTICS_EXPANDED_POLL_MILLISECONDS = 5000;
export const RENDERING_DIAGNOSTICS_COLLAPSED_POLL_MILLISECONDS = 60000;

const STATE_LABELS = Object.freeze({
    ready: "Ready",
    busy: "Busy",
    degraded: "Degraded",
    unavailable: "Unavailable"
});
const STATE_CLASSES = Object.freeze([
    "is-ready",
    "is-busy",
    "is-degraded",
    "is-unavailable"
]);

/**
 * @typedef {Object} RenderingDiagnostics
 * @property {"ready"|"busy"|"degraded"|"unavailable"} state Server-owned
 * rendering state.
 * @property {string} observedAt UTC time when EOLab sampled the metrics.
 * @property {Object|null} metrics Allowlisted current metrics, or null when
 * diagnostics are unavailable.
 */

function requireObject(value, fieldName) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${fieldName} must be an object.`);
    }
    return value;
}

function requireFiniteNumber(value, fieldName, minimum = 0, maximum = Infinity) {
    if (
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum
    ) {
        throw new Error(`${fieldName} is outside its numeric contract.`);
    }
    return value;
}

function requireInteger(value, fieldName, minimum = 0, maximum = Infinity) {
    if (
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
    ) {
        throw new Error(`${fieldName} is outside its integer contract.`);
    }
    return value;
}

function requireUtcTimestamp(value) {
    const hasUtcOffset =
        typeof value === "string" && /(?:Z|[+-]00:00)$/.test(value);
    if (!hasUtcOffset || !Number.isFinite(Date.parse(value))) {
        throw new Error("observedAt must be a UTC timestamp.");
    }
    return value;
}

/**
 * Validate the browser-safe diagnostics response at the network boundary.
 * Unknown response fields are deliberately discarded.
 *
 * @param {unknown} document Response JSON.
 * @return {RenderingDiagnostics} Canonical rendering diagnostics.
 * @throws {Error} If the response violates the documented contract.
 */
export function parseRenderingDiagnostics(document) {
    const response = requireObject(document, "Rendering diagnostics");
    if (!RENDERING_DIAGNOSTICS_STATES.has(response.state)) {
        throw new Error("Rendering diagnostics state is unknown.");
    }
    const observedAt = requireUtcTimestamp(response.observedAt);

    if (response.state === "unavailable") {
        if (response.metrics !== null) {
            throw new Error("Unavailable rendering diagnostics must not include metrics.");
        }
        return { state: response.state, observedAt, metrics: null };
    }

    const metrics = requireObject(response.metrics, "metrics");
    const heap = requireObject(metrics.heap, "metrics.heap");
    const cpu = requireObject(metrics.cpu, "metrics.cpu");
    const garbageCollection = requireObject(
        metrics.garbageCollection,
        "metrics.garbageCollection"
    );
    const threads = requireObject(metrics.threads, "metrics.threads");
    const requests = requireObject(metrics.requests, "metrics.requests");
    const heapUsedBytes = requireInteger(
        heap.usedBytes,
        "metrics.heap.usedBytes"
    );
    const heapCommittedBytes = requireInteger(
        heap.committedBytes,
        "metrics.heap.committedBytes"
    );
    const heapMaxBytes = requireInteger(
        heap.maxBytes,
        "metrics.heap.maxBytes",
        1
    );
    if (
        heapUsedBytes > heapCommittedBytes ||
        heapCommittedBytes > heapMaxBytes
    ) {
        throw new Error("metrics.heap byte values are not ordered.");
    }
    const recentWindowSize = requireInteger(
        requests.recentWindowSize,
        "metrics.requests.recentWindowSize",
        0,
        RECENT_GET_MAP_LIMIT
    );
    const recentGetMapFailures = requireInteger(
        requests.recentGetMapFailures,
        "metrics.requests.recentGetMapFailures",
        0,
        recentWindowSize
    );

    return {
        state: response.state,
        observedAt,
        metrics: {
            heap: {
                usedBytes: heapUsedBytes,
                committedBytes: heapCommittedBytes,
                maxBytes: heapMaxBytes,
                usedPercent: requireFiniteNumber(
                    heap.usedPercent,
                    "metrics.heap.usedPercent",
                    0,
                    100
                )
            },
            cpu: {
                processLoadPercent: requireFiniteNumber(
                    cpu.processLoadPercent,
                    "metrics.cpu.processLoadPercent",
                    0,
                    100
                )
            },
            garbageCollection: {
                count: requireInteger(
                    garbageCollection.count,
                    "metrics.garbageCollection.count"
                ),
                seconds: requireFiniteNumber(
                    garbageCollection.seconds,
                    "metrics.garbageCollection.seconds"
                )
            },
            threads: {
                live: requireInteger(
                    threads.live,
                    "metrics.threads.live"
                )
            },
            uptimeSeconds: requireFiniteNumber(
                metrics.uptimeSeconds,
                "metrics.uptimeSeconds"
            ),
            requests: {
                activeGetMap: requireInteger(
                    requests.activeGetMap,
                    "metrics.requests.activeGetMap"
                ),
                concurrencyLimit: requireInteger(
                    requests.concurrencyLimit,
                    "metrics.requests.concurrencyLimit",
                    1
                ),
                completedGetMap: requireInteger(
                    requests.completedGetMap,
                    "metrics.requests.completedGetMap"
                ),
                latestGetMapSeconds:
                    requests.latestGetMapSeconds === null
                        ? null
                        : requireFiniteNumber(
                            requests.latestGetMapSeconds,
                            "metrics.requests.latestGetMapSeconds"
                        ),
                recentGetMapFailures,
                recentWindowSize
            }
        }
    };
}

/** Load and validate EOLab's browser-safe rendering summary. */
export async function loadRenderingDiagnostics(
    signal,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/diagnostics",
        {
            headers: { Accept: "application/json" },
            signal
        }
    );
    if (!response.ok) {
        throw new Error(`Rendering diagnostics returned ${response.status}`);
    }
    return parseRenderingDiagnostics(await response.json());
}

function formatNumber(value, maximumFractionDigits = 2) {
    return value.toLocaleString("en-US", { maximumFractionDigits });
}

/** Format bytes using explicit IEC units. */
export function formatDiagnosticBytes(bytes) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let unitIndex = 0;
    let quantity = bytes;
    while (quantity >= 1024 && unitIndex < units.length - 1) {
        quantity /= 1024;
        unitIndex += 1;
    }
    const maximumFractionDigits =
        unitIndex === 0 || quantity >= 100 ? 0 : quantity >= 10 ? 1 : 2;
    return `${formatNumber(quantity, maximumFractionDigits)} ${units[unitIndex]}`;
}

/** Format a metric duration while keeping its displayed unit explicit. */
export function formatDiagnosticSeconds(seconds) {
    if (seconds < 1) {
        const milliseconds = seconds * 1000;
        const maximumFractionDigits =
            milliseconds >= 100 ? 0 : milliseconds >= 10 ? 1 : 2;
        return `${formatNumber(milliseconds, maximumFractionDigits)} ms`;
    }
    if (seconds < 60) {
        return `${formatNumber(seconds, 2)} s`;
    }
    const wholeMinutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds - wholeMinutes * 60;
    return remainingSeconds === 0
        ? `${formatNumber(wholeMinutes, 0)} min`
        : `${formatNumber(wholeMinutes, 0)} min ${formatNumber(remainingSeconds, 2)} s`;
}

/** Format JVM uptime without implying sub-second precision. */
export function formatDiagnosticUptime(seconds) {
    const wholeSeconds = Math.floor(seconds);
    if (wholeSeconds < 60) {
        return `${wholeSeconds} s`;
    }
    const wholeMinutes = Math.floor(wholeSeconds / 60);
    if (wholeMinutes < 60) {
        return `${wholeMinutes} min ${wholeSeconds % 60} s`;
    }
    const wholeHours = Math.floor(wholeMinutes / 60);
    if (wholeHours < 24) {
        return `${wholeHours} h ${wholeMinutes % 60} min`;
    }
    const wholeDays = Math.floor(wholeHours / 24);
    return `${wholeDays} d ${wholeHours % 24} h`;
}

function formatObservedAt(observedAt) {
    const isoTimestamp = new Date(observedAt).toISOString();
    return `${isoTimestamp.slice(0, 10)} ${isoTimestamp.slice(11, 19)} UTC`;
}

function unavailableMetricValues() {
    return {
        heap: "Not available",
        cpu: "Not available",
        requests: "Not available",
        latestGetMap: "Not available",
        failures: "Not available",
        garbageCollection: "Not available",
        threads: "Not available",
        uptime: "Not available"
    };
}

/** Build fixed display copy from one validated diagnostics document. */
export function buildRenderingDiagnosticsViewModel(diagnostics) {
    const baseViewModel = {
        state: diagnostics.state,
        stateClass: `is-${diagnostics.state}`,
        statusText: `Rendering: ${STATE_LABELS[diagnostics.state]}`,
        observedAt: diagnostics.observedAt,
        observedAtText: formatObservedAt(diagnostics.observedAt),
        observedAtVerb:
            diagnostics.state === "unavailable" ? "Checked" : "Sampled"
    };
    if (diagnostics.state === "unavailable") {
        return { ...baseViewModel, values: unavailableMetricValues() };
    }

    const { heap, cpu, garbageCollection, threads, requests } =
        diagnostics.metrics;
    return {
        ...baseViewModel,
        values: {
            heap:
                `${formatDiagnosticBytes(heap.usedBytes)} used / ` +
                `${formatDiagnosticBytes(heap.committedBytes)} committed / ` +
                `${formatDiagnosticBytes(heap.maxBytes)} max ` +
                `(${formatNumber(heap.usedPercent, 1)}%)`,
            cpu: `${formatNumber(cpu.processLoadPercent, 1)}%`,
            requests:
                `${requests.activeGetMap.toLocaleString("en-US")} active · ` +
                `render limit ${requests.concurrencyLimit.toLocaleString("en-US")} · ` +
                `${requests.completedGetMap.toLocaleString("en-US")} completed`,
            latestGetMap:
                requests.latestGetMapSeconds === null
                    ? "None recorded"
                    : formatDiagnosticSeconds(requests.latestGetMapSeconds),
            failures:
                `${requests.recentGetMapFailures.toLocaleString("en-US")} / ` +
                `${requests.recentWindowSize.toLocaleString("en-US")} recent GetMaps`,
            garbageCollection:
                `${garbageCollection.count.toLocaleString("en-US")} collections · ` +
                `${formatDiagnosticSeconds(garbageCollection.seconds)} total`,
            threads: `${threads.live.toLocaleString("en-US")} live`,
            uptime: formatDiagnosticUptime(diagnostics.metrics.uptimeSeconds)
        }
    };
}

/** Build the generic state used when EOLab's summary endpoint cannot be read. */
export function buildUnavailableRenderingDiagnosticsViewModel() {
    return {
        state: "unavailable",
        stateClass: "is-unavailable",
        statusText: "Rendering: Unavailable",
        observedAt: null,
        observedAtText: null,
        observedAtVerb: null,
        values: unavailableMetricValues()
    };
}

/**
 * Apply one complete diagnostics view model to its owned DOM elements.
 *
 * @param {Object} elements Diagnostics elements resolved by the page owner.
 * @param {Object} viewModel Safe display state built by this module.
 * @return {void}
 */
export function applyRenderingDiagnosticsViewModel(elements, viewModel) {
    const stateChanged =
        elements.stateText.textContent !== viewModel.statusText;
    elements.disclosure.classList.remove(...STATE_CLASSES);
    elements.disclosure.classList.add(viewModel.stateClass);
    elements.stateText.textContent = viewModel.statusText;
    if (stateChanged) {
        elements.stateAnnouncement.textContent = viewModel.statusText;
    }
    for (const [metricName, metricValue] of Object.entries(viewModel.values)) {
        elements.values[metricName].textContent = metricValue;
    }
    elements.observed.hidden = viewModel.observedAt === null;
    if (viewModel.observedAt !== null) {
        elements.observedVerb.textContent = viewModel.observedAtVerb;
        elements.observedAt.dateTime = viewModel.observedAt;
        elements.observedAt.textContent = viewModel.observedAtText;
    } else {
        elements.observedAt.removeAttribute("datetime");
        elements.observedAt.textContent = "";
    }
}

/**
 * Poll rendering diagnostics without overlapping requests.
 * Page visibility and disclosure state are supplied by the DOM owner.
 */
export class RenderingDiagnosticsPoller {
    constructor(
        loadDiagnostics,
        onDiagnostics,
        onUnavailable,
        { clock = globalThis } = {}
    ) {
        this.loadDiagnostics = loadDiagnostics;
        this.onDiagnostics = onDiagnostics;
        this.onUnavailable = onUnavailable;
        this.clock = clock;
        this.pageVisible = null;
        this.expanded = null;
        this.timeoutId = null;
        this.abortController = null;
        this.requestSequence = 0;
        this.hasPolled = false;
        this.refreshWhenIdle = false;
        this.stopped = false;
    }

    /** Apply the current browser visibility and disclosure state. */
    setMode({ pageVisible, expanded }) {
        if (
            this.stopped ||
            (pageVisible === this.pageVisible && expanded === this.expanded)
        ) {
            return;
        }
        const wasVisible = this.pageVisible === true;
        const wasExpanded = this.expanded === true;
        this.pageVisible = pageVisible;
        this.expanded = expanded;
        this.#clearTimeout();

        if (!pageVisible) {
            this.refreshWhenIdle = false;
            this.requestSequence += 1;
            this.abortController?.abort();
            return;
        }

        const refreshNow =
            !this.hasPolled || !wasVisible || (expanded && !wasExpanded);
        if (refreshNow) {
            if (this.abortController === null) {
                void this.#poll();
            } else if (!wasVisible) {
                this.refreshWhenIdle = true;
            }
            return;
        }
        this.#schedule();
    }

    /** Permanently cancel diagnostics work. */
    stop() {
        this.stopped = true;
        this.pageVisible = false;
        this.refreshWhenIdle = false;
        this.requestSequence += 1;
        this.#clearTimeout();
        this.abortController?.abort();
    }

    #clearTimeout() {
        if (this.timeoutId !== null) {
            this.clock.clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    #schedule() {
        if (
            this.stopped ||
            !this.pageVisible ||
            this.timeoutId !== null ||
            this.abortController !== null
        ) {
            return;
        }
        const delay = this.expanded
            ? RENDERING_DIAGNOSTICS_EXPANDED_POLL_MILLISECONDS
            : RENDERING_DIAGNOSTICS_COLLAPSED_POLL_MILLISECONDS;
        this.timeoutId = this.clock.setTimeout(() => {
            this.timeoutId = null;
            void this.#poll();
        }, delay);
    }

    async #poll() {
        if (this.stopped || !this.pageVisible || this.abortController !== null) {
            return;
        }
        this.hasPolled = true;
        const abortController = new AbortController();
        const requestSequence = ++this.requestSequence;
        this.abortController = abortController;
        try {
            const diagnostics = await this.loadDiagnostics(
                abortController.signal
            );
            if (requestSequence === this.requestSequence) {
                this.onDiagnostics(diagnostics);
            }
        } catch (error) {
            if (
                error.name !== "AbortError" &&
                requestSequence === this.requestSequence
            ) {
                this.onUnavailable();
            }
        } finally {
            if (this.abortController === abortController) {
                this.abortController = null;
            }
            if (this.stopped || !this.pageVisible) {
                return;
            }
            if (this.refreshWhenIdle) {
                this.refreshWhenIdle = false;
                void this.#poll();
                return;
            }
            this.#schedule();
        }
    }
}
