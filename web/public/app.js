// app.js — Logic phía trình duyệt: gọi API, vẽ bảng, cập nhật real-time bằng polling.

const $ = (sel) => document.querySelector(sel);
const fmtBytes = (b) => {
  if (!b) return "0 B";
  const k = 1024,
    sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / k ** i).toFixed(i ? 1 : 0) + " " + sizes[i];
};
// Chuyển KB/s -> MB/s khi số quá lớn để hiển thị gọn trong cột hẹp
// (vd "120773 KB/s" -> "118.0 MB/s"), tránh bị cắt/tràn chữ.
const fmtRate = (kbps) =>
  kbps >= 1000
    ? (kbps / 1024).toFixed(1) + " MB/s"
    : Math.round(kbps) + " KB/s";

// Lưu snapshot lần poll trước để tính tốc độ tức thời (delta byte / delta thời gian).
const prevSnapshot = new Map(); // peerId -> { bytesDown, bytesUp, t }

async function loadConfig() {
  const cfg = await fetch("api/config").then((r) => r.json());
  $("#config").textContent =
    `${cfg.trackerUrl} · chunk mặc định ${fmtBytes(cfg.defaultChunkSize)}`;
}

async function loadTorrents() {
  const torrents = await fetch("api/torrents").then((r) => r.json());
  const tbody = $("#torrentTable tbody");
  tbody.innerHTML = "";
  $("#torrentCount").textContent = torrents.length;
  $("#torrentEmpty").style.display = torrents.length ? "none" : "block";
  $("#torrentTable").style.display = torrents.length ? "table" : "none";
  for (const t of torrents) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="truncate" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</td>
      <td>${fmtBytes(t.size)}</td>
      <td>${t.chunkCount}</td>
      <td class="mono">${t.infohash.slice(0, 12)}…</td>
      <td class="actions">
        <button class="secondary" data-download="${t.infohash}">⬇ Tải xuống</button>
        <button class="secondary" data-seed="${t.infohash}" title="Bật lại seeder nếu swarm không còn ai giữ file (tải xuống bị kẹt 0%)">🌱 Seed lại</button>
        <button class="danger" data-delete="${t.infohash}" title="Xoá torrent này (dừng mọi peer liên quan + xoá file gốc trên đĩa)">🗑 Xoá</button>
      </td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-download]").forEach((btn) => {
    btn.addEventListener("click", () =>
      startDownload(btn.dataset.download, btn),
    );
  });
  tbody.querySelectorAll("[data-seed]").forEach((btn) => {
    btn.addEventListener("click", () => reseed(btn.dataset.seed, btn));
  });
  tbody.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteTorrent(btn.dataset.delete, btn));
  });
}

async function reseed(infohash, btn) {
  btn.disabled = true;
  try {
    await fetch(`api/torrents/${infohash}/seed`, { method: "POST" });
    await loadPeers();
  } finally {
    btn.disabled = false;
  }
}

async function deleteTorrent(infohash, btn) {
  if (
    !confirm(
      "Xoá torrent này? Mọi peer (seed/leech) đang phục vụ nó sẽ bị dừng, file gốc trên server sẽ bị xoá.",
    )
  )
    return;
  btn.disabled = true;
  try {
    await fetch(`api/torrents/${infohash}`, { method: "DELETE" });
    await Promise.all([loadTorrents(), loadPeers()]);
  } finally {
    btn.disabled = false;
  }
}

async function startDownload(infohash, btn) {
  btn.disabled = true;
  btn.textContent = "Đang khởi tạo…";
  try {
    await fetch(`api/torrents/${infohash}/download`, { method: "POST" });
    await loadPeers();
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Tải xuống";
  }
}

// Tính tốc độ tức thời (KB/s) dựa trên snapshot lần poll trước, cập nhật snapshot mới.
function computeSpeeds(p, now) {
  const prev = prevSnapshot.get(p.id);
  let downKBps = 0,
    upKBps = 0;
  if (prev) {
    const dt = (now - prev.t) / 1000;
    if (dt > 0) {
      downKBps = Math.max(0, (p.bytesDown - prev.bytesDown) / 1024 / dt);
      upKBps = Math.max(0, (p.bytesUp - prev.bytesUp) / 1024 / dt);
    }
  }
  prevSnapshot.set(p.id, { bytesDown: p.bytesDown, bytesUp: p.bytesUp, t: now });
  return { downKBps, upKBps };
}

function buildRoleCell(p) {
  const roleBadge =
    p.role === "seed"
      ? '<span class="badge seed">SEED</span>'
      : '<span class="badge leech">LEECH</span>';
  // Icon nhỏ (không phải badge chữ "xong") để không làm ô "Vai trò" giãn to —
  // tooltip giải thích ý nghĩa khi rê chuột.
  const doneBadge = p.complete
    ? '<span class="badge-check" title="Đã hoàn tất">✓</span>'
    : "";
  return `<div class="role-cell">${roleBadge}${doneBadge}</div>`;
}

// Cột tốc độ tải xuống: đang tải → tốc độ tức thời; đã xong → tốc độ TRUNG
// BÌNH cả quá trình (bytesDown/thời gian) thay vì để tụt về 0 gây hiểu lầm
// là "không tải được gì". Dùng nhãn chữ "TB" (thay vì ký hiệu toán học ⌀)
// để người dùng không quen ký hiệu vẫn hiểu ngay, kèm tooltip giải thích.
function buildDownCell(p, downKBps) {
  if (p.role !== "leech") return { cell: "-", title: "" };
  if (!p.complete) return { cell: fmtRate(downKBps), title: "" };
  if (p.ms > 0) {
    const title = "Tốc độ trung bình cả quá trình tải";
    const rate = fmtRate(p.bytesDown / 1024 / (p.ms / 1000));
    return { cell: `<span class="rate-tag" title="${title}">TB</span>${rate}`, title };
  }
  return { cell: "-", title: "" };
}

// Cột tốc độ chia sẻ: đang có người tải từ mình → tốc độ tức thời; nếu hiện
// tại không ai đang xin chunk (tốc độ tức thời = 0) nhưng đã từng phục vụ
// → hiện tổng dung lượng đã chia sẻ (nhãn "Tổng"), tránh hiểu lầm "không hoạt động".
function buildUpCell(p, upKBps) {
  if (upKBps > 0) return { cell: fmtRate(upKBps), title: "" };
  if (p.bytesUp > 0) {
    const title = "Tổng dung lượng đã chia sẻ";
    return { cell: `<span class="rate-tag" title="${title}">Tổng</span>${fmtBytes(p.bytesUp)}`, title };
  }
  return { cell: "-", title: "" };
}

function buildPeerRow(p, downKBps, upKBps) {
  const down = buildDownCell(p, downKBps);
  const up = buildUpCell(p, upKBps);
  const tr = document.createElement("tr");
  tr.innerHTML = `
      <td>${buildRoleCell(p)}</td>
      <td class="mono truncate" title="${p.peerId}">${p.peerId}</td>
      <td class="truncate" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
      <td class="nowrap">
        <div class="progress"><div style="width:${p.percent}%"></div></div>
        <span class="progress-label">${p.have}/${p.chunkCount} (${p.percent}%)</span>
      </td>
      <td class="nowrap" title="${down.title}">${down.cell}</td>
      <td class="nowrap" title="${up.title}">${up.cell}</td>
      <td class="nowrap">${p.connections}</td>
      <td class="nowrap">${p.sources}</td>
      <td class="actions">
        ${p.complete && p.role === "leech" ? `<a href="api/peers/${p.id}/file"><button>Tải file</button></a>` : ""}
        <button class="danger" data-stop="${p.id}">Dừng</button>
      </td>`;
  return tr;
}

async function loadPeers() {
  const list = await fetch("api/peers").then((r) => r.json());
  const tbody = $("#peerTable tbody");
  tbody.innerHTML = "";
  $("#peerCount").textContent = list.length;
  $("#peerEmpty").style.display = list.length ? "none" : "block";
  $("#peerTable").style.display = list.length ? "table" : "none";
  const now = Date.now();

  for (const p of list) {
    const { downKBps, upKBps } = computeSpeeds(p, now);
    tbody.appendChild(buildPeerRow(p, downKBps, upKBps));
  }

  tbody.querySelectorAll("[data-stop]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`api/peers/${btn.dataset.stop}/stop`, { method: "POST" });
      prevSnapshot.delete(btn.dataset.stop);
      await loadPeers();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
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
    const res = await fetch("api/torrents", { method: "POST", body: fd });
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
