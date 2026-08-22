#!/usr/bin/env bash
# Maison POS — one-shot Docker bring-up.
#
#   ./docker/setup.sh            # official frappe/erpnext:v15 image, maison_pos installed at runtime
#   ./docker/setup.sh --build    # build custom image from docker/Containerfile (maison_pos baked in)
#
# Env overrides (or put them in docker/.env):
#   SITE_NAME=maison.localhost ADMIN_PASSWORD=admin DB_ROOT_PASSWORD=admin HTTP_PORT=8080 DEVELOPER_MODE=0
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
cd "$HERE"

export SITE_NAME="${SITE_NAME:-maison.localhost}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
export DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-admin}"
export HTTP_PORT="${HTTP_PORT:-8080}"
export DEVELOPER_MODE="${DEVELOPER_MODE:-0}"

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose v2 is required (https://docs.docker.com/compose/install/)" >&2
  exit 1
fi

BUILD=0
[[ "${1:-}" == "--build" ]] && BUILD=1

if [[ $BUILD -eq 1 ]]; then
  export IMAGE="maison/erpnext" VERSION="v15"
  echo ">> Building custom image $IMAGE:$VERSION (this takes 10-20 min the first time)"
  docker build -f "$HERE/Containerfile" -t "$IMAGE:$VERSION" "$REPO_ROOT"
else
  export IMAGE="frappe/erpnext" VERSION="v15"
  echo ">> Using official image $IMAGE:$VERSION"
fi

echo ">> Starting infrastructure + site creation"
docker compose up -d

echo ">> Waiting for site '$SITE_NAME' to be created (watch with: docker compose logs -f create-site)"
docker compose wait create-site >/dev/null 2>&1 || true
docker compose logs --no-log-prefix create-site | tail -n 20

if [[ $BUILD -eq 0 ]]; then
  # Official image has no maison_pos: mount/copy the repo in and install it.
  if ! docker compose exec -T backend test -d apps/maison_pos; then
    echo ">> Installing maison_pos into the running backend (dev-style; re-run after 'docker compose down -v')"
    docker compose cp "$REPO_ROOT" backend:/home/frappe/frappe-bench/apps/maison_pos
    docker compose exec -T backend bash -c "
      set -e
      cd /home/frappe/frappe-bench
      env/bin/pip install -e apps/maison_pos
      echo maison_pos >> sites/apps.txt
      bench --site $SITE_NAME install-app maison_pos
      bench build --app maison_pos || true
    "
    # workers/scheduler/websocket need the app too; restarting picks up apps.txt + pip install is per-container,
    # so for the official-image path only the backend has the python package. Use --build for a real deployment.
    docker compose restart backend websocket queue-short queue-long scheduler
  fi
fi

echo
echo "==========================================================="
echo " Site:      http://$SITE_NAME:$HTTP_PORT   (add '127.0.0.1 $SITE_NAME' to /etc/hosts)"
echo "            or http://localhost:$HTTP_PORT (Host header is forced to $SITE_NAME by nginx)"
echo " Login:     Administrator / $ADMIN_PASSWORD"
echo " POS:       http://$SITE_NAME:$HTTP_PORT/pos"
echo " DB root:   root / $DB_ROOT_PASSWORD  (container 'db', port 3306, internal only)"
echo " Logs:      docker compose logs -f backend"
echo " Shell:     docker compose exec backend bash"
echo " Stop:      docker compose down        (keeps data)"
echo " Reset:     docker compose down -v     (destroys DB + sites)"
echo "==========================================================="
