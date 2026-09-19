/** Same-origin transport for temporary annotation sessions. */
export class AnnotationSessionsApi {
    /** @param {typeof fetch} [fetcher=globalThis.fetch] Browser HTTP transport. */
    constructor(fetcher = globalThis.fetch.bind(globalThis)) { this.fetcher = fetcher; }

    /**
     * Send one bounded session request with automatic browser credentials.
     * @param {string} path Relative session API path.
     * @param {string} [method="GET"] HTTP method.
     * @param {Object} [body] JSON request body.
     * @return {Promise<Object|null>} Parsed response, or null for a completed command.
     * @throws {Error & {status?:number}} If transport, authorization or input validation fails.
     */
    async request(path = "", method = "GET", body) {
        const response = await this.fetcher(`/api/annotation-sessions${path}`, {
            method, credentials: "same-origin", cache: "no-store",
            headers: { "Content-Type": "application/json", "X-EOLab-Annotations": "1" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(20000),
        });
        if (response.status === 204) return null;
        const data = await response.json();
        if (!response.ok) {
            const detail = data.detail;
            const message = typeof detail === "string" ? detail : Array.isArray(detail)
                ? detail.map(error => `${error.loc?.slice(1).join(" · ")}: ${error.msg}`).join("; ")
                : "Shared annotations are unavailable. Try again.";
            throw Object.assign(new Error(message), { status: response.status });
        }
        return data;
    }
}
