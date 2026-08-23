#!/bin/sh
set -eu

library_directory=${1:-/usr/local/tomcat/webapps/geoserver/WEB-INF/lib}

require_module() {
    module_pattern=$1
    capability_name=$2
    for module_path in "$library_directory"/$module_pattern; do
        if [ -f "$module_path" ]; then
            return
        fi
    done
    echo >&2 "GeoServer ${capability_name} datastore module is missing"
    exit 1
}

require_module 'gt-shapefile-*.jar' 'Shapefile'
require_module 'gt-geopkg-*.jar' 'GeoPackage'
