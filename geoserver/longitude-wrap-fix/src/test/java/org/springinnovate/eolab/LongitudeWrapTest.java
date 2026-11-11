package org.springinnovate.eolab;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Color;
import java.awt.Rectangle;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.geotools.api.data.DataStore;
import org.geotools.api.data.DataStoreFinder;
import org.geotools.api.data.Query;
import org.geotools.api.data.SimpleFeatureSource;
import org.geotools.api.feature.simple.SimpleFeature;
import org.geotools.api.filter.spatial.BBOX;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.factory.CommonFactoryFinder;
import org.geotools.feature.DefaultFeatureCollection;
import org.geotools.feature.simple.SimpleFeatureBuilder;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.filter.visitor.DefaultFilterVisitor;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.geopkg.FeatureEntry;
import org.geotools.geopkg.GeoPackage;
import org.geotools.map.FeatureLayer;
import org.geotools.map.GridCoverageLayer;
import org.geotools.map.Layer;
import org.geotools.map.MapContent;
import org.geotools.referencing.CRS;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.geotools.renderer.RenderListener;
import org.geotools.renderer.lite.StreamingRenderer;
import org.geotools.styling.SLD;
import org.geotools.styling.StyleBuilder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.locationtech.jts.geom.Envelope;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.Polygon;

/** Verify native GeoPackage tile queries and pixels through GeoTools StreamingRenderer. */
final class LongitudeWrapTest {
    private static final String NATIVE_BOUNDS_KEY = "org.geotools.renderer.nativeBounds";
    private static final String TABLE = "study_areas";
    private static final int TILE_SIZE = 128;

    @TempDir
    Path directory;

    /**
     * Paint the same native polygon on both sides of the seam in canonical Mercator tiles.
     *
     * @param eastSpill whether the source polygon extends beyond positive 180°
     * @throws Exception if the native fixture cannot be opened or the tile cannot be projected
     */
    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void rendersBothSidesOfSourceSpill(boolean eastSpill) throws Exception {
        var spill = eastSpill ? new Envelope(179.8, 180.1, -.2, .2) : new Envelope(-180.1, -179.8, -.2, .2);
        var nativeTile = eastSpill ? mercatorTile(179.86, 179.92) : mercatorTile(-179.92, -179.86);
        var wrappedTile = eastSpill ? mercatorTile(-179.96, -179.94) : mercatorTile(179.94, 179.96);
        var store = writeGeoPackage(spill);
        try {
            var source = store.getFeatureSource(TABLE);
            var bounds = source.getBounds();
            assertEquals(eastSpill ? 180.1 : -180.1, eastSpill ? bounds.getMaxX() : bounds.getMinX(), 1e-9);
            assertEquals(Color.RED.getRGB(), center(render(nativeTile, vectorLayer(source, bounds, new ArrayList<>()))));
            assertEquals(Color.RED.getRGB(), center(render(wrappedTile, vectorLayer(source, bounds, new ArrayList<>()))));
            assertEquals(0, center(render(wrappedTile, vectorLayer(source, null, new ArrayList<>()))));
        } finally {
            store.dispose();
        }
    }

    /**
     * A normal regional vector needs one source envelope and no render-time extent lookup.
     *
     * @throws Exception if the fixture cannot be opened or projected
     */
    @Test
    void retainsSingleQueryEnvelopeForRegionalSource() throws Exception {
        var store = writeGeoPackage(new Envelope(10, 11, -.2, .2));
        try {
            var source = store.getFeatureSource(TABLE);
            var queries = new ArrayList<Query>();
            var image = render(mercatorTile(10.4, 10.6), vectorLayer(source, source.getBounds(), queries));
            assertEquals(Color.RED.getRGB(), center(image));
            assertEquals(1, queries.size());
            assertEquals(1, queryEnvelopes(queries.get(0)).size());
        } finally {
            store.dispose();
        }
    }

    /**
     * Keep ordinary query behavior when wrapping is disabled or native metadata has a different CRS.
     *
     * @throws Exception if the fixture cannot be opened or projected
     */
    @Test
    void ignoresSpillWithoutCompatibleMetadataAndWrapping() throws Exception {
        var store = writeGeoPackage(new Envelope(179.8, 180.1, -.2, .2));
        try {
            var source = store.getFeatureSource(TABLE);
            var bounds = source.getBounds();
            var tile = mercatorTile(-179.96, -179.94);
            var wrongBounds = new ReferencedEnvelope(bounds, tile.getCoordinateReferenceSystem());
            var wrongBoundsQueries = new ArrayList<Query>();
            assertEquals(0, center(render(tile, vectorLayer(source, wrongBounds, wrongBoundsQueries))));
            assertEquals(1, queryEnvelopes(wrongBoundsQueries.get(0)).size());

            var disabledQueries = new ArrayList<Query>();
            assertEquals(0, center(render(tile, false, vectorLayer(source, bounds, disabledQueries))));
            assertEquals(1, queryEnvelopes(disabledQueries.get(0)).size());
        } finally {
            store.dispose();
        }
    }

    /**
     * Include both adjacent longitude windows in one native feature query for a world tile.
     *
     * @throws Exception if the fixture cannot be opened or projected
     */
    @Test
    void worldTileQueriesBothSpillsOnce() throws Exception {
        var store = writeGeoPackage(new Envelope(-180.2, -179.8, -.2, .2), new Envelope(179.8, 180.2, -.2, .2));
        try {
            var source = store.getFeatureSource(TABLE);
            var queries = new ArrayList<Query>();
            render(mercatorTile(-179.99, 179.99), vectorLayer(source, source.getBounds(), queries));
            assertEquals(1, queries.size());
            var boxes = queryEnvelopes(queries.get(0));
            assertEquals(3, boxes.size());
            assertTrue(boxes.stream().anyMatch(box -> box.getBounds().getMaximum(0) > 180));
            assertTrue(boxes.stream().anyMatch(box -> box.getBounds().getMinimum(0) < -180));
        } finally {
            store.dispose();
        }
    }

    /**
     * Supplement a world source's queries while preserving predicates and the raster's original tile.
     *
     * @throws Exception if the native fixture cannot be opened or projected
     */
    @Test
    void wrappedWorldSourceRetainsDefinitionFilterAndRasterSibling() throws Exception {
        var store = writeGeoPackage(new Envelope(179.8, 180.065, -.2, .2), new Envelope(-180, -179.8, .3, .4));
        try {
            var source = store.getFeatureSource(TABLE);
            var bounds = source.getBounds();
            var tile = mercatorTile(-179.99, -179.88);
            var queries = new ArrayList<Query>();
            var raster = rasterLayer(tile);
            var vector = vectorLayer(source, bounds, queries);
            var image = render(tile, raster, vector);
            assertEquals(Color.RED.getRGB(), image.getRGB(TILE_SIZE / 4, TILE_SIZE / 2));
            assertEquals(Color.BLUE.getRGB(), image.getRGB(TILE_SIZE * 3 / 4, TILE_SIZE / 2));
            assertEquals(1, queries.size());
            assertEquals(2, queryEnvelopes(queries.get(0)).size());

            var filteredQueries = new ArrayList<Query>();
            var filtered = vectorLayer(source, bounds, filteredQueries);
            var filters = CommonFactoryFinder.getFilterFactory();
            filtered.setQuery(new Query(TABLE, filters.equal(filters.property("region"), filters.literal(-1), true)));
            var filteredImage = render(tile, rasterLayer(tile), filtered);
            assertEquals(Color.BLUE.getRGB(), filteredImage.getRGB(TILE_SIZE / 4, TILE_SIZE / 2));
            assertEquals(1, filteredQueries.size());
            assertEquals(2, queryEnvelopes(filteredQueries.get(0)).size());
        } finally {
            store.dispose();
        }
    }

    /**
     * Write real polygon features with stable native metadata and an RTree index.
     *
     * @param areas polygon extents, numbered in the order supplied for testing predicates
     * @return a read-only native data store for the original file
     * @throws IOException if the GeoPackage cannot be written or reopened
     */
    private DataStore writeGeoPackage(Envelope... areas) throws IOException {
        var type = new SimpleFeatureTypeBuilder();
        type.setName(TABLE);
        type.setCRS(DefaultGeographicCRS.WGS84);
        type.add("shape", Polygon.class);
        type.add("region", Integer.class);
        var schema = type.buildFeatureType();
        var features = new DefaultFeatureCollection(null, schema);
        var geometry = new GeometryFactory();
        for (int i = 0; i < areas.length; i++) {
            features.add(SimpleFeatureBuilder.build(schema, new Object[] {geometry.toGeometry(areas[i]), i + 1}, null));
        }

        var path = directory.resolve("study-areas.gpkg");
        try (var gpkg = new GeoPackage(path.toFile())) {
            gpkg.init();
            var entry = new FeatureEntry();
            entry.setTableName(TABLE);
            entry.setSrid(4326);
            entry.setGeometryColumn("shape");
            gpkg.add(entry, features);
            gpkg.createSpatialIndex(entry);
        }
        var store = DataStoreFinder.getDataStore(
                Map.of("dbtype", "geopkg", "database", path.toFile(), "read_only", true, "immutable", true));
        assertNotNull(store);
        return store;
    }

    /**
     * Attach the published bounds and guard against new render-time bounds reads.
     *
     * @param source the real native data source
     * @param bounds stored publication metadata, or null to use ordinary render queries
     * @param queries records the actual queries sent to the data store
     * @return a layer configured with a solid red polygon style
     */
    private static FeatureLayer vectorLayer(SimpleFeatureSource source, ReferencedEnvelope bounds, List<Query> queries) {
        var trackedSource = (SimpleFeatureSource) Proxy.newProxyInstance(
                SimpleFeatureSource.class.getClassLoader(),
                new Class<?>[] {SimpleFeatureSource.class},
                (proxy, method, arguments) -> {
                    if (method.getName().equals("getBounds")) {
                        throw new AssertionError("Rendering must use the published bounds metadata");
                    }
                    if (method.getName().equals("getFeatures") && arguments != null && arguments[0] instanceof Query query) {
                        queries.add(query);
                    }
                    try {
                        return method.invoke(source, arguments);
                    } catch (InvocationTargetException error) {
                        throw error.getCause();
                    }
                });
        var layer = new FeatureLayer(trackedSource, SLD.createPolygonStyle(Color.RED, Color.RED, 1));
        if (bounds != null) {
            layer.getUserData().put(NATIVE_BOUNDS_KEY, bounds);
        }
        return layer;
    }

    /**
     * Return the spatial clauses actually submitted to the native store.
     *
     * @param query the renderer's final feature query
     * @return the bounding-box clauses in the query filter
     */
    private static List<BBOX> queryEnvelopes(Query query) {
        var boxes = new ArrayList<BBOX>();
        query.getFilter().accept(new DefaultFilterVisitor() {
            @Override
            public Object visit(BBOX box, Object data) {
                boxes.add(box);
                return data;
            }
        }, null);
        return boxes;
    }

    /**
     * Create a projected raster confined to the original requested tile.
     *
     * @param tile the unshifted Mercator tile extent
     * @return an opaque blue raster sibling
     */
    private static GridCoverageLayer rasterLayer(ReferencedEnvelope tile) {
        var raster = new BufferedImage(TILE_SIZE, TILE_SIZE, BufferedImage.TYPE_INT_RGB);
        var graphics = raster.createGraphics();
        try {
            graphics.setColor(Color.BLUE);
            graphics.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
        } finally {
            graphics.dispose();
        }
        var style = new StyleBuilder();
        var coverage = new GridCoverageFactory().create("canonical raster", raster, tile);
        return new GridCoverageLayer(coverage, style.createStyle(style.createRasterSymbolizer()));
    }

    /**
     * Convert a canonical longitude interval around the equator to the map projection.
     *
     * @param west western longitude in degrees
     * @param east eastern longitude in degrees
     * @return map tile bounds in Web Mercator
     * @throws Exception if the tile cannot be projected
     */
    private static ReferencedEnvelope mercatorTile(double west, double east) throws Exception {
        return new ReferencedEnvelope(west, east, -.1, .1, DefaultGeographicCRS.WGS84)
                .transform(CRS.decode("EPSG:3857", true), true);
    }

    /**
     * Paint one tile through the ordinary wrapping renderer in layer order.
     *
     * @param tile map area in Web Mercator
     * @param layers layers in bottom-to-top order
     * @return the rendered tile with an initially transparent background
     */
    private static BufferedImage render(ReferencedEnvelope tile, Layer... layers) {
        return render(tile, true, layers);
    }

    /**
     * Paint one tile and surface errors reported internally by the streaming renderer.
     *
     * @param tile map area in Web Mercator
     * @param wrapping whether to wrap geometries and their native query windows across the seam
     * @param layers layers in bottom-to-top order
     * @return the rendered tile with an initially transparent background
     */
    private static BufferedImage render(ReferencedEnvelope tile, boolean wrapping, Layer... layers) {
        var image = new BufferedImage(TILE_SIZE, TILE_SIZE, BufferedImage.TYPE_INT_ARGB);
        var graphics = image.createGraphics();
        var content = new MapContent();
        try {
            content.addLayers(List.of(layers));
            var renderer = new StreamingRenderer();
            renderer.setMapContent(content);
            renderer.setRendererHints(Map.of(
                    StreamingRenderer.ADVANCED_PROJECTION_HANDLING_KEY, true,
                    StreamingRenderer.CONTINUOUS_MAP_WRAPPING, wrapping));
            var errors = new ArrayList<Exception>();
            renderer.addRenderListener(new RenderListener() {
                @Override
                public void featureRenderer(SimpleFeature feature) {}

                @Override
                public void errorOccurred(Exception error) {
                    errors.add(error);
                }
            });
            renderer.paint(graphics, new Rectangle(0, 0, TILE_SIZE, TILE_SIZE), tile);
            assertTrue(errors.isEmpty(), () -> "GeoTools rendering error: " + errors.get(0));
            return image;
        } finally {
            graphics.dispose();
            content.dispose();
        }
    }

    /**
     * Sample a tile interior away from polygon strokes and tile edges.
     *
     * @param image rendered tile
     * @return the center pixel's ARGB color
     */
    private static int center(BufferedImage image) {
        return image.getRGB(TILE_SIZE / 2, TILE_SIZE / 2);
    }
}
