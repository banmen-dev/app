#!/usr/bin/env bash
set -euo pipefail

pnpm store path -C worktrees/pnpm-other
pnpm install -C worktrees/pnpm-example --frozen-lockfile --store-dir "$PWD/worktrees/pnpm-example/node_modules/.pnpm-store"
