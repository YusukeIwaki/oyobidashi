#!/usr/bin/env bash
# Run real PostgreSQL/Redis integration tests without touching configured services.
set -euo pipefail

cloud_repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v docker >/dev/null || { echo 'Docker is required for cloud integration tests.' >&2; exit 1; }
command -v bun >/dev/null || { echo 'Bun is required for cloud integration tests.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Start Docker before running cloud integration tests.' >&2; exit 1; }

cloud_test_run="oyobidashi-cloud-test-$(date +%s)-$$"
cloud_test_pg="${cloud_test_run}-postgres"
cloud_test_redis="${cloud_test_run}-redis"
cloud_cleanup() {
  local cloud_exit_status=$?
  trap - EXIT
  docker rm --force --volumes "$cloud_test_pg" "$cloud_test_redis" >/dev/null 2>&1 || true
  exit "$cloud_exit_status"
}
trap cloud_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# These credentials are disposable, local-only test values. Ports are assigned
# dynamically and bound only to 127.0.0.1; no personal config or .env is read.
echo 'Starting isolated PostgreSQL 17 and Redis 7 for cloud tests.'
docker run --detach --name "$cloud_test_pg" \
  --label me.oyobidashi.purpose=cloud-test \
  --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data \
  --env POSTGRES_USER=oyobidashi --env POSTGRES_PASSWORD=local-test-only --env POSTGRES_DB=oyobidashi_test \
  --health-cmd 'pg_isready -U oyobidashi -d oyobidashi_test' --health-interval 1s --health-timeout 3s --health-retries 60 \
  postgres:17-alpine >/dev/null

docker run --detach --name "$cloud_test_redis" \
  --label me.oyobidashi.purpose=cloud-test \
  --publish 127.0.0.1::6379 --tmpfs /data \
  --health-cmd 'redis-cli ping' --health-interval 1s --health-timeout 3s --health-retries 60 \
  redis:7-alpine redis-server --save '' --appendonly no >/dev/null

cloud_wait_healthy() {
  local cloud_container=$1 cloud_attempt cloud_health
  for cloud_attempt in {1..60}; do
    cloud_health="$(docker inspect --format '{{.State.Health.Status}}' "$cloud_container")"
    if [[ "$cloud_health" == healthy ]]; then return 0; fi
    if [[ "$cloud_health" == unhealthy ]]; then break; fi
    sleep 1
  done
  echo 'A disposable cloud test service did not become healthy.' >&2
  return 1
}
cloud_wait_healthy "$cloud_test_pg"
cloud_wait_healthy "$cloud_test_redis"
cloud_pg_binding="$(docker port "$cloud_test_pg" 5432/tcp)"
cloud_redis_binding="$(docker port "$cloud_test_redis" 6379/tcp)"
cloud_pg_port="${cloud_pg_binding##*:}"
cloud_redis_port="${cloud_redis_binding##*:}"
[[ "$cloud_pg_port" =~ ^[0-9]+$ && "$cloud_redis_port" =~ ^[0-9]+$ ]] || { echo 'Could not determine disposable service ports.' >&2; exit 1; }
export CLOUD_TEST_DATABASE_URL="postgres://oyobidashi:local-test-only@127.0.0.1:${cloud_pg_port}/oyobidashi_test"
export CLOUD_TEST_REDIS_URL="redis://127.0.0.1:${cloud_redis_port}"
echo 'Running cloud unit and integration tests against disposable local services.'
# Override production defaults as well: even a future startup integration test
# must remain on these disposable services and must not invoke real providers.
DATABASE_URL="$CLOUD_TEST_DATABASE_URL" REDIS_URL="$CLOUD_TEST_REDIS_URL" \
FIREBASE_PROJECT_ID=isolated-cloud-test VOICE_PROVIDER=anthropic ANTHROPIC_API_KEY= ANTHROPIC_MODEL= MODEL_API_KEY= META_MODEL= \
FIREBASE_WEB_API_KEY= FIREBASE_AUTH_SERVICE_ACCOUNT_JSON= FIREBASE_AUTH_PROVIDERS= \
FCM_SERVICE_ACCOUNT_PATH= FCM_SERVICE_ACCOUNT_JSON= APNS_KEY_PATH= APNS_KEY_PEM= APNS_KEY_ID= APNS_TEAM_ID= APNS_BUNDLE_ID= \
bun test --cwd "$cloud_repo_dir/cloud" "$@"
