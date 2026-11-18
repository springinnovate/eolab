package org.springinnovate.eolab.geoserver;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;

import java.util.HashMap;
import java.util.List;
import org.eclipse.imagen.media.range.RangeFactory;
import org.eclipse.imagen.media.rlookup.RangeLookupDescriptor;
import org.eclipse.imagen.media.rlookup.RangeLookupTable;
import org.geotools.api.coverage.grid.GridCoverage;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.filter.expression.Literal;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.coverage.util.CoverageUtilities;
import org.geotools.filter.FunctionExpressionImpl;
import org.geotools.filter.capability.FunctionNameImpl;

/** Excludes source NoData from a raster drawing pass and optionally one numeric value from its gradient. */
public final class MaskRasterValueFunction extends FunctionExpressionImpl {
    /** GeoServer selects the read grid. Only the gradient pass supplies an additional value to mask. */
    static final FunctionName NAME = new FunctionNameImpl("eolabMaskRasterValue", GridCoverage2D.class,
            parameter("value", Double.class, 0, 1));
    private final Double excludedValue;

    /**
     * Read the optional value to mask once when GeoTools parses the style.
     * @param arguments empty for the replacement pass or a single numeric literal for the gradient
     * @throws IllegalArgumentException if the supplied argument is not one finite literal
     */
    MaskRasterValueFunction(List<Expression> arguments) {
        super(NAME);
        if (arguments.isEmpty()) {
            excludedValue = null;
        } else {
            if (arguments.size() != 1 || !(arguments.get(0) instanceof Literal literal)) {
                throw new IllegalArgumentException("A raster mask accepts one optional numeric literal");
            }
            excludedValue = literal.evaluate(null, Double.class);
            if (excludedValue == null || !Double.isFinite(excludedValue)) {
                throw new IllegalArgumentException("The raster mask value must be finite");
            }
        }
        setParameters(List.copyOf(arguments));
    }

    /**
     * Mask declared NoData on both passes and the selected value on the gradient pass.
     * @param input the coverage already sampled by the ordinary GeoServer renderer
     * @return a lazily mapped coverage on the input grid, retaining its source and ROI
     * @throws IllegalArgumentException if the function receives a non-raster input
     */
    @Override
    public Object evaluate(Object input) {
        if (!(input instanceof GridCoverage2D source)) {
            throw new IllegalArgumentException("A raster coverage is required");
        }
        var noData = CoverageUtilities.getNoDataProperty(source);
        if (excludedValue == null && noData == null) {
            return source;
        }
        var table = new RangeLookupTable.Builder<Double, Double>();
        if (excludedValue != null) {
            table.add(RangeFactory.create(excludedValue, excludedValue), Double.NaN);
        }
        if (noData != null) {
            table.add(noData.getAsRange(), Double.NaN);
        }
        // A null fallback copies every other numeric sample through the lookup.
        var masked = RangeLookupDescriptor.create(source.getRenderedImage(), table.build(), null, null, null);
        var properties = new HashMap<String, Object>();
        CoverageUtilities.setNoDataProperty(properties, Double.NaN);
        CoverageUtilities.setROIProperty(properties, CoverageUtilities.getROIProperty(source));
        try {
            return new GridCoverageFactory().create("masked", masked, source.getGridGeometry(), null,
                    new GridCoverage[]{source}, properties);
        } catch (RuntimeException error) {
            masked.dispose();
            throw error;
        }
    }
}
