package org.geotools.renderer.lite;

import java.util.ArrayList;
import java.util.List;
import org.geotools.api.referencing.crs.CoordinateReferenceSystem;
import org.geotools.api.referencing.crs.GeographicCRS;
import org.geotools.api.referencing.cs.AxisDirection;
import org.geotools.api.referencing.cs.CoordinateSystemAxis;
import org.geotools.api.referencing.cs.RangeMeaning;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.referencing.CRS;
import org.locationtech.jts.geom.Envelope;

/** Adds adjacent longitude query windows for a published vector's stored native bounds. */
public final class LongitudeWrapQueries {
    /** Layer metadata supplied from GeoServer's published native extent, without a source scan. */
    public static final String NATIVE_BOUNDS_KEY = "org.geotools.renderer.nativeBounds";

    private LongitudeWrapQueries() {}

    /**
     * Include adjacent-world source coverage which the ordinary canonical query cannot retrieve.
     *
     * <p>Call only when the renderer has selected a wrapping projection handler. The original query
     * windows are retained; at most two additional windows per original window are considered. This
     * supports geographic data extending into the neighboring longitude worlds, not coordinates many
     * revolutions away. Existing projection and geometry wrapping remain responsible for drawing.
     *
     * @param envelopes existing query windows in the source CRS
     * @param sourceCRS feature schema's coordinate reference system
     * @param nativeBounds published native extent, or absent metadata for an unmodified source
     * @return original windows plus intersecting, nonredundant adjacent-world windows
     */
    public static List<ReferencedEnvelope> includeAdjacentLongitudeWindows(
            List<ReferencedEnvelope> envelopes,
            CoordinateReferenceSystem sourceCRS,
            Object nativeBounds) {
        if (!(sourceCRS instanceof GeographicCRS)
                || !(nativeBounds instanceof ReferencedEnvelope bounds)
                || !CRS.equalsIgnoreMetadata(sourceCRS, bounds.getCoordinateReferenceSystem())
                || bounds.isEmpty()) {
            return envelopes;
        }
        int longitudeAxis = -1;
        for (int dimension = 0; dimension < 2; dimension++) {
            CoordinateSystemAxis axis = sourceCRS.getCoordinateSystem().getAxis(dimension);
            if (axis.getRangeMeaning() == RangeMeaning.WRAPAROUND
                    && (axis.getDirection() == AxisDirection.EAST
                            || axis.getDirection() == AxisDirection.WEST)) {
                longitudeAxis = dimension;
                break;
            }
        }
        if (longitudeAxis < 0) {
            return envelopes;
        }
        CoordinateSystemAxis axis = sourceCRS.getCoordinateSystem().getAxis(longitudeAxis);
        double period = axis.getMaximumValue() - axis.getMinimumValue();
        if (!Double.isFinite(period) || period <= 0) {
            return envelopes;
        }
        boolean lowerOverflow = bounds.getMinimum(longitudeAxis) < axis.getMinimumValue();
        boolean upperOverflow = bounds.getMaximum(longitudeAxis) > axis.getMaximumValue();
        if (!lowerOverflow && !upperOverflow) {
            return envelopes;
        }
        List<ReferencedEnvelope> result = new ArrayList<>(envelopes);
        for (ReferencedEnvelope envelope : envelopes) {
            for (int direction : new int[] {-1, 1}) {
                if (direction < 0 ? !lowerOverflow : !upperOverflow) {
                    continue;
                }
                ReferencedEnvelope shifted = new ReferencedEnvelope(envelope);
                shifted.translate(
                        longitudeAxis == 0 ? direction * period : 0,
                        longitudeAxis == 1 ? direction * period : 0);
                if (shifted.intersects((Envelope) bounds)
                        && result.stream().noneMatch(existing -> existing.contains(shifted))) {
                    result.add(shifted);
                }
            }
        }
        return result;
    }
}
