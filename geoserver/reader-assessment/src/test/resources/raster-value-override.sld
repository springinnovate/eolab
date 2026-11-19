<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc" version="1.0.0">
  <NamedLayer>
    <Name>eolab:depth</Name>
    <UserStyle>
      <FeatureTypeStyle>
        <Transformation>
          <ogc:Function name="eolabMaskRasterValue"><ogc:Literal>gradient</ogc:Literal><ogc:Literal>-9999.5,-9999.5</ogc:Literal></ogc:Function>
        </Transformation>
        <Rule>
          <RasterSymbolizer>
            <Opacity>0.5</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry quantity="0" color="#101010" opacity="0.4" label="min"/>
              <ColorMapEntry quantity="1" color="#0000ff" opacity="1" label="med"/>
              <ColorMapEntry quantity="2" color="#00ff00" opacity="0.8" label="max"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
      <FeatureTypeStyle>
        <Transformation><ogc:Function name="eolabMaskRasterValue"><ogc:Literal>ranges</ogc:Literal><ogc:Literal>-9999.5,-9999.5</ogc:Literal></ogc:Function></Transformation>
        <Rule>
          <RasterSymbolizer>
            <Opacity>0.5</Opacity>
            <ColorMap type="values"><ColorMapEntry quantity="1" color="#ff0000" opacity="0.5"/></ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
