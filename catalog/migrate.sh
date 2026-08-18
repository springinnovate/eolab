#!/bin/sh
set -eu

pypgstac migrate

for migration_path in /catalog/migrations/*.sql; do
    psql --set=ON_ERROR_STOP=1 --file "$migration_path"
done
