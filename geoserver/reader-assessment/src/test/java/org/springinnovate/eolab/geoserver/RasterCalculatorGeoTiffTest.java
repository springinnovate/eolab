package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import org.geotools.api.referencing.datum.PixelInCell;
import org.geotools.gce.geotiff.GeoTiffReader;
import org.geotools.referencing.CRS;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/** Open calculator outputs with the GeoTIFF reader shipped in GeoServer. */
@EnabledIfEnvironmentVariable(named = "EOLAB_CALCULATOR_COGS", matches = ".+")
final class RasterCalculatorGeoTiffTest {
    /** Check the opposite corners of each survey against independent WGS84 positions. */
    @Test
    void readsPublishedGridAtSurveyedCoordinates() throws Exception {
        for (String name : new String[] {"degrees", "arcminutes", "height", "mercator"}) {
            var file = Path.of(System.getenv("EOLAB_CALCULATOR_COGS"), name + ".tif").toFile();
            var reader = new GeoTiffReader(file);
            try {
                var image = reader.read().getRenderedImage().getData();
                var grid = reader.getOriginalGridToWorld(PixelInCell.CELL_CENTER);
                var toWgs84 = CRS.findMathTransform(
                        reader.getCoordinateReferenceSystem(), CRS.decode("EPSG:4326", true), true);
                double[] corners = {0, 0, 12, 3};
                grid.transform(corners, 0, corners, 0, 2);
                toWgs84.transform(corners, 0, corners, 0, 2);
                // World Mercator projected coordinates are (500,3500) and (12500,500) metres.
                double[] expected = name.equals("mercator")
                        ? new double[] {2.1414915764, 0.0316529301, 2.2492894105, 0.0045218474}
                        : new double[] {-2.168, 48.365, -2.048, 48.335};
                for (int i = 0; i < corners.length; i++) {
                    assertEquals(expected[i], corners[i], 1e-8, name);
                }
                assertEquals(0, image.getSampleDouble(0, 0, 0), name);
                assertEquals(51, image.getSampleDouble(12, 3, 0), name);
            } finally {
                reader.dispose();
            }
        }
    }
}
