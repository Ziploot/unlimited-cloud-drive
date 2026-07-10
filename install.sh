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

DRIVE_PASSWORD=""
while [ -z "$DRIVE_PASSWORD" ]; do
    read -p "[INPUT] Create an Access Password to secure your drive portal: " DRIVE_PASSWORD
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

# Create KV Namespace on Cloudflare (redirect stderr to stdout)
echo "📦 Creating KV Namespace..."
KV_OUTPUT=$(npx wrangler kv:namespace create DRIVE_KV 2>&1)
echo "$KV_OUTPUT"

KV_ID=$(echo "$KV_OUTPUT" | grep -oE '"id": "[a-f0-9]{32}"|id = "[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}')

if [ -z "$KV_ID" ]; then
    if [[ "$KV_OUTPUT" == *"already exists"* ]] || [[ "$KV_OUTPUT" == *"10014"* ]]; then
        echo "ℹ️ Namespace already exists. Fetching existing namespace ID..."
        KV_LIST=$(npx wrangler kv:namespace list 2>&1)
        # Try to parse KV_LIST with node
        KV_ID=$(echo "$KV_LIST" | node -e '
            try {
                const fs = require("fs");
                const data = JSON.parse(fs.readFileSync(0, "utf-8"));
                const ns = data.find(x => x.title.includes("DRIVE_KV"));
                if (ns) console.log(ns.id);
            } catch(e) {}
        ' 2>/dev/null)
        
        # Fallback regex search on list output
        if [ -z "$KV_ID" ]; then
            KV_ID=$(echo "$KV_LIST" | grep -B 1 "DRIVE_KV" | grep -oE '[a-f0-9]{32}' | head -n 1)
        fi
    fi
fi

if [ -z "$KV_ID" ]; then
    echo "❌ Failed to create or parse KV Namespace. Please create a KV Namespace named DRIVE_KV manually."
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
echo "$DRIVE_PASSWORD" | npx wrangler secret put DRIVE_PASSWORD

echo "🚀 Deploying Cloud Drive to Cloudflare Workers..."
npx wrangler deploy

DRIVE_URL="https://unlimited-cloud-drive.${SUBDOMAIN}.workers.dev"
echo -e "\n🎉 Congratulations! Your Unlimited Private Cloud Drive is live!"
echo "--------------------------------------------------------"
echo "🔗 Cloud Drive Access URL: $DRIVE_URL"
echo "--------------------------------------------------------"
