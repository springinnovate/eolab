package org.springinnovate.eolab.geoserver;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Stable machine-readable result of one deployed GeoTIFF reader acquisition.
 *
 * @param contract versioned reader contract that produced the result
 * @param compatible whether the deployed reader acquired the raster
 * @param reasonCode incompatibility classification, or {@code null} when compatible
 */
public record RasterReaderAssessment(
        String contract,
        boolean compatible,
        @JsonProperty("reasonCode") String reasonCode) {}
