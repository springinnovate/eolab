/** Same-origin API client for authorized composite map render plans. */

/** Register immutable visible-layer plans with the application backend. */
export class CompositeMapPlanClient {
    /**
     * Create the client.
     *
     * @param {string} [url="/api/map-rendering/plans"] Plan endpoint.
     */
    constructor(url = "/api/map-rendering/plans") {
        this.url = url;
    }

    /**
     * Authorize one complete top-first visible-layer plan.
     *
     * @param {Object[]} layers Feature-owned render descriptors with neutral
     * opacity already applied.
     * @param {AbortSignal} signal Cancellation for a superseded presentation.
     * @return {Promise<{planId:string,wmsUrl:string}>} Published plan identity.
     * @throws {Error} If the backend rejects or cannot publish the plan.
     */
    async create(layers, signal) {
        const response = await fetch(this.url, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ layers }),
            signal,
        });
        if (!response.ok) {
            let detail = `Composite map preparation returned ${response.status}.`;
            try {
                const error = await response.json();
                if (typeof error?.detail === "string" && error.detail.length > 0) {
                    detail = error.detail;
                }
            } catch {
                // Preserve the bounded status-based fallback for non-JSON errors.
            }
            throw new Error(detail);
        }
        const plan = await response.json();
        if (
            typeof plan?.planId !== "string" ||
            !/^[0-9a-f]{64}$/.test(plan.planId) ||
            plan.wmsUrl !== `/api/map-rendering/plans/${plan.planId}/wms`
        ) {
            throw new Error("Composite map preparation returned an invalid plan.");
        }
        return Object.freeze(plan);
    }
}
