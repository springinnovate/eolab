<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>dynamic-raster</Name>
    <UserStyle>
      <Title>Dynamic raster ramp</Title>
      <FeatureTypeStyle>
        <Rule>
          <RasterSymbolizer>
            <Opacity>1.0</Opacity>
            <ColorMap type="ramp">
              <ColorMapEntry color="${env('cmin','#2b83ba')}" quantity="${env('min',0)}" opacity="${env('amin',1.0)}" label="min"/>
              <ColorMapEntry color="${env('cmed','#ffffbf')}" quantity="${env('med',50)}" opacity="${env('amed',1.0)}" label="med"/>
              <ColorMapEntry color="${env('cmax','#d7191c')}" quantity="${env('max',100)}" opacity="${env('amax',1.0)}" label="max"/>
            </ColorMap>
          </RasterSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
