package org.springinnovate.eolab.geoserver;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;

import java.awt.Color;
import java.awt.image.RenderedImage;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.CancellationException;
import org.eclipse.imagen.InterpolationNearest;
import org.eclipse.imagen.PlanarImage;
import org.eclipse.imagen.media.classifier.LinearColorMap;
import org.eclipse.imagen.media.classifier.LinearColorMapElement;
import org.eclipse.imagen.media.range.RangeFactory;
import org.geotools.api.coverage.grid.GridCoverage;
import org.geotools.api.coverage.grid.GridCoverageReader;
import org.geotools.api.coverage.grid.GridGeometry;
import org.geotools.api.data.Query;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.filter.expression.Literal;
import org.geotools.api.parameter.GeneralParameterValue;
import org.geotools.api.parameter.ParameterDescriptor;
import org.geotools.api.parameter.ParameterValue;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.coverage.grid.io.AbstractGridFormat;
import org.geotools.coverage.grid.io.DecimationPolicy;
import org.geotools.coverage.grid.io.OverviewPolicy;
import org.geotools.coverage.util.CoverageUtilities;
import org.geotools.filter.FunctionExpressionImpl;
import org.geotools.filter.capability.FunctionNameImpl;
import org.geotools.filter.function.RenderingTransformation;
import org.geotools.image.ImageWorker;

/**
 * Maps one already-authorized, bounded raster read to exact category colors.
 *
 * <p>The function owns appearance only: it never opens paths or consults catalog,
 * analysis, browser, or publication state. GeoServer owns read scheduling,
 * request timeouts, tile caching, and disposal of the returned coverage graph.
 * Classification remains lazy and retains the input as a coverage source.
 */
public final class CategoricalRasterFunction extends FunctionExpressionImpl
        implements RenderingTransformation {
    /** Fixed literal-only signature discoverable by GeoTools' function service registry. */
    public static final FunctionName NAME = new FunctionNameImpl("eolabCategoricalRaster",
            GridCoverage2D.class, parameter("categories", String.class),
            parameter("unmappedColor", String.class), parameter("unmappedOpacity", String.class));
    static final int MAXIMUM_CATEGORIES = 256;
    static final int MAXIMUM_TABLE_CHARACTERS = 32768;
    static final int MAXIMUM_RENDER_EDGE = 4096;
    static final long MAXIMUM_RENDER_PIXELS = 16_777_216L;
    private static final double MAXIMUM_EXACT_VALUE = 9007199254740991d;
    private static final Color TRANSPARENT = new Color(0, 0, 0, 0);

    private final List<Category> categories;
    private final Color unmapped;

    /** One validated exact code and pixel appearance; labels are not native renderer inputs. */
    private record Category(double value, String color, double opacity) {}

    /**
     * Validates the three server-generated literal arguments once per parsed style.
     *
     * @param arguments compact category table, fallback hex color, and fallback opacity
     * @throws IllegalArgumentException if any argument violates the bounded native contract
     */
    public CategoricalRasterFunction(List<Expression> arguments) {
        super(NAME);
        if (arguments.size() != 3 || arguments.stream().anyMatch(value -> !(value instanceof Literal))) {
            throw new IllegalArgumentException("Categorical raster rendering requires three literals");
        }
        setParameters(List.copyOf(arguments));
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
            double opacity = opacity(fields[2]);
            color(fields[1], opacity);
            parsed.add(new Category(value == 0 ? 0d : value, fields[1], opacity));
        }
        parsed.sort(java.util.Comparator.comparingDouble(Category::value));
        categories = List.copyOf(parsed);
        unmapped = color(arguments.get(1).evaluate(null, String.class),
                opacity(arguments.get(2).evaluate(null, String.class)));
    }

    /**
     * Returns a lazily classified coverage without disposing its borrowed input.
     *
     * @param input authorized coverage supplied by the native rendering pipeline
     * @return exact colors with original source NoData and ROI masking applied
     * @throws IllegalArgumentException if the coverage exceeds the bounded render contract
     * @throws CancellationException if the renderer has cancelled this thread
     */
    @Override
    public Object evaluate(Object input) {
        requireActive();
        if (!(input instanceof GridCoverage2D source)) {
            throw new IllegalArgumentException("Categorical rendering requires a raster coverage");
        }
        RenderedImage image = source.getRenderedImage();
        requireDimensions(image.getWidth(), image.getHeight());
        var worker = new ImageWorker(image);
        if (image.getSampleModel().getNumBands() != 1) {
            worker.retainBands(new int[] {0});
        }
        worker.setROI(CoverageUtilities.getROIProperty(source));
        var noData = CoverageUtilities.getNoDataProperty(source);
        worker.setNoData(noData == null ? null : noData.getAsRange());
        worker.classify(colorMap(), null);
        PlanarImage classified = worker.getRenderedOperation();
        try {
            return new GridCoverageFactory().create("categorical", classified,
                    source.getGridGeometry(), null, new GridCoverage[] {source}, null);
        } catch (RuntimeException error) {
            classified.dispose();
            throw error;
        }
    }

    /**
     * Returns an independent query while retaining the renderer's source selection.
     *
     * @param query authorized source query supplied by the rendering pipeline
     * @param target requested output grid, unused because category coloring does not change selection
     * @return an independent copy of the original query
     */
    @Override
    public Query invertQuery(Query query, GridGeometry target) {
        return new Query(query);
    }

    /**
     * Preserves the requested sampling grid and rejects oversized work before reading.
     *
     * @param query current renderer query
     * @param target requested output grid, including the renderer's bounded read buffer
     * @return the unchanged requested grid; never the whole source geometry
     * @throws IllegalArgumentException if the geometry is missing, nonplanar, or oversized
     * @throws CancellationException if the renderer has cancelled this thread
     */
    @Override
    public GridGeometry invertGridGeometry(Query query, GridGeometry target) {
        requireActive();
        if (target == null || target.getGridRange().getDimension() != 2) {
            throw new IllegalArgumentException("Categorical rendering requires a two-dimensional grid");
        }
        requireDimensions(target.getGridRange().getSpan(0), target.getGridRange().getSpan(1));
        return target;
    }

    /**
     * Clones per-read parameters and selects source samples without averaged overviews.
     *
     * @param reader current GeoServer-owned reader, never retained by this function
     * @param parameters existing request-local read parameters
     * @return independent parameters with overview bypass and nearest interpolation
     * @throws CancellationException if the renderer has cancelled this thread
     */
    @Override
    public GeneralParameterValue[] customizeReadParams(GridCoverageReader reader,
            GeneralParameterValue... parameters) {
        requireActive();
        var result = new ArrayList<GeneralParameterValue>();
        if (parameters != null) {
            for (GeneralParameterValue value : parameters) {
                result.add(value.clone());
            }
        }
        // GeoTools injects the geometry validated by invertGridGeometry after this hook returns.
        replace(result, AbstractGridFormat.OVERVIEW_POLICY, OverviewPolicy.IGNORE);
        replace(result, AbstractGridFormat.DECIMATION_POLICY, DecimationPolicy.ALLOW);
        replace(result, AbstractGridFormat.INTERPOLATION, new InterpolationNearest());
        return result.toArray(GeneralParameterValue[]::new);
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
    private LinearColorMap colorMap() {
        var elements = new ArrayList<LinearColorMapElement>(categories.size() * 2 + 1);
        double previous = -Double.MAX_VALUE;
        boolean includePrevious = true;
        int index = 1;
        for (Category category : categories) {
            if (includePrevious || Math.nextUp(previous) < category.value()) {
                elements.add(LinearColorMapElement.create("unmapped", unmapped,
                        RangeFactory.create(previous, includePrevious, category.value(), false, false), 0));
            }
            elements.add(LinearColorMapElement.create("category", color(category.color(), category.opacity()),
                    category.value(), index++));
            previous = category.value();
            includePrevious = false;
        }
        elements.add(LinearColorMapElement.create("unmapped", unmapped,
                RangeFactory.create(previous, false, Double.MAX_VALUE, true, false), 0));
        return new LinearColorMap("categorical", elements.toArray(LinearColorMapElement[]::new),
                new LinearColorMapElement[0], TRANSPARENT);
    }

    /**
     * Replaces only a request-local named parameter, preserving unrelated reader options.
     *
     * @param <T> native parameter value type
     * @param parameters independent request-local parameter list
     * @param descriptor parameter identity and value contract
     * @param value replacement parameter value
     */
    private static <T> void replace(List<GeneralParameterValue> parameters,
            ParameterDescriptor<T> descriptor, T value) {
        parameters.removeIf(parameter -> parameter.getDescriptor().getName().equals(descriptor.getName()));
        ParameterValue<T> replacement = descriptor.createValue();
        replacement.setValue(value);
        parameters.add(replacement);
    }

    /**
     * Rejects image shapes that would exceed the categorical render's output allocation bound.
     *
     * <p>This bounds the returned grid, not bytes decoded from compressed source blocks.
     * Existing GeoServer request timeouts, concurrency, and tile cache govern native reader work.
     *
     * @param width output pixel width
     * @param height output pixel height
     * @throws IllegalArgumentException if either edge or total pixel count exceeds its bound
     */
    private static void requireDimensions(int width, int height) {
        if (width < 1 || height < 1 || width > MAXIMUM_RENDER_EDGE || height > MAXIMUM_RENDER_EDGE
                || (long) width * height > MAXIMUM_RENDER_PIXELS) {
            throw new IllegalArgumentException("Categorical raster read exceeds its bounded render grid");
        }
    }

    /**
     * Honors cancellation before native reader or classifier work is scheduled.
     *
     * @throws CancellationException if the current rendering thread was interrupted
     */
    private static void requireActive() {
        if (Thread.currentThread().isInterrupted()) {
            throw new CancellationException("Categorical raster rendering was cancelled");
        }
    }

    /**
     * Decodes one finite opacity, rejecting nonnumeric or out-of-range native inputs.
     *
     * @param value server-generated scalar literal
     * @return finite opacity between zero and one
     * @throws IllegalArgumentException if the value is missing, nonnumeric, nonfinite, or outside the range
     */
    private static double opacity(String value) {
        if (value == null) {
            throw new IllegalArgumentException("Raster category opacity is required");
        }
        double opacity = Double.parseDouble(value);
        if (!Double.isFinite(opacity) || opacity < 0 || opacity > 1) {
            throw new IllegalArgumentException("Raster category opacity must be between zero and one");
        }
        return opacity;
    }

    /**
     * Decodes only six-digit RGB hex colors and a separately validated opacity.
     *
     * @param value server-generated RGB hex literal
     * @param opacity validated finite pixel opacity
     * @return native ARGB color with nearest eight-bit alpha
     * @throws IllegalArgumentException if the color is not a six-digit RGB hex literal
     */
    private static Color color(String value, double opacity) {
        if (value == null || !value.matches("#[0-9a-fA-F]{6}")) {
            throw new IllegalArgumentException("Raster category colors must be six-digit hex colors");
        }
        return new Color((int) Math.round(opacity * 255) << 24 | Integer.parseInt(value.substring(1), 16), true);
    }
}
