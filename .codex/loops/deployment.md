# DualLane Deployment Loop

Use this loop for Docker, Nginx, environment, production startup, static serving, reverse proxy, WebSocket upgrade, or TURN/STUN configuration changes.

## Deployment Invariants
- Production exposes the web gateway, not the API container directly.
- `/api` and `/ws` route through the gateway to the private API service.
- WebSocket upgrade headers must be preserved.
- `SERVE_STATIC=false` is used for the API container in Docker Compose.
- `PUBLIC_BASE_URL` should match the final public origin.
- Production WebRTC should run behind HTTPS.
- TURN credentials should prefer short-lived coturn REST credentials or explicit static credentials.

## Procedure
1. Read `README.md`, `.env.example`, `docker-compose.yml`, the relevant Dockerfile, and Nginx config.
2. Identify whether the change affects local dev, production compose, or both.
3. Make the smallest deployment change.
4. Validate:
   - `pnpm build`
   - `docker compose config`
   - build the affected image when available
5. Check that logs and proxy config do not expose query strings, payloads, cookies, or browser-only secrets.
6. For the existing production host, deploy only through
   `deploy/production/deploy.sh --expected-commit <full-sha>`. Do not run a bare
   `docker compose up`, and do not substitute an untracked recovery override.
7. Confirm that `POSTGRES_VOLUME_NAME` matches the volume mounted by the current
   PostgreSQL container. Volume switching is a recovery operation, not a
   routine deployment step.
8. Refresh the V2Ray subscription only as an explicit maintenance operation;
   application deployment must reuse the last-known-good proxy config.

## Done
- Compose remains valid.
- The API remains internal in production compose.
- Static frontend, `/api`, and `/ws` routes are still coherent.
- Any manual deployment step or environment variable change is documented.
- The production script reports the deployed commit, authoritative PostgreSQL
  volume, backup path, and health-check URL.
