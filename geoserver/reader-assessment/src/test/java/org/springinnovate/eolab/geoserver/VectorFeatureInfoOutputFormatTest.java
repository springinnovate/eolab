package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.Map;
import net.opengis.wfs.FeatureCollectionType;
import net.opengis.wfs.WfsFactory;
import org.geoserver.catalog.impl.CatalogImpl;
import org.geoserver.config.impl.GeoServerImpl;
import org.geoserver.config.impl.GeoServerInfoImpl;
import org.geoserver.json.GeoJSONFeatureWriter;
import org.geoserver.wms.GetFeatureInfoRequest;
import org.geoserver.wms.GetMapRequest;
import org.geoserver.wms.WMSExtensions;
import org.geotools.api.feature.simple.SimpleFeature;
import org.geotools.api.feature.simple.SimpleFeatureType;
import org.geotools.api.referencing.crs.CoordinateReferenceSystem;
import org.geotools.feature.DefaultFeatureCollection;
import org.geotools.feature.simple.SimpleFeatureBuilder;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.referencing.CRS;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.junit.jupiter.api.Test;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.io.WKTReader;
import org.springframework.beans.factory.xml.XmlBeanDefinitionReader;
import org.springframework.context.support.GenericApplicationContext;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Exercise the deployed GeoTools geometry and GeoServer JSON boundaries together. */
final class VectorFeatureInfoOutputFormatTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    /** Keep the private format selection separate from ordinary public JSON requests. */
    @Test
    void selectsOnlyPrivateFormatAndReturnsJson() {
        var format = new VectorFeatureInfoOutputFormat(configuration());
        assertTrue(format.canProduce("application/vnd.eolab.feature-info+json"));
        assertFalse(format.canProduce("application/json"));
        assertFalse(format.canProduce(null));
        assertEquals("application/json", format.getContentType());
        assertEquals("UTF-8", format.getCharset());
    }

    /** Discover the packaged response writer through GeoServer's actual Spring extension lookup. */
    @Test
    void registersWriterThroughDeployedExtensionContext() {
        try (var context = new GenericApplicationContext()) {
            context.getBeanFactory().registerSingleton("geoServer", configuration());
            new XmlBeanDefinitionReader(context).loadBeanDefinitions(new ClassPathResource("applicationContext.xml"));
            context.refresh();
            assertTrue(WMSExtensions.findFeatureInfoFormats(context).stream()
                    .anyMatch(format -> format.canProduce(VectorFeatureInfoOutputFormat.FORMAT)));
        }
    }

    /**
     * Fit the complete selected polygon while preserving standard scalar and date encoding.
     *
     * @throws Exception if fixture construction or JSON encoding fails
     */
    @Test
    void returnsBroadFeatureBoundsAndStandardAttributesWithoutGeometry() throws Exception {
        SimpleFeatureType schema = schema(DefaultGeographicCRS.WGS84);
        Geometry geometry = new WKTReader().read(
                "POLYGON ((-85 5, -60 5, -60 30, -85 30, -85 5))");
        SimpleFeature feature = feature(schema, "distribution.42", geometry, null);
        var collection = collection(schema, feature);
        JsonNode result = encode(collection);
        JsonNode encoded = result.path("features").get(0);
        assertEquals("distribution.42", encoded.path("id").asText());
        assertBounds(encoded, -85, 5, -60, 30);
        assertTrue(encoded.path("geometry").isNull());
        assertNull(encoded.get("geometry_name"));
        assertNull(result.get("crs"));
        assertNull(result.get("bbox"));
        var original = new ByteArrayOutputStream();
        new GeoJSONFeatureWriter<SimpleFeatureType, SimpleFeature>(configuration()) {
            @Override
            protected boolean isFeatureBounding() {
                return false;
            }
        }.write(List.of(collection), original, null, false);
        JsonNode ordinaryProperties = JSON.readTree(original.toByteArray())
                .path("features").get(0).path("properties");
        JsonNode properties = encoded.path("properties");
        for (String field : List.of("name", "count", "rate", "active", "observed", "missing")) {
            assertEquals(ordinaryProperties.get(field), properties.get(field), field);
        }
        assertEquals(geometry, feature.getDefaultGeometry());
    }

    /**
     * Transform each result independently from the map projection and retain point extents.
     *
     * @throws Exception if fixture projection or JSON encoding fails
     */
    @Test
    void transformsProjectedPolygonAndPointToDistinctGeographicBounds() throws Exception {
        SimpleFeatureType schema = schema(CRS.decode("EPSG:3857", true));
        var reader = new WKTReader();
        var polygon = feature(schema, "distribution.1", reader.read(
                "POLYGON ((0 0, 1113194.9079327357 0, "
                + "1113194.9079327357 2273030.9269876895, 0 2273030.9269876895, 0 0))"), null);
        var point = feature(schema, "distribution.2", reader.read(
                "POINT (-8905559.263461886 1118889.9748579594)"), null);
        JsonNode features = encode(collection(schema, polygon, point)).path("features");
        assertBounds(features.get(0), 0, 0, 10, 20);
        assertBounds(features.get(1), -80, 10, -80, 10);
        assertEquals("distribution.2", features.get(1).path("id").asText());
    }

    /**
     * Respect latitude-first source axes but always publish longitude-first bounds.
     *
     * @throws Exception if the CRS or JSON encoding fails
     */
    @Test
    void handlesLatitudeFirstGeographicAxes() throws Exception {
        SimpleFeatureType schema = schema(CRS.decode("EPSG:4326", false));
        JsonNode encoded = encode(collection(schema, feature(schema, "distribution.1",
                new WKTReader().read("POINT (10 -80)"), null))).path("features").get(0);
        assertBounds(encoded, -80, 10, -80, 10);
    }

    /**
     * Exclude every secondary geometry and keep bounds tied to the selected primary geometry.
     *
     * @throws Exception if fixture construction or JSON encoding fails
     */
    @Test
    void omitsSecondaryGeometries() throws Exception {
        SimpleFeatureType schema = schema(DefaultGeographicCRS.WGS84);
        var reader = new WKTReader();
        JsonNode encoded = encode(collection(schema, feature(schema, "distribution.1",
                reader.read("POINT (-80 10)"), reader.read("POINT (120 60)"))))
                .path("features").get(0);
        assertBounds(encoded, -80, 10, -80, 10);
        assertNull(encoded.path("properties").get("secondary"));
        assertNull(encoded.path("properties").get("shape"));
        assertFalse(encoded.toString().contains("coordinates"));
    }

    /**
     * Preserve attributes when geometry cannot provide a safe navigation target.
     *
     * @throws Exception if fixture construction or JSON encoding fails
     */
    @Test
    void returnsNullBoundsForMissingEmptyAndInvalidGeometry() throws Exception {
        SimpleFeatureType schema = schema(DefaultGeographicCRS.WGS84);
        Geometry invalid = new GeometryFactory().createLineString(new Coordinate[] {
            new Coordinate(1, 2), new Coordinate(Double.NaN, 3), new Coordinate(4, 5)
        });
        JsonNode features = encode(collection(schema,
                feature(schema, "distribution.1", null, null),
                feature(schema, "distribution.2", new WKTReader().read("POINT EMPTY"), null),
                feature(schema, "distribution.3", invalid, null),
                feature(schema, "distribution.4", new WKTReader().read("POINT (10 91)"), null)))
                .path("features");
        assertEquals(4, features.size());
        for (JsonNode feature : features) {
            assertTrue(feature.path("bbox").isNull());
            assertTrue(feature.path("geometry").isNull());
            assertEquals(7, feature.path("properties").path("count").asInt());
        }
        SimpleFeatureType unknown = schema(null);
        assertTrue(encode(collection(unknown, feature(unknown, "distribution.5",
                new WKTReader().read("POINT (10 20)"), null)))
                .path("features").get(0).path("bbox").isNull());
    }

    /**
     * Use conservative whole-longitude bounds for date-line and wrapped-world extents.
     *
     * @throws Exception if fixture construction or JSON encoding fails
     */
    @Test
    void retainsBothSidesOfDateLine() throws Exception {
        SimpleFeatureType schema = schema(DefaultGeographicCRS.WGS84);
        var reader = new WKTReader();
        JsonNode features = encode(collection(schema,
                feature(schema, "distribution.1", reader.read("LINESTRING (179 10, -179 20)"), null),
                feature(schema, "distribution.2", reader.read("LINESTRING (170 10, 190 20)"), null)))
                .path("features");
        assertBounds(features.get(0), -180, 10, 180, 20);
        assertBounds(features.get(1), -180, 10, 180, 20);
    }

    /**
     * Omit unrequested large attributes before encoding without rounding the zoom target.
     *
     * @throws Exception if the private request option or JSON encoding fails
     */
    @Test
    void preservesRequestedFieldsAndFullBoundsPrecision() throws Exception {
        SimpleFeatureType schema = schema(DefaultGeographicCRS.WGS84);
        SimpleFeature selected = feature(schema, "distribution.1",
                new WKTReader().read("POINT (10.12345678 20.87654321)"), null);
        selected.setAttribute("name", "x".repeat(600000));
        FeatureCollectionType result = WfsFactory.eINSTANCE.createFeatureCollectionType();
        result.getFeature().add(collection(schema, selected));
        var request = new GetFeatureInfoRequest();
        var mapRequest = new GetMapRequest();
        mapRequest.setFormatOptions(Map.of("eolabProperties", Base64.getUrlEncoder()
                .withoutPadding().encodeToString("[\"count\"]".getBytes(StandardCharsets.UTF_8))));
        request.setGetMapRequest(mapRequest);
        var output = new ByteArrayOutputStream();
        var settings = configuration();
        settings.getGlobal().getSettings().setNumDecimals(0);
        new VectorFeatureInfoOutputFormat(settings).write(result, request, output);
        JsonNode encoded = JSON.readTree(output.toByteArray()).path("features").get(0);
        assertEquals(1, encoded.path("properties").size());
        assertEquals(7, encoded.path("properties").path("count").asInt());
        assertTrue(output.size() < 1024);
        assertBounds(encoded, 10.12345678, 20.87654321, 10.12345678, 20.87654321);
    }

    /**
     * Preserve unknown-field errors and translate malformed private options without exposing contents.
     *
     * @throws Exception if the native fixture cannot be constructed
     */
    @Test
    void rejectsUnknownFieldsAndMalformedPrivateOptions() throws Exception {
        SimpleFeatureType schema = schema(DefaultGeographicCRS.WGS84);
        FeatureCollectionType result = WfsFactory.eINSTANCE.createFeatureCollectionType();
        result.getFeature().add(collection(schema, feature(schema, "distribution.1",
                new WKTReader().read("POINT (10 20)"), null)));
        var request = new GetFeatureInfoRequest();
        var mapRequest = new GetMapRequest();
        request.setGetMapRequest(mapRequest);
        var writer = new VectorFeatureInfoOutputFormat(configuration());
        for (String fields : List.of("[\"unknown\"]", "malformed-json")) {
            mapRequest.setFormatOptions(Map.of("eolabProperties", Base64.getUrlEncoder()
                    .withoutPadding().encodeToString(fields.getBytes(StandardCharsets.UTF_8))));
            IOException error = assertThrows(IOException.class,
                    () -> writer.write(result, request, new ByteArrayOutputStream()));
            assertFalse(error.getMessage().contains(fields));
        }
        mapRequest.setFormatOptions(Map.of("eolabProperties", "%%%"));
        assertThrows(IOException.class,
                () -> writer.write(result, request, new ByteArrayOutputStream()));
    }

    /**
     * Configure the real encoder without starting a servlet container.
     *
     * @return in-memory GeoServer configuration with ordinary JSON settings
     */
    private static GeoServerImpl configuration() {
        var configuration = new GeoServerImpl();
        configuration.setCatalog(new CatalogImpl());
        var global = new GeoServerInfoImpl();
        global.getSettings().setCharset("UTF-8");
        global.getSettings().setNumDecimals(8);
        configuration.setGlobal(global);
        return configuration;
    }

    /**
     * Build a native schema containing scalar, date and multiple geometry fields.
     *
     * @param crs native result CRS, or null for unavailable metadata
     * @return schema used by actual GeoTools features
     */
    private static SimpleFeatureType schema(CoordinateReferenceSystem crs) {
        var builder = new SimpleFeatureTypeBuilder();
        builder.setName("distribution");
        builder.setCRS(crs);
        builder.add("shape", Geometry.class);
        builder.add("secondary", Geometry.class);
        builder.setDefaultGeometry("shape");
        builder.add("name", String.class);
        builder.add("count", Integer.class);
        builder.add("rate", Double.class);
        builder.add("active", Boolean.class);
        builder.add("observed", Date.class);
        builder.add("missing", String.class);
        return builder.buildFeatureType();
    }

    /**
     * Construct one immutable-source-style feature with representative attributes.
     *
     * @param schema native schema
     * @param id GeoServer feature identity
     * @param primary selected geometry
     * @param secondary optional geometry that must not escape through properties
     * @return native GeoTools feature
     */
    private static SimpleFeature feature(SimpleFeatureType schema, String id,
            Geometry primary, Geometry secondary) {
        return SimpleFeatureBuilder.build(schema, new Object[] {
            primary, secondary, "Name \"quoted\"\nnext line", 7, 1.25, true,
            new Date(1704067200000L), null
        }, id);
    }

    /**
     * Group actual GeoTools features for the GetFeatureInfo result boundary.
     *
     * @param schema native schema
     * @param features ordered selected features
     * @return collection consumed by the native response writer
     */
    private static DefaultFeatureCollection collection(SimpleFeatureType schema, SimpleFeature... features) {
        var collection = new DefaultFeatureCollection(null, schema);
        for (SimpleFeature feature : features) collection.add(feature);
        return collection;
    }

    /**
     * Run the public response-writer contract and parse its emitted JSON bytes.
     *
     * @param collection selected native features
     * @return decoded FeatureCollection
     * @throws Exception if the native encoder or JSON decoder fails
     */
    private static JsonNode encode(DefaultFeatureCollection collection) throws Exception {
        FeatureCollectionType result = WfsFactory.eINSTANCE.createFeatureCollectionType();
        result.getFeature().add(collection);
        var output = new ByteArrayOutputStream();
        var request = new GetFeatureInfoRequest();
        request.setGetMapRequest(new GetMapRequest());
        new VectorFeatureInfoOutputFormat(configuration()).write(result, request, output);
        return JSON.readTree(output.toString(StandardCharsets.UTF_8));
    }

    /**
     * Compare a public feature bbox with independently expected geographic coordinates.
     *
     * @param feature decoded feature
     * @param expected west, south, east, north coordinates
     */
    private static void assertBounds(JsonNode feature, double... expected) {
        JsonNode bbox = feature.path("bbox");
        assertEquals(4, bbox.size());
        for (int index = 0; index < expected.length; index++) {
            assertEquals(expected[index], bbox.get(index).asDouble(), 0.000001);
        }
    }
}
