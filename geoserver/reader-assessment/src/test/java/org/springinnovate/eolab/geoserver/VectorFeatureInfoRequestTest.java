package org.springinnovate.eolab.geoserver;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Color;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import org.geoserver.catalog.CatalogBuilder;
import org.geoserver.catalog.SLDHandler;
import org.geoserver.catalog.impl.CatalogImpl;
import org.geoserver.config.impl.GeoServerImpl;
import org.geoserver.config.impl.GeoServerInfoImpl;
import org.geoserver.ows.kvp.BBoxKvpParser;
import org.geoserver.ows.kvp.FormatOptionsKvpParser;
import org.geoserver.ows.kvp.IntegerKvpParser;
import org.geoserver.ows.util.KvpUtils;
import org.geoserver.platform.GeoServerExtensions;
import org.geoserver.platform.GeoServerResourceLoader;
import org.geoserver.platform.Operation;
import org.geoserver.platform.Service;
import org.geoserver.wms.DefaultWebMapService;
import org.geoserver.wms.GetFeatureInfo;
import org.geoserver.wms.GetFeatureInfoRequest;
import org.geoserver.wms.WMS;
import org.geoserver.wms.WMSInfoImpl;
import org.geoserver.wms.dimension.impl.DimensionDefaultValueSelectionStrategyFactoryImpl;
import org.geoserver.wms.featureinfo.GeoJSONFeatureInfoResponse;
import org.geoserver.wms.featureinfo.GetFeatureInfoKvpReader;
import org.geoserver.wms.featureinfo.GetFeatureInfoResponse;
import org.geoserver.wms.featureinfo.VectorBasicLayerIdentifier;
import org.geotools.api.feature.simple.SimpleFeatureType;
import org.geotools.data.memory.MemoryDataStore;
import org.geotools.feature.simple.SimpleFeatureBuilder;
import org.geotools.feature.simple.SimpleFeatureTypeBuilder;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.geotools.referencing.CRS;
import org.geotools.geometry.jts.JTS;
import org.geotools.styling.SLD;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.locationtech.jts.geom.Polygon;
import org.locationtech.jts.io.WKTReader;
import org.springframework.beans.factory.xml.XmlBeanDefinitionReader;
import org.springframework.context.support.GenericApplicationContext;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Exercise native WMS request parsing, feature selection and response dispatch together. */
final class VectorFeatureInfoRequestTest {
    @TempDir
    Path temporaryDirectory;

    /**
     * Accept the private INFO_FORMAT through WMS validation and keep ordinary GeoJSON unchanged.
     *
     * @throws Exception if native catalog setup, request execution or JSON decoding fails
     */
    @Test
    void handlesPrivateAndOrdinaryJsonThroughNativeWmsRequest() throws Exception {
        var catalog = new CatalogImpl();
        catalog.setResourceLoader(new GeoServerResourceLoader(temporaryDirectory.toFile()));
        var configuration = new GeoServerImpl();
        configuration.setCatalog(catalog);
        var global = new GeoServerInfoImpl();
        global.getSettings().setCharset("UTF-8");
        global.getSettings().setNumDecimals(8);
        configuration.setGlobal(global);
        var service = new WMSInfoImpl();
        service.setName("WMS");
        service.setGetFeatureInfoMimeTypeCheckingEnabled(true);
        service.getGetFeatureInfoMimeTypes().addAll(
                List.of(VectorFeatureInfoOutputFormat.FORMAT, "application/json"));
        configuration.add(service);
        var extensions = new GeoServerExtensions();
        try (var context = new GenericApplicationContext()) {
            context.getBeanFactory().registerSingleton("geoServer", configuration);
            context.getBeanFactory().registerSingleton("sldHandler", new SLDHandler());
            context.getBeanFactory().registerSingleton("dimensionDefaults",
                    new DimensionDefaultValueSelectionStrategyFactoryImpl());
            context.getBeanFactory().registerSingleton("bboxParser", new BBoxKvpParser());
            context.getBeanFactory().registerSingleton("widthParser", new IntegerKvpParser("width"));
            context.getBeanFactory().registerSingleton("heightParser", new IntegerKvpParser("height"));
            var optionsParser = new FormatOptionsKvpParser();
            optionsParser.setApplicationContext(context);
            context.getBeanFactory().registerSingleton("formatOptionsParser", optionsParser);
            new XmlBeanDefinitionReader(context).loadBeanDefinitions(new ClassPathResource("applicationContext.xml"));
            context.refresh();
            extensions.setApplicationContext(context);
            var wms = new WMS(configuration);
            wms.setApplicationContext(context);
            var ordinaryJson = new GeoJSONFeatureInfoResponse(wms, "application/json");
            context.getBeanFactory().registerSingleton("ordinaryJson", ordinaryJson);
            context.getBeanFactory().registerSingleton("vectorIdentifier", new VectorBasicLayerIdentifier(wms));
            addLayer(catalog);
            var reader = new GetFeatureInfoKvpReader(wms);
            var response = new GetFeatureInfoResponse(wms, ordinaryJson);
            var webMapService = new DefaultWebMapService(wms);
            webMapService.setGetFeatureInfo(new GetFeatureInfo(wms));
            var descriptor = new Service("WMS", webMapService, WMS.VERSION_1_1_1, List.of("GetFeatureInfo"));
            for (String format : List.of(VectorFeatureInfoOutputFormat.FORMAT, "application/json")) {
                GetFeatureInfoRequest request = readRequest(reader, format);
                var result = webMapService.getFeatureInfo(request);
                var operation = new Operation("GetFeatureInfo", descriptor,
                        DefaultWebMapService.class.getMethod("getFeatureInfo", GetFeatureInfoRequest.class),
                        new Object[] {request});
                assertTrue(response.canHandle(operation));
                assertEquals(format, response.getMimeType(result, operation));
                assertEquals("UTF-8", response.getCharset(operation));
                var output = new ByteArrayOutputStream();
                response.write(result, output, operation);
                JsonNode document = JsonMapper.builder().build().readTree(output.toByteArray());
                assertEquals("FeatureCollection", document.path("type").asText());
                assertEquals(1, document.path("features").size());
                JsonNode feature = document.path("features").get(0);
                assertEquals("distribution.1", feature.path("id").asText());
                assertEquals("Selected polygon", feature.path("properties").path("name").asText());
                if (format.equals(VectorFeatureInfoOutputFormat.FORMAT)) {
                    assertTrue(feature.path("geometry").isNull());
                    assertEquals(1, feature.path("properties").size());
                    double[] bounds = {-85, 5, -60, 30};
                    assertEquals(bounds.length, feature.path("bbox").size());
                    for (int index = 0; index < bounds.length; index++) {
                        assertEquals(bounds[index], feature.path("bbox").get(index).asDouble(), 0.000001);
                    }
                } else {
                    assertFalse(feature.path("geometry").isNull());
                    assertEquals("Polygon", feature.path("geometry").path("type").asText());
                    assertTrue(feature.path("properties").has("count"));
                }
            }
        } finally {
            extensions.setApplicationContext(null);
            catalog.dispose();
        }
    }

    /**
     * Parse the same query parameters the application sends with native GeoServer KVP parsers.
     *
     * @param reader native GetFeatureInfo request reader
     * @param format private navigation response or ordinary GeoJSON
     * @return validated request with native map and feature-info parameters
     * @throws Exception if a parser rejects the request
     */
    private static GetFeatureInfoRequest readRequest(GetFeatureInfoKvpReader reader, String format)
            throws Exception {
        String fields = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("[\"name\"]".getBytes(StandardCharsets.UTF_8));
        var raw = KvpUtils.normalize(KvpUtils.parseQueryString(
                "http://localhost/geoserver/wms?service=WMS&request=GetFeatureInfo&version=1.1.1&layers=eolab:distribution"
                + "&query_layers=eolab:distribution&styles=&srs=EPSG:3857"
                + "&bbox=-10000000,0,-5000000,5000000&width=400&height=400&x=150&y=225&feature_count=1"
                + "&info_format=" + java.net.URLEncoder.encode(format, StandardCharsets.UTF_8)
                + "&format_options=eolabProperties:" + fields));
        var parsed = KvpUtils.normalize(raw);
        assertTrue(KvpUtils.parse(parsed).isEmpty());
        return (GetFeatureInfoRequest) reader.read(new GetFeatureInfoRequest(), parsed, raw);
    }

    /**
     * Publish two real in-memory polygons so WMS must select only the clicked feature.
     *
     * @param catalog native catalog owning the temporary layer and source cache
     * @throws Exception if the native schema, source or style cannot be created
     */
    private static void addLayer(CatalogImpl catalog) throws Exception {
        var factory = catalog.getFactory();
        var workspace = factory.createWorkspace();
        workspace.setName("eolab");
        catalog.add(workspace);
        var namespace = factory.createNamespace();
        namespace.setPrefix("eolab");
        namespace.setURI("https://eolab.test");
        catalog.add(namespace);
        var store = factory.createDataStore();
        store.setName("distribution");
        store.setWorkspace(workspace);
        store.setEnabled(true);
        catalog.add(store);
        var builder = new SimpleFeatureTypeBuilder();
        builder.setName("distribution");
        builder.setNamespaceURI(namespace.getURI());
        builder.setCRS(CRS.decode("EPSG:3857", true));
        builder.add("shape", Polygon.class);
        builder.add("name", String.class);
        builder.add("count", Integer.class);
        SimpleFeatureType schema = builder.buildFeatureType();
        var geometry = new WKTReader();
        var projection = CRS.findMathTransform(DefaultGeographicCRS.WGS84, schema.getCoordinateReferenceSystem());
        var source = new MemoryDataStore(
                SimpleFeatureBuilder.build(schema, new Object[] {
                    JTS.transform(geometry.read("POLYGON ((-85 5, -60 5, -60 30, -85 30, -85 5))"), projection),
                    "Selected polygon", 7
                }, "distribution.1"),
                SimpleFeatureBuilder.build(schema, new Object[] {
                    JTS.transform(geometry.read("POLYGON ((10 5, 20 5, 20 30, 10 30, 10 5))"), projection),
                    "Other polygon", 9
                }, "distribution.2"));
        catalog.getResourcePool().getDataStoreCache().put(store.getId(), source);
        var catalogBuilder = new CatalogBuilder(catalog);
        catalogBuilder.setStore(store);
        var featureType = catalogBuilder.buildFeatureType(source.getFeatureSource("distribution"));
        catalog.add(featureType);
        var style = factory.createStyle();
        style.setName("polygon");
        style.setFilename("polygon.sld");
        catalog.add(style);
        catalog.getResourcePool().writeStyle(style, SLD.createPolygonStyle(Color.BLACK, Color.GREEN, 1));
        var layer = factory.createLayer();
        layer.setResource(featureType);
        layer.setDefaultStyle(style);
        layer.setEnabled(true);
        layer.setQueryable(true);
        catalog.add(layer);
    }
}
