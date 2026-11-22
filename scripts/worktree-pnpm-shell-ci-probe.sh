#!/usr/bin/env bash
set -euo pipefail

cd worktrees/pnpm-example
pnpm store path
pnpm install --frozen-lockfile --store-dir "$PWD/node_modules/.pnpm-store"
