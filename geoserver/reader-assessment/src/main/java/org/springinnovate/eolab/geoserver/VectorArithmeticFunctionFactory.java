package org.springinnovate.eolab.geoserver;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;

import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.geotools.api.feature.type.Name;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.filter.expression.Function;
import org.geotools.api.filter.expression.Literal;
import org.geotools.filter.FunctionExpressionImpl;
import org.geotools.filter.FunctionFactory;
import org.geotools.filter.capability.FunctionNameImpl;

/** Registers finite-double arithmetic for server-generated vector styles and predicates. */
public final class VectorArithmeticFunctionFactory implements FunctionFactory {
    private static final FunctionName NAME = new FunctionNameImpl("eolabArithmetic", Double.class,
            parameter("operator", String.class), parameter("left", Object.class),
            parameter("right", Object.class));
    private static final Set<String> OPERATORS = Set.of("number", "+", "-", "*", "/", "negate", "positive");
    private static final Pattern DECIMAL = Pattern.compile(
            "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?");

    /** @return the one strict scalar arithmetic signature */
    @Override
    public List<FunctionName> getFunctionNames() {
        return List.of(NAME);
    }

    /**
     * Construct a scalar operation emitted by the application's validated expression compiler.
     * @param name requested function name
     * @param arguments fixed operator and two operand expressions
     * @param fallback unused fallback; missing arithmetic returns null
     * @return a function, or null when this factory does not own the name
     * @throws IllegalArgumentException when the native expression contract is invalid
     */
    @Override
    public Function function(String name, List<Expression> arguments, Literal fallback) {
        return NAME.getName().equals(name) ? new Arithmetic(arguments) : null;
    }

    /**
     * Match the unqualified function used in application-generated SLD and ECQL.
     * @param name requested qualified name
     * @param arguments operator and operand expressions
     * @param fallback unused fallback
     * @return an arithmetic function, or null for an unrelated name
     * @throws IllegalArgumentException when the native expression contract is invalid
     */
    @Override
    public Function function(Name name, List<Expression> arguments, Literal fallback) {
        if (name.getNamespaceURI() != null && !name.getNamespaceURI().isEmpty()) {
            return null;
        }
        return function(name.getLocalPart(), arguments, fallback);
    }

    /** One scalar operation; GeoServer supplies features and owns cancellation and reading. */
    private static final class Arithmetic extends FunctionExpressionImpl {
        private final String operator;

        /**
         * Validate the operator once when native parsing constructs the expression.
         * @param arguments operator literal and two operands
         * @throws IllegalArgumentException for an unknown operator or wrong argument shape
         */
        Arithmetic(List<Expression> arguments) {
            super(NAME);
            if (arguments.size() != 3 || !(arguments.get(0) instanceof Literal)) {
                throw new IllegalArgumentException("Vector arithmetic requires an operator and two operands");
            }
            operator = arguments.get(0).evaluate(null, String.class);
            if (!OPERATORS.contains(operator)) {
                throw new IllegalArgumentException("Unsupported vector arithmetic operator");
            }
            setParameters(List.copyOf(arguments));
        }

        /**
         * Evaluate one operation with the same null and finite-double rules as source reads.
         * @param feature feature supplied by the ordinary vector renderer
         * @return a finite double, or null for missing, invalid, zero-divisor or overflow values
         */
        @Override
        public Object evaluate(Object feature) {
            Object leftValue = getExpression(1).evaluate(feature);
            if (operator.equals("number")) {
                return number(leftValue, Boolean.TRUE.equals(getExpression(2).evaluate(feature, Boolean.class)));
            }
            // Numeric literals in OGC XML arrive as text. Source attributes always pass
            // through the explicit number operation and its numeric-text policy first.
            Double left = number(leftValue, true);
            if (left == null) {
                return null;
            }
            if (operator.equals("positive")) {
                return left;
            }
            if (operator.equals("negate")) {
                return -left;
            }
            Double right = number(getExpression(2).evaluate(feature), true);
            if (right == null || (operator.equals("/") && right == 0d)) {
                return null;
            }
            double result = switch (operator) {
                case "+" -> left + right;
                case "-" -> left - right;
                case "*" -> left * right;
                case "/" -> left / right;
                default -> throw new IllegalStateException("Validated arithmetic operator is missing");
            };
            return Double.isFinite(result) ? result : null;
        }
    }

    /**
     * Convert native numeric scalars and optionally complete decimal/scientific strings.
     * @param value native attribute, literal or arithmetic result
     * @param numericText whether complete numeric strings are accepted
     * @return a finite double or null; booleans, blank/partial strings and nonfinite numbers fail
     */
    private static Double number(Object value, boolean numericText) {
        double result;
        if (value instanceof Number number) {
            result = number.doubleValue();
        } else if (numericText && value instanceof String text) {
            int start = 0;
            int end = text.length();
            while (start < end && whitespace(text.charAt(start))) {
                start++;
            }
            while (end > start && whitespace(text.charAt(end - 1))) {
                end--;
            }
            text = text.substring(start, end);
            if (!DECIMAL.matcher(text).matches()) {
                return null;
            }
            result = Double.parseDouble(text);
        } else {
            return null;
        }
        return Double.isFinite(result) ? result : null;
    }

    /**
     * Match Python's Unicode whitespace trimming at the numeric-text boundary.
     * @param character candidate boundary character
     * @return whether Python str.strip removes this character
     */
    private static boolean whitespace(char character) {
        return Character.isWhitespace(character) || Character.isSpaceChar(character) || character == '\u0085';
    }
}
