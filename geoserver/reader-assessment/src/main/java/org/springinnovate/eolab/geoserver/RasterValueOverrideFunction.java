package org.springinnovate.eolab.geoserver;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;

import java.awt.Color;
import java.util.List;
import org.eclipse.imagen.media.classifier.ColorMapTransform;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.style.ColorMap;
import org.geotools.factory.CommonFactoryFinder;
import org.geotools.filter.capability.FunctionNameImpl;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.renderer.lite.gridcoverage2d.SLDColorMapBuilder;

/** Uses GeoTools' ordinary three-stop ramp with a priority color for a single numeric sample. */
public final class RasterValueOverrideFunction extends ExactValueRasterFunction {
    /** Four literal stops, each encoded as value, RGB hex and opacity separated by colons. */
    public static final FunctionName NAME = new FunctionNameImpl("eolabRasterValueOverride",
            GridCoverage2D.class, parameter("minimum", String.class), parameter("midpoint", String.class),
            parameter("maximum", String.class), parameter("valueOverride", String.class));
    private final SingleValueColorMap colorMap;

    /**
     * Builds the same native ramp used by RasterSymbolizer and reserves one exact input value.
     * @param arguments minimum, midpoint, maximum and override from the authorized SLD
     * @throws IllegalArgumentException if stops are malformed, nonfinite or out of order
     */
    public RasterValueOverrideFunction(List<Expression> arguments) {
        super(NAME, arguments, "continuous");
        var style = CommonFactoryFinder.getStyleFactory();
        var filters = CommonFactoryFinder.getFilterFactory();
        var builder = new SLDColorMapBuilder();
        // Reserve the same mask slot as GeoTools' ordinary RasterSymbolizer ramp.
        builder.setLinearColorMapType(ColorMap.TYPE_RAMP).setNumberColorMapEntries(3)
                .setColorForValuesToPreserve(TRANSPARENT);
        builder.setGapsColor(TRANSPARENT);
        double previous = Double.NEGATIVE_INFINITY;
        for (Expression argument : arguments.subList(0, 3)) {
            var stop = readStop(argument);
            if (stop.value <= previous) throw new IllegalArgumentException("Raster ramp stops must increase");
            previous = stop.value;
            var entry = style.createColorMapEntry();
            entry.setQuantity(filters.literal(stop.value));
            entry.setColor(filters.literal(stop.color));
            entry.setOpacity(filters.literal(stop.opacity));
            builder.addColorMapEntry(entry);
        }
        var override = readStop(arguments.get(3));
        colorMap = new SingleValueColorMap(builder.buildLinearColorMap(), override.value, override.color);
    }

    /** A validated numeric quantity, six-digit RGB and opacity from zero to one. */
    private record Stop(double value, Color color, double opacity) {}

    /**
     * Reads one color stop from a server-generated literal.
     * @param argument value, color and opacity joined with colons
     * @return the finite quantity and validated color components
     * @throws IllegalArgumentException for invalid values, colors or opacity
     */
    private static Stop readStop(Expression argument) {
        String literal = argument.evaluate(null, String.class);
        String[] fields = literal == null ? new String[0] : literal.split(":", -1);
        if (fields.length != 3) throw new IllegalArgumentException("A raster stop requires value, color and opacity");
        double value = Double.parseDouble(fields[0]);
        if (!Double.isFinite(value)) throw new IllegalArgumentException("Raster values must be finite");
        double opacity = parseOpacity(fields[2]);
        return new Stop(value, parseColor(fields[1], opacity), opacity);
    }

    /** @return the native continuous ramp with its exact-value classification */
    @Override
    ColorMapTransform<?> buildColorMap() {
        return colorMap;
    }
}
