#!/bin/sh
set -eu
umask 077
domain=${1:?Usage: sh configure.sh your.server.example (or localhost --port 8080)}
shift
local_port=8080
if [ "${1:-}" = --port ] && [ "$#" -eq 2 ]; then local_port=$2
elif [ "$#" -ne 0 ]; then echo 'Usage: sh configure.sh hostname [--port 8080]' >&2; exit 1
fi
case "$local_port" in ''|*[!0-9]*|0*|??????*) echo 'Port must be a number from 1 to 65535.' >&2; exit 1 ;; esac
if [ "$local_port" -gt 65535 ]; then echo 'Port must be a number from 1 to 65535.' >&2; exit 1; fi
case "$domain" in
  *[!a-zA-Z0-9.-]*|.*|*..*|-*|*-) echo 'Use a hostname without a scheme, path or port.' >&2; exit 1 ;;
esac
if ! printf '%s\n' "$domain" | awk 'length($0) > 253 {exit 1} {n=split($0,labels,"."); for(i=1;i<=n;i++) if(length(labels[i])<1 || length(labels[i])>63 || labels[i] ~ /^-/ || labels[i] ~ /-$/) exit 1}'; then
  echo 'Use a valid hostname (each label must contain 1-63 letters, digits or hyphens).' >&2; exit 1
fi
command -v openssl >/dev/null
if [ -e .env ]; then
  echo '.env already exists; keep its credentials and edit it directly.' >&2
  exit 1
fi
postgres_password=$(openssl rand -hex 32)
auth_password=$(openssl rand -hex 32)
api_password=$(openssl rand -hex 32)
jwt_secret=$(openssl rand -hex 32)
project_name=orka-$(openssl rand -hex 4)
install_image=${ORKA_INSTALL_IMAGE:-}
if [ -z "$install_image" ] && [ -f .release-image ]; then install_image=$(cat .release-image); fi
case "$install_image" in *[!a-zA-Z0-9._/:@-]*) echo 'Invalid image reference.' >&2; exit 1 ;; esac
server_mode=public
compose_files=compose.yml
if [ -n "$install_image" ]; then compose_files="$compose_files:compose.image.yml"; fi
if [ "$domain" = localhost ]; then
  server_mode=local
  compose_files="$compose_files:deploy/local/compose.yml"
fi
# Noclobber also protects against a concurrent initialization.
set -C
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    DOMAIN=*) printf 'DOMAIN=%s\n' "$domain" ;;
    ORKA_SERVER_MODE=*) printf 'ORKA_SERVER_MODE=%s\n' "$server_mode" ;;
    ORKA_LOCAL_PORT=*) printf 'ORKA_LOCAL_PORT=%s\n' "$local_port" ;;
    COMPOSE_PROJECT_NAME=*) printf 'COMPOSE_PROJECT_NAME=%s\n' "$project_name" ;;
    COMPOSE_FILE=*) printf 'COMPOSE_FILE=%s\n' "$compose_files" ;;
    ORKA_IMAGE=*) printf 'ORKA_IMAGE=%s\n' "$install_image" ;;
    POSTGRES_PASSWORD=*) printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password" ;;
    AUTH_DB_PASSWORD=*) printf 'AUTH_DB_PASSWORD=%s\n' "$auth_password" ;;
    API_DB_PASSWORD=*) printf 'API_DB_PASSWORD=%s\n' "$api_password" ;;
    JWT_SECRET=*) printf 'JWT_SECRET=%s\n' "$jwt_secret" ;;
    ORKA_OPERATOR_UID=*) printf 'ORKA_OPERATOR_UID=%s\n' "$(id -u)" ;;
    ORKA_OPERATOR_GID=*) printf 'ORKA_OPERATOR_GID=%s\n' "$(id -g)" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < deploy/self-hosted/.env.example > .env
mkdir -p .runtime/accounts
chmod 700 .runtime .runtime/accounts
printf 'Created private configuration. Continue with sh ./orka-server setup --email you@example.com.\n'
