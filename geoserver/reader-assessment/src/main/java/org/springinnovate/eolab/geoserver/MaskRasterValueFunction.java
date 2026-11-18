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

/** Masks one numeric sample in the gradient so a normal exact-value symbolizer can supply its own alpha. */
public final class MaskRasterValueFunction extends FunctionExpressionImpl {
    /** Server-generated SLD supplies one exact finite value. GeoServer selects the raster and read grid. */
    static final FunctionName NAME = new FunctionNameImpl("eolabMaskRasterValue", GridCoverage2D.class,
            parameter("value", Double.class));
    private final double value;

    /**
     * Read the value to mask once when GeoTools parses the style.
     * @param arguments the single numeric literal supplied by the authorized SLD
     * @throws IllegalArgumentException if a finite literal was not supplied
     */
    MaskRasterValueFunction(List<Expression> arguments) {
        super(NAME);
        if (arguments.size() != 1 || !(arguments.get(0) instanceof Literal literal)) {
            throw new IllegalArgumentException("A raster mask requires one numeric literal");
        }
        Double target = literal.evaluate(null, Double.class);
        if (target == null || !Double.isFinite(target)) {
            throw new IllegalArgumentException("The raster mask value must be finite");
        }
        value = target;
        setParameters(List.copyOf(arguments));
    }

    /**
     * Exclude matches and the existing source NoData from this gradient pass.
     * @param input the coverage already sampled by the ordinary GeoServer renderer
     * @return a lazily mapped coverage on the input grid, retaining its source and ROI
     * @throws IllegalArgumentException if the function receives a non-raster input
     */
    @Override
    public Object evaluate(Object input) {
        if (!(input instanceof GridCoverage2D source)) {
            throw new IllegalArgumentException("A raster coverage is required");
        }
        var table = new RangeLookupTable.Builder<Double, Double>();
        table.add(RangeFactory.create(value, value), Double.NaN);
        var noData = CoverageUtilities.getNoDataProperty(source);
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
