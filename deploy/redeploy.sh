#!/usr/bin/env bash
# Redeploy: pull, install, build, migrate, restart.
set -euo pipefail
cd /opt/endowment-aquarium-api

git pull --ff-only
npm ci
npm run build
npm run db:migrate

sudo systemctl restart endowment-aquarium-api endowment-aquarium-mock

sleep 2
curl -fsS http://127.0.0.1:3100/api/v1/health && echo
