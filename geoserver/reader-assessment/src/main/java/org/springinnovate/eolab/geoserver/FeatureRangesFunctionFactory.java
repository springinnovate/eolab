package org.springinnovate.eolab.geoserver;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;

import java.util.Arrays;
import java.util.List;
import org.geotools.api.feature.type.Name;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.filter.expression.Function;
import org.geotools.api.filter.expression.Literal;
import org.geotools.filter.FunctionExpressionImpl;
import org.geotools.filter.FunctionFactory;
import org.geotools.filter.capability.FunctionNameImpl;

/** Tests GeoServer feature identifiers against the original records selected by a map filter. */
public final class FeatureRangesFunctionFactory implements FunctionFactory {
    private static final FunctionName NAME = new FunctionNameImpl("eolabFeatureInRanges", Boolean.class,
            parameter("featureId", String.class), parameter("ranges", String.class));

    /** @return the feature-membership function available to ECQL and SLD */
    @Override public List<FunctionName> getFunctionNames() { return List.of(NAME); }

    /** {@inheritDoc} */
    @Override public Function function(Name name, List<Expression> arguments, Literal fallback) {
        if (name.getNamespaceURI() != null && !name.getNamespaceURI().isEmpty()) return null;
        return function(name.getLocalPart(), arguments, fallback);
    }

    /** {@inheritDoc} */
    @Override public Function function(String name, List<Expression> arguments, Literal fallback) {
        return NAME.getName().equals(name) ? new Membership(arguments) : null;
    }

    /** Parses ordered inclusive ID intervals once per style or map predicate. */
    private static final class Membership extends FunctionExpressionImpl {
        private final long[] starts;
        private final long[] ends;

        /** @param arguments feature ID expression and a literal of comma-separated start:end pairs */
        Membership(List<Expression> arguments) {
            super(NAME);
            if (arguments.size() != 2 || !(arguments.get(1) instanceof Literal)) {
                throw new IllegalArgumentException("Expected a feature ID and literal ID ranges");
            }
            String value = arguments.get(1).evaluate(null, String.class);
            String[] ranges = value.isEmpty() ? new String[0] : value.split(",");
            starts = new long[ranges.length];
            ends = new long[ranges.length];
            for (int i = 0; i < ranges.length; i++) {
                String[] pair = ranges[i].split(":", 2);
                starts[i] = Long.parseLong(pair[0]);
                ends[i] = pair.length == 1 ? starts[i] : Long.parseLong(pair[1]);
            }
            setParameters(List.copyOf(arguments));
        }

        /** @param feature original GeoServer feature @return whether its native ID is in an accepted interval */
        @Override public Object evaluate(Object feature) {
            String fid = getParameters().get(0).evaluate(feature, String.class);
            if (fid == null) return false;
            try {
                long id = Long.parseLong(fid.substring(fid.lastIndexOf('.') + 1));
                int position = Arrays.binarySearch(starts, id);
                if (position >= 0) return true;
                int previous = -position - 2;
                return previous >= 0 && id <= ends[previous];
            } catch (NumberFormatException invalid) {
                return false;
            }
        }
    }
}
