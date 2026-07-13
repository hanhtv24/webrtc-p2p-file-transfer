// app.js — Logic phía trình duyệt: gọi API, vẽ bảng, cập nhật real-time bằng polling.

const $ = (sel) => document.querySelector(sel);
const fmtBytes = (b) => {
  if (!b) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / k ** i).toFixed(i ? 1 : 0) + " " + sizes[i];
};

// Lưu snapshot lần poll trước để tính tốc độ tức thời (delta byte / delta thời gian).
const prevSnapshot = new Map(); // peerId -> { bytesDown, bytesUp, t }

async function loadConfig() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  $("#config").textContent = `Tracker: ${cfg.trackerUrl} · chunk mặc định: ${fmtBytes(cfg.defaultChunkSize)}`;
}

async function loadTorrents() {
  const torrents = await fetch("/api/torrents").then((r) => r.json());
  const tbody = $("#torrentTable tbody");
  tbody.innerHTML = "";
  for (const t of torrents) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(t.name)}</td>
      <td>${fmtBytes(t.size)}</td>
      <td>${t.chunkCount}</td>
      <td class="mono">${t.infohash.slice(0, 12)}…</td>
      <td><button class="secondary" data-download="${t.infohash}">⬇ Tải xuống (peer mới)</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-download]").forEach((btn) => {
    btn.addEventListener("click", () => startDownload(btn.dataset.download, btn));
  });
}

async function startDownload(infohash, btn) {
  btn.disabled = true;
  btn.textContent = "Đang khởi tạo…";
  try {
    await fetch(`/api/torrents/${infohash}/download`, { method: "POST" });
    await loadPeers();
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Tải xuống (peer mới)";
  }
}

async function loadPeers() {
  const list = await fetch("/api/peers").then((r) => r.json());
  const tbody = $("#peerTable tbody");
  tbody.innerHTML = "";
  const now = Date.now();

  for (const p of list) {
    const prev = prevSnapshot.get(p.id);
    let downKBps = 0, upKBps = 0;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) {
        downKBps = Math.max(0, (p.bytesDown - prev.bytesDown) / 1024 / dt);
        upKBps = Math.max(0, (p.bytesUp - prev.bytesUp) / 1024 / dt);
      }
    }
    prevSnapshot.set(p.id, { bytesDown: p.bytesDown, bytesUp: p.bytesUp, t: now });

    const roleBadge = p.role === "seed" ? '<span class="badge seed">SEED</span>' : '<span class="badge leech">LEECH</span>';
    const doneBadge = p.complete ? '<span class="badge done">✓ xong</span>' : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${roleBadge} ${doneBadge}</td>
      <td class="mono">${p.peerId}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>
        <div class="progress"><div style="width:${p.percent}%"></div></div>
        <span class="progress-label">${p.have}/${p.chunkCount} (${p.percent}%)</span>
      </td>
      <td>${p.role === "leech" && !p.complete ? downKBps.toFixed(0) + " KB/s" : "-"}</td>
      <td>${p.bytesUp > 0 ? upKBps.toFixed(0) + " KB/s" : "-"}</td>
      <td>${p.connections}</td>
      <td>${p.sources}</td>
      <td>
        ${p.complete && p.role === "leech" ? `<a href="/api/peers/${p.id}/file"><button>Tải file</button></a>` : ""}
        <button class="danger" data-stop="${p.id}">Dừng</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-stop]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`/api/peers/${btn.dataset.stop}/stop`, { method: "POST" });
      prevSnapshot.delete(btn.dataset.stop);
      await loadPeers();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("#uploadForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = $("#fileInput");
  const chunkSize = $("#chunkSize").value;
  const statusEl = $("#uploadStatus");
  if (!fileInput.files[0]) return;

  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  fd.append("chunkSize", chunkSize);
  fd.append("autoSeed", "true");

  statusEl.textContent = "Đang tải lên & chia chunk…";
  statusEl.className = "status";
  try {
    const res = await fetch("/api/torrents", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "lỗi không rõ");
    statusEl.textContent = `✓ Đã chia sẻ "${data.name}" — ${data.chunkCount} chunk. Đang seed.`;
    statusEl.className = "status ok";
    fileInput.value = "";
    await Promise.all([loadTorrents(), loadPeers()]);
  } catch (err) {
    statusEl.textContent = "✗ Lỗi: " + err.message;
    statusEl.className = "status err";
  }
});

async function refreshAll() {
  await Promise.all([loadTorrents(), loadPeers()]);
}

loadConfig();
refreshAll();
setInterval(loadPeers, 1000);
setInterval(loadTorrents, 5000);
