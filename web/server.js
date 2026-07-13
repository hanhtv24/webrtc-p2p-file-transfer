// @ts-check
/**
 * web/server.js — Giao diện Web cho hệ thống P2P (đáp ứng mục nâng cao "GUI").
 *
 * Đây KHÔNG phải là 1 web app tách rời gọi CLI qua child_process — nó import
 * thẳng các module lõi (`Peer`, `Tracker`, `torrent`) và chạy chúng NGAY TRONG
 * tiến trình Node của web server. Nhờ vậy:
 *   - Có thể đọc trạng thái tải (have/chunkCount, bytesUp/Down, sources...)
 *     trực tiếp từ object `Peer`, không cần parse log.
 *   - Vẫn là P2P THẬT: mỗi Peer vẫn mở TCP server/client riêng, nói chuyện với
 *     seeder/leecher khác qua wire protocol — kể cả các peer chạy từ `cli.js`
 *     (dòng lệnh) trên máy khác, miễn cùng trỏ về tracker này.
 *
 * Luồng sử dụng:
 *   1. Người dùng tải file lên trình duyệt → server tạo metadata (chunk+hash)
 *      và NGAY LẬP TỨC tự làm seeder cho file đó (chức năng 1 + 5).
 *   2. Người dùng bấm "Tải xuống" 1 torrent → server tạo 1 Peer LEECHER mới,
 *      tải qua swarm thật (chức năng 3, 4, 6, 7), tiến trình xem được real-time.
 *   3. Tải xong → nút "Tải file" xuất hiện, phục vụ file đã ghép qua HTTP.
 *
 * Không dùng framework/dependency ngoài — chỉ module built-in của Node, đúng
 * tinh thần "ưu tiên built-in" của toàn dự án.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const { createMetadata, saveMetadata, loadMetadata, ChunkStore, DEFAULT_CHUNK_SIZE } = require("../bittorrent/src/torrent");
const { startTracker } = require("../bittorrent/tracker/tracker");
const { Peer } = require("../bittorrent/peer/peer");

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 5000;
const TRACKER_PORT = Number(process.argv[3]) || Number(process.env.TRACKER_PORT) || 4000;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300MB — đủ cho demo, tránh tràn RAM

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DOWNLOAD_DIR = path.join(DATA_DIR, "downloads");
const PUBLIC_DIR = path.join(__dirname, "public");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

/** @type {Map<string, {infohash:string, meta:object, filePath:string, uploadedAt:number}>} */
const torrents = new Map(); // infohash -> torrent record (nguồn gốc do server này biết)

/** @type {Map<string, {peer:Peer, role:'seed'|'leech', infohash:string, name:string, outFile?:string, createdAt:number}>} */
const peers = new Map(); // id nội bộ -> phiên Peer đang chạy trong tiến trình này

let trackerUrl;

// ===================== TIỆN ÍCH =====================

function randomId(n = 8) {
  return crypto.randomBytes(n).toString("hex");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Parser multipart/form-data tối giản (đủ dùng cho <input type=file> qua fetch).
 * Trả về { fields: {name:string}, files: {name:{filename, buffer}} }.
 */
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from("--" + boundary);
  const fields = {};
  const files = {};
  let start = buffer.indexOf(boundaryBuf);
  while (start >= 0) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next < 0) break;
    // Phần thân giữa 2 boundary, bỏ CRLF đầu/cuối
    let part = buffer.subarray(start + boundaryBuf.length, next);
    if (part.slice(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.slice(-2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const headerText = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + 4);
      const nameMatch = headerText.match(/name="([^"]*)"/);
      const filenameMatch = headerText.match(/filename="([^"]*)"/);
      const name = nameMatch ? nameMatch[1] : null;
      if (name) {
        if (filenameMatch && filenameMatch[1]) {
          files[name] = { filename: path.basename(filenameMatch[1]), buffer: Buffer.from(body) };
        } else {
          fields[name] = body.toString("utf8");
        }
      }
    }
    start = next;
  }
  return { fields, files };
}

function getBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  return m ? (m[1] || m[2]) : null;
}

// ===================== NGHIỆP VỤ =====================

/** Tạo torrent từ buffer đã tải lên: ghi ra đĩa, tạo metadata, đăng ký. */
function registerUpload(filename, buffer, chunkSize) {
  const uploadId = randomId(6);
  const dir = path.join(UPLOAD_DIR, uploadId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);

  const meta = createMetadata(filePath, chunkSize || DEFAULT_CHUNK_SIZE);
  saveMetadata(meta, filePath + ".meta.json");

  const record = { infohash: meta.infohash, meta, filePath, uploadedAt: Date.now() };
  torrents.set(meta.infohash, record);
  return record;
}

/** Khởi động 1 Peer SEEDER cho torrent đã có (dùng file gốc trên đĩa server). */
function startSeeder(record) {
  const store = ChunkStore.openSeed(record.meta, record.filePath);
  const peer = new Peer({
    meta: record.meta,
    store,
    trackerUrl,
    port: 0,
    peerId: "web-seed-" + randomId(3),
    strategy: "rarest",
  });
  peer.start();
  const id = randomId(6);
  peers.set(id, { peer, role: "seed", infohash: record.infohash, name: record.meta.name, createdAt: Date.now() });
  return id;
}

/** Khởi động 1 Peer LEECHER tải torrent về đĩa server (rồi phục vụ qua HTTP). */
function startLeecher(record) {
  const outDir = path.join(DOWNLOAD_DIR, randomId(6));
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, record.meta.name);
  const store = ChunkStore.openLeech(record.meta, outFile);
  const peer = new Peer({
    meta: record.meta,
    store,
    trackerUrl,
    port: 0,
    peerId: "web-leech-" + randomId(3),
    strategy: "rarest",
  });
  peer.start();
  const id = randomId(6);
  peers.set(id, { peer, role: "leech", infohash: record.infohash, name: record.meta.name, outFile, createdAt: Date.now() });
  return id;
}

function serializePeer(id, entry) {
  const p = entry.peer;
  const chunkCount = p.meta.chunkCount;
  const have = p.store.count();
  return {
    id,
    peerId: p.peerId,
    role: entry.role,
    infohash: entry.infohash,
    name: entry.name,
    port: p.port,
    have,
    chunkCount,
    percent: chunkCount ? Math.round((have / chunkCount) * 1000) / 10 : 0,
    bytesDown: p.bytesDown,
    bytesUp: p.bytesUp,
    connections: p.conns.size,
    sources: p.sources.size,
    complete: !!p.completeTime,
    ms: p.completeTime ? p.completeTime - p.startTime : null,
    createdAt: entry.createdAt,
  };
}

// ===================== ROUTES API =====================

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

route("GET", /^\/api\/config$/, async (req, res) => {
  sendJson(res, 200, { trackerUrl, defaultChunkSize: DEFAULT_CHUNK_SIZE });
});

route("GET", /^\/api\/torrents$/, async (req, res) => {
  sendJson(res, 200, Array.from(torrents.values()).map((t) => ({
    infohash: t.infohash,
    name: t.meta.name,
    size: t.meta.size,
    chunkCount: t.meta.chunkCount,
    chunkSize: t.meta.chunkSize,
    uploadedAt: t.uploadedAt,
  })));
});

route("POST", /^\/api\/torrents$/, async (req, res) => {
  const contentType = req.headers["content-type"] || "";
  const boundary = getBoundary(contentType);
  if (!boundary) return sendJson(res, 400, { error: "cần multipart/form-data với file" });

  let raw;
  try {
    raw = await readBody(req, MAX_UPLOAD_BYTES);
  } catch (e) {
    return sendJson(res, e.status || 500, { error: e.message });
  }
  const { fields, files } = parseMultipart(raw, boundary);
  const file = files.file;
  if (!file) return sendJson(res, 400, { error: "thiếu field 'file'" });

  const chunkSize = Number(fields.chunkSize) || DEFAULT_CHUNK_SIZE;
  const record = registerUpload(file.filename, file.buffer, chunkSize);

  let seedId = null;
  if (fields.autoSeed !== "false") {
    seedId = startSeeder(record);
  }
  sendJson(res, 201, {
    infohash: record.infohash,
    name: record.meta.name,
    size: record.meta.size,
    chunkCount: record.meta.chunkCount,
    seedPeerId: seedId,
  });
});

route("POST", /^\/api\/torrents\/([a-f0-9]+)\/download$/, async (req, res, m) => {
  const record = torrents.get(m[1]);
  if (!record) return sendJson(res, 404, { error: "không tìm thấy torrent" });
  const id = startLeecher(record);
  sendJson(res, 201, { id, ...serializePeer(id, peers.get(id)) });
});

route("POST", /^\/api\/torrents\/([a-f0-9]+)\/seed$/, async (req, res, m) => {
  const record = torrents.get(m[1]);
  if (!record) return sendJson(res, 404, { error: "không tìm thấy torrent" });
  const id = startSeeder(record);
  sendJson(res, 201, { id, ...serializePeer(id, peers.get(id)) });
});

route("GET", /^\/api\/peers$/, async (req, res) => {
  sendJson(res, 200, Array.from(peers.entries()).map(([id, e]) => serializePeer(id, e)));
});

route("POST", /^\/api\/peers\/([a-f0-9]+)\/stop$/, async (req, res, m) => {
  const entry = peers.get(m[1]);
  if (!entry) return sendJson(res, 404, { error: "không tìm thấy peer" });
  entry.peer.stop();
  peers.delete(m[1]);
  sendJson(res, 200, { ok: true });
});

route("GET", /^\/api\/peers\/([a-f0-9]+)\/file$/, async (req, res, m) => {
  const entry = peers.get(m[1]);
  if (!entry || entry.role !== "leech" || !entry.outFile) return sendJson(res, 404, { error: "không có file" });
  if (!entry.peer.completeTime) return sendJson(res, 409, { error: "chưa tải xong" });
  if (!fs.existsSync(entry.outFile)) return sendJson(res, 404, { error: "file không tồn tại" });
  const stat = fs.statSync(entry.outFile);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${encodeURIComponent(entry.name)}"`,
  });
  fs.createReadStream(entry.outFile).pipe(res);
});

// ===================== STATIC FILE SERVING =====================

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ===================== HTTP SERVER =====================

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(u.pathname);
    if (!m) continue;
    try {
      return await r.handler(req, res, m);
    } catch (e) {
      console.error(e);
      return sendJson(res, 500, { error: "lỗi máy chủ: " + e.message });
    }
  }
  if (req.method === "GET") return serveStatic(req, res, u.pathname);
  sendJson(res, 404, { error: "not found" });
});

async function main() {
  const { server: trackerServer } = await startTracker(TRACKER_PORT);
  trackerUrl = `http://localhost:${TRACKER_PORT}`;
  server.listen(PORT, () => {
    console.log(`\n[web] Giao diện quản lý P2P: http://localhost:${PORT}`);
    console.log(`[web] Tracker dùng chung : ${trackerUrl}  (peer CLI khác cũng có thể trỏ vào đây)\n`);
  });

  const shutdown = () => {
    for (const { peer } of peers.values()) peer.stop();
    server.close();
    trackerServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
