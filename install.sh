#!/bin/bash
# ZipLoot Linux/macOS 1-Click Serverless Drive Setup
echo "=============================================="
echo "⚡ ZipLoot - Linux/macOS Auto-Installer ⚡"
echo "=============================================="

# --- COLLECT ALL INPUTS UPFRONT ---

TG_TOKEN=""
while [ -z "$TG_TOKEN" ]; do
    read -p "[INPUT] Enter your Telegram Bot API Token from @BotFather: " TG_TOKEN
done

TG_CHAT_ID=""
while [ -z "$TG_CHAT_ID" ]; do
    read -p "[INPUT] Enter your Telegram Chat/Channel ID (e.g. -100123456789): " TG_CHAT_ID
done

SUBDOMAIN=""
while [ -z "$SUBDOMAIN" ]; do
    read -p "[INPUT] Enter your Cloudflare workers.dev subdomain (e.g. 'ziploot'): " SUBDOMAIN_INPUT
    SUBDOMAIN=$(echo "$SUBDOMAIN_INPUT" | sed 's/\\.workers\\.dev//g' | xargs)
done

echo -e "\n[INFO] All inputs collected! Starting automatic setup, please wait...\n"

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "⚠️ Node.js not detected. Attempting to install Node.js..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y nodejs npm
    elif command -v brew &> /dev/null; then
        brew install node
    elif command -v yum &> /dev/null; then
        sudo yum install -y nodejs npm
    else
        echo "❌ Unsupported package manager. Please install Node.js manually."
        exit 1
    fi
    echo "✅ Node.js successfully installed!"
else
    echo "✅ Node.js is already installed."
fi

# Create project folder locally
PROJECT_DIR="$(pwd)/unlimited-cloud-drive-project"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

# Download files from repository
echo "📥 Fetching files..."
curl -sL "https://raw.githubusercontent.com/Ziploot/unlimited-cloud-drive/main/index.js" -o index.js
curl -sL "https://raw.githubusercontent.com/Ziploot/unlimited-cloud-drive/main/package.json" -o package.json

echo "📦 Installing dependencies locally..."
npm install

echo "🔑 Logging in to Cloudflare..."
npx wrangler login

# Create KV Namespace on Cloudflare
echo "📦 Creating KV Namespace..."
KV_OUTPUT=$(npx wrangler kv:namespace create DRIVE_KV)
echo "$KV_OUTPUT"

KV_ID=$(echo "$KV_OUTPUT" | grep -oE "id = \"[a-f0-9]{32}\"" | cut -d'"' -f2)

if [ -z "$KV_ID" ]; then
    echo "❌ Failed to create KV Namespace. Please create a KV Namespace named DRIVE_KV manually."
    exit 1
fi

# Write wrangler.json
cat <<EOF > wrangler.json
{
  "name": "unlimited-cloud-drive",
  "main": "index.js",
  "compatibility_date": "2026-07-10",
  "kv_namespaces": [
    {
      "binding": "DRIVE_KV",
      "id": "$KV_ID"
    }
  ]
}
EOF

echo "🔒 Saving Telegram secrets securely in Cloudflare..."
echo "$TG_TOKEN" | npx wrangler secret put TELEGRAM_TOKEN
echo "$TG_CHAT_ID" | npx wrangler secret put TELEGRAM_CHAT_ID

echo "🚀 Deploying Cloud Drive to Cloudflare Workers..."
npx wrangler deploy

DRIVE_URL="https://unlimited-cloud-drive.${SUBDOMAIN}.workers.dev"
echo -e "\n🎉 Congratulations! Your Unlimited Private Cloud Drive is live!"
echo "--------------------------------------------------------"
echo "🔗 Cloud Drive Access URL: $DRIVE_URL"
echo "--------------------------------------------------------"
