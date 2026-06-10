#!/bin/bash
set -e

echo "🚀 TulipFarm Local Development Setup"
echo ""

# Detect OS and install with appropriate package manager
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

# Create the Postgres database (idempotent)
if command -v createdb &> /dev/null; then
  if createdb tulipfarm 2>/dev/null; then
    echo "✅ Created Postgres database 'tulipfarm'"
  else
    echo "✅ Postgres database 'tulipfarm' already exists"
  fi
else
  echo "⚠ createdb not on PATH — create the 'tulipfarm' database manually"
fi

# Initialize the soul directory — a DEDICATED git repo OUTSIDE the project repo so its own commits
# (resource schemas etc.) never touch the project tree. Lives at ~/.tulipfarm/soul.
SOUL_DIR="$HOME/.tulipfarm/soul"
if [ ! -d "$SOUL_DIR/.git" ]; then
  echo "📁 Initializing soul directory at $SOUL_DIR..."
  mkdir -p "$SOUL_DIR"/{resources,routines,agents,skills,integrations}

  # Create stub files. NOTE: no llm.config.yaml stub — an empty/comment-only one fails LLM-config
  # validation (requires `tiers`). Absent config = LLM features disabled until the UI wizard writes it.
  cat > "$SOUL_DIR/soul.yaml" << 'EOF'
# TulipFarm Soul Configuration
# Root soul manifest — populated during UI setup
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

  # Replace placeholders (cross-platform sed: macOS uses -i '', Linux uses -i)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|<generate: openssl rand -base64 32>|$ENCRYPTION_KEY|" .env.local
    sed -i '' "0,/<generate: openssl rand -base64 32>/{s|<generate: openssl rand -base64 32>|$JWT_SECRET|;}" .env.local
    sed -i '' "0,/<generate: openssl rand -base64 32>/{s|<generate: openssl rand -base64 32>|$WEBHOOK_SECRET|;}" .env.local
  else
    sed -i "s|<generate: openssl rand -base64 32>|$ENCRYPTION_KEY|" .env.local
    sed -i "0,/<generate: openssl rand -base64 32>/{s|<generate: openssl rand -base64 32>|$JWT_SECRET|;}" .env.local
    sed -i "0,/<generate: openssl rand -base64 32>/{s|<generate: openssl rand -base64 32>|$WEBHOOK_SECRET|;}" .env.local
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
  # Pre-existing dev setups may carry an in-repo SOUL_PATH (e.g. ./soul) from before the
  # soul dir moved out of the project tree. The boot-time guard now refuses an in-repo path,
  # so detect and migrate it to the out-of-repo dir rather than letting the app fail to start.
  if grep -qE '^SOUL_PATH=\.?/?soul/?$|^SOUL_PATH=\./' .env.local 2>/dev/null; then
    echo "⚠️  .env.local has an in-repo SOUL_PATH — migrating it to $SOUL_DIR"
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^SOUL_PATH=.*|SOUL_PATH=$SOUL_DIR|" .env.local
    else
      sed -i "s|^SOUL_PATH=.*|SOUL_PATH=$SOUL_DIR|" .env.local
    fi
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
echo "  1. Review and customize .env.local if needed"
echo "  2. Run: pnpm dev"
echo "  3. API will start on http://localhost:3001"
echo "  4. Web UI will start on http://localhost:3000"
echo ""
echo "To verify the datastore is running:"
echo "  psql tulipfarm -c 'select 1'"
echo ""
