package org.springinnovate.eolab;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.awt.Color;
import java.awt.RenderingHints;
import java.awt.geom.AffineTransform;
import java.awt.image.BandedSampleModel;
import java.awt.image.DataBuffer;
import java.awt.image.RenderedImage;
import java.util.stream.Stream;
import org.eclipse.imagen.BorderExtender;
import org.eclipse.imagen.ImageN;
import org.eclipse.imagen.Interpolation;
import org.eclipse.imagen.PlanarImage;
import org.eclipse.imagen.TiledImage;
import org.eclipse.imagen.media.range.Range;
import org.eclipse.imagen.media.range.RangeFactory;
import org.eclipse.imagen.media.scale.ScaleDescriptor;
import org.eclipse.imagen.media.scale.Scale2Descriptor;
import org.geotools.factory.CommonFactoryFinder;
import org.geotools.image.ImageWorker;
import org.geotools.renderer.lite.gridcoverage2d.SLDColorMapBuilder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** Regression coverage at ImageN's registered scaling and GeoTools color-mapping boundaries. */
class ScaleNoDataTest {
    /** Enumerates both scaling implementations, interpolators and signedness boundaries. */
    static Stream<Arguments> scalingCases() {
        return Stream.of(false, true).flatMap(scale2 -> Stream.of(0, 1, 2).flatMap(interpolation ->
                Stream.of(
                        new double[] {DataBuffer.TYPE_USHORT, 32767},
                        new double[] {DataBuffer.TYPE_USHORT, 32768},
                        new double[] {DataBuffer.TYPE_USHORT, 65535},
                        new double[] {DataBuffer.TYPE_SHORT, -1},
                        new double[] {DataBuffer.TYPE_SHORT, -32768},
                        new double[] {DataBuffer.TYPE_FLOAT, -9999})
                    .map(value -> Arguments.of(scale2, interpolation, (int) value[0], value[1]))));
    }

    /** NoData metadata must name the emitted sample, and valid 50/zero samples remain opaque. */
    @ParameterizedTest(name = "Scale2={0}, interpolation={1}, type={2}, NoData={3}")
    @MethodSource("scalingCases")
    void preservesNoDataThroughColorMapping(boolean scale2, int interpolation, int type, double noData)
            throws Exception {
        RenderedImage scaled = scale(scale2, interpolation, type, noData, null);
        assertNoData(scaled, noData);
        assertColors(scaled);
    }

    /** Explicit output sentinels take precedence over the input range minimum. */
    @Test
    void preservesExplicitBackgroundPrecedence() throws Exception {
        for (boolean scale2 : new boolean[] {false, true}) {
            for (int interpolation : new int[] {0, 1, 2}) {
                RenderedImage scaled = scale(scale2, interpolation, DataBuffer.TYPE_USHORT, 65535,
                        new double[] {60000});
                assertNoData(scaled, 60000);
                assertColors(scaled);
            }
        }
    }

    /** Exercises GeoTools' actual affine-to-Scale dispatch with an implicit background. */
    @Test
    void geotoolsScalingRetainsUnsignedNoData() throws Exception {
        ImageWorker worker = new ImageWorker(source(DataBuffer.TYPE_USHORT, 65535));
        worker.setNoData(RangeFactory.create(65535d, 65535d));
        worker.affine(AffineTransform.getScaleInstance(2, 2), Interpolation.getInstance(0), null);
        assertColors(worker.getRenderedImage());
        assertNoData(worker.getRenderedImage(), 65535);
    }

    /** An undeclared high sample stays valid; the fix must not hard-code 65535 as missing. */
    @Test
    void leavesUndeclaredHighValuesIntact() {
        for (boolean scale2 : new boolean[] {false, true}) {
            TiledImage image = source(DataBuffer.TYPE_USHORT, 65535);
            RenderedImage scaled = scale2
                    ? Scale2Descriptor.create(image, 2d, 2d, 0d, 0d, Interpolation.getInstance(0),
                            null, false, null, null, null)
                    : ScaleDescriptor.create(image, 2f, 2f, 0f, 0f, Interpolation.getInstance(0),
                            null, false, null, null, null);
            assertEquals(65535, scaled.getData().getSample(8, 8, 0));
            assertEquals(50, scaled.getData().getSample(24, 8, 0));
            assertEquals(0, scaled.getData().getSample(40, 8, 0));
        }
    }

    /** Builds a small image with constant NoData, valid-50 and valid-zero regions. */
    private static TiledImage source(int type, double noData) {
        var samples = new BandedSampleModel(type, 24, 8, 1);
        var image = new TiledImage(0, 0, 24, 8, 0, 0, samples, PlanarImage.createColorModel(samples));
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 24; x++) {
                image.setSample(x, y, 0, x < 8 ? noData : x < 16 ? 50 : 0);
            }
        }
        return image;
    }

    /** Calls the registered operation, including its factory's range conversion and defaulting. */
    private static RenderedImage scale(boolean scale2, int interpolation, int type, double noData,
            double[] background) {
        TiledImage image = source(type, noData);
        Range range = RangeFactory.create(noData, noData);
        var hints = new RenderingHints(ImageN.KEY_BORDER_EXTENDER,
                BorderExtender.createInstance(BorderExtender.BORDER_COPY));
        return scale2
                ? Scale2Descriptor.create(image, 2d, 2d, 0d, 0d, Interpolation.getInstance(interpolation),
                        null, false, range, background, hints)
                : ScaleDescriptor.create(image, 2f, 2f, 0f, 0f, Interpolation.getInstance(interpolation),
                        null, false, range, background, hints);
    }

    /** Checks both metadata endpoints against the actual output NoData sample. */
    private static void assertNoData(RenderedImage scaled, double expected) {
        assertEquals(expected, scaled.getData().getSampleDouble(8, 8, 0));
        Range range = new ImageWorker(scaled).getNoData();
        assertNotNull(range);
        assertEquals(expected, range.getMin().doubleValue());
        assertEquals(expected, range.getMax().doubleValue());
    }

    /** Applies a normal ramp and checks alpha alongside exact valid-pixel colors. */
    private static void assertColors(RenderedImage scaled) throws Exception {
        var styleFactory = CommonFactoryFinder.getStyleFactory();
        var filterFactory = CommonFactoryFinder.getFilterFactory();
        var builder = new SLDColorMapBuilder();
        builder.setExtendedColors(false).setLinearColorMapType(1).setNumberColorMapEntries(3)
                .setColorForValuesToPreserve(new Color(0, 0, 0, 0)).setGapsColor(new Color(0, 0, 0, 0));
        String[] colors = {"#2b83ba", "#ffffbf", "#d7191c"};
        for (int i = 0; i < colors.length; i++) {
            var entry = styleFactory.createColorMapEntry();
            entry.setColor(filterFactory.literal(colors[i]));
            entry.setQuantity(filterFactory.literal(i * 50));
            entry.setOpacity(filterFactory.literal(1));
            builder.addColorMapEntry(entry);
        }
        var worker = new ImageWorker(scaled);
        worker.classify(builder.buildLinearColorMap(), null);
        RenderedImage colored = worker.getRenderedImage();
        assertEquals(0, argb(colored, 8) >>> 24, "NoData must be transparent");
        assertEquals(0xffffffbf, argb(colored, 24), "Valid 50 must remain yellow and opaque");
        assertEquals(0xff2b83ba, argb(colored, 40), "Valid zero must remain blue and opaque");
    }

    /** Returns the rendered color at an interior sample, away from interpolation boundaries. */
    private static int argb(RenderedImage image, int x) {
        return image.getColorModel().getRGB(image.getData().getDataElements(x, 8, null));
    }
}
