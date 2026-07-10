export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Helper to check authentication cookie
    const checkAuth = (req) => {
      const cookieHeader = req.headers.get("Cookie") || "";
      const cookies = Object.fromEntries(cookieHeader.split(";").map(c => {
        const parts = c.trim().split("=");
        return [parts[0], parts.slice(1).join("=")];
      }));
      return cookies.drive_token === env.DRIVE_PASSWORD;
    };

    // Handle Login API
    if (url.pathname === "/login" && request.method === "POST") {
      try {
        const body = await request.json();
        if (body.password === env.DRIVE_PASSWORD) {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `drive_token=${body.password}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
        return new Response(JSON.stringify({ error: "Invalid password" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.toString() }), { status: 400 });
      }
    }

    // Handle Logout API
    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": "drive_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
        }
      });
    }

    // Authentication Gate
    const authenticated = checkAuth(request);
    if (!authenticated) {
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(getHtmlLogin(), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Serve HTML Dashboard (only when authenticated)
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(getHtmlDashboard(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // API: List Files
    if (url.pathname === "/api/files" && request.method === "GET") {
      const keysList = await env.DRIVE_KV.list({ prefix: "file_" });
      const files = [];
      for (const key of keysList.keys) {
        const value = await env.DRIVE_KV.get(key.name);
        if (value) {
          files.push(JSON.parse(value));
        }
      }
      return new Response(JSON.stringify(files), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // API: List Folders
    if (url.pathname === "/api/folders" && request.method === "GET") {
      const keysList = await env.DRIVE_KV.list({ prefix: "folder_" });
      const folders = [];
      for (const key of keysList.keys) {
        const value = await env.DRIVE_KV.get(key.name);
        if (value) {
          folders.push(JSON.parse(value));
        }
      }
      return new Response(JSON.stringify(folders), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // API: Create Folder
    if (url.pathname === "/api/folders" && request.method === "POST") {
      try {
        const body = await request.json();
        const folderKey = `folder_${crypto.randomUUID()}`;
        const folderData = {
          key: folderKey,
          name: body.name,
          date: new Date().toISOString()
        };
        await env.DRIVE_KV.put(folderKey, JSON.stringify(folderData));
        return new Response(JSON.stringify({ success: true, key: folderKey }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.toString() }), { status: 500 });
      }
    }

    // API: Delete Folder (Soft delete grouping, keep files in Root)
    if (url.pathname.startsWith("/api/delete-folder/") && request.method === "DELETE") {
      const folderKey = url.pathname.split("/").pop();
      await env.DRIVE_KV.delete(folderKey);
      
      const keysList = await env.DRIVE_KV.list({ prefix: "file_" });
      for (const key of keysList.keys) {
        const value = await env.DRIVE_KV.get(key.name);
        if (value) {
          const fileData = JSON.parse(value);
          if (fileData.folderId === folderKey) {
            fileData.folderId = null;
            await env.DRIVE_KV.put(key.name, JSON.stringify(fileData));
          }
        }
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // API: Upload Chunk to Telegram
    if (url.pathname === "/api/upload-chunk" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const fileChunk = formData.get("chunk");
        const chunkIndex = formData.get("index");
        
        // Post chunk to Telegram Document API
        const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`;
        const tgForm = new FormData();
        tgForm.append("chat_id", env.TELEGRAM_CHAT_ID);
        tgForm.append("document", fileChunk, `chunk_${chunkIndex}`);

        const tgRes = await fetch(tgUrl, {
          method: "POST",
          body: tgForm
        });
        const tgData = await tgRes.json();

        if (!tgData.ok) {
          return new Response(JSON.stringify({ error: tgData.description }), { status: 500 });
        }

        const fileId = tgData.result.document.file_id;
        return new Response(JSON.stringify({ fileId }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.toString() }), { status: 500 });
      }
    }

    // API: Finalize Upload (Save metadata to KV)
    if (url.pathname === "/api/finalize" && request.method === "POST") {
      try {
        const metadata = await request.json();
        const fileKey = `file_${crypto.randomUUID()}`;
        
        const fileData = {
          key: fileKey,
          name: metadata.name,
          size: metadata.size,
          type: metadata.type,
          chunks: metadata.chunks, // Array of Telegram fileIds
          date: new Date().toISOString(),
          folderId: metadata.folderId || null
        };

        await env.DRIVE_KV.put(fileKey, JSON.stringify(fileData));

        return new Response(JSON.stringify({ success: true, key: fileKey }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.toString() }), { status: 500 });
      }
    }

    // API: Download/Stream File
    if (url.pathname.startsWith("/api/download/") && request.method === "GET") {
      const fileKey = url.pathname.split("/").pop();
      const fileDataStr = await env.DRIVE_KV.get(fileKey);
      if (!fileDataStr) {
        return new Response("File not found", { status: 404 });
      }
      const fileData = JSON.parse(fileDataStr);

      // Stream Chunks sequentially
      const { readable, writable } = new TransformStream();
      streamFileChunks(fileData.chunks, env.TELEGRAM_TOKEN, writable);

      return new Response(readable, {
        headers: {
          "Content-Disposition": `attachment; filename="${fileData.name}"`,
          "Content-Type": fileData.type || "application/octet-stream",
          "Content-Length": fileData.size,
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // API: Delete File
    if (url.pathname.startsWith("/api/delete/") && request.method === "DELETE") {
      const fileKey = url.pathname.split("/").pop();
      await env.DRIVE_KV.delete(fileKey);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

// Sequential Chunk Streaming Helper
async function streamFileChunks(chunks, botToken, writable) {
  const writer = writable.getWriter();
  try {
    for (const fileId of chunks) {
      // 1. Get file path from Telegram API
      const pathRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
      const pathData = await pathRes.json();
      if (!pathData.ok) throw new Error(pathData.description);
      const filePath = pathData.result.file_path;

      // 2. Fetch binary stream
      const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
      const reader = fileRes.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    writer.close();
  }
}

// Embedded HTML Login Portal
function getHtmlLogin() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZipLoot Cloud - Secure Login</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Syne:wght@800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(255, 255, 255, 0.03);
      --border: rgba(255, 255, 255, 0.06);
      --primary: #818cf8;
      --text: #cbd5e1;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
      overflow: hidden;
    }
    body::before {
      content: "";
      position: absolute;
      width: 400px;
      height: 400px;
      background: radial-gradient(circle, rgba(129, 140, 248, 0.15) 0%, rgba(0,0,0,0) 70%);
      top: -100px;
      left: -100px;
      z-index: 1;
    }
    body::after {
      content: "";
      position: absolute;
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(16, 185, 129, 0.1) 0%, rgba(0,0,0,0) 70%);
      bottom: -150px;
      right: -150px;
      z-index: 1;
    }
    .login-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
      backdrop-filter: blur(20px);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
      text-align: center;
      z-index: 10;
      position: relative;
    }
    .logo {
      font-family: 'Syne', sans-serif;
      font-size: 26px;
      font-weight: 800;
      background: linear-gradient(135deg, #818cf8 0%, #10b981 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 30px;
      letter-spacing: -0.5px;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 10px;
    }
    p {
      font-size: 13px;
      color: #64748b;
      margin-bottom: 25px;
    }
    .input-group {
      text-align: left;
      margin-bottom: 20px;
    }
    input {
      width: 100%;
      padding: 14px 18px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: #fff;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      transition: all 0.2s ease;
      outline: none;
    }
    input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 10px rgba(129, 140, 248, 0.2);
      background: rgba(255, 255, 255, 0.04);
    }
    .btn {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #818cf8 0%, #6366f1 100%);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 18px rgba(99, 102, 241, 0.4);
    }
    .error-msg {
      color: #ef4444;
      font-size: 13px;
      margin-top: 15px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo">⚡ ZIPLOOT CLOUD</div>
    <h2>Private Cloud Storage</h2>
    <p>Please enter the access password to view files</p>
    
    <div class="input-group">
      <input type="password" id="password" placeholder="Access Password" required />
    </div>
    
    <button class="btn" id="loginBtn">Authorize Session</button>
    <div class="error-msg" id="errorMsg">Incorrect password. Please try again.</div>
  </div>

  <script>
    const passwordInput = document.getElementById("password");
    const loginBtn = document.getElementById("loginBtn");
    const errorMsg = document.getElementById("errorMsg");

    const doLogin = async () => {
      const password = passwordInput.value;
      if (!password) return;
      
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      
      if (res.ok) {
        window.location.reload();
      } else {
        errorMsg.style.display = "block";
      }
    };

    loginBtn.onclick = doLogin;
    passwordInput.onkeydown = (e) => {
      if (e.key === "Enter") doLogin();
    };
  </script>
</body>
</html>`;
}

// Embedded Premium Dashboard HTML/CSS/JS UI
function getHtmlDashboard(origin) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZipLoot - Unlimited Serverless Cloud Drive</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #070913;
      --bg-surface: rgba(13, 17, 39, 0.45);
      --bg-surface-hover: rgba(20, 27, 61, 0.6);
      --border-glow: rgba(99, 102, 241, 0.15);
      --border-subtle: rgba(255, 255, 255, 0.04);
      --primary: #6366f1;
      --primary-glow: rgba(99, 102, 241, 0.35);
      --secondary: #10b981;
      --secondary-glow: rgba(16, 185, 129, 0.35);
      --text: #f1f5f9;
      --text-muted: #64748b;
      --text-active: #a5b4fc;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-dark);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      display: flex;
      overflow-x: hidden;
      position: relative;
    }
    body::before {
      content: "";
      position: absolute;
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.12) 0%, rgba(7, 9, 19, 0) 70%);
      top: -100px;
      left: -100px;
      z-index: 0;
      pointer-events: none;
    }
    body::after {
      content: "";
      position: absolute;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(16, 185, 129, 0.07) 0%, rgba(7, 9, 19, 0) 70%);
      bottom: -150px;
      right: -150px;
      z-index: 0;
      pointer-events: none;
    }
    aside {
      width: 280px;
      background: rgba(8, 10, 24, 0.75);
      border-right: 1px solid var(--border-subtle);
      padding: 30px 24px;
      display: flex;
      flex-direction: column;
      backdrop-filter: blur(20px);
      z-index: 10;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 40px;
    }
    .brand-logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #fff;
      font-size: 20px;
      box-shadow: 0 4px 15px var(--primary-glow);
    }
    .brand-name {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      font-weight: 800;
      background: linear-gradient(135deg, #fff 30%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }
    .nav-section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-muted);
      margin: 20px 0 10px 8px;
    }
    .nav-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .nav-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-radius: 12px;
      cursor: pointer;
      font-weight: 500;
      font-size: 14px;
      color: #94a3b8;
      transition: all 0.2s ease;
    }
    .nav-item:hover, .nav-item.active {
      background: var(--bg-surface-hover);
      color: #fff;
    }
    .nav-item.active {
      border: 1px solid var(--border-glow);
      color: var(--text-active);
    }
    .nav-item-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .nav-icon { font-size: 18px; }
    .badge {
      background: rgba(255, 255, 255, 0.05);
      padding: 2px 8px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .nav-item.active .badge {
      background: rgba(99, 102, 241, 0.15);
      color: var(--text-active);
    }
    .btn-create-folder {
      margin-top: auto;
      background: linear-gradient(135deg, var(--primary) 0%, #4f46e5 100%);
      color: #fff;
      border: none;
      padding: 14px;
      border-radius: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 15px var(--primary-glow);
      transition: all 0.2s ease;
      font-size: 14px;
    }
    .btn-create-folder:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px var(--primary-glow);
    }
    main {
      flex: 1;
      padding: 40px;
      z-index: 10;
      display: flex;
      flex-direction: column;
      gap: 30px;
      max-width: 1400px;
      margin: 0 auto;
      width: 100%;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
    }
    .search-wrapper {
      position: relative;
      flex: 1;
      max-width: 400px;
    }
    .search-icon {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 16px;
    }
    .search-input {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      padding: 14px 18px 14px 46px;
      color: #fff;
      font-family: inherit;
      outline: none;
      transition: all 0.2s ease;
      font-size: 14px;
    }
    .search-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 12px var(--primary-glow);
      background: rgba(13, 17, 39, 0.7);
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .control-wrapper {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      padding: 8px 14px;
    }
    .control-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    .control-select {
      background: transparent;
      border: none;
      color: #fff;
      font-family: inherit;
      font-weight: 600;
      outline: none;
      cursor: pointer;
      font-size: 13px;
    }
    .logout-btn {
      background: rgba(239, 68, 68, 0.08);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.15);
      padding: 12px 20px;
      border-radius: 14px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s ease;
      cursor: pointer;
    }
    .logout-btn:hover {
      background: rgba(239, 68, 68, 0.15);
      transform: translateY(-1px);
    }
    .breadcrumbs {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 600;
    }
    .breadcrumb-item {
      color: var(--text-muted);
      cursor: pointer;
      transition: color 0.2s ease;
    }
    .breadcrumb-item:hover { color: #fff; }
    .breadcrumb-item.active {
      color: var(--text-active);
      cursor: default;
    }
    .breadcrumb-separator { color: var(--text-muted); }
    .upload-zone {
      border: 2px dashed rgba(99, 102, 241, 0.25);
      background: var(--bg-surface);
      border-radius: 20px;
      padding: 40px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    .upload-zone:hover {
      border-color: var(--primary);
      background: rgba(99, 102, 241, 0.02);
      box-shadow: 0 10px 30px rgba(99, 102, 241, 0.05);
    }
    .upload-icon {
      font-size: 40px;
      margin-bottom: 12px;
      background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .upload-zone h3 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 6px;
      color: #fff;
    }
    .upload-zone p { font-size: 13px; color: var(--text-muted); }
    .section-title {
      font-family: 'Outfit', sans-serif;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .folder-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .folder-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 18px;
      display: flex;
      align-items: center;
      gap: 15px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .folder-card:hover {
      border-color: var(--primary-glow);
      background: var(--bg-surface-hover);
      transform: translateY(-2px);
    }
    .folder-icon { font-size: 32px; color: #eab308; }
    .folder-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .folder-name {
      font-weight: 600;
      font-size: 14px;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .folder-files-count { font-size: 11px; color: var(--text-muted); }
    .file-table-wrapper {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 20px;
      overflow: hidden;
      backdrop-filter: blur(12px);
      box-shadow: 0 15px 35px rgba(0, 0, 0, 0.2);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th, td { padding: 18px 24px; border-bottom: 1px solid var(--border-subtle); }
    th {
      background: rgba(255, 255, 255, 0.01);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }
    td { font-size: 14px; color: #cbd5e1; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255, 255, 255, 0.01); }
    .file-name-cell {
      display: flex;
      align-items: center;
      gap: 15px;
      font-weight: 500;
      color: #fff;
      cursor: pointer;
    }
    .file-name-cell:hover span {
      color: var(--text-active);
      text-decoration: underline;
    }
    .file-type-icon {
      width: 38px;
      height: 38px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }
    .action-btn-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn-action {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-subtle);
      color: #fff;
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-action-primary {
      background: rgba(99, 102, 241, 0.1);
      border-color: rgba(99, 102, 241, 0.2);
      color: var(--text-active);
    }
    .btn-action-primary:hover {
      background: var(--primary);
      color: #fff;
      box-shadow: 0 4px 12px var(--primary-glow);
    }
    .btn-action-danger {
      background: rgba(239, 68, 68, 0.05);
      border-color: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }
    .btn-action-danger:hover {
      background: #ef4444;
      color: #fff;
      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
    }
    .empty-state {
      text-align: center;
      padding: 60px;
      color: var(--text-muted);
    }
    .empty-state-icon { font-size: 48px; margin-bottom: 15px; }
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(4, 5, 12, 0.85);
      backdrop-filter: blur(20px);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 200;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    .modal-overlay.active {
      display: flex;
      opacity: 1;
    }
    .modal-content {
      background: rgba(13, 17, 39, 0.6);
      border: 1px solid var(--border-glow);
      border-radius: 24px;
      padding: 24px;
      width: 90%;
      max-width: 800px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
    }
    .modal-close {
      position: absolute;
      top: 20px;
      right: 20px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
      width: 36px;
      height: 36px;
      border-radius: 12px;
      color: #fff;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }
    .modal-close:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: scale(1.05);
    }
    .modal-header {
      width: 100%;
      margin-bottom: 20px;
      text-align: left;
    }
    .modal-title {
      font-family: 'Outfit', sans-serif;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
    }
    .modal-body {
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      border-radius: 14px;
      background: rgba(0, 0, 0, 0.2);
      min-height: 300px;
    }
    .preview-image {
      max-width: 100%;
      max-height: 60vh;
      object-fit: contain;
    }
    .preview-video {
      width: 100%;
      max-height: 60vh;
      outline: none;
    }
    .preview-fallback {
      text-align: center;
      padding: 40px;
    }
    .progress-container {
      margin-top: 20px;
      display: none;
      text-align: left;
    }
    .progress-bar-wrapper {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      height: 8px;
      width: 100%;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-bar {
      background: linear-gradient(90deg, #818cf8 0%, #10b981 100%);
      height: 100%;
      width: 0%;
      transition: width 0.1s ease;
    }
  </style>
</head>
<body>
  <div class="glow-1"></div>
  <div class="glow-2"></div>

  <aside>
    <div class="brand">
      <div class="brand-logo">⚡</div>
      <div class="brand-name">ZIPLOOT CLOUD</div>
    </div>

    <nav>
      <div class="nav-section-title">Navigation</div>
      <ul class="nav-list">
        <li class="nav-item active" id="nav-all" onclick="filterCategory('all', this)">
          <div class="nav-item-left">
            <span class="nav-icon">📦</span>
            <span>All Files</span>
          </div>
          <span class="badge" id="badge-all">0</span>
        </li>
      </ul>

      <div class="nav-section-title">Categories</div>
      <ul class="nav-list">
        <li class="nav-item" onclick="filterCategory('images', this)">
          <div class="nav-item-left">
            <span class="nav-icon">🖼️</span>
            <span>Images</span>
          </div>
          <span class="badge" id="badge-images">0</span>
        </li>
        <li class="nav-item" onclick="filterCategory('videos', this)">
          <div class="nav-item-left">
            <span class="nav-icon">🎥</span>
            <span>Videos</span>
          </div>
          <span class="badge" id="badge-videos">0</span>
        </li>
        <li class="nav-item" onclick="filterCategory('documents', this)">
          <div class="nav-item-left">
            <span class="nav-icon">📝</span>
            <span>Documents</span>
          </div>
          <span class="badge" id="badge-documents">0</span>
        </li>
        <li class="nav-item" onclick="filterCategory('archives', this)">
          <div class="nav-item-left">
            <span class="nav-icon">📦</span>
            <span>Archives</span>
          </div>
          <span class="badge" id="badge-archives">0</span>
        </li>
      </ul>
    </nav>

    <button class="btn-create-folder" onclick="createNewFolderPrompt()">
      <span>📁</span>
      <span>New Folder</span>
    </button>
  </aside>

  <main>
    <div class="topbar">
      <div class="search-wrapper">
        <span class="search-icon">🔍</span>
        <input type="text" class="search-input" id="searchInput" placeholder="Search files by name..." oninput="handleSearch()" />
      </div>

      <div class="topbar-actions">
        <div class="control-wrapper">
          <span class="control-label">Date:</span>
          <select class="control-select" id="dateFilterSelect" onchange="handleDateFilter()">
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
          </select>
        </div>

        <div class="control-wrapper">
          <span class="control-label">Sort:</span>
          <select class="control-select" id="sortSelect" onchange="handleSort()">
            <option value="newest">Newest Upload</option>
            <option value="oldest">Oldest Upload</option>
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
            <option value="size-desc">Largest Size</option>
            <option value="size-asc">Smallest Size</option>
          </select>
        </div>

        <a href="/logout" class="logout-btn">Lock Drive</a>
      </div>
    </div>

    <div class="breadcrumbs">
      <span class="breadcrumb-item" onclick="navigateToFolder(null)">Root</span>
      <div id="breadcrumb-subfolders" style="display: inline-flex; align-items: center; gap: 8px;"></div>
    </div>

    <div class="upload-zone" id="dropzone">
      <input type="file" id="fileinput" style="display: none;" />
      <div class="upload-icon">📤</div>
      <h3>Drag & Drop Files Here</h3>
      <p>Supports files up to any size (automatic 20MB chunking & streaming bypass)</p>

      <div class="progress-container" id="progressContainer">
        <div style="display: flex; justify-content: space-between; font-size: 13px;">
          <span id="fileName" style="font-weight: 600;">Uploading...</span>
          <span id="progressText">0%</span>
        </div>
        <div class="progress-bar-wrapper">
          <div class="progress-bar" id="progressBar"></div>
        </div>
      </div>
    </div>

    <div id="folders-section">
      <div class="section-title">Folders</div>
      <div class="folder-grid" id="folderGrid"></div>
    </div>

    <div>
      <div class="section-title">Files</div>
      <div class="file-table-wrapper">
        <table>
          <thead>
            <tr>
              <th>File Name</th>
              <th>Size</th>
              <th>Upload Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="fileList"></tbody>
        </table>
      </div>
    </div>
  </main>

  <div class="modal-overlay" id="previewModal">
    <div class="modal-content">
      <button class="modal-close" onclick="closePreviewModal()">&times;</button>
      <div class="modal-header">
        <h4 class="modal-title" id="modalTitle">File Preview</h4>
      </div>
      <div class="modal-body" id="modalBody"></div>
    </div>
  </div>

  <script>
    const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB chunks
    const dropzone = document.getElementById("dropzone");
    const fileinput = document.getElementById("fileinput");
    const progressContainer = document.getElementById("progressContainer");
    const progressText = document.getElementById("progressText");
    const progressBar = document.getElementById("progressBar");
    const fileNameDisplay = document.getElementById("fileName");
    const fileList = document.getElementById("fileList");

    dropzone.onclick = () => fileinput.click();
    fileinput.onchange = (e) => handleUpload(e.target.files[0]);

    dropzone.ondragover = (e) => { e.preventDefault(); };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      handleUpload(e.dataTransfer.files[0]);
    };

    let folders = [];
    let files = [];
    let currentFolderId = null;
    let currentCategory = "all";
    let searchQuery = "";
    let currentSort = "newest";
    let currentDateFilter = "all";

    function getFileIcon(fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      const icons = {
        pdf: '📄', doc: '📝', docx: '📝', txt: '📝', md: '📝',
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
        mp4: '🎥', mkv: '🎥', avi: '🎥', mov: '🎥', webm: '🎥',
        mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵',
        zip: '📦', rar: '📦', tar: '📦', gz: '📦', '7z': '📦',
        js: '💻', html: '💻', css: '💻', py: '💻', json: '💻'
      };
      return icons[ext] || '💾';
    }

    function getFileCategory(fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'images';
      if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return 'videos';
      if (['pdf', 'doc', 'docx', 'txt', 'md', 'xls', 'xlsx'].includes(ext)) return 'documents';
      if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) return 'archives';
      return 'other';
    }

    async function fetchFolders() {
      const res = await fetch("/api/folders");
      if (res.ok) folders = await res.json();
    }

    async function fetchFiles() {
      const res = await fetch("/api/files");
      if (res.ok) files = await res.json();
    }

    async function createNewFolderPrompt() {
      const folderName = prompt("Enter new folder name:");
      if (!folderName || !folderName.trim()) return;
      
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName.trim() })
      });
      if (res.ok) {
        await fetchFolders();
        renderUI();
      }
    }

    async function deleteFolder(folderKey) {
      if (confirm("Are you sure you want to delete this folder? (Files inside will be moved to Root)")) {
        const res = await fetch(\`/api/delete-folder/\${folderKey}\`, { method: "DELETE" });
        if (res.ok) {
          await fetchFolders();
          await fetchFiles();
          renderUI();
        }
      }
    }

    async function handleUpload(file) {
      if (!file) return;
      progressContainer.style.display = "block";
      fileNameDisplay.textContent = file.name;

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const chunkIds = [];

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append("chunk", chunk);
        formData.append("index", i);

        const res = await fetch("/api/upload-chunk", {
          method: "POST",
          body: formData
        });
        const data = await res.json();
        if (res.ok) {
          chunkIds.push(data.fileId);
          const percent = Math.round(((i + 1) / totalChunks) * 100);
          progressBar.style.width = percent + "%";
          progressText.textContent = percent + "%";
        } else {
          alert("Upload failed: " + data.error);
          return;
        }
      }

      const finRes = await fetch("/api/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          type: file.type,
          chunks: chunkIds,
          folderId: currentFolderId
        })
      });

      if (finRes.ok) {
        progressContainer.style.display = "none";
        progressBar.style.width = "0%";
        progressText.textContent = "0%";
        await fetchFiles();
        renderUI();
      } else {
        alert("Finalizing upload failed.");
      }
    }

    async function deleteFile(key) {
      if (confirm("Are you sure you want to delete this file?")) {
        await fetch(`/api/delete/${key}`, { method: "DELETE" });
        await fetchFiles();
        renderUI();
      }
    }

    function openPreview(fileKey) {
      const file = files.find(f => f.key === fileKey);
      if (!file) return;

      const modal = document.getElementById("previewModal");
      const title = document.getElementById("modalTitle");
      const body = document.getElementById("modalBody");

      title.textContent = file.name;
      body.innerHTML = ""; 

      const category = getFileCategory(file.name);

      if (category === "images") {
        body.innerHTML = \`
          <img src="/api/download/\${file.key}" class="preview-image" alt="\${file.name}" />
        \`;
      } else if (category === "videos") {
        body.innerHTML = \`
          <video controls autoplay class="preview-video">
            <source src="/api/download/\${file.key}" type="\${file.type || 'video/mp4'}">
            Your browser does not support the video tag.
          </video>
        \`;
      } else {
        body.innerHTML = \`
          <div class="preview-fallback">
            <div style="font-size: 60px; margin-bottom: 15px;">\${getFileIcon(file.name)}</div>
            <p style="margin-bottom: 15px; color: #cbd5e1;">Preview not available for this file type.</p>
            <a href="/api/download/\${file.key}" class="btn-action btn-action-primary">Download to Device</a>
          </div>
        \`;
      }

      modal.classList.add("active");
    }

    function closePreviewModal() {
      const modal = document.getElementById("previewModal");
      const body = document.getElementById("modalBody");
      body.innerHTML = ""; 
      modal.classList.remove("active");
    }

    function filterCategory(category, el) {
      document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      currentCategory = category;
      currentFolderId = null;
      renderUI();
    }

    function handleSearch() {
      searchQuery = document.getElementById("searchInput").value.toLowerCase();
      renderUI();
    }

    function handleSort() {
      currentSort = document.getElementById("sortSelect").value;
      renderUI();
    }

    function handleDateFilter() {
      currentDateFilter = document.getElementById("dateFilterSelect").value;
      renderUI();
    }

    function navigateToFolder(folderId) {
      currentFolderId = folderId;
      currentCategory = "all";
      document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
      document.getElementById("nav-all").classList.add('active');
      renderUI();
    }

    function updateBreadcrumbs() {
      const subcontainer = document.getElementById("breadcrumb-subfolders");
      subcontainer.innerHTML = "";
      if (currentFolderId) {
        const folder = folders.find(f => f.key === currentFolderId);
        if (folder) {
          subcontainer.innerHTML = `
            <span class="breadcrumb-separator">/</span>
            <span class="breadcrumb-item active">${folder.name}</span>
          `;
        }
      }
    }

    function updateBadges() {
      document.getElementById("badge-all").textContent = files.length;
      document.getElementById("badge-images").textContent = files.filter(f => getFileCategory(f.name) === 'images').length;
      document.getElementById("badge-videos").textContent = files.filter(f => getFileCategory(f.name) === 'videos').length;
      document.getElementById("badge-documents").textContent = files.filter(f => getFileCategory(f.name) === 'documents').length;
      document.getElementById("badge-archives").textContent = files.filter(f => getFileCategory(f.name) === 'archives').length;
    }

    function renderUI() {
      updateBreadcrumbs();
      updateBadges();

      const folderGrid = document.getElementById("folderGrid");
      const fileList = document.getElementById("fileList");
      const foldersSection = document.getElementById("folders-section");

      if (currentCategory === "all" && !searchQuery && !currentFolderId) {
        foldersSection.style.display = "block";
        folderGrid.innerHTML = "";
        folders.forEach(folder => {
          const count = files.filter(f => f.folderId === folder.key).length;
          const card = document.createElement("div");
          card.className = "folder-card";
          card.innerHTML = \`
            <div style="display: flex; align-items: center; gap: 15px; width: 100%; min-width: 0;" onclick="navigateToFolder('\${folder.key}')">
              <div class="folder-icon">📁</div>
              <div class="folder-info" style="flex: 1;">
                <div class="folder-name">\${folder.name}</div>
                <div class="folder-files-count">\${count} files</div>
              </div>
            </div>
            <button class="btn-action btn-action-danger" style="padding: 6px 10px; border-radius: 8px;" onclick="deleteFolder('\${folder.key}')">&times;</button>
          \`;
          folderGrid.appendChild(card);
        });
      } else {
        foldersSection.style.display = "none";
      }

      let filteredFiles = files.filter(file => {
        if (currentCategory === "all" && !searchQuery && currentDateFilter === "all") {
          if (file.folderId !== currentFolderId) return false;
        }
        if (currentCategory !== "all") {
          if (getFileCategory(file.name) !== currentCategory) return false;
        }
        if (searchQuery) {
          if (!file.name.toLowerCase().includes(searchQuery)) return false;
        }
        if (currentDateFilter !== "all") {
          const fileDate = new Date(file.date);
          const now = new Date();
          const diffTime = Math.abs(now - fileDate);
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          
          if (currentDateFilter === "today") {
            if (fileDate.toDateString() !== now.toDateString()) return false;
          } else if (currentDateFilter === "yesterday") {
            const yesterday = new Date();
            yesterday.setDate(now.getDate() - 1);
            if (fileDate.toDateString() !== yesterday.toDateString()) return false;
          } else if (currentDateFilter === "week") {
            if (diffDays > 7) return false;
          } else if (currentDateFilter === "month") {
            if (diffDays > 30) return false;
          }
        }
        return true;
      });

      filteredFiles.sort((a, b) => {
        if (currentSort === "newest") return new Date(b.date) - new Date(a.date);
        if (currentSort === "oldest") return new Date(a.date) - new Date(b.date);
        if (currentSort === "name-asc") return a.name.localeCompare(b.name);
        if (currentSort === "name-desc") return b.name.localeCompare(a.name);
        if (currentSort === "size-desc") return b.size - a.size;
        if (currentSort === "size-asc") return a.size - b.size;
        return 0;
      });

      fileList.innerHTML = "";
      if (filteredFiles.length === 0) {
        fileList.innerHTML = \`
          <tr>
            <td colspan="4">
              <div class="empty-state">
                <div class="empty-state-icon">🔍</div>
                <div>No files found.</div>
              </div>
            </td>
          </tr>
\`;
      } else {
        filteredFiles.forEach(file => {
          const row = document.createElement("tr");
          row.innerHTML = \`
            <td>
              <div class="file-name-cell" onclick="openPreview('\${file.key}')">
                <div class="file-type-icon">\${getFileIcon(file.name)}</div>
                <span>\${file.name}</span>
              </div>
            </td>
            <td>\${(file.size / (1024 * 1024)).toFixed(2)} MB</td>
            <td>\${new Date(file.date).toLocaleDateString()}</td>
            <td>
              <div class="action-btn-group">
                <a href="/api/download/\${file.key}" class="btn-action btn-action-primary">Download</a>
                <button class="btn-action btn-action-danger" onclick="deleteFile('\${file.key}')">Delete</button>
              </div>
            </td>
          \`;
          fileList.appendChild(row);
        });
      }
    }

    window.onclick = function(event) {
      const modal = document.getElementById("previewModal");
      if (event.target === modal) closePreviewModal();
    }

    async function init() {
      await fetchFolders();
      await fetchFiles();
      renderUI();
    }
    init();
  </script>
</body>
</html>`;
}
