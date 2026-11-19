package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Rectangle;
import java.awt.image.BandedSampleModel;
import java.awt.image.BufferedImage;
import java.awt.image.DataBuffer;
import java.io.File;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import org.eclipse.imagen.ROIShape;
import org.eclipse.imagen.TiledImage;
import org.eclipse.imagen.media.range.NoDataContainer;
import org.geotools.api.filter.expression.Function;
import org.geotools.api.style.RasterSymbolizer;
import org.geotools.api.style.Style;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.coverage.util.CoverageUtilities;
import org.geotools.factory.CommonFactoryFinder;
import org.geotools.gce.geotiff.GeoTiffReader;
import org.geotools.gce.geotiff.GeoTiffWriter;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.map.GridCoverageLayer;
import org.geotools.map.GridReaderLayer;
import org.geotools.map.Layer;
import org.geotools.map.MapContent;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.geotools.renderer.lite.StreamingRenderer;
import org.geotools.xml.styling.SLDParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/** Check pixels painted by GeoTools from the same SLD emitted by the application's WMS adapter. */
class RasterValueOverrideStyleTest {
    /** Parse a style fixture checked against the production SLD builder by the WMS tests. */
    private static Style readStyle(String resource) throws Exception {
        try (var input = RasterValueOverrideStyleTest.class.getResourceAsStream(resource)) {
            assertNotNull(input);
            return new SLDParser(CommonFactoryFinder.getStyleFactory(), input).readXML()[0];
        }
    }

    /** Load the checked SLD and select the same gradient with or without an exact value. */
    private static Style style(Double target, double opacity) throws Exception {
        var style = readStyle("/raster-value-override.sld");
        var passes = style.featureTypeStyles();
        if (target == null) {
            passes.remove(1);
            passes.get(0).setTransformation(null);
            return style;
        }
        var filters = CommonFactoryFinder.getFilterFactory();
        var mask = (Function) passes.get(0).getTransformation();
        var bounds = filters.literal(target + "," + target);
        passes.get(0).setTransformation(filters.function(mask.getName(), filters.literal("gradient"), bounds));
        passes.get(1).setTransformation(filters.function(mask.getName(), filters.literal("ranges"), bounds));
        if (opacity == 0) {
            passes.remove(1);
        } else {
            var symbolizer = (RasterSymbolizer) passes.get(1).rules().get(0).symbolizers().get(0);
            symbolizer.getColorMap().getColorMapEntries()[0].setOpacity(filters.literal(opacity));
        }
        return style;
    }

    /** Paint complete layers bottom-first on a transparent map, disposing their readers afterward. */
    private static BufferedImage render(int width, int height, Layer... layers) {
        return render(layers[0].getBounds(), width, height, layers);
    }

    /** Paint a map at a selected extent and screen resolution to exercise native sampling. */
    private static BufferedImage render(ReferencedEnvelope bounds, int width, int height, Layer... layers) {
        var map = new MapContent();
        var image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        var graphics = image.createGraphics();
        try {
            for (var layer : layers) map.addLayer(layer);
            var renderer = new StreamingRenderer();
            renderer.setMapContent(map);
            renderer.paint(graphics, new Rectangle(0, 0, width, height), bounds);
            return image;
        } finally {
            graphics.dispose();
            map.dispose();
        }
    }

    /** Open a fresh GeoTIFF layer whose original cells alternate 0/2 and whose overviews contain 1. */
    private static GridReaderLayer checkerboard(Style style) throws Exception {
        return rasterFixture("/categorical-averaged-overview.tif", style);
    }

    /** Open a real GeoTIFF for one layer so the native renderer chooses its samples and source mask. */
    private static GridReaderLayer rasterFixture(String name, Style style) throws Exception {
        var file = RasterValueOverrideStyleTest.class.getResource(name);
        assertNotNull(file);
        return new GridReaderLayer(new GeoTiffReader(new File(file.toURI())), style);
    }

    /** Construct a double-valued row with finite NoData and an excluded last pixel in the source mask. */
    private static GridCoverageLayer sampleRow(double[] samples, Style style) {
        var model = new BandedSampleModel(DataBuffer.TYPE_DOUBLE, samples.length, 1, 1);
        var image = new TiledImage(0, 0, samples.length, 1, 0, 0, model, null);
        for (int x = 0; x < samples.length; x++) image.setSample(x, 0, 0, samples[x]);
        var bounds = new ReferencedEnvelope(0, samples.length, 0, 1, DefaultGeographicCRS.WGS84);
        var properties = new HashMap<String, Object>();
        properties.put(NoDataContainer.GC_NODATA, new NoDataContainer(-32768d));
        CoverageUtilities.setROIProperty(properties, new ROIShape(new Rectangle(0, 0, samples.length - 1, 1)));
        var coverage = new GridCoverageFactory().create("samples", image, bounds, null, null, properties);
        return new GridCoverageLayer(coverage, style);
    }

    /** Expected red over transparency with the fixture's 50% whole-layer opacity. */
    private static int replacementColor(double opacity) {
        return opacity == 0 ? 0 : ((int) Math.round(255 * opacity * 0.5) << 24) | 0xff0000;
    }

    /** An absent value leaves every painted pixel intact, including those read from averaged overviews. */
    @ParameterizedTest
    @CsvSource({"256,99", "16,99", "256,0", "16,0", "256,1", "16,1"})
    void colorsOnlyTheSampleUsedByTheOrdinaryGradient(int size, double target) throws Exception {
        var ordinary = render(size, size, checkerboard(style(null, 0)));
        var styled = render(size, size, checkerboard(style(target, 0.5)));
        assertEquals(size == 16 ? 0x800000ff : 0x6600ff00, ordinary.getRGB(1, 0));
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                int sample = size == 16 ? 1 : ((x + y) % 2) * 2;
                assertEquals(sample == target ? replacementColor(0.5) : ordinary.getRGB(x, y), styled.getRGB(x, y));
            }
        }
    }

    /** Replace fractional Float32 samples from disk while keeping declared NaN cells transparent. */
    @Test
    void colorsFloatSamplesAndPreservesDeclaredNaN() throws Exception {
        var name = "/categorical-float-nodata.tif";
        var ordinary = render(8, 8, rasterFixture(name, style(null, 0)));
        var styled = render(8, 8, rasterFixture(name, style(101551.296875, 0.5)));
        var ranged = render(8, 8, rasterFixture(name, readStyle("/raster-range-overrides.sld")));
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                int expected = switch (x) {
                    case 2, 3 -> replacementColor(0.5);
                    case 4, 5 -> 0;
                    default -> ordinary.getRGB(x, y);
                };
                assertEquals(expected, styled.getRGB(x, y));
                int rangeColor = switch (x) {
                    case 2, 3 -> 0x80ff00ff;
                    case 4, 5 -> 0;
                    default -> 0x80000000;
                };
                assertEquals(rangeColor, ranged.getRGB(x, y));
            }
        }
    }

    /** Changing the override opacity cannot paint an unsigned GeoTIFF's declared NoData in a cropped tile. */
    @Test
    void croppedUnsignedNoDataStaysTransparent(@TempDir Path directory) throws Exception {
        var image = new BufferedImage(128, 128, BufferedImage.TYPE_USHORT_GRAY);
        for (int y = 0; y < 128; y++) {
            for (int x = 0; x < 128; x++) {
                image.getRaster().setSample(x, y, 0, (x + y) % 31 == 0 ? 65535 : 1);
            }
        }
        var bounds = new ReferencedEnvelope(-1, 1, -1, 1, DefaultGeographicCRS.WGS84);
        var properties = new HashMap<String, Object>();
        CoverageUtilities.setNoDataProperty(properties, 65535d);
        var source = new GridCoverageFactory().create("unsigned", image, bounds, null, null, properties);
        var file = directory.resolve("unsigned.tif").toFile();
        var writer = new GeoTiffWriter(file);
        try {
            writer.write(source, null);
        } finally {
            writer.dispose();
        }
        var crop = new ReferencedEnvelope(-.87, -.06, -.93, -.3387, DefaultGeographicCRS.WGS84);
        var hidden = render(crop, 127, 124, new GridReaderLayer(new GeoTiffReader(file), style(65535d, 0)));
        var colored = render(crop, 127, 124, new GridReaderLayer(new GeoTiffReader(file), style(65535d, 1)));
        int[] expected = hidden.getRGB(0, 0, 127, 124, null, 0, 127);
        assertTrue(Arrays.stream(expected).anyMatch(pixel -> pixel == 0));
        assertTrue(Arrays.stream(expected).anyMatch(pixel -> pixel == 0x800000ff));
        assertArrayEquals(expected, colored.getRGB(0, 0, 127, 124, null, 0, 127));
        var ranged = render(crop, 127, 124,
                new GridReaderLayer(new GeoTiffReader(file), readStyle("/raster-range-overrides.sld")));
        for (int y = 0; y < 124; y++) {
            for (int x = 0; x < 127; x++) {
                assertEquals(hidden.getRGB(x, y) == 0 ? 0 : 0x80000000, ranged.getRGB(x, y));
            }
        }
    }

    /** Transparent matches reveal an independently rendered layer below them in a combined map. */
    @Test
    void transparentMatchRevealsLowerRaster() throws Exception {
        var below = render(16, 16, checkerboard(style(null, 0)));
        var combined = render(16, 16, checkerboard(style(null, 0)), checkerboard(style(1d, 0)));
        assertEquals(0x800000ff, below.getRGB(0, 0));
        assertArrayEquals(below.getRGB(0, 0, 16, 16, null, 0, 16), combined.getRGB(0, 0, 16, 16, null, 0, 16));
    }

    /** An unused rule in the middle of a translucent layer stack preserves the complete map. */
    @Test
    void absentValuePreservesStackedLayerColors() throws Exception {
        var lower = style(null, 0);
        var upper = style(null, 0);
        var filters = CommonFactoryFinder.getFilterFactory();
        var lowerSymbol = (RasterSymbolizer) lower.featureTypeStyles().get(0).rules().get(0).symbolizers().get(0);
        var upperSymbol = (RasterSymbolizer) upper.featureTypeStyles().get(0).rules().get(0).symbolizers().get(0);
        lowerSymbol.setOpacity(filters.literal(0.47));
        lowerSymbol.getColorMap().getColorMapEntries()[1].setColor(filters.literal("#e6910c"));
        upperSymbol.setOpacity(filters.literal(0.37));
        upperSymbol.getColorMap().getColorMapEntries()[1].setColor(filters.literal("#489dc2"));
        var ordinary = render(16, 16, checkerboard(lower), checkerboard(style(null, 0)), checkerboard(upper));
        var styled = render(16, 16, checkerboard(lower), checkerboard(style(99d, 0.5)), checkerboard(upper));
        assertArrayEquals(ordinary.getRGB(0, 0, 16, 16, null, 0, 16), styled.getRGB(0, 0, 16, 16, null, 0, 16));
    }

    /** Preserve the native gradient for adjacent doubles and the mask even if its value matches the rule. */
    @ParameterizedTest
    @ValueSource(doubles = {-9999.5, 0, 0.5, 1, 2, -32768})
    void exactValueOpacityAndNoData(double target) throws Exception {
        double[] samples = {-32768, -9999.5, -1, -0d, 0, Math.nextUp(0d), .49,
                Math.nextDown(.5), .5, Math.nextUp(.5), .8, 1, 1.5, 2, 20, .5};
        var ordinary = render(samples.length, 1, sampleRow(samples, style(null, 0)));
        for (double opacity : new double[]{0, 0.5, 1}) {
            var styled = render(samples.length, 1, sampleRow(samples, style(target, opacity)));
            for (int x = 0; x < samples.length; x++) {
                int expected = samples[x] == -32768 || x == samples.length - 1 ? 0 : samples[x] == target
                        ? replacementColor(opacity) : ordinary.getRGB(x, 0);
                assertEquals(expected, styled.getRGB(x, 0), "Sample " + samples[x] + ", target " + target);
            }
        }
    }

    /** Paint inclusive ranges, exact exceptions, and intervening gradient samples at layer opacity 50%. */
    @Test
    void rangesReplaceOnlyMatchingPixelsInPriorityOrder() throws Exception {
        double[] samples = {-32768, Math.nextDown(-9999.5), -9999.5, Math.nextUp(-9999.5),
                -15, 0, 1, Math.nextUp(1d), 10, Math.nextDown(25.25),
                25.25, 30.5, Math.nextUp(30.5), 40, Math.nextUp(40d), 50, Math.nextDown(100d),
                100, 100.25, 1000, 100};
        var resource = "/raster-range-overrides.sld";
        var gradient = readStyle(resource);
        gradient.featureTypeStyles().remove(1);
        gradient.featureTypeStyles().get(0).setTransformation(null);
        var ordinary = render(samples.length, 1, sampleRow(samples, gradient));
        var styled = render(samples.length, 1, sampleRow(samples, readStyle(resource)));
        for (int x = 0; x < samples.length; x++) {
            double value = samples[x];
            int expected = ordinary.getRGB(x, 0);
            if (x == samples.length - 1 || value == -32768 || value == -9999.5) expected = 0;
            else if (value <= 1) expected = 0x80000000;
            else if (value >= 100) expected = 0x80ff00ff;
            else if (value >= 25.25 && value <= 30.5) expected = replacementColor(0.5);
            else if (value <= 40 && value >= 30.5) expected = 0;
            assertEquals(expected, styled.getRGB(x, 0), "Sample " + value + " at " + x);
        }
    }

    /** Tiny overlapping intervals retain distinct neighbors on either side of an exact transparent zero. */
    @Test
    void smallRangesKeepAdjacentDoubleSamplesDistinct() throws Exception {
        var style = readStyle("/raster-range-overrides.sld");
        var filters = CommonFactoryFinder.getFilterFactory();
        var bounds = filters.literal("0.0,0.0|-1e-8,1e-8|1e-8,2e-8");
        for (var pass : style.featureTypeStyles()) {
            var mask = (Function) pass.getTransformation();
            pass.setTransformation(filters.function(mask.getName(), mask.getParameters().get(0), bounds));
        }
        double[] samples = {-1e-8, Math.nextDown(0d), 0, Math.nextUp(0d),
                1e-8, Math.nextUp(1e-8), 2e-8, 0};
        var styled = render(samples.length, 1, sampleRow(samples, style));
        assertArrayEquals(new int[]{0x80000000, 0x80000000, 0, 0x80000000,
                0x80000000, 0x80ff00ff, 0x80ff00ff, 0}, styled.getRGB(0, 0, samples.length, 1, null, 0, samples.length));
    }
}
