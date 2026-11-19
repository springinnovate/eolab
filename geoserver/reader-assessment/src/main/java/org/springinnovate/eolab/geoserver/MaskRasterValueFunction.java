package org.springinnovate.eolab.geoserver;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.TreeSet;
import org.eclipse.imagen.media.range.Range;
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

/** Selects gradient samples or one-based color rule indices on the ordinary GeoServer read grid. */
public final class MaskRasterValueFunction extends FunctionExpressionImpl {
    /** Both drawing passes use the same ordered pairs of inclusive bounds. */
    static final FunctionName NAME = new FunctionNameImpl("eolabMaskRasterValue", GridCoverage2D.class,
            parameter("mode", String.class), parameter("bounds", String.class));
    private final boolean gradient;
    private final List<SampleInterval> ranges = new ArrayList<>();

    /** Inclusive sample bounds and their output for this drawing pass. NaN hides matching samples. */
    private record SampleInterval(double minimum, double maximum, double output) {}

    /**
     * Read the drawing mode and comparison bounds when GeoTools parses the style.
     * @param arguments literal mode and pipe-separated pairs of lower and upper bounds;
     *     an empty endpoint extends the rule to the end of the finite sample domain
     * @throws IllegalArgumentException if the mode or any numeric interval is invalid
     */
    MaskRasterValueFunction(List<Expression> arguments) {
        super(NAME);
        if (arguments.size() != 2 || !(arguments.get(0) instanceof Literal mode)
                || !(arguments.get(1) instanceof Literal bounds)) {
            throw new IllegalArgumentException("A raster mask requires literal mode and bounds");
        }
        gradient = switch (String.valueOf(mode.getValue())) {
            case "gradient" -> true;
            case "ranges" -> false;
            default -> throw new IllegalArgumentException("Unknown raster mask mode");
        };
        String table = bounds.evaluate(null, String.class);
        if (table == null || table.length() > 2048) {
            throw new IllegalArgumentException("Invalid raster mask bounds");
        }
        String[] rows = table.split("\\|", -1);
        if (rows.length > 17) {
            throw new IllegalArgumentException("A raster mask accepts one exact value and up to 16 ranges");
        }
        for (String row : rows) {
            String[] pair = row.split(",", -1);
            if (pair.length != 2 || (pair[0].isEmpty() && pair[1].isEmpty())) {
                throw new IllegalArgumentException("Each raster range needs at least one bound");
            }
            double low = pair[0].isEmpty() ? -Double.MAX_VALUE : Double.parseDouble(pair[0]);
            double high = pair[1].isEmpty() ? Double.MAX_VALUE : Double.parseDouble(pair[1]);
            if (!Double.isFinite(low) || !Double.isFinite(high) || low > high) {
                throw new IllegalArgumentException("Raster mask bounds must be finite and ordered");
            }
            ranges.add(new SampleInterval(low, high, gradient ? Double.NaN : ranges.size() + 1d));
        }
        setParameters(List.copyOf(arguments));
    }

    /**
     * Split overlapping rules at the exact doubles where the winning rule can change.
     * ImageN's overlap subtraction treats bounds within 1e-6 as equal. Disjoint
     * lookup entries preserve adjacent samples at every magnitude.
     * @param noData declared NoData interval for the sampled coverage, or null
     * @return numeric lookup with precedence for source NoData, then the first matching rule
     */
    private RangeLookupTable<Double, Double> buildSampleLookup(Range noData) {
        var rules = new ArrayList<SampleInterval>();
        // NaN already passes through as NaN in the gradient and is the replacement fallback.
        if (noData != null && !noData.isNaN()) {
            rules.add(new SampleInterval(noData.getMin(true).doubleValue(), noData.getMax(true).doubleValue(), Double.NaN));
        }
        rules.addAll(ranges);
        // Positive and negative zero compare equal as raster samples.
        var starts = new TreeSet<Double>((a, b) -> a.doubleValue() == b.doubleValue() ? 0 : Double.compare(a, b));
        for (var rule : rules) {
            starts.add(rule.minimum());
            starts.add(Math.nextUp(rule.maximum()));
        }
        var table = new RangeLookupTable.Builder<Double, Double>();
        for (double start : starts) {
            for (var rule : rules) {
                if (rule.minimum() <= start && start <= rule.maximum()) {
                    Double next = starts.higher(start);
                    double end = next == null ? rule.maximum() : Math.nextDown(next);
                    table.add(RangeFactory.create(start, end), rule.output());
                    break;
                }
            }
        }
        return table.build();
    }

    /**
     * Exclude declared NoData and map the first matching rule to its drawing pass.
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
        var table = buildSampleLookup(noData == null ? null : noData.getAsRange());
        // A null fallback preserves the gradient's original nonmatching samples.
        Double fallback = gradient ? null : Double.NaN;
        var masked = RangeLookupDescriptor.create(source.getRenderedImage(), table, fallback, null, null);
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
