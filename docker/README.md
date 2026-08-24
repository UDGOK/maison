# AWANZ POS — Docker deployment

Runs Frappe v15 + ERPNext v15 + `maison_pos` on any host with Docker Engine 24+ and Compose v2.
Layout follows [frappe_docker](https://github.com/frappe/frappe_docker) `pwd.yml`.

| File | Purpose |
|---|---|
| `docker-compose.yml` | Full stack: MariaDB 10.6, 2x Redis, backend (gunicorn), websocket, nginx frontend, 2 workers, scheduler, one-shot `configurator` + `create-site` |
| `setup.sh` | Bring-up script (`./setup.sh` or `./setup.sh --build`) |
| `Containerfile` | Custom image: official `frappe/build:version-15` layer + ERPNext + `maison_pos` copied from this repo |
| `apps.json` | Alternative app list for `frappe_docker`'s stock image build (see Option C) |

## Quick start

```bash
git clone <repo> awanz && cd awanz
chmod +x docker/setup.sh
./docker/setup.sh            # Option A — official image, app installed at runtime (dev/demo)
#   or
./docker/setup.sh --build    # Option B — custom image with maison_pos baked in (production)
```

Then open http://localhost:8080 — login `Administrator` / `admin`. POS at `/pos`.

Add `127.0.0.1 maison.localhost` to `/etc/hosts` if you want the site name in the URL (nginx forces the
`Host` header to `SITE_NAME` anyway, so `localhost:8080` also works).

### Configuration

All via environment variables or `docker/.env`:

| Var | Default | |
|---|---|---|
| `SITE_NAME` | `maison.localhost` | Frappe site name (also nginx Host) |
| `ADMIN_PASSWORD` | `admin` | Administrator password |
| `DB_ROOT_PASSWORD` | `admin` | MariaDB root |
| `HTTP_PORT` | `8080` | Host port mapped to nginx |
| `DEVELOPER_MODE` | `0` | Set `1` to allow DocType edits / fixture export |
| `IMAGE` / `VERSION` | `frappe/erpnext` / `v15` | Image to run (`setup.sh --build` sets `awanz/erpnext:v15`) |

## Option A — official image (`frappe/erpnext:v15`)

`setup.sh` starts the stack, creates the site with ERPNext, then copies the repo into the
`backend` container, `pip install -e`s it and runs `bench install-app maison_pos`.
Only the `backend` container has the Python package; workers and scheduler that import
`maison_pos` code will fail until you switch to Option B. Fine for demos/UI work, not for production.
Data survives `docker compose down`, but `down -v` wipes the DB and you re-run `setup.sh`.

## Option B — custom image (recommended)

```bash
./docker/setup.sh --build
# or manually:
docker build -f docker/Containerfile -t awanz/erpnext:v15 .
IMAGE=awanz/erpnext VERSION=v15 docker compose -f docker/docker-compose.yml up -d
```

The image contains bench + frappe + erpnext + maison_pos with built assets; `create-site` detects
`apps/maison_pos` and installs it along with ERPNext. Every service (workers, scheduler, websocket)
runs the same image. Push it to your registry and set `IMAGE`/`VERSION` on the servers.

Upgrading: rebuild the image, then

```bash
docker compose pull   # or build
docker compose up -d
docker compose exec backend bench --site maison.localhost migrate
```

## Option C — frappe_docker `apps.json` build

If you prefer frappe_docker's own tooling, `apps.json` lists ERPNext + this repo. Replace
`YOUR_ORG` with your git host (use a deploy token in the URL for a private repo) and:

```bash
git clone https://github.com/frappe/frappe_docker && cd frappe_docker
export APPS_JSON_BASE64=$(base64 -w 0 ../maison/docker/apps.json)
docker build --build-arg=FRAPPE_PATH=https://github.com/frappe/frappe \
  --build-arg=FRAPPE_BRANCH=version-15 \
  --build-arg=APPS_JSON_BASE64=$APPS_JSON_BASE64 \
  --tag=awanz/erpnext:v15 --file=images/layered/Containerfile .
```

Then run with `IMAGE=awanz/erpnext VERSION=v15` as in Option B.

## Day-2 operations

```bash
cd docker
docker compose ps                                    # health
docker compose logs -f backend queue-long scheduler  # logs
docker compose exec backend bash                     # bench shell (cd is /home/frappe/frappe-bench)
docker compose exec backend bench --site maison.localhost console
docker compose exec backend bench --site maison.localhost backup --with-files
docker compose exec backend bench --site maison.localhost migrate
docker compose exec backend bench --site maison.localhost set-admin-password newpass
docker compose exec backend bench --site maison.localhost execute frappe.ping
```

Backups land in the `sites` volume under `sites/maison.localhost/private/backups`. Copy them off-host
(e.g. `docker compose cp backend:/home/frappe/frappe-bench/sites/maison.localhost/private/backups ./backups`).

### TLS / public hostname

Put Traefik or Caddy in front of the `frontend` service on port 8080, or follow
frappe_docker's `overrides/compose.https.yaml`. Set `SITE_NAME` to the real hostname before
`create-site` runs (site name is baked into the DB/site folder; renaming later needs `bench --site ... set-config host_name`
or a second site).

### Stripe Terminal / receipt printers

Set Stripe keys per site after creation:

```bash
docker compose exec backend bench --site maison.localhost set-config stripe_secret_key sk_live_xxx
docker compose exec backend bench --site maison.localhost set-config stripe_publishable_key pk_live_xxx
```

Network printers must be reachable from the boutique PWA (browser side), not from the containers.

## Resource sizing

Compose defaults suit a 2 vCPU / 4-8 GB host (HQ + a few boutiques). For 100+ boutiques raise
gunicorn workers (`--workers` in the image CMD / `GUNICORN_CMD_ARGS`), add `queue-*` replicas, and move
MariaDB to a managed instance (set `DB_HOST`/`DB_PORT` on `configurator`, remove the `db` service).
