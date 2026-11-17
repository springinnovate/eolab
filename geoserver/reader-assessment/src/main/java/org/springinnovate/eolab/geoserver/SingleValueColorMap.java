package org.springinnovate.eolab.geoserver;

import java.awt.Color;
import java.awt.image.DataBuffer;
import java.awt.image.IndexColorModel;
import java.awt.image.SampleModel;
import org.eclipse.imagen.media.classifier.ColorMapTransform;
import org.eclipse.imagen.media.classifier.ColorMapTransformElement;
import org.eclipse.imagen.media.classifier.LinearColorMap;
import org.eclipse.imagen.media.piecewise.DefaultPiecewiseTransform1D;
import org.eclipse.imagen.media.piecewise.DefaultPiecewiseTransform1DElement;
import org.eclipse.imagen.media.piecewise.TransformationException;
import org.eclipse.imagen.media.range.RangeFactory;

/** Adds one exact sample color to a GeoTools ramp, preserving its palette indices and mask default. */
final class SingleValueColorMap extends DefaultPiecewiseTransform1D<SingleValueColorMap.Samples>
        implements ColorMapTransform<SingleValueColorMap.Samples> {
    private final IndexColorModel palette;

    /**
     * Appends one palette entry without moving or subdividing any of the original gradient stops.
     * @param ramp ordinary GeoTools three-stop raster color map
     * @param value source value to match by numeric equality
     * @param color RGB and alpha for matching valid samples
     */
    SingleValueColorMap(LinearColorMap ramp, double value, Color color) {
        super(new Samples[] {new Samples(ramp, value, color)}, ramp.getDefaultValue());
        palette = get(0).palette;
    }

    /** @return the native indexed palette including the override and original transparent mask */
    @Override
    public IndexColorModel getColorModel() {
        return palette;
    }

    /**
     * Sizes a tile to store the original indices and the extra color.
     * @param width requested tile width
     * @param height requested tile height
     * @return the indexed tile sample model
     */
    @Override
    public SampleModel getSampleModel(int width, int height) {
        return palette.createCompatibleSampleModel(width, height);
    }

    /** Classifies finite samples before the ramp's output quantization can combine adjacent numbers. */
    static final class Samples extends DefaultPiecewiseTransform1DElement implements ColorMapTransformElement {
        private final LinearColorMap ramp;
        private final double value;
        private final int overrideIndex;
        private final IndexColorModel palette;

        /**
         * Retains the native gradient's exact lookup and allocates one extra palette index.
         * @param ramp ordinary raster gradient
         * @param value exact numeric match
         * @param color replacement color including alpha
         */
        Samples(LinearColorMap ramp, double value, Color color) {
            super("Continuous raster with an exact value", RangeFactory.create(-Double.MAX_VALUE, Double.MAX_VALUE));
            this.ramp = ramp;
            this.value = value;
            var original = ramp.getColorModel();
            overrideIndex = original.getMapSize();
            int[] colors = new int[overrideIndex + 1];
            original.getRGBs(colors);
            colors[overrideIndex] = color.getRGB();
            boolean useByte = colors.length <= 256;
            palette = new IndexColorModel(useByte ? 8 : 16, colors.length, colors, 0, true,
                    original.getTransparentPixel(), useByte ? DataBuffer.TYPE_BYTE : DataBuffer.TYPE_USHORT);
        }

        /**
         * Maps exactly one source value to the appended entry and delegates every other sample to GeoTools.
         * @param sample valid source sample
         * @return its palette index
         * @throws TransformationException if native ramp evaluation fails
         */
        @Override
        public double transform(double sample) throws TransformationException {
            return sample == value ? overrideIndex : ramp.transform(sample);
        }

        /** @return an independent array of palette colors in output index order */
        @Override
        public Color[] getColors() {
            Color[] colors = new Color[palette.getMapSize()];
            for (int i = 0; i < colors.length; i++) colors[i] = new Color(palette.getRGB(i), true);
            return colors;
        }
    }
}
