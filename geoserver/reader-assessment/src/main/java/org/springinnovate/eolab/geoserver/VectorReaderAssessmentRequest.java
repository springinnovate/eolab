package org.springinnovate.eolab.geoserver;

/**
 * Exact mounted vector source and layer requested by the EOLab application.
 *
 * @param sourceUri file URI below the shared read-only scan mount
 * @param sourceFormat explicit {@code shapefile} or {@code geopackage} format
 * @param layerName exact native layer name selected by the catalog Item
 */
public record VectorReaderAssessmentRequest(
        String sourceUri,
        String sourceFormat,
        String layerName) {}
