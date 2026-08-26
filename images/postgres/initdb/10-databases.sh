#!/bin/bash
# Create one database + one role per consumer of the shared Postgres.
#
# Runs ONCE, by the official entrypoint, only on an EMPTY data directory. On a
# restart with an existing volume it does not run at all — which is exactly the
# behaviour we want: the databases (and the offer book inside `offerfiles`)
# persist. To start over, drop the `postgres-data` volume, which `./down.sh -v`
# does along with the chain the data belongs to.
#
# Each consumer gets its own role rather than sharing `postgres`: a role per
# database keeps one component's migrations from touching another's schema, and
# makes `\l` readable when something goes wrong.
#
# pg_ivm is created HERE, as the superuser. The offer-files kernel probes with
# `CREATE EXTENSION IF NOT EXISTS pg_ivm` and then confirms via pg_extension;
# pre-installing means that probe is a successful no-op and the `offerfiles`
# role never needs superuser. (pg_ivm is not a trusted extension, so an
# unprivileged CREATE EXTENSION would fail.)

set -euo pipefail

# Consumer -> password, from the environment with dev-only defaults. These are
# never exposed outside the compose network: the service publishes no host port.
UMBRA_USER="${UMBRA_PG_USER:-umbra}"
UMBRA_PW="${UMBRA_PG_PASSWORD:-umbra}"
UMBRA_DB="${UMBRA_PG_DB:-umbra}"

OFFERFILES_USER="${OFFERFILES_PG_USER:-offerfiles}"
OFFERFILES_PW="${OFFERFILES_PG_PASSWORD:-offerfiles}"
OFFERFILES_DB="${OFFERFILES_PG_DB:-offerfiles}"

create_consumer() {
  local role="$1" pw="$2" db="$3"
  echo "[initdb] creating role '${role}' and database '${db}'"

  # Roles and databases are created with psql rather than SQL literals built by
  # string concatenation elsewhere: the values come from compose, and quoting
  # them with format()/%I is what keeps a stray character from becoming syntax.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
       -v role="$role" -v pw="$pw" -v db="$db" <<-'SQL'
	SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
	WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
	SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
	WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL

  # Extension + schema privileges inside the new database.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
       -v role="$role" <<-'SQL'
	CREATE EXTENSION IF NOT EXISTS pg_ivm;
	-- The owner still needs explicit rights on the public schema: since PG15
	-- it is no longer world-writable, and a migration that creates tables as
	-- this role fails with "permission denied for schema public" otherwise.
	SELECT format('GRANT ALL ON SCHEMA public TO %I', :'role') \gexec
	SELECT format('ALTER SCHEMA public OWNER TO %I', :'role') \gexec
SQL
}

create_consumer "$UMBRA_USER"      "$UMBRA_PW"      "$UMBRA_DB"
create_consumer "$OFFERFILES_USER" "$OFFERFILES_PW" "$OFFERFILES_DB"

echo "[initdb] shared Postgres ready: ${UMBRA_DB}, ${OFFERFILES_DB} (pg_ivm installed in both)"
