package org.springinnovate.eolab.geoserver;

import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.opengis.wfs.FeatureCollectionType;
import org.geoserver.config.GeoServer;
import org.geoserver.feature.RetypingFeatureCollection;
import org.geoserver.json.GeoJSONBuilder;
import org.geoserver.json.GeoJSONFeatureWriter;
import org.geoserver.wms.GetFeatureInfoRequest;
import org.geoserver.wms.featureinfo.GetFeatureInfoOutputFormat;
import org.geotools.api.feature.Feature;
import org.geotools.api.feature.simple.SimpleFeature;
import org.geotools.api.feature.simple.SimpleFeatureType;
import org.geotools.api.feature.type.GeometryDescriptor;
import org.geotools.api.referencing.FactoryException;
import org.geotools.api.referencing.crs.CoordinateReferenceSystem;
import org.geotools.api.referencing.operation.TransformException;
import org.geotools.data.DataUtilities;
import org.geotools.feature.FeatureCollection;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.locationtech.jts.geom.CoordinateSequence;
import org.locationtech.jts.geom.CoordinateSequenceFilter;
import org.locationtech.jts.geom.Geometry;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/** Encode inspected vector attributes and geographic bounds without returning geometry. */
public final class VectorFeatureInfoOutputFormat extends GetFeatureInfoOutputFormat {
    /** Private format selected by the application's authorized WMS proxy. */
    public static final String FORMAT = "application/vnd.eolab.feature-info+json";

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final GeoServer geoServer;

    /**
     * Reuse the deployed GeoServer JSON encoder and its attribute formatting settings.
     *
     * @param geoServer current GeoServer configuration
     */
    public VectorFeatureInfoOutputFormat(GeoServer geoServer) {
        super("application/json");
        this.geoServer = geoServer;
    }

    /**
     * Select this writer only for the proxy's private format, leaving ordinary JSON unchanged.
     *
     * @param requestedFormat requested GetFeatureInfo format
     * @return whether the request selects EOLab's bounds-only geometry representation
     */
    @Override
    public boolean canProduce(String requestedFormat) {
        return FORMAT.equalsIgnoreCase(requestedFormat);
    }

    /**
     * Encode already matched features with their original IDs, attributes and WGS84 bounds.
     *
     * GeoServer owns matching, source access and the feature-count limit. This writer
     * retains no geometry and opens no source. Null, empty or unprojectable geometry
     * produces a null bbox so the browser cannot mistake a click for a feature extent.
     * Secondary geometry attributes are excluded before the ordinary JSON encoder runs.
     * The private eolabProperties format option preserves the proxy's requested fields
     * as a base64url-encoded UTF-8 JSON array while geometry remains available internally.
     *
     * @param results GeoServer's bounded GetFeatureInfo result collections
     * @param request originating authorized GetFeatureInfo request
     * @param output response stream owned by GeoServer
     * @throws IOException if the result schema or response stream cannot be read or written
     */
    @Override
    public void write(FeatureCollectionType results, GetFeatureInfoRequest request,
            OutputStream output) throws IOException {
        Set<String> requestedProperties = readRequestedProperties(request);
        List<FeatureCollection<SimpleFeatureType, SimpleFeature>> collections = new ArrayList<>();
        for (Object result : results.getFeature()) {
            @SuppressWarnings("unchecked")
            FeatureCollection<SimpleFeatureType, SimpleFeature> collection =
                    (FeatureCollection<SimpleFeatureType, SimpleFeature>) result;
            var simple = DataUtilities.simple(collection);
            SimpleFeatureType schema = simple.getSchema();
            if (requestedProperties != null) {
                for (String field : requestedProperties) {
                    if (schema.getDescriptor(field) == null) {
                        throw new IOException("The requested feature attribute is unavailable");
                    }
                }
            }
            GeometryDescriptor primary = schema.getGeometryDescriptor();
            String[] fields = schema.getAttributeDescriptors().stream()
                    .filter(attribute -> attribute.equals(primary)
                            || !(attribute instanceof GeometryDescriptor)
                            && (requestedProperties == null
                                    || requestedProperties.contains(attribute.getLocalName())))
                    .map(attribute -> attribute.getLocalName())
                    .toArray(String[]::new);
            collections.add(new RetypingFeatureCollection(simple,
                    SimpleFeatureTypeBuilder.retype(schema, fields)));
        }
        new FeatureBoundsWriter(geoServer).write(collections, output,
                results.getNumberOfFeatures(), false);
    }

    /**
     * Return the same character encoding used by the ordinary GeoJSON writer.
     *
     * @return configured response character encoding
     */
    @Override
    public String getCharset() {
        return geoServer.getGlobal().getSettings().getCharset();
    }

    /**
     * Decode the proxy's field projection independently of its internal geometry query.
     *
     * @param request authorized request with private format options
     * @return requested field names, or null when every non-geometry field is requested
     * @throws IOException if the private option is malformed
     */
    private static Set<String> readRequestedProperties(GetFeatureInfoRequest request) throws IOException {
        Object encoded = request.getGetMapRequest().getFormatOptions().get("eolabProperties");
        if (encoded == null) return null;
        try {
            byte[] decoded = Base64.getUrlDecoder().decode((String) encoded);
            return new HashSet<>(Arrays.asList(JSON.readValue(decoded, String[].class)));
        } catch (IllegalArgumentException | JacksonException error) {
            throw new IOException("The requested feature attributes are invalid", error);
        }
    }

    /** Preserve GeoServer attribute encoding while replacing geometry with geographic bounds. */
    private static final class FeatureBoundsWriter
            extends GeoJSONFeatureWriter<SimpleFeatureType, SimpleFeature> {
        /**
         * Connect the standard GeoJSON encoder to the current formatting settings.
         *
         * @param geoServer current GeoServer configuration
         */
        FeatureBoundsWriter(GeoServer geoServer) {
            super(geoServer);
        }

        /** @return false because geographic feature bounds are written explicitly */
        @Override
        protected boolean isFeatureBounding() {
            return false;
        }

        /**
         * Omit all coordinates from the public feature representation.
         *
         * @param writer current JSON response writer
         * @param descriptor source geometry metadata
         * @param geometry source geometry, retained only by GeoServer's result iterator
         */
        @Override
        protected void writeGeometry(GeoJSONBuilder writer, GeometryDescriptor descriptor,
                Geometry geometry) {
            writer.key("geometry").value(null);
        }

        /**
         * Omit the input CRS because the only output coordinates are explicitly WGS84.
         *
         * @param writer current JSON response writer
         * @param crs GeoServer result CRS, not the output bbox CRS
         */
        @Override
        protected void writeCollectionCRS(GeoJSONBuilder writer, CoordinateReferenceSystem crs) {}

        /**
         * Append the primary geometry's geographic envelope, or an unavailable null bbox.
         *
         * @param feature current source feature
         * @param writer current JSON response writer
         */
        @Override
        protected void writeExtraFeatureProperties(Feature feature, GeoJSONBuilder writer) {
            ReferencedEnvelope bounds = getGeographicBounds((SimpleFeature) feature);
            if (bounds == null) {
                writer.key("bbox").value(null);
            } else {
                // Navigation bounds must not inherit the layer's display-coordinate rounding.
                writer.key("bbox").array()
                        .value(bounds.getMinX()).value(bounds.getMinY())
                        .value(bounds.getMaxX()).value(bounds.getMaxY()).endArray();
            }
        }
    }

    /**
     * Transform one feature envelope into safe longitude/latitude navigation bounds.
     *
     * Envelope edges are densified during projection. Longitude spans exceeding half
     * the world or crossing its canonical limits use the full longitude range; this
     * deliberately favors including the feature over choosing the wrong wrapped half.
     *
     * @param feature current feature with its result CRS, which may differ from the source CRS
     * @return geographic bounds, or null for missing, invalid or unprojectable coordinates
     */
    private static ReferencedEnvelope getGeographicBounds(SimpleFeature feature) {
        Geometry geometry = (Geometry) feature.getDefaultGeometry();
        if (geometry == null || geometry.isEmpty()) return null;
        boolean[] finite = {true};
        geometry.apply(new CoordinateSequenceFilter() {
            @Override
            public void filter(CoordinateSequence sequence, int index) {
                finite[0] = Double.isFinite(sequence.getX(index))
                        && Double.isFinite(sequence.getY(index));
            }

            @Override
            public boolean isDone() {
                return !finite[0];
            }

            @Override
            public boolean isGeometryChanged() {
                return false;
            }
        });
        if (!finite[0]) return null;
        CoordinateReferenceSystem crs = feature.getFeatureType().getCoordinateReferenceSystem();
        if (crs == null) return null;
        try {
            ReferencedEnvelope bounds = new ReferencedEnvelope(geometry.getEnvelopeInternal(), crs)
                    .transform(DefaultGeographicCRS.WGS84, true, 20);
            double west = bounds.getMinX();
            double east = bounds.getMaxX();
            double south = bounds.getMinY();
            double north = bounds.getMaxY();
            if (!Double.isFinite(west) || !Double.isFinite(east)
                    || !Double.isFinite(south) || !Double.isFinite(north)
                    || south < -90 || north > 90) return null;
            if (east - west > 180 || west < -180 || east > 180) {
                west = -180;
                east = 180;
            }
            return new ReferencedEnvelope(west, east, south, north, DefaultGeographicCRS.WGS84);
        } catch (FactoryException | TransformException | IllegalArgumentException error) {
            return null;
        }
    }
}
