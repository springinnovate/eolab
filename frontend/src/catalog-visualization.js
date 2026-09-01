/** Format-neutral Catalog assessment and mixed map-layer coordination. */

import { getCatalogVisualization } from "./catalog.js";
import { assessCatalogRaster } from "./raster/api.js";
import { assessCatalogVector } from "./vector/api.js";

/** Coordinate dataset adapters without placing format checks in composition. */
export class CatalogVisualizationCoordinator {
    /**
     * Create the coordinator over the shared mixed-layer viewer.
     *
     * @param {Object} rasterViewer Raster-owned map and analysis boundary.
     * @param {Object} mapLayerController Neutral retained-layer controller.
     * @param {Object} vectorMapLayerAdapter Focused vector map-layer adapter.
     * @param {(item:Object)=>Promise<Object>} [assessRaster=assessCatalogRaster]
     * Raster assessment boundary.
     * @param {(item:Object)=>Promise<Object>} [assessVector=assessCatalogVector]
     * Vector assessment boundary.
     */
    constructor(
        rasterViewer,
        mapLayerController,
        vectorMapLayerAdapter,
        assessRaster = assessCatalogRaster,
        assessVector = assessCatalogVector
    ) {
        this.rasterViewer = rasterViewer;
        this.mapLayerController = mapLayerController;
        this.vectorMapLayerAdapter = vectorMapLayerAdapter;
        this.assessors = Object.freeze({
            raster: assessRaster,
            vector: assessVector,
        });
    }

    /**
     * Return the supported kind and current assessment for one Item.
     *
     * @param {Object|null} item Selected STAC Item.
     * @return {{kind:"raster"|"vector",metadata:Object|undefined}|null}
     * Visualization descriptor or null when unsupported.
     */
    describe(item) {
        return getCatalogVisualization(item);
    }

    /**
     * Assess one Item through its explicitly owned adapter.
     *
     * @param {Object} item Selected supported STAC Item.
     * @return {Promise<Object>} Updated authoritative assessed Item.
     * @throws {TypeError} If the Item has no visualization adapter.
     */
    assess(item) {
        const descriptor = this.#requireDescriptor(item);
        return this.assessors[descriptor.kind](item);
    }

    /**
     * Publish and retain one Item in the shared mixed layer lifecycle.
     *
     * @param {Object} item Selected supported and eligible STAC Item.
     * @return {Promise<Object|null>} Publication or null after invalidation.
     * @throws {TypeError} If the Item has no visualization adapter.
     */
    show(item) {
        const descriptor = this.#requireDescriptor(item);
        return descriptor.kind === "raster"
            ? this.rasterViewer.show(item)
            : this.mapLayerController.show(item, this.vectorMapLayerAdapter);
    }

    /**
     * Return whether one Item is retained in the mixed layer stack.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {boolean} Whether the Item is retained.
     */
    contains(item) {
        return this.mapLayerController.contains(item);
    }

    /**
     * Remove one retained Item from the mixed layer stack.
     *
     * @param {Object} item Retained Catalog STAC Item.
     * @return {void}
     */
    remove(item) {
        this.mapLayerController.remove(item);
    }

    /**
     * Clear mixed retained layers and raster-owned interaction state.
     *
     * @return {void}
     */
    clear() {
        this.rasterViewer.clear();
        this.mapLayerController.clear();
    }

    /**
     * Return a user-facing dataset noun for one supported Item.
     *
     * @param {Object} item Supported Catalog STAC Item.
     * @return {"raster"|"vector layer"} Dataset noun.
     */
    noun(item) {
        return this.#requireDescriptor(item).kind === "raster"
            ? "raster"
            : "vector layer";
    }

    /**
     * Return the scanner-owned source revision for compatibility checks.
     *
     * The revision is an opaque value. Consumers must not infer paths or
     * rendering authorization from its structure.
     *
     * @param {Object} item Supported, assessed Catalog Item.
     * @return {unknown|null} Opaque revision or null when not supplied.
     */
    sourceRevision(item) {
        return this.#requireDescriptor(item).metadata?.source_signature ?? null;
    }

    /**
     * Require one supported visualization descriptor.
     *
     * @param {Object} item Candidate Catalog STAC Item.
     * @return {{kind:"raster"|"vector",metadata:Object|undefined}}
     * Supported descriptor.
     * @throws {TypeError} If no owned visualization adapter exists.
     */
    #requireDescriptor(item) {
        const descriptor = this.describe(item);
        if (descriptor === null) {
            throw new TypeError("Catalog Item has no map visualization adapter.");
        }
        return descriptor;
    }
}
