#!/bin/sh
# Create or upgrade Temporal's PostgreSQL schemas to this image's server version.
set -eu
dir=/etc/temporal/schema/postgresql/v12
for db in temporal temporal_visibility; do
  schema=$([ "$db" = temporal ] && echo temporal || echo visibility)
  temporal-sql-tool --db "$db" setup-schema -v 0.0
  temporal-sql-tool --db "$db" update-schema -d "$dir/$schema/versioned"
done
