#!/bin/bash
set -euo pipefail

# Install dependencies for Claude Code on the web so lint, typecheck, and the
# non-database tests work immediately. Local sessions manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# npm install (not ci) so the cached container state is reused between runs.
# The postinstall script runs `prisma generate`, so the Prisma client is ready
# for typecheck and tests without a database connection.
npm install --no-audit --no-fund
