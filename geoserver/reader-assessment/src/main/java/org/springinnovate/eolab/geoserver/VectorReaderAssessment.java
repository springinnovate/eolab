package org.springinnovate.eolab.geoserver;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Stable result of opening one exact vector layer through deployed GeoTools.
 *
 * @param contract versioned deployed datastore contract
 * @param compatible whether GeoTools opened the requested exact layer
 * @param reasonCode incompatibility classification, or {@code null}
 * @param geometryKind point, line, or polygon for a compatible layer
 */
public record VectorReaderAssessment(
        String contract,
        boolean compatible,
        @JsonProperty("reasonCode") String reasonCode,
        @JsonProperty("geometryKind") String geometryKind) {}

