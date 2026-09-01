#!/bin/sh
set -eu

if [ "$(id -u)" = 0 ]; then
  find /var/lib/rabbitmq ! -user rabbitmq -exec chown rabbitmq '{}' +
  exec su-exec rabbitmq /bin/sh "$0"
fi

readonly ready_marker=/var/lib/rabbitmq/.nix-topology-ready
rm -f "$ready_marker"

docker-entrypoint.sh rabbitmq-server &
broker_pid=$!

shutdown() {
  trap - EXIT INT TERM
  rm -f "$ready_marker"
  if kill -0 "$broker_pid" 2>/dev/null; then
    kill -TERM "$broker_pid"
    wait "$broker_pid" || true
  fi
  exit 0
}

cleanup() {
  rm -f "$ready_marker"
  if kill -0 "$broker_pid" 2>/dev/null; then
    kill -TERM "$broker_pid"
    wait "$broker_pid" || true
  fi
}

trap cleanup EXIT
trap shutdown INT TERM

attempt=0
until rabbitmq-diagnostics -q ping >/dev/null 2>&1; do
  if ! kill -0 "$broker_pid" 2>/dev/null; then
    wait "$broker_pid"
    exit $?
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    echo "RabbitMQ did not start within 90 seconds." >&2
    exit 1
  fi
  sleep 1
done
rabbitmqctl await_startup

: "${NIX_RABBITMQ_API_PASSWORD:?set NIX_RABBITMQ_API_PASSWORD}"
: "${NIX_RABBITMQ_IMPORT_PASSWORD:?set NIX_RABBITMQ_IMPORT_PASSWORD}"
: "${NIX_RABBITMQ_EXPORT_PASSWORD:?set NIX_RABBITMQ_EXPORT_PASSWORD}"
: "${NIX_RABBITMQ_INDEX_PASSWORD:?set NIX_RABBITMQ_INDEX_PASSWORD}"
: "${NIX_RABBITMQ_PLUGIN_PASSWORD:?set NIX_RABBITMQ_PLUGIN_PASSWORD}"

if [ "$NIX_RABBITMQ_API_PASSWORD" = "$NIX_RABBITMQ_IMPORT_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_API_PASSWORD" = "$NIX_RABBITMQ_EXPORT_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_API_PASSWORD" = "$NIX_RABBITMQ_INDEX_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_API_PASSWORD" = "$NIX_RABBITMQ_PLUGIN_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_IMPORT_PASSWORD" = "$NIX_RABBITMQ_EXPORT_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_IMPORT_PASSWORD" = "$NIX_RABBITMQ_INDEX_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_IMPORT_PASSWORD" = "$NIX_RABBITMQ_PLUGIN_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_EXPORT_PASSWORD" = "$NIX_RABBITMQ_INDEX_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_EXPORT_PASSWORD" = "$NIX_RABBITMQ_PLUGIN_PASSWORD" ] \
  || [ "$NIX_RABBITMQ_INDEX_PASSWORD" = "$NIX_RABBITMQ_PLUGIN_PASSWORD" ]; then
  echo "RabbitMQ service passwords must be distinct." >&2
  exit 1
fi

user_exists() {
  rabbitmqctl list_users --no-table-headers | awk -v expected="$1" '$1 == expected { found = 1 } END { exit !found }'
}

ensure_user() {
  username="$1"
  password="$2"
  if user_exists "$username"; then
    rabbitmqctl change_password "$username" "$password"
  else
    rabbitmqctl add_user "$username" "$password"
  fi
  rabbitmqctl set_user_tags "$username"
  rabbitmqctl clear_topic_permissions --vhost /nix "$username"
}

delete_user() {
  if user_exists "$1"; then
    rabbitmqctl delete_user "$1"
  fi
}

rabbitmqctl import_definitions /etc/rabbitmq/definitions.json

readonly no_resources='^$'
readonly generated_queue='^amq\.gen-[A-Za-z0-9_-]+$'

ensure_user nix-api "$NIX_RABBITMQ_API_PASSWORD"
rabbitmqctl set_permissions --vhost /nix nix-api \
  "$generated_queue" \
  '^(amq\.gen-[A-Za-z0-9_-]+|nix\.commands\.v1|nix\.workspace\.v1)$' \
  '^(amq\.gen-[A-Za-z0-9_-]+|nix\.api\.results\.v1|nix\.capabilities\.v1)$'
rabbitmqctl set_topic_permissions --vhost /nix nix-api nix.commands.v1 \
  '^(import|file|object|export)\..+$' "$no_resources"
rabbitmqctl set_topic_permissions --vhost /nix nix-api nix.workspace.v1 \
  '^.+$' "$no_resources"
rabbitmqctl set_topic_permissions --vhost /nix nix-api nix.capabilities.v1 \
  "$no_resources" '^#$'

ensure_user nix-import "$NIX_RABBITMQ_IMPORT_PASSWORD"
rabbitmqctl set_permissions --vhost /nix nix-import "$no_resources" \
  '^nix\.results\.v1$' '^nix\.worker\.import\.v1$'
rabbitmqctl set_topic_permissions --vhost /nix nix-import nix.results.v1 \
  '^job\.result$' "$no_resources"

ensure_user nix-export "$NIX_RABBITMQ_EXPORT_PASSWORD"
rabbitmqctl set_permissions --vhost /nix nix-export "$no_resources" \
  '^(nix\.results\.v1|nix\.capabilities\.v1)$' '^nix\.worker\.export\.v1$'
rabbitmqctl set_topic_permissions --vhost /nix nix-export nix.results.v1 \
  '^job\.result$' "$no_resources"
rabbitmqctl set_topic_permissions --vhost /nix nix-export nix.capabilities.v1 \
  '^worker\.export$' "$no_resources"

ensure_user nix-index "$NIX_RABBITMQ_INDEX_PASSWORD"
rabbitmqctl set_permissions --vhost /nix nix-index "$no_resources" \
  "$no_resources" '^nix\.worker\.index\.v1$'

ensure_user nix-plugin "$NIX_RABBITMQ_PLUGIN_PASSWORD"
rabbitmqctl set_permissions --vhost /nix nix-plugin "$no_resources" \
  "$no_resources" '^nix\.worker\.plugin-events\.v1$'

# The all-in-one local binary needs the union of worker permissions. Production never sets this
# value: its role-specific deployments use the dedicated accounts above.
if [ -n "${NIX_RABBITMQ_DEV_WORKER_PASSWORD:-}" ]; then
  if [ "$NIX_RABBITMQ_DEV_WORKER_PASSWORD" = "$NIX_RABBITMQ_API_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_DEV_WORKER_PASSWORD" = "$NIX_RABBITMQ_IMPORT_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_DEV_WORKER_PASSWORD" = "$NIX_RABBITMQ_EXPORT_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_DEV_WORKER_PASSWORD" = "$NIX_RABBITMQ_INDEX_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_DEV_WORKER_PASSWORD" = "$NIX_RABBITMQ_PLUGIN_PASSWORD" ]; then
    echo "The development worker password must be distinct from service passwords." >&2
    exit 1
  fi
  ensure_user nix-worker-dev "$NIX_RABBITMQ_DEV_WORKER_PASSWORD"
  rabbitmqctl set_permissions --vhost /nix nix-worker-dev "$no_resources" \
    '^(nix\.results\.v1|nix\.capabilities\.v1)$' \
    '^nix\.worker\.(import|export|index|plugin-events)\.v1$'
  rabbitmqctl set_topic_permissions --vhost /nix nix-worker-dev nix.results.v1 \
    '^job\.result$' "$no_resources"
  rabbitmqctl set_topic_permissions --vhost /nix nix-worker-dev nix.capabilities.v1 \
    '^worker\.export$' "$no_resources"
else
  delete_user nix-worker-dev
fi

# The management UI is exposed on loopback in development only. Production omits this account and
# administers the broker locally with rabbitmqctl.
if [ -n "${NIX_RABBITMQ_ADMIN_PASSWORD:-}" ]; then
  if [ "$NIX_RABBITMQ_ADMIN_PASSWORD" = "$NIX_RABBITMQ_API_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_ADMIN_PASSWORD" = "$NIX_RABBITMQ_IMPORT_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_ADMIN_PASSWORD" = "$NIX_RABBITMQ_EXPORT_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_ADMIN_PASSWORD" = "$NIX_RABBITMQ_INDEX_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_ADMIN_PASSWORD" = "$NIX_RABBITMQ_PLUGIN_PASSWORD" ] \
    || [ "$NIX_RABBITMQ_ADMIN_PASSWORD" = "${NIX_RABBITMQ_DEV_WORKER_PASSWORD:-}" ]; then
    echo "The development administrator password must be distinct from service passwords." >&2
    exit 1
  fi
  ensure_user nix-admin "$NIX_RABBITMQ_ADMIN_PASSWORD"
  rabbitmqctl set_user_tags nix-admin administrator
  rabbitmqctl set_permissions --vhost /nix nix-admin '.*' '.*' '.*'
else
  delete_user nix-admin
fi

# Remove the image bootstrap account and the retired shared application account only after all
# service users and permissions are ready. rabbitmqctl remains the local administrative path.
delete_user guest
delete_user nix
touch "$ready_marker"

wait "$broker_pid"
