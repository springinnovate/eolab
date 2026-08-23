/** Format-neutral Catalog assessment and mixed map-layer coordination. */

import { getCatalogVisualization } from "./catalog.js";
import { assessCatalogRaster } from "./raster/api.js";
import { assessCatalogVector } from "./vector/api.js";

/** Coordinate owned raster/vector adapters without format checks in main.js. */
export class CatalogVisualizationCoordinator {
    /**
     * Create the coordinator over the shared mixed-layer viewer.
     *
     * @param {Object} viewer Viewer exposing raster and vector retain methods.
     * @param {(item:Object)=>Promise<Object>} [assessRaster=assessCatalogRaster]
     * Raster assessment boundary.
     * @param {(item:Object)=>Promise<Object>} [assessVector=assessCatalogVector]
     * Vector assessment boundary.
     */
    constructor(
        viewer,
        assessRaster = assessCatalogRaster,
        assessVector = assessCatalogVector
    ) {
        this.viewer = viewer;
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
            ? this.viewer.show(item)
            : this.viewer.showVector(item);
    }

    /**
     * Return whether one Item is retained in the mixed layer stack.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {boolean} Whether the Item is retained.
     */
    contains(item) {
        return this.viewer.contains(item);
    }

    /**
     * Remove one retained Item from the mixed layer stack.
     *
     * @param {Object} item Retained Catalog STAC Item.
     * @return {void}
     */
    remove(item) {
        this.viewer.remove(item);
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
