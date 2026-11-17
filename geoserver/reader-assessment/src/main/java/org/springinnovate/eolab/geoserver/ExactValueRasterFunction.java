package org.springinnovate.eolab.geoserver;

import java.awt.Color;
import java.awt.image.DataBuffer;
import java.awt.image.RenderedImage;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import org.eclipse.imagen.InterpolationNearest;
import org.eclipse.imagen.PlanarImage;
import org.eclipse.imagen.media.classifier.ColorMapTransform;
import org.eclipse.imagen.media.range.RangeFactory;
import org.geotools.api.coverage.grid.GridCoverage;
import org.geotools.api.coverage.grid.GridCoverageReader;
import org.geotools.api.coverage.grid.GridGeometry;
import org.geotools.api.data.Query;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.filter.expression.Literal;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.api.parameter.GeneralParameterValue;
import org.geotools.api.parameter.ParameterDescriptor;
import org.geotools.api.parameter.ParameterValue;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.coverage.grid.io.AbstractGridFormat;
import org.geotools.coverage.grid.io.DecimationPolicy;
import org.geotools.coverage.grid.io.OverviewPolicy;
import org.geotools.coverage.util.CoverageUtilities;
import org.geotools.filter.FunctionExpressionImpl;
import org.geotools.filter.function.RenderingTransformation;
import org.geotools.image.ImageWorker;

/** Reads original samples on the requested grid and applies an exact-value color map with source masking. */
abstract class ExactValueRasterFunction extends FunctionExpressionImpl implements RenderingTransformation {
    static final int MAXIMUM_RENDER_EDGE = 4096;
    static final long MAXIMUM_RENDER_PIXELS = 16_777_216L;
    static final Color TRANSPARENT = new Color(0, 0, 0, 0);
    private final String coverageName;

    /**
     * Accepts only the registered signature's server-generated literal parameters.
     * @param name GeoTools function signature
     * @param arguments parsed SLD expressions
     * @param coverageName descriptive name of the classified coverage
     * @throws IllegalArgumentException if the signature or literal contract is violated
     */
    ExactValueRasterFunction(FunctionName name, List<Expression> arguments, String coverageName) {
        super(name);
        if (arguments.size() != name.getArguments().size() || arguments.stream().anyMatch(value -> !(value instanceof Literal))) {
            throw new IllegalArgumentException("Exact raster rendering requires its declared literal arguments");
        }
        this.coverageName = coverageName;
        setParameters(List.copyOf(arguments));
    }

    /** @return the native classifier for the validated appearance, with a transparent default for masks */
    abstract ColorMapTransform<?> buildColorMap();

    /**
     * Returns a lazily classified coverage without disposing its borrowed input.
     *
     * @param input authorized coverage supplied by the native rendering pipeline
     * @return the styled coverage with original source NoData and ROI masking applied
     * @throws IllegalArgumentException if the input is not a GridCoverage2D or its image
     *     dimensions exceed the rendering limits
     * @throws CancellationException if the renderer has cancelled this thread
     */
    @Override
    public Object evaluate(Object input) {
        requireActiveRender();
        if (!(input instanceof GridCoverage2D source)) {
            throw new IllegalArgumentException("Exact raster styling requires a raster coverage");
        }
        RenderedImage image = source.getRenderedImage();
        requireRenderDimensions(image.getWidth(), image.getHeight());
        var worker = new ImageWorker(image);
        if (image.getSampleModel().getNumBands() != 1) {
            worker.retainBands(new int[] {0});
        }
        worker.setROI(CoverageUtilities.getROIProperty(source));
        var noData = CoverageUtilities.getNoDataProperty(source);
        worker.setNoData(noData == null ? null : noData.getAsRange());
        var colorMap = buildColorMap();
        worker.classify(colorMap, null);
        // Output samples are palette indices; source NoData values no longer describe them.
        worker.setNoData(RangeFactory.create(colorMap.getDefaultValue(), colorMap.getDefaultValue()));
        // Paint wide palettes as RGBA. Their alpha now carries the mask, and an index
        // such as 255 must never be interpreted as NoData in an individual color band.
        if (colorMap.getColorModel().getTransferType() == DataBuffer.TYPE_USHORT) {
            worker.forceComponentColorModel();
            worker.setNoData(null);
        }
        PlanarImage classified = worker.getRenderedOperation();
        try {
            return new GridCoverageFactory().create(coverageName, classified,
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
     * @param target requested output grid, unused because styling does not change selection
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
        requireActiveRender();
        if (target == null || target.getGridRange().getDimension() != 2) {
            throw new IllegalArgumentException("Exact raster styling requires a two-dimensional grid");
        }
        requireRenderDimensions(target.getGridRange().getSpan(0), target.getGridRange().getSpan(1));
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
        requireActiveRender();
        var result = new ArrayList<GeneralParameterValue>();
        if (parameters != null) {
            for (GeneralParameterValue value : parameters) {
                result.add(value.clone());
            }
        }
        // GeoTools injects the geometry validated by invertGridGeometry after this hook returns.
        replaceReadParameter(result, AbstractGridFormat.OVERVIEW_POLICY, OverviewPolicy.IGNORE);
        replaceReadParameter(result, AbstractGridFormat.DECIMATION_POLICY, DecimationPolicy.ALLOW);
        replaceReadParameter(result, AbstractGridFormat.INTERPOLATION, new InterpolationNearest());
        return result.toArray(GeneralParameterValue[]::new);
    }

    /**
     * Replaces only a request-local named parameter, preserving unrelated reader options.
     *
     * @param <T> native parameter value type
     * @param parameters independent request-local parameter list
     * @param descriptor name and type of the parameter to replace
     * @param value replacement parameter value
     */
    private static <T> void replaceReadParameter(List<GeneralParameterValue> parameters,
            ParameterDescriptor<T> descriptor, T value) {
        parameters.removeIf(parameter -> parameter.getDescriptor().getName().equals(descriptor.getName()));
        ParameterValue<T> replacement = descriptor.createValue();
        replacement.setValue(value);
        parameters.add(replacement);
    }

    /**
     * Rejects image shapes that would exceed the exact-value render's output allocation bound.
     *
     * <p>This bounds the returned grid, not bytes decoded from compressed source blocks.
     * GeoServer request timeouts, concurrency, and the tile cache govern native reader work.
     *
     * @param width output pixel width
     * @param height output pixel height
     * @throws IllegalArgumentException if either edge or total pixel count exceeds its bound
     */
    private static void requireRenderDimensions(int width, int height) {
        if (width < 1 || height < 1 || width > MAXIMUM_RENDER_EDGE || height > MAXIMUM_RENDER_EDGE
                || (long) width * height > MAXIMUM_RENDER_PIXELS) {
            throw new IllegalArgumentException("Exact raster read exceeds its bounded render grid");
        }
    }

    /**
     * Honors cancellation before native reader or classifier work is scheduled.
     *
     * @throws CancellationException if the current rendering thread was interrupted
     */
    private static void requireActiveRender() {
        if (Thread.currentThread().isInterrupted()) {
            throw new CancellationException("Exact raster rendering was cancelled");
        }
    }

    /**
     * Decodes one finite opacity, rejecting nonnumeric or out-of-range native inputs.
     *
     * @param value server-generated scalar literal
     * @return finite opacity between zero and one
     * @throws IllegalArgumentException if the value is missing, nonnumeric, nonfinite, or outside the range
     */
    static double parseOpacity(String value) {
        if (value == null) {
            throw new IllegalArgumentException("Raster pixel opacity is required");
        }
        double opacity = Double.parseDouble(value);
        if (!Double.isFinite(opacity) || opacity < 0 || opacity > 1) {
            throw new IllegalArgumentException("Raster pixel opacity must be between zero and one");
        }
        return opacity;
    }

    /**
     * Decodes a six-digit RGB hex color and its separately validated opacity.
     *
     * @param value server-generated RGB hex literal
     * @param opacity validated finite pixel opacity
     * @return native ARGB color with nearest eight-bit alpha
     * @throws IllegalArgumentException if the color is not a six-digit RGB hex literal
     */
    static Color parseColor(String value, double opacity) {
        if (value == null || !value.matches("#[0-9a-fA-F]{6}")) {
            throw new IllegalArgumentException("Raster pixel colors must be six-digit hex colors");
        }
        return new Color((int) Math.round(opacity * 255) << 24 | Integer.parseInt(value.substring(1), 16), true);
    }
}
