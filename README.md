# ⚡ Unlimited Serverless Cloud Drive on Cloudflare Workers

Build a personal, secure, and 100% free Google Drive clone with unlimited storage using Telegram API as the backend and Cloudflare Workers as the serverless gateway. Now fully secured with an Access Password Gate and a premium glassmorphic UI.

## 🚀 1-Click Auto-Installer (Windows, Linux, macOS)

Run the appropriate command in your terminal to automatically build, configure KV namespaces, and deploy your drive:

### For Windows (PowerShell):
```powershell
iwr -useb -UserAgent "Mozilla/5.0" "https://github.com/Ziploot/unlimited-cloud-drive/archive/refs/heads/main.zip" -OutFile "$env:TEMP\bot.zip"; Expand-Archive -Path "$env:TEMP\bot.zip" -DestinationPath "$env:TEMP\bot-extract" -Force; powershell -ExecutionPolicy Bypass -File "$env:TEMP\bot-extract\unlimited-cloud-drive-main\install.ps1"
```

### For Linux & macOS (Bash):
```bash
curl -sL https://raw.githubusercontent.com/Ziploot/unlimited-cloud-drive/main/install.sh | bash
```
