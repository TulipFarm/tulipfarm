#!/bin/bash
set -e

echo "🚀 TulipFarm Local Development Setup"
echo ""

# --- Choose datastore mode -------------------------------------------------
# Two ways to run the local Postgres (both satisfy AC-006):
#   docker : bundled pgvector/pgvector:pg17 container (same image CI/prod use) — no
#            system install, exposed on localhost:5432 via docker-compose.dev.yml.
#   native : install PostgreSQL 17 + pgvector via Homebrew/apt/yum on the host.
# Honour a preset DB_MODE for non-interactive runs (CI, re-runs); otherwise prompt.
DB_MODE="${DB_MODE:-}"
if [ -z "$DB_MODE" ]; then
  if [ -t 0 ]; then
    echo "How do you want to run PostgreSQL for local development?"
    echo "  1) Docker  — bundled pgvector container, no system install (recommended)"
    echo "  2) Native  — install PostgreSQL 17 + pgvector on this machine"
    read -r -p "Select [1/2] (default 1): " choice
    case "$choice" in
      2 | native | n | N) DB_MODE="native" ;;
      *) DB_MODE="docker" ;;
    esac
  else
    DB_MODE="docker"
    echo "ℹ Non-interactive shell — defaulting to Docker. Set DB_MODE=native to override."
  fi
fi
echo "▶ Datastore mode: $DB_MODE"
echo ""

# Set by whichever branch runs; consumed when writing .env.local below.
# Native keeps the template's peer-auth URL; Docker wires in the generated password.
DATABASE_URL_OVERRIDE=""

if [ "$DB_MODE" = "docker" ]; then
  # --- Docker: bundled Postgres container ----------------------------------
  if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Install Docker Desktop / Engine, or re-run with DB_MODE=native."
    exit 1
  fi
  if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose v2 plugin required ('docker compose')."
    exit 1
  fi
  if ! docker info &> /dev/null; then
    echo "❌ Docker daemon not running. Start Docker and re-run."
    exit 1
  fi

  # The bundled postgres reads POSTGRES_PASSWORD from .env (compose interpolation).
  # Reuse an existing value so it matches the persisted data volume; else generate
  # an alphanumeric one (no URL-special chars, so DATABASE_URL needs no escaping).
  touch .env
  if grep -q '^POSTGRES_PASSWORD=' .env; then
    POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-)"
    echo "✅ Reusing POSTGRES_PASSWORD from .env"
  else
    POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)"
    echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" >> .env
    echo "✅ Generated POSTGRES_PASSWORD and wrote it to .env"
  fi
  grep -q '^COMPOSE_PROFILES=' .env || echo "COMPOSE_PROFILES=bundled" >> .env

  echo "🐳 Starting bundled Postgres container (pgvector/pgvector:pg17)..."
  docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile bundled up -d postgres

  echo "⏳ Waiting for Postgres to be ready..."
  for _ in $(seq 1 30); do
    if docker compose -f docker-compose.yml -f docker-compose.dev.yml \
      exec -T postgres pg_isready -U tulipfarm -d tulipfarm &> /dev/null; then
      echo "✅ Postgres is ready on localhost:5432"
      break
    fi
    sleep 2
  done

  # POSTGRES_PASSWORD only takes effect on a container's FIRST init of an empty data volume — an
  # existing volume initialized under a different password (e.g. .env hand-edited, or the volume
  # outlived a password rotation) silently drifts out of sync, and the app fails at boot with
  # "password authentication failed" instead of at setup time. Verify the reused/generated
  # password actually authenticates over TCP (what the app uses) and self-heal via the container's
  # local socket (trust auth, no password needed) if not.
  if ! docker compose -f docker-compose.yml -f docker-compose.dev.yml \
    exec -T postgres env PGPASSWORD="$POSTGRES_PASSWORD" \
    psql -h 127.0.0.1 -U tulipfarm -d tulipfarm -c "select 1" &> /dev/null; then
    echo "⚠ POSTGRES_PASSWORD in .env doesn't match the running container's role — syncing..."
    if docker compose -f docker-compose.yml -f docker-compose.dev.yml \
      exec -T postgres psql -U tulipfarm -d tulipfarm \
      -c "ALTER USER tulipfarm WITH PASSWORD '${POSTGRES_PASSWORD}';" &> /dev/null; then
      echo "✅ Synced Postgres role password to match .env"
    else
      echo "❌ Could not sync role password — check \`docker compose logs postgres\`"
    fi
  fi

  # The container auto-creates the tulipfarm DB + user (POSTGRES_DB/POSTGRES_USER),
  # so no createdb step. Wire the dev app at the host-exposed port with the password.
  DATABASE_URL_OVERRIDE="postgresql://tulipfarm:${POSTGRES_PASSWORD}@localhost:5432/tulipfarm"

else
  # --- Native: install Postgres on the host --------------------------------
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS with Homebrew
    if ! command -v brew &> /dev/null; then
      echo "❌ Homebrew not found. Install from https://brew.sh"
      exit 1
    fi

    if ! brew ls postgresql@17 &> /dev/null; then
      echo "📦 Installing postgresql@17..."
      brew install postgresql@17
    else
      echo "✅ postgresql@17 already installed"
    fi

    if ! brew ls pgvector &> /dev/null; then
      echo "📦 Installing pgvector..."
      brew install pgvector
    else
      echo "✅ pgvector already installed"
    fi

    echo "🔄 Starting PostgreSQL service..."
    brew services start postgresql@17 || true
    # postgresql@17 is keg-only; expose its client tools (createdb/psql) for this script
    export PATH="$(brew --prefix postgresql@17)/bin:$PATH"

  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux with apt or yum
    if command -v apt-get &> /dev/null; then
      echo "📦 Using apt to install dependencies..."
      sudo apt-get update

      if ! command -v psql &> /dev/null; then
        echo "📦 Installing PostgreSQL + pgvector..."
        sudo apt-get install -y postgresql postgresql-contrib
        sudo apt-get install -y postgresql-17-pgvector \
          || sudo apt-get install -y postgresql-16-pgvector \
          || echo "⚠ Install pgvector manually for your Postgres version"
      else
        echo "✅ PostgreSQL already installed"
      fi

      echo "🔄 Starting PostgreSQL service..."
      sudo systemctl start postgresql || true

    elif command -v yum &> /dev/null; then
      echo "📦 Using yum to install dependencies..."

      if ! command -v psql &> /dev/null; then
        echo "📦 Installing PostgreSQL + pgvector..."
        sudo yum install -y postgresql-server postgresql-contrib
        sudo yum install -y pgvector || echo "⚠ Install pgvector manually for your Postgres version"
      else
        echo "✅ PostgreSQL already installed"
      fi

      echo "🔄 Starting PostgreSQL service..."
      sudo systemctl start postgresql || true

    else
      echo "❌ No supported package manager found (apt or yum required)"
      exit 1
    fi

  else
    echo "❌ Unsupported OS: $OSTYPE"
    exit 1
  fi

  # Give services a moment to start
  sleep 2

  # On Linux, apt-installed Postgres uses peer auth via Unix socket for the postgres superuser.
  # The current OS user has no Postgres role yet, so we must create one via sudo -u postgres.
  # We switch DATABASE_URL to a Unix socket URL with ?host=<socket-dir> because node-postgres
  # treats an empty host as TCP localhost — the explicit socket path triggers peer auth.
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if sudo -u postgres createuser --superuser "$USER" 2>/dev/null; then
      echo "✅ Created Postgres role '$USER'"
    else
      echo "✅ Postgres role '$USER' already exists"
    fi
    if createdb tulipfarm 2>/dev/null; then
      echo "✅ Created Postgres database 'tulipfarm'"
    else
      echo "✅ Postgres database 'tulipfarm' already exists"
    fi
    # node-postgres ignores an empty host and falls back to TCP; we must pass the socket
    # directory explicitly via ?host= so peer auth is used (no password required).
    PG_SOCKET_DIR="$(psql -Atqc "SHOW unix_socket_directories" 2>/dev/null | tr ',' '\n' | head -1 | tr -d ' ')"
    PG_SOCKET_DIR="${PG_SOCKET_DIR:-/var/run/postgresql}"
    DATABASE_URL_OVERRIDE="postgres:///tulipfarm?host=${PG_SOCKET_DIR}"
  else
    # macOS Homebrew: initdb creates a superuser role for the OS user automatically
    if command -v createdb &> /dev/null; then
      if createdb tulipfarm 2>/dev/null; then
        echo "✅ Created Postgres database 'tulipfarm'"
      else
        echo "✅ Postgres database 'tulipfarm' already exists"
      fi

      # An existing .env.local may carry a password-auth DATABASE_URL (e.g. left over from a
      # prior Docker-mode setup, or hand-edited) instead of the template's peer-auth default.
      # Native Postgres has no such role by default — ensure it exists so the app can connect.
      if [ -f ".env.local" ]; then
        EXISTING_DB_URL="$(grep -E '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
        if [[ "$EXISTING_DB_URL" =~ ^postgres(ql)?://([^:@/]+):([^@/]+)@ ]]; then
          DB_ROLE="${BASH_REMATCH[2]}"
          DB_ROLE_PASSWORD="${BASH_REMATCH[3]}"
          if psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname='$DB_ROLE'" postgres 2>/dev/null | grep -q 1; then
            echo "✅ Postgres role '$DB_ROLE' already exists"
          else
            psql -c "CREATE ROLE \"$DB_ROLE\" WITH LOGIN PASSWORD '$DB_ROLE_PASSWORD';" postgres \
              && echo "✅ Created Postgres role '$DB_ROLE'"
          fi
          # Docker mode's tulipfarm role is superuser (POSTGRES_USER on the official postgres
          # image), which owns the DB, the public schema, and can CREATE EXTENSION (vector,
          # citext, pg_trgm — none are "trusted" extensions installable by a plain role).
          # Match that here instead of granting each privilege piecemeal.
          psql -c "ALTER ROLE \"$DB_ROLE\" WITH SUPERUSER;" postgres &> /dev/null
        fi
      fi
    else
      echo "⚠ createdb not on PATH — create the 'tulipfarm' database manually"
    fi
  fi
fi

# Initialize the soul directory — a DEDICATED git repo OUTSIDE the project repo so its own commits
# (resource schemas etc.) never touch the project tree. Lives at ~/.tulipfarm/soul.
SOUL_DIR="$HOME/.tulipfarm/soul"
if [ ! -d "$SOUL_DIR/.git" ]; then
  echo "📁 Initializing soul directory at $SOUL_DIR..."
  mkdir -p "$SOUL_DIR"/{resources,routines,agents,skills,integrations}

  # Create stub files. NOTE: no `llm:` key in soul.yaml — an empty/comment-only one fails LLM-config
  # validation (requires `tiers`). Absent config = LLM features disabled until the UI wizard writes it.
  # soul.yaml is intentionally minimal — setupComplete is set by the setup wizard, not here.
  cat > "$SOUL_DIR/soul.yaml" << 'EOF'
# TulipFarm Soul Configuration
EOF

  cat > "$SOUL_DIR/skills-lock.json" << 'EOF'
{}
EOF

  # Initialize as its own git repo
  git -C "$SOUL_DIR" init
  git -C "$SOUL_DIR" config user.email "tulipfarm@local"
  git -C "$SOUL_DIR" config user.name "TulipFarm Dev"
  git -C "$SOUL_DIR" add .
  git -C "$SOUL_DIR" commit -m "Initial soul structure"

  echo "✅ Soul directory initialized at $SOUL_DIR"
else
  echo "✅ Soul directory already exists at $SOUL_DIR"
fi

# Copy .env.local.example to .env.local if not present
if [ ! -f ".env.local" ]; then
  echo "📋 Creating .env.local from template..."
  cp .env.local.example .env.local

  # Generate secrets
  ENCRYPTION_KEY=$(openssl rand -base64 32)
  JWT_SECRET=$(openssl rand -base64 32)
  WEBHOOK_SECRET=$(openssl rand -base64 32)

  # Replace placeholders by matching each full KEY=<placeholder> line so every substitution
  # is unique and order-independent (a bare s/// on the shared placeholder would overwrite
  # all three lines with the first secret, and the 0,/pattern/ range trick is not supported
  # by BSD sed on macOS). cross-platform sed: macOS uses -i '', Linux uses -i.
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|ENCRYPTION_KEY=<generate: openssl rand -base64 32>|ENCRYPTION_KEY=$ENCRYPTION_KEY|" .env.local
    sed -i '' "s|JWT_SECRET=<generate: openssl rand -base64 32>|JWT_SECRET=$JWT_SECRET|" .env.local
    sed -i '' "s|WEBHOOK_SIGNING_SECRET=<generate: openssl rand -base64 32>|WEBHOOK_SIGNING_SECRET=$WEBHOOK_SECRET|" .env.local
  else
    sed -i "s|ENCRYPTION_KEY=<generate: openssl rand -base64 32>|ENCRYPTION_KEY=$ENCRYPTION_KEY|" .env.local
    sed -i "s|JWT_SECRET=<generate: openssl rand -base64 32>|JWT_SECRET=$JWT_SECRET|" .env.local
    sed -i "s|WEBHOOK_SIGNING_SECRET=<generate: openssl rand -base64 32>|WEBHOOK_SIGNING_SECRET=$WEBHOOK_SECRET|" .env.local
  fi

  # Docker mode: point the dev app at the bundled container (host port + password).
  # Native mode keeps the template's local peer-auth URL.
  if [ -n "$DATABASE_URL_OVERRIDE" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL_OVERRIDE|" .env.local
    else
      sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL_OVERRIDE|" .env.local
    fi
    echo "✅ DATABASE_URL pointed at the bundled Postgres container"
  fi

  # Expand SOUL_PATH to the absolute soul dir (dotenv does not expand ~).
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^SOUL_PATH=.*|SOUL_PATH=$SOUL_DIR|" .env.local
  else
    sed -i "s|^SOUL_PATH=.*|SOUL_PATH=$SOUL_DIR|" .env.local
  fi

  echo "✅ .env.local created with generated secrets"
else
  echo "✅ .env.local already exists"
  if [ -n "$DATABASE_URL_OVERRIDE" ]; then
    echo "ℹ Docker mode: ensure DATABASE_URL in .env.local is:"
    echo "    $DATABASE_URL_OVERRIDE"
  fi
fi

# Symlink .env.local to apps/api for turbo dev (turbo runs from package dir)
if [ ! -L "apps/api/.env.local" ]; then
  echo "🔗 Symlinking .env.local to apps/api..."
  ln -s ../../.env.local apps/api/.env.local
else
  echo "✅ .env.local symlink already exists in apps/api"
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Run: pnpm dev"
echo "  2. Open: http://localhost:4000"
echo "  3. Complete the setup wizard in the browser (creates your admin account)"
echo ""
echo "To verify the datastore is running:"
if [ "$DB_MODE" = "docker" ]; then
  echo "  pg_isready -h localhost -p 5432 -U tulipfarm"
  echo ""
  echo "To stop the bundled Postgres container (keeps data):"
  echo "  docker compose -f docker-compose.yml -f docker-compose.dev.yml down"
else
  echo "  psql tulipfarm -c 'select 1'"
fi
echo ""
