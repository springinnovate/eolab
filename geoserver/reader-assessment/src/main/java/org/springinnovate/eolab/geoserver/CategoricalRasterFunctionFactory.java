package org.springinnovate.eolab.geoserver;

import java.util.List;
import org.geotools.api.feature.type.Name;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.filter.expression.Function;
import org.geotools.api.filter.expression.Literal;
import org.geotools.filter.FunctionFactory;

/** Registers the raster-owned rendering transformation with GeoTools' existing function SPI. */
public final class CategoricalRasterFunctionFactory implements FunctionFactory {
    /**
     * Returns the single function signature supported by this factory.
     *
     * @return immutable list containing the exact categorical raster signature
     */
    @Override
    public List<FunctionName> getFunctionNames() {
        return List.of(CategoricalRasterFunction.NAME);
    }

    /**
     * Builds the named function from bounded literal arguments, or declines an unrelated name.
     *
     * @param name requested unqualified function name
     * @param arguments three fixed literals from the server-generated style
     * @param fallback unused expression fallback; categorical validation fails explicitly
     * @return a validated categorical function, or null for an unrelated name
     * @throws IllegalArgumentException if the categorical arguments violate the native contract
     */
    @Override
    public Function function(String name, List<Expression> arguments, Literal fallback) {
        if (!CategoricalRasterFunction.NAME.getName().equals(name)) {
            return null;
        }
        return new CategoricalRasterFunction(arguments);
    }

    /**
     * Matches only the unqualified function registered in server-generated SLD.
     *
     * @param name requested namespaced function identifier
     * @param arguments three fixed literals from the server-generated style
     * @param fallback unused expression fallback; categorical validation fails explicitly
     * @return a validated categorical function, or null for a namespaced or unrelated identifier
     * @throws IllegalArgumentException if the categorical arguments violate the native contract
     */
    @Override
    public Function function(Name name, List<Expression> arguments, Literal fallback) {
        if (name.getNamespaceURI() != null && !name.getNamespaceURI().isEmpty()) {
            return null;
        }
        return function(name.getLocalPart(), arguments, fallback);
    }
}
