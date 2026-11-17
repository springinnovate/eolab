package org.springinnovate.eolab.geoserver;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;
import java.awt.Color;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import org.eclipse.imagen.media.classifier.LinearColorMap;
import org.eclipse.imagen.media.classifier.LinearColorMapElement;
import org.eclipse.imagen.media.range.RangeFactory;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.filter.capability.FunctionNameImpl;

/**
 * Colors raster pixels by exact category value, preserving NoData transparency.
 *
 * <p>The function owns appearance only: it never opens paths or consults catalog,
 * analysis, browser, or publication state. GeoServer owns read scheduling,
 * request timeouts, tile caching, and disposal of the returned coverage graph.
 * Classification remains lazy and retains the input as a coverage source.
 */
public final class CategoricalRasterFunction extends ExactValueRasterFunction {
    /** Fixed literal-only signature discoverable by GeoTools' function service registry. */
    public static final FunctionName NAME = new FunctionNameImpl("eolabCategoricalRaster",
            GridCoverage2D.class, parameter("categories", String.class),
            parameter("unmappedColor", String.class), parameter("unmappedOpacity", String.class));
    static final int MAXIMUM_CATEGORIES = 256;
    static final int MAXIMUM_TABLE_CHARACTERS = 32768;
    private static final double MAXIMUM_EXACT_VALUE = 9007199254740991d;

    private final List<Category> categories;
    private final Color unmappedColor;

    /** One validated exact code and pixel appearance; labels are not native renderer inputs. */
    private record Category(double value, String color, double opacity) {}

    /**
     * Validates the three server-generated literal arguments once per parsed style.
     *
     * @param arguments compact category table, fallback hex color, and fallback opacity
     * @throws IllegalArgumentException if the category table, colors or opacity are invalid
     *     or exceed their limits
     */
    public CategoricalRasterFunction(List<Expression> arguments) {
        super(NAME, arguments, "categorical");
        String table = arguments.get(0).evaluate(null, String.class);
        if (table == null || table.isEmpty() || table.length() > MAXIMUM_TABLE_CHARACTERS) {
            throw new IllegalArgumentException("Categorical raster table exceeds its bound");
        }
        String[] rows = table.split(";", -1);
        if (rows.length > MAXIMUM_CATEGORIES) {
            throw new IllegalArgumentException("Too many raster categories");
        }
        var parsed = new ArrayList<Category>(rows.length);
        var values = new HashSet<Double>();
        for (String row : rows) {
            String[] fields = row.split(":", -1);
            if (fields.length != 3) {
                throw new IllegalArgumentException("Invalid categorical raster row");
            }
            double value = Double.parseDouble(fields[0]);
            if (!Double.isFinite(value) || Math.abs(value) > MAXIMUM_EXACT_VALUE
                    || value != Math.rint(value) || !values.add(value == 0 ? 0d : value)) {
                throw new IllegalArgumentException("Raster category codes must be unique safe integers");
            }
            double opacity = parseOpacity(fields[2]);
            parseColor(fields[1], opacity);
            parsed.add(new Category(value == 0 ? 0d : value, fields[1], opacity));
        }
        parsed.sort(java.util.Comparator.comparingDouble(Category::value));
        categories = List.copyOf(parsed);
        unmappedColor = parseColor(arguments.get(1).evaluate(null, String.class),
                parseOpacity(arguments.get(2).evaluate(null, String.class)));
    }

    /**
     * Builds exact point classes and open finite fallback ranges with a transparent mask default.
     *
     * <p>The classifier uses its default for NoData and excluded ROI samples. Giving valid
     * unmapped numbers explicit ranges keeps that default transparent. Open bounds do not
     * approximate integer equality; adjacent representable category values need no intervening
     * fallback range. Nonfinite values remain outside the finite domain and transparent.
     *
     * @return a native classifier with at most 513 finite entries and 258 palette colors
     */
    @Override
    LinearColorMap buildColorMap() {
        var elements = new ArrayList<LinearColorMapElement>(categories.size() * 2 + 1);
        double lowerBound = -Double.MAX_VALUE;
        boolean includeLowerBound = true;
        int paletteIndex = 1;
        for (Category category : categories) {
            if (includeLowerBound || Math.nextUp(lowerBound) < category.value()) {
                elements.add(LinearColorMapElement.create("unmapped", unmappedColor,
                        RangeFactory.create(lowerBound, includeLowerBound, category.value(), false, false), 0));
            }
            elements.add(LinearColorMapElement.create("category", parseColor(category.color(), category.opacity()),
                    category.value(), paletteIndex++));
            lowerBound = category.value();
            includeLowerBound = false;
        }
        elements.add(LinearColorMapElement.create("unmapped", unmappedColor,
                RangeFactory.create(lowerBound, false, Double.MAX_VALUE, true, false), 0));
        return new LinearColorMap("categorical", elements.toArray(LinearColorMapElement[]::new),
                new LinearColorMapElement[0], TRANSPARENT);
    }
}
