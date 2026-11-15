package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Rectangle;
import java.awt.image.BufferedImage;
import java.io.StringReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.geotools.api.data.DataStore;
import org.geotools.api.data.DataStoreFinder;
import org.geotools.api.data.Query;
import org.geotools.api.feature.simple.SimpleFeature;
import org.geotools.api.filter.Filter;
import org.geotools.data.DefaultRepository;
import org.geotools.data.gen.PreGeneralizedDataStore;
import org.geotools.data.gen.info.GeneralizationInfosProviderImpl;
import org.geotools.factory.CommonFactoryFinder;
import org.geotools.feature.DefaultFeatureCollection;
import org.geotools.feature.NameImpl;
import org.geotools.feature.simple.SimpleFeatureBuilder;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.geopkg.FeatureEntry;
import org.geotools.geopkg.GeoPackage;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.map.FeatureLayer;
import org.geotools.map.MapContent;
import org.geotools.referencing.CRS;
import org.geotools.renderer.RenderListener;
import org.geotools.renderer.lite.StreamingRenderer;
import org.geotools.util.factory.Hints;
import org.geotools.xml.styling.SLDParser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.Polygon;
import org.locationtech.jts.io.WKTReader;

/** Exercise stored display levels through the deployed GeoTools GeoPackage reader. */
final class GeoPackageOverviewTest {
    @TempDir
    Path directory;
    private DataStore original;
    private DataStore display;

    /**
     * Create one indexed package and load the stock XML layout used by publication.
     *
     * @throws Exception if native fixture creation or configuration loading fails
     */
    @BeforeEach
    void createPackage() throws Exception {
        Path path = directory.resolve("overviews.gpkg");
        try (var gpkg = new GeoPackage(path.toFile())) {
            gpkg.init();
            addTable(gpkg, "original",
                    "POLYGON ((0 0, 500 -1, 1000 0, 1001 500, 1000 1000, 500 1001, 0 1000, -1 500, 0 0))",
                    "POLYGON ((2000 0, 2001 0, 2001 1, 2000 1, 2000 0))");
            addTable(gpkg, "overview_10",
                    "POLYGON ((0 0, 1000 0, 1001 500, 1000 1000, 0 1000, -1 500, 0 0))",
                    "POLYGON EMPTY");
            addTable(gpkg, "overview_100", "POLYGON ((0 0, 1000 0, 1000 1000, 0 1000, 0 0))",
                    "POLYGON EMPTY");
        }
        original = DataStoreFinder.getDataStore(Map.of(
                "dbtype", "geopkg", "database", path.toString(), "read_only", true, "immutable", true));
        assertNotNull(original);
        var repository = new DefaultRepository();
        repository.register(new NameImpl("eolab", "source_original"), original);
        Path xml = directory.resolve("levels.xml");
        Files.writeString(xml, """
                <GeneralizationInfos version="1.0" dataSourceName="source_original" dataSourceNameSpace="eolab">
                  <GeneralizationInfo featureName="original" baseFeatureName="original" geomPropertyName="geom">
                    <Generalization distance="10.0" featureName="overview_10" geomPropertyName="geom"/>
                    <Generalization distance="100.0" featureName="overview_100" geomPropertyName="geom"/>
                  </GeneralizationInfo>
                </GeneralizationInfos>
                """);
        var infos = new GeneralizationInfosProviderImpl().getGeneralizationInfos(xml.toUri().toURL());
        display = new PreGeneralizedDataStore(infos, repository);
    }

    /** Release the wrapper and the separately managed GeoPackage connection pool. */
    @AfterEach
    void closePackage() {
        if (display != null) display.dispose();
        if (original != null) original.dispose();
    }

    /**
     * The renderer's distance hint chooses stored levels and retains attributes.
     *
     * @throws Exception if the native query fails
     */
    @Test
    void selectsGeometryAndRetainsFilteredAttributes() throws Exception {
        var filters = CommonFactoryFinder.getFilterFactory();
        Filter large = filters.equals(filters.property("label"), filters.literal("large"));
        for (double distance : new double[] {0, 9, 10, 99, 100, 10000}) {
            Query query = new Query("original", large, new String[] {"geom", "label", "amount"});
            query.getHints().put(Hints.GEOMETRY_DISTANCE, distance);
            var feature = read(display, query).get(0);
            int expectedVertices = distance < 10 ? 9 : distance < 100 ? 7 : 5;
            assertEquals(expectedVertices, ((Geometry) feature.getDefaultGeometry()).getNumPoints());
            assertEquals("large", feature.getAttribute("label"));
            assertEquals(42, ((Number) feature.getAttribute("amount")).intValue());
        }
    }

    /**
     * Empty display geometry retains its row but an indexed viewport query excludes it.
     *
     * @throws Exception if the native query or index inspection fails
     */
    @Test
    void viewportExcludesEmptyDisplayGeometry() throws Exception {
        Query all = new Query("original");
        all.getHints().put(Hints.GEOMETRY_DISTANCE, 100.0);
        var allFeatures = read(display, all);
        assertEquals(2, allFeatures.size());
        assertEquals(1, allFeatures.stream().filter(f -> f.getDefaultGeometry() == null).count());
        var filters = CommonFactoryFinder.getFilterFactory();
        Query viewport = new Query("original", filters.bbox("geom", -10, -10, 2100, 1100, "EPSG:3857"));
        viewport.getHints().put(Hints.GEOMETRY_DISTANCE, 100.0);
        var visible = read(display, viewport);
        assertEquals(1, visible.size());
        assertEquals("large", visible.get(0).getAttribute("label"));
        try (var gpkg = new GeoPackage(directory.resolve("overviews.gpkg").toFile());
                var connection = gpkg.getDataSource().getConnection();
                var statement = connection.createStatement();
                var result = statement.executeQuery("SELECT count(*) FROM rtree_overview_100_geom")) {
            assertTrue(result.next());
            assertEquals(1, result.getInt(1));
        }
    }

    /**
     * Picking without a hint and ID-specific rendering preserve exact original geometry.
     *
     * @throws Exception if the native query fails
     */
    @Test
    void exactQueriesKeepOriginalIdentifiersAndGeometry() throws Exception {
        var filters = CommonFactoryFinder.getFilterFactory();
        var picked = read(display, new Query("original",
                filters.equals(filters.property("label"), filters.literal("small"))));
        assertEquals(1, picked.size());
        assertFalse(((Geometry) picked.get(0).getDefaultGeometry()).isEmpty());
        assertEquals("original.2", picked.get(0).getID());
        Query outline = new Query("original", filters.id(filters.featureId("original.1")));
        outline.getHints().put(Hints.GEOMETRY_DISTANCE, 100.0);
        var outlined = read(original, outline);
        assertEquals(1, outlined.size());
        assertEquals(9, ((Geometry) outlined.get(0).getDefaultGeometry()).getNumPoints());
        assertEquals("original.1", outlined.get(0).getID());
    }

    /**
     * Inline styles and the real map renderer automatically choose the correct stored table.
     *
     * @throws Exception if style parsing or rendering setup fails
     */
    @Test
    void rendererSelectsLevelsWithInlineAttributeStyle() throws Exception {
        var parser = new SLDParser(CommonFactoryFinder.getStyleFactory(), new StringReader("""
                <StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld"
                    xmlns:ogc="http://www.opengis.net/ogc">
                  <NamedLayer><Name>original</Name><UserStyle><FeatureTypeStyle><Rule>
                    <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>label</ogc:PropertyName>
                      <ogc:Literal>large</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
                    <PolygonSymbolizer><Fill><CssParameter name="fill">#123456</CssParameter></Fill></PolygonSymbolizer>
                  </Rule></FeatureTypeStyle></UserStyle></NamedLayer>
                </StyledLayerDescriptor>
                """));
        var content = new MapContent();
        content.addLayer(new FeatureLayer(display.getFeatureSource("original"), parser.readXML()[0]));
        try {
            var renderer = new StreamingRenderer();
            renderer.setMapContent(content);
            var featureIds = new ArrayList<String>();
            var errors = new ArrayList<Exception>();
            renderer.addRenderListener(new RenderListener() {
                /** Record the backing table selected for a rendered feature. */
                @Override
                public void featureRenderer(SimpleFeature feature) {
                    featureIds.add(feature.getID());
                }

                /** Retain renderer failures so asynchronous errors fail the test. */
                @Override
                public void errorOccurred(Exception error) {
                    errors.add(error);
                }
            });
            double[] extents = {2000, 10000, 100000};
            int[] widths = {1000, 100, 100};
            String[] expectedIds = {"original.1", "overview_10.1", "overview_100.1"};
            for (int i = 0; i < extents.length; i++) {
                featureIds.clear();
                var image = new BufferedImage(widths[i], widths[i], BufferedImage.TYPE_INT_ARGB);
                var graphics = image.createGraphics();
                try {
                    renderer.paint(graphics, new Rectangle(0, 0, widths[i], widths[i]),
                            new ReferencedEnvelope(-10, extents[i], -10, extents[i], CRS.decode("EPSG:3857", true)));
                } finally {
                    graphics.dispose();
                }
                assertTrue(errors.isEmpty(), errors.toString());
                assertEquals(List.of(expectedIds[i]), featureIds);
            }
        } finally {
            content.dispose();
        }
    }

    /**
     * Add matching feature identities, attributes and an Rtree to a fixture table.
     *
     * @param gpkg open writable fixture package
     * @param table native table name
     * @param largeWkt display geometry for the large feature
     * @param smallWkt display geometry for the small feature
     * @throws Exception if schema, geometry or index creation fails
     */
    private static void addTable(GeoPackage gpkg, String table, String largeWkt, String smallWkt) throws Exception {
        var builder = new SimpleFeatureTypeBuilder();
        builder.setName(table);
        builder.setCRS(CRS.decode("EPSG:3857", true));
        builder.add("geom", Polygon.class);
        builder.add("label", String.class);
        builder.add("amount", Integer.class);
        var type = builder.buildFeatureType();
        var features = new DefaultFeatureCollection(null, type);
        var reader = new WKTReader();
        features.add(SimpleFeatureBuilder.build(type, new Object[] {reader.read(largeWkt), "large", 42}, table + ".1"));
        features.add(SimpleFeatureBuilder.build(type, new Object[] {reader.read(smallWkt), "small", 7}, table + ".2"));
        var entry = new FeatureEntry();
        entry.setTableName(table);
        gpkg.add(entry, features);
        gpkg.createSpatialIndex(entry);
    }

    /**
     * Materialize a small fixture query while closing its JDBC feature iterator.
     *
     * @param store managed original or stock display datastore
     * @param query feature filter and renderer hints
     * @return detached fixture features in native query order
     * @throws Exception if the native query fails
     */
    private static List<SimpleFeature> read(DataStore store, Query query) throws Exception {
        var result = new ArrayList<SimpleFeature>();
        try (var features = store.getFeatureSource("original").getFeatures(query).features()) {
            while (features.hasNext()) result.add(SimpleFeatureBuilder.copy(features.next()));
        }
        return result;
    }
}
