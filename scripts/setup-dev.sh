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

# Initialize soul directory structure
if [ ! -d "soul" ]; then
  echo "📁 Initializing soul directory..."
  mkdir -p soul/{resources,routines,agents,skills,integrations}

  # Create stub files
  cat > soul/llm.config.yaml << 'EOF'
# LLM Configuration
# To be populated via the UI setup wizard
EOF

  cat > soul/soul.yaml << 'EOF'
# TulipFarm Soul Configuration
# Root soul manifest — populated during UI setup
EOF

  cat > soul/skills-lock.json << 'EOF'
{}
EOF

  # Initialize as git repo
  cd soul
  git init
  git config user.email "tulipfarm@local"
  git config user.name "TulipFarm Dev"
  git add .
  git commit -m "Initial soul structure"
  cd ..

  echo "✅ Soul directory initialized at ./soul"
else
  echo "✅ Soul directory already exists"
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

  echo "✅ .env.local created with generated secrets"
else
  echo "✅ .env.local already exists"
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
