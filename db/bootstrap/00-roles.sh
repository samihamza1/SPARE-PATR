#!/usr/bin/env bash
# Creates the cluster-level roles and databases. Idempotent; safe to re-run.
#
# Runs automatically on first start of the postgres container (docker-entrypoint-initdb.d)
# and explicitly in CI. Connects as a superuser using the usual libpq variables
# (PGHOST, PGUSER, PGPASSWORD, ...) or POSTGRES_USER inside the container.
#
#   autoparts_owner  owns the databases and schema, runs migrations. Not a superuser, so
#                    FORCE ROW LEVEL SECURITY applies to it as well.
#   autoparts_app    used by the application at runtime. NOBYPASSRLS and owns nothing;
#                    migrations grant it exactly the table privileges it needs.
set -euo pipefail

: "${AUTOPARTS_OWNER_PASSWORD:?AUTOPARTS_OWNER_PASSWORD must be set}"
: "${AUTOPARTS_APP_PASSWORD:?AUTOPARTS_APP_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 ${POSTGRES_USER:+--username="$POSTGRES_USER"} --dbname=postgres \
  --set=owner_password="$AUTOPARTS_OWNER_PASSWORD" \
  --set=app_password="$AUTOPARTS_APP_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE autoparts_owner'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'autoparts_owner') \gexec
ALTER ROLE autoparts_owner
  LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB PASSWORD :'owner_password';

SELECT 'CREATE ROLE autoparts_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'autoparts_app') \gexec
ALTER ROLE autoparts_app
  LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT PASSWORD :'app_password';

SELECT 'CREATE DATABASE autoparts OWNER autoparts_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'autoparts') \gexec
SELECT 'CREATE DATABASE autoparts_test OWNER autoparts_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'autoparts_test') \gexec
SQL
