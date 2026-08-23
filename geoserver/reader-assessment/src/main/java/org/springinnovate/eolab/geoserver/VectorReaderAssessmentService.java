package org.springinnovate.eolab.geoserver;

import java.io.IOException;
import java.net.URL;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import org.geotools.api.data.DataStore;
import org.geotools.api.data.DataStoreFinder;
import org.geotools.api.feature.simple.SimpleFeatureType;
import org.geotools.api.feature.type.GeometryDescriptor;
import org.locationtech.jts.geom.LineString;
import org.locationtech.jts.geom.MultiLineString;
import org.locationtech.jts.geom.MultiPoint;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Point;
import org.locationtech.jts.geom.Polygon;

/** Open mounted vector sources through the datastore factories deployed in GeoServer. */
public final class VectorReaderAssessmentService {
    /** Contract shared with EOLab's persisted vector-v1 assessment. */
    public static final String READER_CONTRACT =
            "geoserver-3.0.1-geotools-35.1-vector-v1";

    /** Stable reason for an absent format datastore factory. */
    public static final String DATASTORE_UNAVAILABLE_REASON =
            "geoserver_datastore_unavailable";

    /** Stable reason for a container that lacks the requested exact layer. */
    public static final String LAYER_MISSING_REASON = "geoserver_layer_missing";

    /** Stable reason for missing CRS metadata. */
    public static final String CRS_REASON = "geoserver_crs_metadata_incompatible";

    /** Stable reason for an unsupported or absent geometry binding. */
    public static final String GEOMETRY_REASON = "geoserver_geometry_unreadable";

    /** Stable reason for another datastore or schema acquisition failure. */
    public static final String READER_REASON = "geoserver_vector_reader_incompatible";

    /** Create a deployed datastore assessment service. */
    public VectorReaderAssessmentService() {}

    /**
     * Open one exact source layer without modifying GeoServer catalog state.
     *
     * @param sourceFormat explicit mounted source format
     * @param sourcePath canonical mounted file path
     * @param layerName exact native layer name
     * @return stable deployed-reader assessment
     */
    public VectorReaderAssessment assess(
            String sourceFormat,
            Path sourcePath,
            String layerName) {
        DataStore dataStore = null;
        try {
            dataStore = DataStoreFinder.getDataStore(
                    connectionParameters(sourceFormat, sourcePath));
            if (dataStore == null) {
                return incompatible(DATASTORE_UNAVAILABLE_REASON);
            }
            if (!Arrays.asList(dataStore.getTypeNames()).contains(layerName)) {
                return incompatible(LAYER_MISSING_REASON);
            }
            SimpleFeatureType schema = dataStore.getSchema(layerName);
            GeometryDescriptor geometry = schema.getGeometryDescriptor();
            if (geometry == null) {
                return incompatible(GEOMETRY_REASON);
            }
            if (geometry.getCoordinateReferenceSystem() == null) {
                return incompatible(CRS_REASON);
            }
            String geometryKind = geometryKind(geometry.getType().getBinding());
            if (geometryKind == null) {
                return incompatible(GEOMETRY_REASON);
            }
            return new VectorReaderAssessment(
                    READER_CONTRACT,
                    true,
                    null,
                    geometryKind);
        } catch (IOException | RuntimeException error) {
            return incompatible(READER_REASON);
        } finally {
            if (dataStore != null) {
                dataStore.dispose();
            }
        }
    }

    /**
     * Build the exact GeoTools connection parameters for a supported format.
     *
     * @param sourceFormat explicit mounted source format
     * @param sourcePath canonical mounted file path
     * @return datastore factory parameters with read-only GeoPackage access
     * @throws IOException if the Shapefile path cannot become a URL
     * @throws IllegalArgumentException if the format is unsupported
     */
    private static Map<String, Object> connectionParameters(
            String sourceFormat,
            Path sourcePath) throws IOException {
        Map<String, Object> parameters = new HashMap<>();
        if ("shapefile".equals(sourceFormat)) {
            URL sourceUrl = sourcePath.toUri().toURL();
            parameters.put("url", sourceUrl);
            parameters.put("create spatial index", false);
            return parameters;
        }
        if ("geopackage".equals(sourceFormat)) {
            parameters.put("dbtype", "geopkg");
            parameters.put("database", sourcePath.toUri().toString());
            parameters.put("read_only", true);
            parameters.put("immutable", true);
            return parameters;
        }
        throw new IllegalArgumentException("Unsupported vector source format");
    }

    /**
     * Classify one JTS binding into the fixed default-style families.
     *
     * @param geometryBinding schema geometry binding
     * @return point, line, polygon, or {@code null} when unsupported
     */
    static String geometryKind(Class<?> geometryBinding) {
        if (Point.class.isAssignableFrom(geometryBinding)
                || MultiPoint.class.isAssignableFrom(geometryBinding)) {
            return "point";
        }
        if (LineString.class.isAssignableFrom(geometryBinding)
                || MultiLineString.class.isAssignableFrom(geometryBinding)) {
            return "line";
        }
        if (Polygon.class.isAssignableFrom(geometryBinding)
                || MultiPolygon.class.isAssignableFrom(geometryBinding)) {
            return "polygon";
        }
        return null;
    }

    /**
     * Build an incompatible result with no geometry.
     *
     * @param reasonCode stable incompatibility reason
     * @return incompatible assessment under the current contract
     */
    private static VectorReaderAssessment incompatible(String reasonCode) {
        return new VectorReaderAssessment(
                READER_CONTRACT,
                false,
                reasonCode,
                null);
    }
}

