package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;
import org.geotools.util.factory.Hints;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/** Exercise the deployed GeoTools reader contract against regression fixtures. */
final class GeoTiffReaderAssessmentServiceTest {
    private static final Path FIXTURE_DIRECTORY =
            Path.of("..", "..", "tests", "fixtures", "rasters");

    private final GeoTiffReaderAssessmentService assessmentService =
            new GeoTiffReaderAssessmentService();

    /**
     * Reject the user-defined Eckert IV citation that GeoTools cannot parse.
     *
     * @throws IOException if the regression fixture cannot be read
     */
    @Test
    void rejectsGeoToolsIncompatibleUserDefinedCrsCitation() throws IOException {
        Path fixturePath =
                FIXTURE_DIRECTORY.resolve("geoserver-incompatible-eckert-iv.tif");
        byte[] sourceBeforeAssessment = Files.readAllBytes(fixturePath);

        RasterReaderAssessment assessment =
                assessmentService.assess(fixturePath, new Hints());

        assertFalse(assessment.compatible());
        assertEquals(
                GeoTiffReaderAssessmentService.CRS_METADATA_REASON,
                assessment.reasonCode());
        assertEquals(
                GeoTiffReaderAssessmentService.READER_CONTRACT,
                assessment.contract());
        assertArrayEquals(sourceBeforeAssessment, Files.readAllBytes(fixturePath));
    }

    /**
     * Keep geographic, projected EPSG, and supported custom CRS encodings eligible.
     *
     * @param fixtureName supported control fixture filename
     */
    @ParameterizedTest
    @MethodSource("supportedFixtureNames")
    void acceptsSupportedCoordinateSystemEncodings(String fixtureName) {
        RasterReaderAssessment assessment = assessmentService.assess(
                FIXTURE_DIRECTORY.resolve(fixtureName),
                new Hints());

        assertTrue(assessment.compatible(), assessment.toString());
        assertNull(assessment.reasonCode());
    }

    /**
     * Return representative filenames for every supported control class.
     *
     * @return geographic EPSG, projected EPSG, and supported custom CRS fixtures
     */
    private static Stream<String> supportedFixtureNames() {
        return Stream.of(
                "geographic-epsg-4326.tif",
                "projected-epsg-3857.tif",
                "geoserver-supported-user-defined-transverse-mercator.tif");
    }
}
