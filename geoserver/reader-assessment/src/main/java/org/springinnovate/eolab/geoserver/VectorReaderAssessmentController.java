package org.springinnovate.eolab.geoserver;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;
import org.geoserver.rest.RestBaseController;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** Expose a private read-only exact-layer probe through authenticated REST. */
@RestController
@RequestMapping(path = RestBaseController.ROOT_PATH + "/eolab/vector-reader-assessments")
public final class VectorReaderAssessmentController {
    private static final Path SCAN_SOURCE_ROOT = Path.of("/scan-source");
    private static final Set<String> SUPPORTED_FORMATS =
            Set.of("shapefile", "geopackage");

    private final VectorReaderAssessmentService assessmentService;

    /** Create the controller over the deployed GeoTools service. */
    public VectorReaderAssessmentController() {
        this.assessmentService = new VectorReaderAssessmentService();
    }

    /**
     * Ask deployed GeoTools to open one exact mounted vector layer.
     *
     * @param request explicit source URI, format, and layer identity
     * @return stable compatibility result without catalog mutation
     * @throws ResponseStatusException if any source identity field is invalid
     */
    @PostMapping(
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public VectorReaderAssessment assess(
            @RequestBody VectorReaderAssessmentRequest request) {
        if (request == null
                || request.sourceUri() == null
                || request.sourceUri().isBlank()
                || !SUPPORTED_FORMATS.contains(request.sourceFormat())
                || request.layerName() == null
                || request.layerName().isBlank()) {
            throw invalidSource();
        }
        Path sourcePath = resolveSource(request.sourceUri(), request.sourceFormat());
        return assessmentService.assess(
                request.sourceFormat(),
                sourcePath,
                request.layerName());
    }

    /**
     * Resolve and confine one supported file URI to the read-only scan mount.
     *
     * @param sourceUri candidate file URI
     * @param sourceFormat explicit supported format
     * @return canonical existing source file below {@code /scan-source}
     * @throws ResponseStatusException if the mounted source contract fails
     */
    private static Path resolveSource(String sourceUri, String sourceFormat) {
        try {
            URI uri = new URI(sourceUri.trim());
            if (!"file".equals(uri.getScheme())) {
                throw invalidSource();
            }
            Path sourcePath = Path.of(uri).toRealPath();
            String filename = sourcePath.getFileName().toString().toLowerCase(Locale.ROOT);
            boolean validSuffix = "shapefile".equals(sourceFormat)
                    ? filename.endsWith(".shp")
                    : filename.endsWith(".gpkg");
            if (!sourcePath.startsWith(SCAN_SOURCE_ROOT.toRealPath())
                    || !Files.isRegularFile(sourcePath)
                    || !validSuffix) {
                throw invalidSource();
            }
            return sourcePath;
        } catch (IllegalArgumentException | IOException | URISyntaxException error) {
            throw invalidSource(error);
        }
    }

    /**
     * Build the public bad-request response for an invalid vector identity.
     *
     * @return bad-request exception with no filesystem detail
     */
    private static ResponseStatusException invalidSource() {
        return new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "Vector assessment requires an exact mounted source layer");
    }

    /**
     * Build the public bad-request response while retaining its internal cause.
     *
     * @param cause URI or filesystem validation failure
     * @return bad-request exception with no filesystem detail
     */
    private static ResponseStatusException invalidSource(Exception cause) {
        return new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "Vector assessment requires an exact mounted source layer",
                cause);
    }
}
