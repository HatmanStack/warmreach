#!/bin/bash
# Setup script for WarmReach local development
set -euo pipefail

echo "=== WarmReach — Setup ==="

# Check prerequisites
check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo "ERROR: $1 is required but not installed."
    exit 1
  fi
  echo "  ✓ $1 found"
}

echo ""
echo "Checking prerequisites..."
check_command node
check_command npm
check_command docker
check_command python3
check_command uv

# Every install below uses `npm ci`: it installs exactly what the lockfile pins
# and fails rather than rewriting it, so a local setup cannot drift from CI,
# which uses `npm ci` throughout (.github/workflows/ci.yml).
echo ""
echo "Installing root dependencies..."
npm ci

echo ""
echo "Installing frontend dependencies..."
(cd frontend && npm ci)

echo ""
echo "Installing client dependencies..."
(cd client && npm ci)

# admin/ is a Pro-only workspace: it is in .sync/config.json exclude_paths and
# never reaches the community edition, while this script syncs verbatim. The
# guard is what keeps community setup working.
echo ""
echo "Installing admin dependencies..."
if [ -d admin ]; then
  (cd admin && npm ci)
else
  echo "  skipping admin/ (not present in this edition)"
fi

echo ""
echo "Installing mock-linkedin dependencies..."
(cd mock-linkedin && npm ci)

echo ""
echo "Setting up Python test environment..."
if [ ! -d "tests/backend/.venv" ]; then
  python3 -m venv tests/backend/.venv
fi
(cd tests/backend && . .venv/bin/activate && uv pip install -r requirements-test.lock -q)

echo ""
echo "Setting up environment file..."
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "  Copied .env.example → .env (edit with your values)"
  else
    echo "  No .env.example found, skipping"
  fi
else
  echo "  .env already exists, skipping"
fi

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Quick start:"
echo "  docker compose up        # Start all services with MiniStack"
echo "  npm run dev              # Start frontend only"
echo "  npm run dev:client       # Start client backend only"
echo "  npm run check            # Run all lint + typecheck + tests"
