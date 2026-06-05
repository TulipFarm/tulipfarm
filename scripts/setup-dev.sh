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

  if ! brew ls mongodb-community@8.0 &> /dev/null; then
    echo "📦 Installing mongodb-community@8.0..."
    brew tap mongodb/brew
    brew install mongodb-community@8.0
  else
    echo "✅ mongodb-community@8.0 already installed"
  fi

  if ! brew ls redis &> /dev/null; then
    echo "📦 Installing redis..."
    brew install redis
  else
    echo "✅ redis already installed"
  fi

  echo "🔄 Starting MongoDB service..."
  brew services start mongodb-community@8.0 || true
  echo "🔄 Starting Redis service..."
  brew services start redis || true

elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  # Linux with apt or yum
  if command -v apt-get &> /dev/null; then
    echo "📦 Using apt to install dependencies..."
    sudo apt-get update

    if ! command -v mongosh &> /dev/null; then
      echo "📦 Installing MongoDB..."
      sudo apt-get install -y mongodb
    else
      echo "✅ MongoDB already installed"
    fi

    if ! command -v redis-cli &> /dev/null; then
      echo "📦 Installing Redis..."
      sudo apt-get install -y redis-server
    else
      echo "✅ Redis already installed"
    fi

    echo "🔄 Starting MongoDB service..."
    sudo systemctl start mongodb || true
    echo "🔄 Starting Redis service..."
    sudo systemctl start redis-server || true

  elif command -v yum &> /dev/null; then
    echo "📦 Using yum to install dependencies..."

    if ! command -v mongosh &> /dev/null; then
      echo "📦 Installing MongoDB..."
      sudo yum install -y mongodb-org
    else
      echo "✅ MongoDB already installed"
    fi

    if ! command -v redis-cli &> /dev/null; then
      echo "📦 Installing Redis..."
      sudo yum install -y redis
    else
      echo "✅ Redis already installed"
    fi

    echo "🔄 Starting MongoDB service..."
    sudo systemctl start mongod || true
    echo "🔄 Starting Redis service..."
    sudo systemctl start redis || true

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
echo "To verify MongoDB and Redis are running:"
echo "  mongosh --eval 'db.version()'"
echo "  redis-cli ping"
echo ""
