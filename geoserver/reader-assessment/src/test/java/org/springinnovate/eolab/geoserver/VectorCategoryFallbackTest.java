package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.awt.Rectangle;
import java.awt.image.BufferedImage;
import java.util.HashMap;
import java.util.List;
import org.geotools.api.feature.simple.SimpleFeature;
import org.geotools.api.style.Style;
import org.geotools.factory.CommonFactoryFinder;
import org.geotools.feature.DefaultFeatureCollection;
import org.geotools.feature.simple.SimpleFeatureBuilder;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.map.FeatureLayer;
import org.geotools.map.MapContent;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.geotools.renderer.lite.StreamingRenderer;
import org.geotools.xml.styling.SLDParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.Polygon;

/** Test generated fallback predicates through native SLD parsing and rendering. */
class VectorCategoryFallbackTest {
    /**
     * Parse the Python-generated style and optionally combine its rules, as
     * GeoServer feature picking does. This exercises the resulting rule
     * interaction rather than duplicating GeoServer's symbolizer preprocessor.
     *
     * @param missing whether nulls have their own color
     * @param combined whether geometry and label rules share one feature style
     * @return fresh parsed style
     * @throws Exception if fixture loading or parsing fails
     */
    private static Style fixture(boolean missing, boolean combined) throws Exception {
        String filename = "/vector-category-fallback" + (missing ? "" : "-null") + ".sld";
        try (var input = VectorCategoryFallbackTest.class.getResourceAsStream(filename)) {
            assertNotNull(input);
            Style style = new SLDParser(CommonFactoryFinder.getStyleFactory(), input).readXML()[0];
            assertEquals(2, style.featureTypeStyles().size());
            if (combined) {
                var geometry = style.featureTypeStyles().get(0);
                geometry.rules().addAll(style.featureTypeStyles().get(1).rules());
                style.featureTypeStyles().remove(1);
            }
            return style;
        }
    }

    /**
     * Build a polygon whose label anchor lies away from the sampled interior.
     *
     * @param value nullable numeric category from the source
     * @return typed native feature with an empty label like the reported source
     */
    private static SimpleFeature feature(Double value) {
        var type = new SimpleFeatureTypeBuilder();
        type.setName("biomes");
        type.setCRS(DefaultGeographicCRS.WGS84);
        type.add("shape", Polygon.class);
        type.add("G200_BIOME", Double.class);
        type.add("BIOME_1", String.class);
        var geometry = new GeometryFactory().createPolygon(new Coordinate[] {
                new Coordinate(0, 0), new Coordinate(10, 0), new Coordinate(10, 10),
                new Coordinate(0, 10), new Coordinate(0, 0)});
        return SimpleFeatureBuilder.build(type.buildFeatureType(), new Object[] {geometry, value, ""}, "biomes.1");
    }

    /**
     * Paint with the production GeoTools renderer and inspect a polygon interior.
     *
     * @param style parsed production style
     * @param value nullable category to draw
     * @return ARGB at an interior pixel away from the label and stroke
     */
    private static int render(Style style, Double value) {
        var feature = feature(value);
        var features = new DefaultFeatureCollection(null, feature.getFeatureType());
        features.add(feature);
        var content = new MapContent();
        content.addLayer(new FeatureLayer(features, style));
        var image = new BufferedImage(100, 100, BufferedImage.TYPE_INT_ARGB);
        var graphics = image.createGraphics();
        try {
            var renderer = new StreamingRenderer();
            renderer.setMapContent(content);
            var hints = new HashMap<Object, Object>();
            hints.put(StreamingRenderer.OPTIMIZE_FTS_RENDERING_KEY, false);
            renderer.setRendererHints(hints);
            renderer.paint(graphics, new Rectangle(0, 0, 100, 100),
                    new ReferencedEnvelope(0, 10, 0, 10, DefaultGeographicCRS.WGS84));
            return image.getRGB(20, 20);
        } finally {
            graphics.dispose();
            content.dispose();
        }
    }

    /**
     * Other excludes typed matches, hidden matches, and separately colored nulls.
     *
     * @param missing whether missing values have their own rule
     * @throws Exception if fixture parsing fails
     */
    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void fallbackMembershipPreservesNullAndHiddenCategories(boolean missing) throws Exception {
        var style = fixture(missing, false);
        var rules = style.featureTypeStyles().get(0).rules();
        var fallback = rules.get(rules.size() - 1);
        assertFalse(fallback.isElseFilter());
        assertNotNull(fallback.getFilter());
        for (double value : List.of(0d, 1d, 13d, 13.1d, -1d)) {
            assertEquals(value != 1 && value != 13, fallback.getFilter().evaluate(feature(value)), "value " + value);
        }
        assertEquals(!missing, fallback.getFilter().evaluate(feature(null)));
    }

    /**
     * Label rule combination must retain visible fallback, exact, and null fills.
     *
     * @param combined whether rules have been combined for feature picking
     * @throws Exception if fixture parsing fails
     */
    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void rendersFallbackWithSeparateOrCombinedLabelRules(boolean combined) throws Exception {
        var style = fixture(true, combined);
        assertEquals(0xff9ca3af, render(style, 0d));
        assertEquals(0xffff0000, render(style, 1d));
        assertEquals(0, render(style, 13d));
        assertEquals(0xff0000ff, render(style, null));
        assertEquals(0xff9ca3af, render(fixture(false, combined), null));
    }

    /**
     * Reproduce the former ElseFilter disappearing when label rules are combined.
     *
     * @throws Exception if fixture parsing fails
     */
    @Test
    void legacyElseFallbackDisappearsWhenLabelRulesAreCombined() throws Exception {
        var separate = fixture(true, false);
        var fallback = separate.featureTypeStyles().get(0).rules().get(3);
        fallback.setFilter(null);
        fallback.setElseFilter(true);
        assertEquals(0xff9ca3af, render(separate, 0d));
        separate.featureTypeStyles().get(0).rules().addAll(separate.featureTypeStyles().get(1).rules());
        separate.featureTypeStyles().remove(1);
        assertEquals(0, render(separate, 0d));
    }
}
