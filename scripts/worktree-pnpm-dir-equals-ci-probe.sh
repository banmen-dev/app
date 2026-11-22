#!/usr/bin/env bash
set -euo pipefail

pnpm --dir=worktrees/pnpm-example store path
pnpm --dir=worktrees/pnpm-example install --frozen-lockfile --store-dir "$PWD/worktrees/pnpm-example/node_modules/.pnpm-store"
