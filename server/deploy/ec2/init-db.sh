#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 --set auth_password="$AUTH_DB_PASSWORD" --set api_password="$API_DB_PASSWORD" <<'SQL'
CREATE ROLE supabase_auth_admin LOGIN PASSWORD :'auth_password';
CREATE ROLE orka_api LOGIN PASSWORD :'api_password';
GRANT CREATE ON DATABASE orka TO orka_api;
CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
CREATE SCHEMA orka AUTHORIZATION orka_api;
ALTER ROLE supabase_auth_admin SET search_path TO auth,public;
ALTER ROLE orka_api SET search_path TO orka,public;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
