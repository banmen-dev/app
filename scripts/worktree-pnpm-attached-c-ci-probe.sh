#!/usr/bin/env bash
set -euo pipefail

pnpm -Cworktrees/pnpm-example store path
pnpm -Cworktrees/pnpm-example install --frozen-lockfile --store-dir "$PWD/worktrees/pnpm-example/node_modules/.pnpm-store"
