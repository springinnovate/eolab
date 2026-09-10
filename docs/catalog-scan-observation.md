# Catalog scan status recovery

The Catalog browser controls observe the authoritative `/api/scans/current`
snapshot. A transport failure does not mean the server scan stopped. The last
received scan details remain visible with a separate status-unavailable message.

Healthy active scans are checked 750 ms after each successful check. Failed
checks retry after 1, 2, 4 and 8 seconds. After those four retries, observation
waits for **Retry status check**. A successful check resets the retry budget.
Requests have a ten-second timeout. Retry reads status; it never submits another
scan. The ordinary **Scan directories** action still accepts HTTP 202, or HTTP
409 to attach to an already-running scan. If startup cannot be confirmed, the
controls offer a status check before another start can be requested.

`frontend/src/catalog-scan-controls.js:CatalogScanControls` owns this observation
and the scan buttons. It is used by browser composition, depends on the existing
scan HTTP contract and browser timers, and coordinates with Catalog search via
the injected completion callback. The detailed status renderer remains in
`frontend/src/main.js`. There are no new cross-subsystem dependencies, public API
changes, libraries, services, or connections to Processing, rendering or AOIs.

Replacing an observation aborts its request and clears its timers. Generation
checks prevent late replies from updating the current controls. Page departure
pauses observation; returning from the browser back-forward cache reads status
again without restarting the server scan. A completed scan's existing ID avoids
duplicate successful completion refreshes; overlapping checks share an ongoing
refresh. A failed Catalog refresh is reported separately and can be retried.

The recovery button has a descriptive status region. Focus moves to the scan
summary when the recovery button disappears, unless the user moved focus to
another control while waiting. Automatic status checks preserve disclosure
choices; existing scan-start/finish disclosure behavior is unchanged.

## Verification

From `frontend`:

```text
node --test test/catalog-scan-controls.test.js
node --test --test-reporter=dot
node node_modules/vite/bin/vite.js build
```

Relevant server boundary checks, from the repository root:

```text
python -m pytest tests/test_scan_routes.py tests/test_application_boundaries.py tests/test_catalog_architecture.py
```

The focused tests use the actual HTML control identities and simulate HTTP and
network errors, malformed responses, request timeout, exhausted retries, manual
recovery, 202/409 startup, uncertain POST outcomes, stale replies, page lifecycle,
refresh coalescing and disclosure/focus behavior. Browser verification should
also exercise one failed status request followed by recovery, a longer outage
that exhausts retries, and keyboard use of the manual retry control. Check that
all recovery requests are GETs, the warning disappears after recovery, and only
one successful Catalog refresh occurs for the completed scan.

Use a disposable local HTTP fixture for injected failures; do not take down the
deployed Catalog service to test browser recovery. An unavailable-status warning
does not authorize deletion of a scan, its catalog Items or its mounted data.
