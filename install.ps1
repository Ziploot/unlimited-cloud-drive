# ZipLoot Windows 1-Click Serverless Drive Setup
try {
    Write-Host "==============================================" -ForegroundColor Green
    Write-Host "[ZipLoot] Cloud Drive Installer" -ForegroundColor Green
    Write-Host "==============================================" -ForegroundColor Green

    $ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

    # --- COLLECT ALL INPUTS UPFRONT ---
    
    $tgToken = ""
    while ([string]::IsNullOrWhiteSpace($tgToken)) {
        $tgToken = Read-Host "[INPUT] Enter your Telegram Bot API Token from @BotFather"
    }

    $tgChatId = ""
    while ([string]::IsNullOrWhiteSpace($tgChatId)) {
        $tgChatId = Read-Host "[INPUT] Enter your Telegram Chat/Channel ID (e.g. -100123456789)"
    }

    $drivePassword = ""
    while ([string]::IsNullOrWhiteSpace($drivePassword)) {
        $drivePassword = Read-Host "[INPUT] Create an Access Password to secure your drive portal"
    }

    $subdomain = ""
    while ([string]::IsNullOrWhiteSpace($subdomain)) {
        $subdomainInput = Read-Host "[INPUT] Enter your Cloudflare workers.dev subdomain (e.g. 'ziploot')"
        if (-not [string]::IsNullOrWhiteSpace($subdomainInput)) {
            $subdomain = $subdomainInput.Replace(".workers.dev", "").Trim()
        }
    }

    Write-Host "`n[INFO] All inputs collected! Starting automatic setup, please wait...`n" -ForegroundColor Green

    # 1. Check Node.js
    $nodeInstalled = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeInstalled) {
        Write-Host "[WARN] Node.js not detected. Installing Node.js silently via winget..." -ForegroundColor Yellow
        winget install OpenJS.NodeJS --silent --accept-package-agreements --accept-source-agreements
        
        # Update PATH env in current session so npx works immediately
        $env:Path += ";$env:ProgramFiles\\nodejs"
        
        # Verify installation
        $nodeVerify = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeVerify) {
            Write-Host "[ERROR] Silent Node.js installation failed. Please install Node.js manually." -ForegroundColor Red
            Read-Host "Press Enter to exit..."
            Exit
        }
        Write-Host "[SUCCESS] Node.js successfully installed!" -ForegroundColor Green
    } else {
        Write-Host "[SUCCESS] Node.js is already installed." -ForegroundColor Green
    }

    # Create project folder locally in the user's CURRENT directory
    $projectFolder = Join-Path $pwd "unlimited-cloud-drive-project"
    if (Test-Path $projectFolder) {
        Write-Host "[WARN] Folder 'unlimited-cloud-drive-project' already exists." -ForegroundColor Yellow
    } else {
        New-Item -ItemType Directory -Path $projectFolder -ErrorAction SilentlyContinue | Out-Null
    }

    # Copy template files
    Copy-Item -Path "$scriptDir\\index.js" -Destination "$projectFolder\\index.js" -Force
    Copy-Item -Path "$scriptDir\\package.json" -Destination "$projectFolder\\package.json" -Force

    Set-Location $projectFolder

    Write-Host "[INSTALL] Installing dependencies locally..." -ForegroundColor Cyan
    cmd.exe /c "npm install"

    Write-Host "[LOGIN] Logging in to Cloudflare..." -ForegroundColor Cyan
    cmd.exe /c "npx wrangler login"

    # Create KV Namespace on Cloudflare (redirect stderr to stdout to catch error details)
    Write-Host "[KV] Creating Cloudflare KV Namespace..." -ForegroundColor Cyan
    $kvOutput = cmd.exe /c "npx wrangler kv:namespace create DRIVE_KV 2>&1"
    Write-Host $kvOutput

    # Parse KV Namespace ID
    $kvIdMatch = [regex]::Match($kvOutput, '"?id"?\s*[:=]\s*"([a-f0-9]{32})"')
    $kvId = ""
    if ($kvIdMatch.Success) {
        $kvId = $kvIdMatch.Groups[1].Value
    } else {
        # Check if already exists (error code 10014 or text match)
        if ($kvOutput -match "already exists" -or $kvOutput -match "10014") {
            Write-Host "[KV] Namespace already exists. Fetching existing namespace ID..." -ForegroundColor Cyan
            $kvListOutput = cmd.exe /c "npx wrangler kv:namespace list 2>&1"
            # Parse list JSON
            try {
                $namespaces = ConvertFrom-Json $kvListOutput
                foreach ($ns in $namespaces) {
                    if ($ns.title -match "DRIVE_KV") {
                        $kvId = $ns.id
                        break
                    }
                }
            } catch {
                # Fallback to regex match on list output
                $nsMatch = [regex]::Match($kvListOutput, '"id"\s*:\s*"([a-f0-9]{32})"[^}]+DRIVE_KV')
                if ($nsMatch.Success) {
                    $kvId = $nsMatch.Groups[1].Value
                }
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($kvId)) {
        Write-Host "[ERROR] Failed to auto-create or parse KV Namespace. Please create a KV Namespace named DRIVE_KV manually." -ForegroundColor Red
        Read-Host "Press Enter to exit..."
        Exit
    }

    # Write customized wrangler.json with KV Namespace ID
    $wranglerJsonContent = @"
{
  "name": "unlimited-cloud-drive",
  "main": "index.js",
  "compatibility_date": "2026-07-10",
  "kv_namespaces": [
    {
      "binding": "DRIVE_KV",
      "id": "$kvId"
    }
  ]
}
"@
    $wranglerJsonContent | Out-File -FilePath "$projectFolder\\wrangler.json" -Encoding utf8 -Force

    Write-Host "[SECURE] Saving Telegram secrets securely in Cloudflare..." -ForegroundColor Cyan
    cmd.exe /c "echo $tgToken | npx wrangler secret put TELEGRAM_TOKEN"
    cmd.exe /c "echo $tgChatId | npx wrangler secret put TELEGRAM_CHAT_ID"
    cmd.exe /c "echo $drivePassword | npx wrangler secret put DRIVE_PASSWORD"

    Write-Host "[DEPLOY] Deploying Cloud Drive to Cloudflare Workers..." -ForegroundColor Cyan
    cmd.exe /c "npx wrangler deploy"

    $driveUrl = "https://unlimited-cloud-drive.$subdomain.workers.dev"
    Write-Host "`n[SUCCESS] Congratulations! Your Unlimited Private Cloud Drive is live!" -ForegroundColor Green
    Write-Host "--------------------------------------------------------" -ForegroundColor Green
    Write-Host "[LINK] Cloud Drive Access URL: $driveUrl" -ForegroundColor Cyan
    Write-Host "--------------------------------------------------------" -ForegroundColor Green
    Write-Host "`n[FOLDER] Local Project Folder created at: $projectFolder" -ForegroundColor Yellow
    Read-Host "`nSetup completed. Press Enter to exit..."
} catch {
    Write-Host "[ERROR] An unexpected error occurred: $_" -ForegroundColor Red
    Read-Host "Press Enter to exit..."
}
