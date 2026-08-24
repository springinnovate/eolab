package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import org.geotools.api.data.DataStore;
import org.geotools.api.feature.simple.SimpleFeatureType;
import org.geotools.data.shapefile.ShapefileDataStoreFactory;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.locationtech.jts.geom.GeometryCollection;
import org.locationtech.jts.geom.LineString;
import org.locationtech.jts.geom.MultiPoint;
import org.locationtech.jts.geom.Point;
import org.locationtech.jts.geom.Polygon;
import org.springframework.web.server.ResponseStatusException;

/** Exercise the fixed geometry-to-default-style classification. */
final class VectorReaderAssessmentServiceTest {
    @TempDir
    Path temporaryDirectory;

    /** Classify point, line, and polygon families distinctly. */
    @Test
    void classifiesSupportedGeometryFamilies() {
        assertEquals("point", VectorReaderAssessmentService.geometryKind(MultiPoint.class));
        assertEquals("line", VectorReaderAssessmentService.geometryKind(LineString.class));
        assertEquals("polygon", VectorReaderAssessmentService.geometryKind(Polygon.class));
    }

    /** Reject mixed geometry collections instead of assigning a misleading style. */
    @Test
    void rejectsGeometryCollections() {
        assertNull(VectorReaderAssessmentService.geometryKind(GeometryCollection.class));
    }

    /** Reject a missing source URI at the authenticated controller boundary. */
    @Test
    void rejectsMissingSourceUri() {
        VectorReaderAssessmentRequest request = new VectorReaderAssessmentRequest(
                null,
                "shapefile",
                "sites");

        assertThrows(
                ResponseStatusException.class,
                () -> new VectorReaderAssessmentController().assess(request));
    }

    /**
     * Open a real Shapefile through the same deployed factory and exact type name.
     *
     * @throws IOException if the temporary Shapefile cannot be created
     */
    @Test
    void assessesShapefileThroughDeployedDataStore() throws IOException {
        Path sourcePath = temporaryDirectory.resolve("sites.shp");
        Map<String, Object> parameters = new HashMap<>();
        parameters.put("url", sourcePath.toUri().toURL());
        parameters.put("create spatial index", false);
        DataStore dataStore = new ShapefileDataStoreFactory()
                .createNewDataStore(parameters);
        try {
            dataStore.createSchema(featureType("sites", Point.class));
        } finally {
            dataStore.dispose();
        }

        VectorReaderAssessment assessment = new VectorReaderAssessmentService()
                .assess("shapefile", sourcePath, "sites");

        assertTrue(assessment.compatible(), assessment.toString());
        assertEquals("point", assessment.geometryKind());
        assertNull(assessment.reasonCode());
    }

    /** Select one exact native layer from a real multi-layer GeoPackage. */
    @Test
    void assessesExactGeoPackageLayerThroughDeployedDataStore() {
        Path sourcePath = Path.of(
                "..",
                "..",
                "tests",
                "fixtures",
                "vectors",
                "multi-layer.gpkg");

        VectorReaderAssessmentService service = new VectorReaderAssessmentService();
        VectorReaderAssessment assessment = service.assess(
                "geopackage",
                sourcePath,
                "selected_areas");
        VectorReaderAssessment missingLayer = service.assess(
                "geopackage",
                sourcePath,
                "not_present");

        assertTrue(assessment.compatible(), assessment.toString());
        assertEquals("polygon", assessment.geometryKind());
        assertEquals(
                VectorReaderAssessmentService.LAYER_MISSING_REASON,
                missingLayer.reasonCode());
    }

    /**
     * Build one WGS 84 schema with the requested exact native name and geometry.
     *
     * @param typeName exact native layer name
     * @param geometryBinding JTS geometry class
     * @return simple feature schema accepted by file datastores
     */
    private static SimpleFeatureType featureType(
            String typeName,
            Class<?> geometryBinding) {
        SimpleFeatureTypeBuilder builder = new SimpleFeatureTypeBuilder();
        builder.setName(typeName);
        builder.setCRS(DefaultGeographicCRS.WGS84);
        builder.add("geometry", geometryBinding);
        builder.add("name", String.class);
        return builder.buildFeatureType();
    }
}
