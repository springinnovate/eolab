/** Portable saved-map orchestration over existing Catalog and map owners. */

import { getCatalogItemKey } from "../catalog-item-identity.js";
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
        if (this.busy) return;
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
        if (this.busy) return;
        this.#setBusy(true);
        try {
            const serialized = await decodeSavedMapViewFragment(fragment, {
                maximumOutputBytes: MAX_SAVED_MAP_VIEW_BYTES,
            });
            const savedMapView = parseSavedMapView(serialized);
            this.view.showLoading(savedMapView.layers.length);
            const report = await this.#restore(savedMapView);
            this.view.showResults(report);
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
     * Restore every saved layer bottom-first, then restore the viewport.
     *
     * @param {Object} savedMapView Validated saved-map document.
     * @return {Promise<{loaded:number,total:number,details:string[]}>}
     * Per-layer restoration report.
     */
    async #restore(savedMapView) {
        this.beforeRestore();
        this.catalogVisualization.clear();
        const outcomes = new Array(savedMapView.layers.length);
        let loaded = 0;
        const reversedLayers = [...savedMapView.layers]
            .map((layer, index) => ({ layer, index }))
            .reverse();
        for (const { layer, index } of reversedLayers) {
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
                const publication = await this.catalogVisualization.show(
                    preparedItem
                );
                if (publication === null) {
                    throw new Error("Layer publication was superseded.");
                }
                const key = getCatalogItemKey(preparedItem);
                const record = this.mapLayers.getRecord(key);
                if (record === null ||
                    typeof record.adapter.applySavedState !== "function") {
                    throw new Error("Layer style restoration is unavailable.");
                }
                let styleWarning = null;
                try {
                    await record.adapter.applySavedState(record, layer.style);
                } catch (error) {
                    styleWarning = asError(error).message;
                }
                this.mapLayers.setOpacity(key, layer.opacity);
                if (record.entry.visible !== layer.visible) {
                    this.mapLayers.setVisible(key, layer.visible);
                }
                this.mapLayers.render();
                loaded += 1;
                const notices = [];
                if (changed) notices.push("source changed; current data was used");
                if (layer.sourceRevision !== null && currentRevision === null) {
                    notices.push("current source revision was unavailable");
                }
                if (styleWarning !== null) {
                    notices.push(`saved style was not applied: ${styleWarning}`);
                }
                if (notices.length > 0) {
                    outcomes[index] =
                        `${record.entry.label}: ${notices.join("; ")}.`;
                }
            } catch (error) {
                outcomes[index] = `${identityLabel}: ${asError(error).message}`;
            }
        }
        this.viewport.restore(savedMapView.viewport);
        return {
            loaded,
            total: savedMapView.layers.length,
            details: outcomes.filter((detail) => detail !== undefined),
        };
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
