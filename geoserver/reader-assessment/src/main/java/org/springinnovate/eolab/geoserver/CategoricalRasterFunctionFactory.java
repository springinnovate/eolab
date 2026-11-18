package org.springinnovate.eolab.geoserver;

import java.util.List;
import org.geotools.api.feature.type.Name;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.filter.expression.Function;
import org.geotools.api.filter.expression.Literal;
import org.geotools.filter.FunctionFactory;

/** Registers EOLab raster styling functions with GeoTools. */
public final class CategoricalRasterFunctionFactory implements FunctionFactory {
    /**
     * Lists the raster styling functions accepted in server-generated SLD.
     *
     * @return the categorical classifier and the single-value mask signatures
     */
    @Override
    public List<FunctionName> getFunctionNames() {
        return List.of(CategoricalRasterFunction.NAME, MaskRasterValueFunction.NAME);
    }

    /**
     * Builds the named function from bounded literal arguments, or declines an unrelated name.
     *
     * @param name requested unqualified function name
     * @param arguments fixed literals from the server-generated style
     * @param fallback unused expression fallback
     * @return the requested raster function, or null for an unrelated name
     * @throws IllegalArgumentException if the literals violate the function's contract
     */
    @Override
    public Function function(String name, List<Expression> arguments, Literal fallback) {
        if (MaskRasterValueFunction.NAME.getName().equals(name)) {
            return new MaskRasterValueFunction(arguments);
        }
        if (!CategoricalRasterFunction.NAME.getName().equals(name)) {
            return null;
        }
        return new CategoricalRasterFunction(arguments);
    }

    /**
     * Matches unqualified functions registered in server-generated SLD.
     *
     * @param name requested namespaced function identifier
     * @param arguments fixed literals from the server-generated style
     * @param fallback unused expression fallback
     * @return the requested raster function, or null for a namespaced or unrelated identifier
     * @throws IllegalArgumentException if the literals violate the function's contract
     */
    @Override
    public Function function(Name name, List<Expression> arguments, Literal fallback) {
        if (name.getNamespaceURI() != null && !name.getNamespaceURI().isEmpty()) {
            return null;
        }
        return function(name.getLocalPart(), arguments, fallback);
    }
}
