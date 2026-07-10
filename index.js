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

    // Serve HTML Dashboard
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(getHtmlDashboard(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // API: List Files
    if (url.pathname === "/api/files" && request.method === "GET") {
      const keysList = await env.DRIVE_KV.list();
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
          date: new Date().toISOString()
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

// Embedded Premium Dashboard HTML/CSS/JS UI
function getHtmlDashboard(origin) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZipLoot - Unlimited Serverless Cloud Drive</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Syne:wght@700;800&family=Space+Mono&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(255, 255, 255, 0.03);
      --border: rgba(255, 255, 255, 0.06);
      --primary: #818cf8;
      --success: #10b981;
      --text: #cbd5e1;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      overflow-x: hidden;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding: 20px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(11, 15, 25, 0.8);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo {
      font-family: 'Syne', sans-serif;
      font-size: 22px;
      font-weight: 800;
      background: linear-gradient(135deg, #818cf8 0%, #10b981 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }
    .container {
      max-width: 1200px;
      width: 100%;
      margin: 40px auto;
      padding: 0 20px;
      flex: 1;
    }
    .upload-zone {
      border: 2px dashed rgba(129, 140, 248, 0.3);
      background: var(--card-bg);
      border-radius: 16px;
      padding: 40px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s ease;
      margin-bottom: 40px;
    }
    .upload-zone:hover {
      border-color: var(--primary);
      background: rgba(129, 140, 248, 0.02);
    }
    .upload-zone h3 {
      font-family: 'Syne', sans-serif;
      font-size: 20px;
      margin-bottom: 8px;
      color: #fff;
    }
    .upload-zone p { font-size: 14px; color: #64748b; }
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
    .file-table-wrapper {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th, td { padding: 18px 24px; border-bottom: 1px solid var(--border); }
    th {
      background: rgba(255, 255, 255, 0.01);
      font-family: 'Syne', sans-serif;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #94a3b8;
    }
    td { font-size: 14px; color: #cbd5e1; }
    tr:last-child td { border-bottom: none; }
    .btn {
      padding: 8px 16px;
      border-radius: 8px;
      border: none;
      font-family: 'Inter', sans-serif;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      transition: all 0.2s ease;
    }
    .btn-primary {
      background: var(--primary);
      color: #fff;
    }
    .btn-primary:hover { background: #6366f1; }
    .btn-danger {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
      margin-left: 8px;
    }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.2); }
  </style>
</head>
<body>
  <header>
    <div class="logo">⚡ ZIPLOOT CLOUD</div>
  </header>
  <div class="container">
    <div class="upload-zone" id="dropzone">
      <input type="file" id="fileinput" style="display: none;" />
      <h3>Drag & Drop Files Here</h3>
      <p>Supports files up to any size (automatic 20MB chunking & streaming bypass)</p>
      
      <div class="progress-container" id="progressContainer">
        <div style="display: flex; justify-content: space-between; font-size: 13px;">
          <span id="fileName">Uploading...</span>
          <span id="progressText">0%</span>
        </div>
        <div class="progress-bar-wrapper">
          <div class="progress-bar" id="progressBar"></div>
        </div>
      </div>
    </div>

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
        <tbody id="fileList">
          <!-- Dynamically populated -->
        </tbody>
      </table>
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

      // Finalize upload
      const finRes = await fetch("/api/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          type: file.type,
          chunks: chunkIds
        })
      });

      if (finRes.ok) {
        progressContainer.style.display = "none";
        progressBar.style.width = "0%";
        progressText.textContent = "0%";
        loadFiles();
      } else {
        alert("Finalizing upload failed.");
      }
    }

    async function loadFiles() {
      const res = await fetch("/api/files");
      const files = await res.json();
      fileList.innerHTML = "";
      
      files.forEach(file => {
        const row = document.createElement("tr");
        row.innerHTML = `
          <td>${file.name}</td>
          <td>${(file.size / (1024 * 1024)).toFixed(2)} MB</td>
          <td>${new Date(file.date).toLocaleDateString()}</td>
          <td>
            <a href="/api/download/${file.key}" class="btn btn-primary">Download</a>
            <button class="btn btn-danger" onclick="deleteFile('${file.key}')">Delete</button>
          </td>
        `;
        fileList.appendChild(row);
      });
    }

    async function deleteFile(key) {
      if (confirm("Are you sure you want to delete this file?")) {
        await fetch(`/api/delete/${key}`, { method: "DELETE" });
        loadFiles();
      }
    }

    loadFiles();
  </script>
</body>
</html>`;
}
