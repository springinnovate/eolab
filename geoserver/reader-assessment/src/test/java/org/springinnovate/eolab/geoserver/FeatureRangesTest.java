package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import org.geotools.feature.simple.SimpleFeatureBuilder;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.filter.text.ecql.ECQL;
import org.junit.jupiter.api.Test;

/** Check the ECQL sent to GeoServer for spatially filtered map tiles. */
class FeatureRangesTest {
    /**
     * Read native IDs from features and match both ends of each selected interval.
     * @throws Exception if the registered function cannot be parsed by GeoTools
     */
    @Test
    void matchesOriginalFeatureIds() throws Exception {
        var builder = new SimpleFeatureTypeBuilder();
        builder.setName("parcels");
        builder.add("name", String.class);
        var schema = builder.buildFeatureType();
        var selected = ECQL.toFilter("eolabFeatureInRanges('2:4,7,9007199254741003') = true");
        var empty = ECQL.toFilter("eolabFeatureInRanges('') = true");
        for (long id : new long[] {1, 2, 3, 4, 5, 7, 8, 9007199254741003L}) {
            var parcel = SimpleFeatureBuilder.build(schema, new Object[] {"test"}, "parcels." + id);
            assertEquals(id >= 2 && id <= 4 || id == 7 || id == 9007199254741003L, selected.evaluate(parcel));
            assertFalse(empty.evaluate(parcel));
        }
    }
}
