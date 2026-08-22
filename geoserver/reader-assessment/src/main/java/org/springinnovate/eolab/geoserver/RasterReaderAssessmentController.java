package org.springinnovate.eolab.geoserver;

import java.awt.RenderingHints;
import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import org.geoserver.catalog.Catalog;
import org.geoserver.catalog.CatalogRepository;
import org.geoserver.rest.RestBaseController;
import org.geotools.util.factory.Hints;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** Expose a private read-only acquisition probe through authenticated GeoServer REST. */
@RestController
@RequestMapping(path = RestBaseController.ROOT_PATH + "/eolab/reader-assessments")
public final class RasterReaderAssessmentController {
    private static final Path SCAN_SOURCE_ROOT = Path.of("/scan-source");

    private final Catalog catalog;
    private final GeoTiffReaderAssessmentService assessmentService;

    /**
     * Create the assessment controller from GeoServer's active catalog.
     *
     * @param catalog active GeoServer catalog used to reproduce publication hints
     */
    public RasterReaderAssessmentController(Catalog catalog) {
        this.catalog = catalog;
        this.assessmentService = new GeoTiffReaderAssessmentService();
    }

    /**
     * Ask the deployed GeoTools reader to acquire one mounted GeoTIFF.
     *
     * @param sourceUri file URI below GeoServer's read-only scan mount
     * @return stable compatibility result without catalog mutation
     * @throws ResponseStatusException if the URI is invalid, outside the mount,
     *     missing, or not a GeoTIFF
     */
    @PostMapping(
            consumes = MediaType.TEXT_PLAIN_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public RasterReaderAssessment assess(@RequestBody String sourceUri) {
        Path sourcePath = resolveSource(sourceUri);
        CatalogRepository repository = catalog.getResourcePool().getRepository();
        Hints hints = new Hints(new RenderingHints(Hints.REPOSITORY, repository));
        return assessmentService.assess(sourcePath, hints);
    }

    /**
     * Resolve and confine one file URI to the shared read-only scan mount.
     *
     * @param sourceUri candidate file URI
     * @return canonical existing GeoTIFF path below {@code /scan-source}
     * @throws ResponseStatusException if the URI violates the mounted-source contract
     */
    private static Path resolveSource(String sourceUri) {
        try {
            URI uri = new URI(sourceUri.trim());
            if (!"file".equals(uri.getScheme())) {
                throw invalidSource();
            }
            Path sourcePath = Path.of(uri).toRealPath();
            String filename = sourcePath.getFileName().toString().toLowerCase(Locale.ROOT);
            if (!sourcePath.startsWith(SCAN_SOURCE_ROOT.toRealPath())
                    || !Files.isRegularFile(sourcePath)
                    || !(filename.endsWith(".tif") || filename.endsWith(".tiff"))) {
                throw invalidSource();
            }
            return sourcePath;
        } catch (IllegalArgumentException | IOException | URISyntaxException error) {
            throw invalidSource(error);
        }
    }

    /**
     * Build the public bad-request response for an invalid mounted source.
     *
     * @return bad-request exception with no filesystem detail
     */
    private static ResponseStatusException invalidSource() {
        return new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "Reader assessment requires a mounted GeoTIFF source");
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
                "Reader assessment requires a mounted GeoTIFF source",
                cause);
    }
}
