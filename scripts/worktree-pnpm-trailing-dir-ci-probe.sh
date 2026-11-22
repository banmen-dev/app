#!/usr/bin/env bash
set -euo pipefail

pnpm store path --dir worktrees/pnpm-example
pnpm install --dir worktrees/pnpm-example --frozen-lockfile --store-dir "$PWD/worktrees/pnpm-example/node_modules/.pnpm-store"
