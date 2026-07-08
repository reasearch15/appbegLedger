#!/usr/bin/env bash
# Create AppBeg Ledger PostgreSQL database and user on a VPS.
# Run on the VPS as a PostgreSQL superuser (e.g. sudo -u postgres bash scripts/vps/create_postgres_db.sh).

set -euo pipefail

DB_NAME="${APPBEG_DB_NAME:-appbeg_ledger_db}"
DB_USER="${APPBEG_DB_USER:-appbeg_ledger_user}"
DB_PASSWORD="${APPBEG_DB_PASSWORD:-}"

if [[ -z "${DB_PASSWORD}" ]]; then
  echo "Set APPBEG_DB_PASSWORD before running this script." >&2
  echo "Example: APPBEG_DB_PASSWORD='strong-password' bash scripts/vps/create_postgres_db.sh" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<SQL
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL

echo "Database ready: ${DB_NAME}"
echo "User: ${DB_USER}"
echo "Connection URL:"
echo "postgresql://${DB_USER}:<password>@<vps-host>:5432/${DB_NAME}"
