package org.springinnovate.eolab.geoserver;

import java.nio.file.Path;
import org.geotools.api.data.DataSourceException;
import org.geotools.gce.geotiff.GeoTiffReader;
import org.geotools.util.factory.Hints;

/** Acquire GeoTIFF metadata through the reader bundled with deployed GeoServer. */
public final class GeoTiffReaderAssessmentService {
    /** Contract shared with EOLab's persisted raster-v3 assessment. */
    public static final String READER_CONTRACT =
            "geoserver-3.0.1-geotools-35.1-geotiff-v1";

    /** Stable reason for the representative coordinate-system metadata failure. */
    public static final String CRS_METADATA_REASON =
            "geoserver_crs_metadata_incompatible";

    /** Stable reason for another deterministic GeoTIFF reader rejection. */
    public static final String READER_REASON = "geoserver_reader_incompatible";

    /**
     * Acquire one raster without reading pixels or modifying GeoServer state.
     *
     * @param sourcePath canonical mounted GeoTIFF path
     * @param hints GeoServer repository hints used by coverage publication
     * @return stable deployed-reader assessment
     */
    public RasterReaderAssessment assess(Path sourcePath, Hints hints) {
        GeoTiffReader reader = null;
        try {
            reader = new GeoTiffReader(sourcePath.toFile(), hints);
            return new RasterReaderAssessment(READER_CONTRACT, true, null);
        } catch (DataSourceException error) {
            return new RasterReaderAssessment(
                    READER_CONTRACT,
                    false,
                    isCoordinateSystemMetadataFailure(error)
                            ? CRS_METADATA_REASON
                            : READER_REASON);
        } finally {
            dispose(reader);
        }
    }

    /**
     * Classify the GeoTools exception text raised for incompatible CRS encoding.
     *
     * @param error reader-acquisition exception and its cause chain
     * @return whether GeoTools identified coordinate-system metadata encoding
     */
    private static boolean isCoordinateSystemMetadataFailure(Throwable error) {
        Throwable current = error;
        while (current != null) {
            String message = current.getMessage();
            if (message != null
                    && (message.contains("User-defined requires citation")
                            || message.contains("Only Geographic & Projected Systems"))) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    /**
     * Release an acquired reader after the metadata-only probe.
     *
     * @param reader acquired reader, or {@code null} after acquisition failure
     */
    private static void dispose(GeoTiffReader reader) {
        if (reader == null) {
            return;
        }
        reader.dispose();
    }
}
