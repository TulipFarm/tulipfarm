#!/bin/bash
set -e

echo "🚀 TulipFarm Local Development Setup"
echo ""

# --- Datastore: bundled Postgres container ----------------------------------
# Local Postgres runs as the same pgvector/pgvector:pg17 container CI and production use
# (AC-006), exposed on localhost:5432 via docker-compose.dev.yml. There is no native lane:
# the container IS the tested path, so dev and prod cannot drift.

if ! command -v docker &> /dev/null; then
  echo "❌ Docker not found. Install Docker Desktop or Docker Engine, then re-run."
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
echo "🐳 Starting bundled Postgres container (pgvector/pgvector:pg17)..."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres

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
CONTAINER_DATABASE_URL="postgresql://tulipfarm:${POSTGRES_PASSWORD}@localhost:5432/tulipfarm"

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

  # Point the dev app at the bundled container (host port + generated password).
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^DATABASE_URL=.*|DATABASE_URL=$CONTAINER_DATABASE_URL|" .env.local
  else
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$CONTAINER_DATABASE_URL|" .env.local
  fi
  echo "✅ DATABASE_URL pointed at the bundled Postgres container"

  # Expand SOUL_PATH to the absolute soul dir (dotenv does not expand ~).
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^SOUL_PATH=.*|SOUL_PATH=$SOUL_DIR|" .env.local
  else
    sed -i "s|^SOUL_PATH=.*|SOUL_PATH=$SOUL_DIR|" .env.local
  fi

  echo "✅ .env.local created with generated secrets"
else
  echo "✅ .env.local already exists"
  echo "ℹ Ensure DATABASE_URL in .env.local is:"
  echo "    $CONTAINER_DATABASE_URL"
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
echo "  pg_isready -h localhost -p 5432 -U tulipfarm"
echo ""
echo "To stop the bundled Postgres container (keeps data):"
echo "  docker compose -f docker-compose.yml -f docker-compose.dev.yml down"
echo ""
