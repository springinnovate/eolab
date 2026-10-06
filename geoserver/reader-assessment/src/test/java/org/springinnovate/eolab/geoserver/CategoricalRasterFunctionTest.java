package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.awt.image.BandedSampleModel;
import java.awt.image.DataBuffer;
import java.awt.image.RenderedImage;
import java.io.File;
import java.lang.reflect.Proxy;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import org.eclipse.imagen.InterpolationBilinear;
import org.eclipse.imagen.InterpolationNearest;
import org.eclipse.imagen.PlanarImage;
import org.eclipse.imagen.ROIShape;
import org.eclipse.imagen.TiledImage;
import org.eclipse.imagen.media.range.NoDataContainer;
import org.geotools.api.coverage.grid.GridCoverageReader;
import org.geotools.api.data.Query;
import org.geotools.api.parameter.GeneralParameterValue;
import org.geotools.api.parameter.ParameterValue;
import org.geotools.api.style.FeatureTypeStyle;
import org.geotools.api.style.RasterSymbolizer;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.coverage.grid.GridEnvelope2D;
import org.geotools.coverage.grid.GridGeometry2D;
import org.geotools.coverage.grid.io.AbstractGridFormat;
import org.geotools.coverage.grid.io.DecimationPolicy;
import org.geotools.coverage.grid.io.OverviewPolicy;
import org.geotools.coverage.util.CoverageUtilities;
import org.geotools.factory.CommonFactoryFinder;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.gce.geotiff.GeoTiffFormat;
import org.geotools.gce.geotiff.GeoTiffReader;
import org.geotools.map.GridReaderLayer;
import org.geotools.map.MapContent;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.geotools.renderer.lite.StreamingRenderer;
import org.geotools.renderer.lite.gridcoverage2d.RasterSymbolizerHelper;
import org.geotools.util.factory.Hints;
import org.geotools.xml.styling.SLDParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Regression coverage through the SLD SPI, native classifier, and raster read override. */
class CategoricalRasterFunctionTest {
    /** Parses the actual Python-generated fixture through GeoTools' service-discovered factory. */
    private static FeatureTypeStyle fixture() throws Exception {
        try (var input = CategoricalRasterFunctionTest.class.getResourceAsStream("/categorical-raster.sld")) {
            assertNotNull(input);
            return new SLDParser(CommonFactoryFinder.getStyleFactory(), input)
                    .readXML()[0].featureTypeStyles().get(0);
        }
    }

    /** Builds a native function with fixed literal arguments, just as generated SLD does. */
    private static CategoricalRasterFunction function(String table, String color, String opacity) {
        var factory = CommonFactoryFinder.getFilterFactory();
        return new CategoricalRasterFunction(List.of(
                factory.literal(table), factory.literal(color), factory.literal(opacity)));
    }

    /** Builds a small numeric coverage with an optional declared source NoData value. */
    private static GridCoverage2D source(int type, Double noData, double... values) {
        var samples = new BandedSampleModel(type, values.length, 1, 1);
        var image = new TiledImage(0, 0, values.length, 1, 0, 0, samples,
                PlanarImage.createColorModel(samples));
        for (int x = 0; x < values.length; x++) {
            image.setSample(x, 0, 0, values[x]);
        }
        var envelope = new ReferencedEnvelope(0, values.length, 0, 1, DefaultGeographicCRS.WGS84);
        Map<String, Object> properties = noData == null ? Map.of()
                : Map.of(NoDataContainer.GC_NODATA, new NoDataContainer(noData));
        return new GridCoverageFactory().create("source", image, envelope, null, null, properties);
    }

    /** Reads actual rendered ARGB rather than assuming a color-map index or sample model. */
    private static int argb(RenderedImage image, int x) {
        return image.getColorModel().getRGB(image.getData().getDataElements(x, 0, null));
    }

    /** Exact matching includes browser-safe endpoints, fractional neighbors, and nonfinite samples. */
    @Test
    void generatedSldClassifiesExactValuesAndFallback() throws Exception {
        var transform = assertInstanceOf(CategoricalRasterFunction.class, fixture().getTransformation());
        double[] values = {-Double.MAX_VALUE, -9007199254740991d, Math.nextDown(-1d), -1,
                Math.nextUp(-1d), -0d, 0d, Math.nextUp(0d), Math.nextDown(1d), 1,
                Math.nextUp(1d), 40.5, Math.nextDown(41d), 41, Math.nextUp(41d), 42,
                9007199254740991d, Double.MAX_VALUE, Double.NaN,
                Double.NEGATIVE_INFINITY, Double.POSITIVE_INFINITY};
        var original = source(DataBuffer.TYPE_DOUBLE, Double.NaN, values);
        var output = (GridCoverage2D) transform.evaluate(original);
        var image = output.getRenderedImage();
        for (int x = 0; x < values.length; x++) {
            double value = values[x];
            int expected = !Double.isFinite(value) || value == 0 ? 0
                    : value == 1 ? 0x80ff0000
                    : value == -9007199254740991d || value == -1 || value == 41
                            || value == 9007199254740991d ? 0xffff0000 : 0xff808080;
            int actual = argb(image, x);
            assertEquals(expected >>> 24, actual >>> 24, "alpha at " + value);
            if (expected != 0) {
                assertEquals(expected, actual, "color at " + value);
            }
        }
        assertSame(original, output.getSources().get(0));
        assertEquals(41, original.getRenderedImage().getData().getSampleDouble(13, 0, 0));
        output.dispose(true);
    }

    /** A declared finite source NoData overrides even an explicitly colored category. */
    @ParameterizedTest
    @ValueSource(ints = {DataBuffer.TYPE_SHORT, DataBuffer.TYPE_FLOAT, DataBuffer.TYPE_DOUBLE})
    void preservesFiniteNoDataWithGrayUnmapped(int type) throws Exception {
        var transform = fixture().getTransformation();
        var original = source(type, -1d, -1, 41, 42, 0, 1);
        var output = (GridCoverage2D) transform.evaluate(original);
        var image = output.getRenderedImage();
        assertEquals(0, argb(image, 0) >>> 24);
        assertEquals(0xffff0000, argb(image, 1));
        assertEquals(0xff808080, argb(image, 2));
        assertEquals(0, argb(image, 3) >>> 24);
        assertEquals(0x80ff0000, argb(image, 4));
        output.dispose(true);
    }

    /** Unsigned source NoData is preserved without treating an undeclared high value as missing. */
    @Test
    void preservesUnsignedNoDataAndUndeclaredSamples() {
        var transform = function("65535:#123456:1;0:#abcdef:1", "#808080", "0.25");
        for (Double noData : new Double[] {65535d, null}) {
            var output = (GridCoverage2D) transform.evaluate(source(DataBuffer.TYPE_USHORT, noData, 65535, 0, 42));
            assertEquals(noData == null ? 255 : 0, argb(output.getRenderedImage(), 0) >>> 24);
            assertEquals(0xffabcdef, argb(output.getRenderedImage(), 1));
            assertEquals(0x40808080, argb(output.getRenderedImage(), 2));
            output.dispose(true);
        }
    }

    /** Adjacent large integers remain distinct even when no representable number separates them. */
    @Test
    void distinguishesAdjacentSafeIntegers() {
        var transform = function("9007199254740990:#ff0000:1;9007199254740991:#00ff00:1;"
                + "-9007199254740991:#0000ff:1;-9007199254740990:#ffffff:1", "#808080", "1");
        var output = (GridCoverage2D) transform.evaluate(source(DataBuffer.TYPE_DOUBLE, null,
                9007199254740990d, 9007199254740991d, -9007199254740991d, -9007199254740990d));
        assertEquals(0xffff0000, argb(output.getRenderedImage(), 0));
        assertEquals(0xff00ff00, argb(output.getRenderedImage(), 1));
        assertEquals(0xff0000ff, argb(output.getRenderedImage(), 2));
        assertEquals(0xffffffff, argb(output.getRenderedImage(), 3));
        output.dispose(true);
    }

    /** The reader hook bypasses potentially averaged overviews without changing shared parameters. */
    @Test
    void customizesOnlyIndependentReadParameters() {
        var transform = function("1:#123456:1", "#808080", "1");
        var overview = AbstractGridFormat.OVERVIEW_POLICY.createValue();
        overview.setValue(OverviewPolicy.NEAREST);
        var interpolation = AbstractGridFormat.INTERPOLATION.createValue();
        interpolation.setValue(new InterpolationBilinear());
        var bands = AbstractGridFormat.BANDS.createValue();
        bands.setValue(new int[] {0});
        var geometry = AbstractGridFormat.READ_GRIDGEOMETRY2D.createValue();
        geometry.setValue(new GridGeometry2D(new GridEnvelope2D(0, 0, 256, 256),
                new ReferencedEnvelope(0, 10, 0, 10, DefaultGeographicCRS.WGS84)));
        GridCoverageReader reader = (GridCoverageReader) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[] {GridCoverageReader.class},
                (proxy, method, args) -> method.getName().equals("getFormat") ? new GeoTiffFormat() : null);
        GeneralParameterValue[] output = transform.customizeReadParams(reader, overview, interpolation, bands, geometry);
        assertEquals(OverviewPolicy.NEAREST, overview.getValue());
        assertInstanceOf(InterpolationBilinear.class, interpolation.getValue());
        var byName = Arrays.stream(output).map(value -> (ParameterValue<?>) value)
                .collect(Collectors.toMap(value -> value.getDescriptor().getName().getCode(), ParameterValue::getValue));
        assertEquals(OverviewPolicy.IGNORE, byName.get(AbstractGridFormat.OVERVIEW_POLICY.getName().getCode()));
        assertEquals(DecimationPolicy.ALLOW, byName.get(AbstractGridFormat.DECIMATION_POLICY.getName().getCode()));
        assertInstanceOf(InterpolationNearest.class, byName.get(AbstractGridFormat.INTERPOLATION.getName().getCode()));
        assertNotSame(bands, Arrays.stream(output).filter(value -> value.getDescriptor().getName()
                .equals(AbstractGridFormat.BANDS.getName())).findFirst().orElseThrow());
        assertEquals(3, transform.customizeReadParams(reader).length);
    }

    /** ROI exclusion remains transparent independently of unmapped appearance or category opacity. */
    @Test
    void masksSourceRoiWithoutChangingValidFallback() {
        var original = source(DataBuffer.TYPE_SHORT, null, 1, 2, 1, 2);
        var properties = new java.util.HashMap<String, Object>();
        CoverageUtilities.setROIProperty(properties, new ROIShape(new java.awt.Rectangle(0, 0, 2, 1)));
        var maskedSource = new GridCoverageFactory().create("masked", original.getRenderedImage(),
                original.getGridGeometry(), null, null, properties);
        var output = (GridCoverage2D) function("1:#ff0000:0.5", "#808080", "1").evaluate(maskedSource);
        assertEquals(0x80ff0000, argb(output.getRenderedImage(), 0));
        assertEquals(0xff808080, argb(output.getRenderedImage(), 1));
        assertEquals(0, argb(output.getRenderedImage(), 2) >>> 24);
        assertEquals(0, argb(output.getRenderedImage(), 3) >>> 24);
        output.dispose(true);
        original.dispose(true);
    }

    /** A real GeoTIFF read bypasses averaged overview values using only request-local policy. */
    @Test
    void ignoresAveragedOverviewsAtNativeReadBoundary() throws Exception {
        var fixture = getClass().getResource("/categorical-averaged-overview.tif");
        assertNotNull(fixture);
        var reader = new GeoTiffReader(new File(fixture.toURI()));
        try {
            var transform = function("0:#ff0000:1;2:#00ff00:1", "#808080", "1");
            var geometry = AbstractGridFormat.READ_GRIDGEOMETRY2D.createValue();
            geometry.setValue(new GridGeometry2D(new GridEnvelope2D(0, 0, 16, 16), reader.getOriginalEnvelope()));
            var overview = AbstractGridFormat.OVERVIEW_POLICY.createValue();
            overview.setValue(OverviewPolicy.NEAREST);
            var averaged = reader.read(geometry, overview);
            assertEquals(1, averaged.getRenderedImage().getData().getSample(8, 8, 0));
            averaged.dispose(true);
            var original = reader.read(transform.customizeReadParams(reader, geometry, overview));
            assertEquals(16, original.getRenderedImage().getWidth());
            assertEquals(16, original.getRenderedImage().getHeight());
            var output = (GridCoverage2D) transform.evaluate(original);
            var image = output.getRenderedImage();
            var raster = image.getData();
            for (int y = 0; y < 16; y++) {
                for (int x = 0; x < 16; x++) {
                    int color = image.getColorModel().getRGB(raster.getDataElements(x, y, null));
                    org.junit.jupiter.api.Assertions.assertTrue(color == 0xffff0000 || color == 0xff00ff00);
                }
            }
            output.dispose(true);
            assertEquals(OverviewPolicy.NEAREST, overview.getValue());
        } finally {
            reader.dispose();
        }
    }

    /** The real renderer supplies geometry and invokes the overview override before classification. */
    @Test
    void rendersThroughNativeTransformationReadPipeline() throws Exception {
        var location = getClass().getResource("/categorical-averaged-overview.tif");
        assertNotNull(location);
        var reader = new GeoTiffReader(new File(location.toURI()));
        var content = new MapContent();
        var canvas = new java.awt.image.BufferedImage(16, 16, java.awt.image.BufferedImage.TYPE_INT_ARGB);
        var graphics = canvas.createGraphics();
        try {
            var featureStyle = fixture();
            featureStyle.setTransformation(function("0:#ff0000:1;2:#00ff00:1", "#808080", "1"));
            var style = CommonFactoryFinder.getStyleFactory().createStyle();
            style.featureTypeStyles().add(featureStyle);
            content.addLayer(new GridReaderLayer(reader, style));
            var renderer = new StreamingRenderer();
            renderer.setMapContent(content);
            renderer.setJava2DHints(new java.awt.RenderingHints(
                    org.eclipse.imagen.ImageN.KEY_INTERPOLATION, new InterpolationNearest()));
            renderer.paint(graphics, new java.awt.Rectangle(0, 0, 16, 16),
                    new ReferencedEnvelope(reader.getOriginalEnvelope()));
            for (int y = 0; y < 16; y++) {
                for (int x = 0; x < 16; x++) {
                    int color = canvas.getRGB(x, y);
                    org.junit.jupiter.api.Assertions.assertTrue(color == 0xffff0000 || color == 0xff00ff00,
                            "Unexpected rendered color at " + x + "," + y + ": " + Integer.toHexString(color));
                }
            }
        } finally {
            graphics.dispose();
            content.dispose();
            reader.dispose();
        }
    }

    /** Final symbolizer processing must not reinterpret source NoData as a valid palette index. */
    @ParameterizedTest
    @ValueSource(ints = {0, 255})
    void finalSymbolizerPreservesTransparentAndOpaquePaletteEntries(int noData) throws Exception {
        String table = IntStream.range(0, 256).mapToObj(value -> value + ":#123456:1")
                .collect(Collectors.joining(";"));
        var transform = function(table, "#808080", "0.25");
        var output = (GridCoverage2D) transform.evaluate(source(DataBuffer.TYPE_USHORT, (double) noData,
                noData, 1, 254, 300));
        var helper = new RasterSymbolizerHelper(output, new Hints());
        var symbolizer = (RasterSymbolizer) fixture().rules().get(0).symbolizers().get(0);
        helper.visit(symbolizer);
        var finalCoverage = helper.execute();
        var image = finalCoverage.getRenderedImage();
        assertEquals(0, argb(image, 0) >>> 24);
        assertEquals(0xff123456, argb(image, 1));
        assertEquals(0xff123456, argb(image, 2));
        assertEquals(0x40808080, argb(image, 3));
        finalCoverage.dispose(true);
    }

    /** Rejects oversized work before native reading, and honors cancellation before classifying. */
    @Test
    void boundsReadGeometryAndCancellation() {
        var transform = function("1:#123456:1", "#808080", "1");
        var envelope = new ReferencedEnvelope(0, 10, 0, 10, DefaultGeographicCRS.WGS84);
        var normal = new GridGeometry2D(new GridEnvelope2D(0, 0, 256, 256), envelope);
        assertSame(normal, transform.invertGridGeometry(new Query(), normal));
        var oversized = new GridGeometry2D(new GridEnvelope2D(0, 0, 4097, 1), envelope);
        assertThrows(IllegalArgumentException.class, () -> transform.invertGridGeometry(new Query(), oversized));
        assertThrows(IllegalArgumentException.class, () -> transform.evaluate(source(DataBuffer.TYPE_DOUBLE, null, new double[4097])));
        try {
            Thread.currentThread().interrupt();
            assertThrows(CancellationException.class, () -> transform.invertGridGeometry(new Query(), normal));
            assertThrows(CancellationException.class, () -> transform.evaluate(null));
        } finally {
            Thread.interrupted();
        }
    }

    /** Native validation also constrains unsupported expressions and finite integer/color/alpha bounds. */
    @Test
    void rejectsMalformedNativeArguments() {
        for (String row : List.of("1.5:#123456:1", "NaN:#123456:1", "9007199254740992:#123456:1",
                "1:#123456:1;1:#123456:1", "0:#123456:1;-0:#123456:1", "1:red:1",
                "1:#123456:NaN", "1:#123456:1.1", "1:#123456:-0.1", "1:#123456:1;")) {
            assertThrows(IllegalArgumentException.class, () -> function(row, "#808080", "1"), row);
        }
        var factory = CommonFactoryFinder.getFilterFactory();
        assertThrows(IllegalArgumentException.class, () -> new CategoricalRasterFunction(List.of(
                factory.property("categories"), factory.literal("#808080"), factory.literal("1"))));
        String table = IntStream.range(0, 256).mapToObj(value -> value + ":#123456:1")
                .collect(Collectors.joining(";"));
        assertNotNull(function(table, "#808080", "1"));
        assertThrows(IllegalArgumentException.class, () -> function(table + ";256:#123456:1", "#808080", "1"));
    }
}
