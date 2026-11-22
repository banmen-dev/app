#!/usr/bin/env bash
set -euo pipefail

pnpm -C=worktrees/pnpm-other store path
pnpm -C=worktrees/pnpm-example install --frozen-lockfile --store-dir "$PWD/worktrees/pnpm-example/node_modules/.pnpm-store"
