package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.geotools.api.feature.simple.SimpleFeature;
import org.geotools.api.style.Style;
import org.geotools.factory.CommonFactoryFinder;
import org.geotools.feature.simple.SimpleFeatureBuilder;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.filter.text.ecql.ECQL;
import org.geotools.xml.styling.SLDParser;
import org.junit.jupiter.api.Test;

/** Verify Python-generated calculated-field SLD and native ECQL share finite arithmetic. */
class VectorArithmeticTest {
    /**
     * Construct a native attribute without converting its original scalar type.
     * @param value original field value
     * @return a feature for testing native property lookup and arithmetic
     */
    private static SimpleFeature feature(Object value) {
        var type = new SimpleFeatureTypeBuilder();
        type.setName("parcels");
        type.add("owner's value", Object.class);
        return SimpleFeatureBuilder.build(type.buildFeatureType(), new Object[] {value}, "parcels.1");
    }
    /**
     * Parse the production-generated appearance consumed by ordinary WMS rendering.
     * @return graduated style with two numeric classes and an explicit missing class
     * @throws Exception when native SLD parsing fails
     */
    private static Style style() throws Exception {
        try (var input = VectorArithmeticTest.class.getResourceAsStream("/vector-calculated-fields.sld")) {
            assertNotNull(input);
            return new SLDParser(CommonFactoryFinder.getStyleFactory(), input).readXML()[0];
        }
    }

    /**
     * Exercise missing, text-conversion and chained arithmetic through actual native class filters.
     * @throws Exception if SLD parsing or feature construction fails
     */
    @Test
    void generatedSldClassifiesExactlyOneRuleIncludingMissingValues() throws Exception {
        var rules = style().featureTypeStyles().get(0).rules();
        var type = new SimpleFeatureTypeBuilder();
        type.setName("parcels");
        type.add("people text", String.class);
        type.add("area km2", Double.class);
        var schema = type.buildFeatureType();
        Object[][] rows = {{"8", 2d, 0}, {" 1e2 ", 4d, 1}, {"\u0085\u00a0100\u202f", 4d, 1},
                {null, 2d, 2}, {"5", 0d, 2}, {"12abc", 2d, 2}, {" ", 2d, 2}, {"1e309", 2d, 2}};
        for (Object[] row : rows) {
            var feature = SimpleFeatureBuilder.build(schema, new Object[] {row[0], row[1]}, "parcels.1");
            int matching = 0;
            for (int index = 0; index < rules.size(); index++) {
                if (rules.get(index).getFilter().evaluate(feature)) {
                    assertEquals(row[2], index);
                    matching++;
                }
            }
            assertEquals(1, matching);
        }
    }

    /**
     * Native function discovery and ECQL reject partial strings and nonfinite intermediate values.
     * @throws Exception when ECQL parsing fails
     */
    @Test
    void ecqlUsesStrictConversionAndPerOperationMissingValues() throws Exception {
        var strict = ECQL.toExpression("eolabArithmetic('number', \"owner's value\", false)");
        var conversion = ECQL.toExpression("eolabArithmetic('number', \"owner's value\", true)");
        assertEquals(12.5d, strict.evaluate(feature(12.5d)));
        assertNull(strict.evaluate(feature("12.5")));
        assertEquals(1000d, conversion.evaluate(feature(" +1e3 ")));
        for (Object bad : new Object[] {"12abc", "", "1,000", "NaN", "Infinity", true}) {
            assertNull(conversion.evaluate(feature(bad)));
        }
        assertNull(ECQL.toExpression("eolabArithmetic('/', 1, 0)").evaluate(null));
        assertNull(ECQL.toExpression("eolabArithmetic('*', eolabArithmetic('*', 1e308, 2), 0)").evaluate(null));
        assertEquals(-4d, ECQL.toExpression("eolabArithmetic('negate', 4, 0)").evaluate(null));
        assertEquals(3d, ECQL.toExpression("eolabArithmetic('-', 5, 2)").evaluate(null));
        assertEquals(5d, ECQL.toExpression("eolabArithmetic('positive', 5, 0)").evaluate(null));
        assertEquals(2d, ECQL.toExpression("eolabArithmetic('number', '2.0', true)").evaluate(null));
        assertTrue(ECQL.toFilter("eolabArithmetic('number', \"owner's value\", true) IS NULL")
                .evaluate(feature("12abc")));
    }
}
