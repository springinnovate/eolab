/** Portable saved-map orchestration over existing Catalog and map owners. */

import {
    decodeSavedMapViewFragment,
    encodeSavedMapViewFragment,
    isSavedMapViewFragment,
} from "./fragment-codec.js";
import {
    createSavedMapView,
    hashSavedMapSourceRevision,
    MAX_SAVED_MAP_VIEW_BYTES,
    parseSavedMapView,
    serializeSavedMapView,
} from "./model.js";

const RESTORE_CONCURRENCY = 4;

/** Coordinate shareable map views without becoming a rendering owner. */
export class SavedMapViewController {
    /**
     * Create and bind the portable saved-map coordinator.
     *
     * @param {Object} configuration Collaborating public boundaries.
     * @param {Object} configuration.view Saved-map DOM adapter.
     * @param {Object} configuration.viewport Neutral viewport adapter.
     * @param {Object} configuration.mapLayers Neutral retained-layer owner.
     * @param {Object} configuration.catalogVisualization Format-neutral
     * preparation, publication, and clearing coordinator.
     * @param {Object} configuration.catalogItems Exact Catalog Item client.
     * @param {string} configuration.viewerVersion Running application version.
     * @param {string} configuration.viewerOrigin Running application origin.
     * @param {()=>void} [configuration.beforeRestore] Composition-owned cleanup
     * for transient map presentations excluded from the portable contract.
     * @param {()=>Date} [configuration.clock] Creation-time provider.
     * @param {SubtleCrypto} [configuration.subtleCrypto] Revision hasher.
     */
    constructor({
        view,
        viewport,
        mapLayers,
        catalogVisualization,
        catalogItems,
        viewerVersion,
        viewerOrigin,
        beforeRestore = () => {},
        clock = () => new Date(),
        subtleCrypto = globalThis.crypto?.subtle,
    }) {
        this.view = view;
        this.viewport = viewport;
        this.mapLayers = mapLayers;
        this.catalogVisualization = catalogVisualization;
        this.catalogItems = catalogItems;
        this.viewerVersion = viewerVersion;
        this.viewerOrigin = viewerOrigin;
        this.beforeRestore = beforeRestore;
        this.clock = clock;
        this.subtleCrypto = subtleCrypto;
        this.busy = false;
        this.restoreGeneration = 0;
        this.destroyed = false;
        this.view.bind({
            onCopy: () => void this.copyMapLink(),
        });
    }

    /**
     * Build and copy a compressed link for the current portable map document.
     *
     * @return {Promise<void>} Completion after copy or fallback presentation.
     */
    async copyMapLink() {
        if (this.busy || this.destroyed) return;
        this.#setBusy(true);
        try {
            const layers = await Promise.all(
                this.mapLayers.retainedRecords.map(
                    async (record) => this.#exportLayer(record)
                )
            );
            const savedMapView = createSavedMapView({
                viewer: {
                    version: this.viewerVersion,
                    origin: this.viewerOrigin,
                },
                createdAt: this.clock().toISOString(),
                viewport: this.viewport.snapshot(),
                layers,
            });
            const fragment = await encodeSavedMapViewFragment(
                serializeSavedMapView(savedMapView),
                { maximumInputBytes: MAX_SAVED_MAP_VIEW_BYTES }
            );
            const result = await this.view.copyLink(fragment);
            if (result.copied) this.view.showCopied();
            else this.view.showCopyFallback(result.url);
        } catch (error) {
            this.view.showError(asError(error), "copy");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Validate and restore one shared map fragment.
     *
     * Unrelated fragments are ignored so this component does not own other
     * application anchors.
     *
     * @param {string} fragment Current browser URL fragment.
     * @return {Promise<void>} Completion after restoration.
     */
    async openSharedFragment(fragment) {
        if (!isSavedMapViewFragment(fragment)) return;
        if (this.busy || this.destroyed) return;
        const restoreGeneration = this.restoreGeneration + 1;
        this.restoreGeneration = restoreGeneration;
        this.#setBusy(true);
        try {
            const serialized = await decodeSavedMapViewFragment(fragment, {
                maximumOutputBytes: MAX_SAVED_MAP_VIEW_BYTES,
            });
            const savedMapView = parseSavedMapView(serialized);
            this.view.showLoading(savedMapView.layers.length);
            const report = await this.#restore(
                savedMapView,
                restoreGeneration
            );
            if (report !== null) {
                this.view.showResults(report);
            }
        } catch (error) {
            this.view.showError(asError(error), "open");
        } finally {
            this.#setBusy(false);
        }
    }

    /**
     * Detach UI events owned by this coordinator.
     *
     * @return {void}
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.restoreGeneration += 1;
        this.view.unbind();
    }

    /**
     * Export one layer through its feature-owned portable-style hook.
     *
     * @param {Object} record Neutral retained-layer record.
     * @return {Promise<Object>} Portable identity, revision, and presentation.
     */
    async #exportLayer(record) {
        if (typeof record.adapter.exportSavedState !== "function") {
            throw new Error(
                `${record.entry.label} cannot yet be saved as a portable layer.`
            );
        }
        return {
            catalogItem: {
                collection: record.entry.item.collection,
                id: record.entry.item.id,
            },
            sourceRevision: await hashSavedMapSourceRevision(
                this.catalogVisualization.sourceRevision(record.entry.item),
                this.subtleCrypto
            ),
            visible: record.entry.visible,
            opacity: record.entry.opacity,
            style: record.adapter.exportSavedState(record),
        };
    }

    /**
     * Prepare saved layers concurrently, restore the viewport, then commit
     * them top-first.
     *
     * @param {Object} savedMapView Validated saved-map document.
     * @param {number} restoreGeneration Current restoration generation.
     * @return {Promise<{loaded:number,total:number,details:string[]}|null>}
     * Per-layer restoration report, or null after supersession.
     */
    async #restore(savedMapView, restoreGeneration) {
        this.beforeRestore();
        this.catalogVisualization.clear();
        const preparations = await mapBounded(
            savedMapView.layers,
            RESTORE_CONCURRENCY,
            async (layer) => this.#prepareLayer(layer)
        );
        const stagedLayers = preparations
            .filter(({ staged }) => staged !== null)
            .map(({ staged }) => staged);
        if (restoreGeneration !== this.restoreGeneration) {
            return null;
        }
        this.viewport.restore(savedMapView.viewport);
        this.mapLayers.commitStaged(stagedLayers, { fitToBounds: false });
        return {
            loaded: stagedLayers.length,
            total: savedMapView.layers.length,
            details: preparations
                .map(({ detail }) => detail)
                .filter((detail) => detail !== null),
        };
    }

    /**
     * Resolve, validate, publish, and style one detached saved layer.
     *
     * @param {Object} layer Validated saved-layer document.
     * @return {Promise<{staged:Object|null,detail:string|null}>} Detached layer and
     * ordered user-facing outcome, or a failure detail without a layer.
     */
    async #prepareLayer(layer) {
        const identityLabel =
            `${layer.catalogItem.collection}/${layer.catalogItem.id}`;
        try {
            const catalogItem = await this.catalogItems.get(
                layer.catalogItem
            );
            const preparedItem = await this.catalogVisualization.prepare(
                catalogItem
            );
            const currentRevision = await hashSavedMapSourceRevision(
                this.catalogVisualization.sourceRevision(preparedItem),
                this.subtleCrypto
            );
            const changed = layer.sourceRevision !== null &&
                currentRevision !== null &&
                layer.sourceRevision !== currentRevision;
            const staged = await this.catalogVisualization.stage(
                preparedItem,
                { visible: layer.visible, opacity: layer.opacity }
            );
            const record = staged.record;
            if (typeof record.adapter.applySavedState !== "function") {
                throw new Error("Layer style restoration is unavailable.");
            }
            let styleWarning = null;
            try {
                await record.adapter.applySavedState(record, layer.style);
            } catch (error) {
                styleWarning = asError(error).message;
            }
            const notices = [];
            if (changed) notices.push("source changed; current data was used");
            if (layer.sourceRevision !== null && currentRevision === null) {
                notices.push("current source revision was unavailable");
            }
            if (styleWarning !== null) {
                notices.push(`saved style was not applied: ${styleWarning}`);
            }
            const detail = notices.length === 0
                ? null
                : `${record.entry.label}: ${notices.join("; ")}.`;
            return { staged, detail };
        } catch (error) {
            return {
                staged: null,
                detail: `${identityLabel}: ${asError(error).message}`,
            };
        }
    }

    /**
     * Update controller and view busy state together.
     *
     * @param {boolean} busy Whether a bounded operation is active.
     * @return {void}
     */
    #setBusy(busy) {
        this.busy = busy;
        this.view.setBusy(busy);
    }
}

/**
 * Map inputs through a fixed-size worker pool while preserving input order.
 *
 * @template Input, Output
 * @param {Input[]} inputs Ordered input values.
 * @param {number} concurrency Positive maximum number of active workers.
 * @param {(input:Input,index:number)=>Promise<Output>} transform Async mapper.
 * @return {Promise<Output[]>} Results in the same order as inputs.
 */
async function mapBounded(inputs, concurrency, transform) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new TypeError("Restore concurrency must be a positive integer.");
    }
    const results = new Array(inputs.length);
    let nextIndex = 0;
    async function runWorker() {
        while (nextIndex < inputs.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await transform(inputs[index], index);
        }
    }
    const workerCount = Math.min(concurrency, inputs.length);
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
}

/**
 * Convert thrown values to ordinary Error instances for presentation.
 *
 * @param {unknown} candidate Thrown value.
 * @return {Error} Safe ordinary Error instance.
 */
function asError(candidate) {
    return candidate instanceof Error
        ? candidate
        : new Error("Saved map operation failed.");
}
