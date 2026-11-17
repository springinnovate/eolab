package org.springinnovate.eolab.geoserver;

import java.util.List;
import org.geotools.api.feature.type.Name;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.filter.expression.Function;
import org.geotools.api.filter.expression.Literal;
import org.geotools.filter.FunctionFactory;

/** Registers exact raster styles with the GeoTools rendering function service. */
public final class CategoricalRasterFunctionFactory implements FunctionFactory {
    /**
     * Lists the categorical and continuous override functions available in server-generated SLD.
     *
     * @return immutable list of exact raster styling signatures
     */
    @Override
    public List<FunctionName> getFunctionNames() {
        return List.of(CategoricalRasterFunction.NAME, RasterValueOverrideFunction.NAME);
    }

    /**
     * Builds the named function from bounded literal arguments, or declines an unrelated name.
     *
     * @param name requested unqualified function name
     * @param arguments fixed literals from the server-generated style
     * @param fallback unused expression fallback for these server-generated styles
     * @return a validated raster function, or null for an unrelated name
     * @throws IllegalArgumentException if the arguments violate the requested function's contract
     */
    @Override
    public Function function(String name, List<Expression> arguments, Literal fallback) {
        if (RasterValueOverrideFunction.NAME.getName().equals(name)) {
            return new RasterValueOverrideFunction(arguments);
        }
        if (!CategoricalRasterFunction.NAME.getName().equals(name)) {
            return null;
        }
        return new CategoricalRasterFunction(arguments);
    }

    /**
     * Matches the unqualified raster styling functions registered in server-generated SLD.
     *
     * @param name requested namespaced function identifier
     * @param arguments fixed literals from the server-generated style
     * @param fallback unused expression fallback for these server-generated styles
     * @return a validated raster function, or null for a namespaced or unrelated identifier
     * @throws IllegalArgumentException if the arguments violate the requested function's contract
     */
    @Override
    public Function function(Name name, List<Expression> arguments, Literal fallback) {
        if (name.getNamespaceURI() != null && !name.getNamespaceURI().isEmpty()) {
            return null;
        }
        return function(name.getLocalPart(), arguments, fallback);
    }
}
