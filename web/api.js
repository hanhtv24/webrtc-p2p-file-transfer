// @ts-check
/**
 * web/api.js — Router Express cho dashboard + API của hệ BitTorrent-swarm.
 *
 * Tách ra thành 1 Router riêng (thay vì 1 http server độc lập như trước) để
 * có thể **gắn vào bất kỳ Express app nào** tại bất kỳ tiền tố (prefix) nào —
 * dùng để gộp vào server chính (`server/index.js`, cổng 5000) dưới đường dẫn
 * `/bittorrent`, đồng thời vẫn cho phép chạy độc lập qua `web/server.js` nếu
 * cần (mount tại `/`).
 *
 * Vẫn giữ nguyên triết lý cũ: import thẳng `Peer`/`torrent` và chạy chúng
 * NGAY TRONG tiến trình Node hiện tại — không qua child_process — nên đọc
 * được tiến độ tải trực tiếp từ object `Peer`.
 */

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  createMetadata,
  saveMetadata,
  ChunkStore,
  DEFAULT_CHUNK_SIZE,
} = require("../bittorrent/src/torrent");
const { Peer } = require("../bittorrent/peer/peer");

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — đủ cho demo, tránh tràn RAM

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DOWNLOAD_DIR = path.join(DATA_DIR, "downloads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function randomId(n = 8) {
  return crypto.randomBytes(n).toString("hex");
}

/**
 * Parse 1 “part” (giữa 2 boundary) của multipart/form-data thành header + body,
 * rối gán vào `fields` (text) hoặc `files` (có filename) tương ứng.
 * Tách ra khỏi `parseMultipart` để giảm độ phức tạp của hàm chính.
 * @param {Buffer} rawPart
 * @param {Record<string, string>} fields
 * @param {Record<string, {filename: string, buffer: Buffer}>} files
 */
function parsePart(rawPart, fields, files) {
  let part = rawPart;
  if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
  if (part.subarray(-2).toString() === "\r\n") part = part.subarray(0, -2);

  const headerEnd = part.indexOf("\r\n\r\n");
  if (headerEnd < 0) return;

  const headerText = part.subarray(0, headerEnd).toString("utf8");
  const body = part.subarray(headerEnd + 4);
  const nameMatch = headerText.match(/name="([^"]*)"/);
  const filenameMatch = headerText.match(/filename="([^"]*)"/);
  const name = nameMatch ? nameMatch[1] : null;
  if (!name) return;

  if (filenameMatch?.[1]) {
    files[name] = { filename: path.basename(filenameMatch[1]), buffer: Buffer.from(body) };
  } else {
    fields[name] = body.toString("utf8");
  }
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
    parsePart(buffer.subarray(start + boundaryBuf.length, next), fields, files);
    start = next;
  }
  return { fields, files };
}

function getBoundary(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  return m ? m[1] || m[2] : null;
}

/**
 * Dịch 1 peer (seed/leech đang chạy) thành object JSON gỬn cho FE poll.
 * Đặt ngoài `createBittorrentRouter` vì không dùng biến closure nào.
 * @param {string} id
 * @param {{peer: Peer, role: 'seed'|'leech', infohash: string, name: string, outFile?: string, createdAt: number}} entry
 */
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

/**
 * Tạo router Express phục vụ dashboard + API cho hệ BitTorrent-swarm.
 * @param {{trackerUrl: string}} opts trackerUrl phải trỏ tới 1 tracker đang chạy
 * @returns {import('express').Router}
 */
function createBittorrentRouter({ trackerUrl }) {
  const router = express.Router();

  /** @type {Map<string, {infohash:string, meta:object, filePath:string, uploadedAt:number}>} */
  const torrents = new Map();
  /** @type {Map<string, {peer:Peer, role:'seed'|'leech', infohash:string, name:string, outFile?:string, createdAt:number}>} */
  const peers = new Map();

  function registerUpload(filename, buffer, chunkSize) {
    const uploadId = randomId(6);
    const dir = path.join(UPLOAD_DIR, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);

    const meta = createMetadata(filePath, chunkSize || DEFAULT_CHUNK_SIZE);
    saveMetadata(meta, filePath + ".meta.json");

    const record = {
      infohash: meta.infohash,
      meta,
      filePath,
      uploadedAt: Date.now(),
    };
    torrents.set(meta.infohash, record);
    return record;
  }

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
    peers.set(id, {
      peer,
      role: "seed",
      infohash: record.infohash,
      name: record.meta.name,
      createdAt: Date.now(),
    });
    return id;
  }

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
    peers.set(id, {
      peer,
      role: "leech",
      infohash: record.infohash,
      name: record.meta.name,
      outFile,
      createdAt: Date.now(),
    });
    return id;
  }

  // ===================== ROUTES API =====================

  router.get("/api/config", (req, res) => {
    res.json({ trackerUrl, defaultChunkSize: DEFAULT_CHUNK_SIZE });
  });

  router.get("/api/torrents", (req, res) => {
    res.json(
      Array.from(torrents.values()).map((t) => ({
        infohash: t.infohash,
        name: t.meta.name,
        size: t.meta.size,
        chunkCount: t.meta.chunkCount,
        chunkSize: t.meta.chunkSize,
        uploadedAt: t.uploadedAt,
      })),
    );
  });

  router.post(
    "/api/torrents",
    express.raw({ type: "multipart/form-data", limit: MAX_UPLOAD_BYTES }),
    (req, res) => {
      const boundary = getBoundary(req.headers["content-type"]);
      if (!boundary || !Buffer.isBuffer(req.body)) {
        return res
          .status(400)
          .json({ error: "cần multipart/form-data với file" });
      }
      const { fields, files } = parseMultipart(req.body, boundary);
      const file = files.file;
      if (!file) return res.status(400).json({ error: "thiếu field 'file'" });

      const chunkSize = Number(fields.chunkSize) || DEFAULT_CHUNK_SIZE;
      const record = registerUpload(file.filename, file.buffer, chunkSize);

      let seedId = null;
      if (fields.autoSeed !== "false") {
        seedId = startSeeder(record);
      }
      res.status(201).json({
        infohash: record.infohash,
        name: record.meta.name,
        size: record.meta.size,
        chunkCount: record.meta.chunkCount,
        seedPeerId: seedId,
      });
    },
  );

  router.post("/api/torrents/:infohash/download", (req, res) => {
    const record = torrents.get(req.params.infohash);
    if (!record)
      return res.status(404).json({ error: "không tìm thấy torrent" });
    const id = startLeecher(record);
    res.status(201).json({ id, ...serializePeer(id, peers.get(id)) });
  });

  router.post("/api/torrents/:infohash/seed", (req, res) => {
    const record = torrents.get(req.params.infohash);
    if (!record)
      return res.status(404).json({ error: "không tìm thấy torrent" });
    const id = startSeeder(record);
    res.status(201).json({ id, ...serializePeer(id, peers.get(id)) });
  });

  // Xoá 1 torrent: dừng mọi peer (seed/leech) đang phục vụ nó, xoá file gốc +
  // metadata trên đĩa, và gỡ khỏi danh sách torrent. Không xoá được các file
  // .bin đã tải VỀ (nằm trong DOWNLOAD_DIR của từng leecher) vì chúng thuộc sở
  // hữu của phiên leecher đó, không phải của torrent.
  router.delete("/api/torrents/:infohash", (req, res) => {
    const record = torrents.get(req.params.infohash);
    if (!record)
      return res.status(404).json({ error: "không tìm thấy torrent" });

    for (const [id, entry] of peers) {
      if (entry.infohash === req.params.infohash) {
        entry.peer.stop();
        peers.delete(id);
      }
    }

    try {
      fs.rmSync(path.dirname(record.filePath), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      console.error(`[bittorrent-api] không xóa được thư mục torrent ${req.params.infohash}:`, err instanceof Error ? err.message : err);
    }
    torrents.delete(req.params.infohash);
    res.json({ ok: true });
  });

  router.get("/api/peers", (req, res) => {
    res.json(
      Array.from(peers.entries()).map(([id, e]) => serializePeer(id, e)),
    );
  });

  router.post("/api/peers/:id/stop", (req, res) => {
    const entry = peers.get(req.params.id);
    if (!entry) return res.status(404).json({ error: "không tìm thấy peer" });
    entry.peer.stop();
    peers.delete(req.params.id);
    res.json({ ok: true });
  });

  router.get("/api/peers/:id/file", (req, res) => {
    const entry = peers.get(req.params.id);
    if (entry?.role !== "leech" || !entry?.outFile)
      return res.status(404).json({ error: "không có file" });
    if (!entry.peer.completeTime)
      return res.status(409).json({ error: "chưa tải xong" });
    if (!fs.existsSync(entry.outFile))
      return res.status(404).json({ error: "file không tồn tại" });
    res.download(entry.outFile, entry.name);
  });

  // Đảm bảo URL luôn có dấu "/" cuối khi vào trang gốc của dashboard, để các
  // đường dẫn tương đối (fetch("api/..."), <script src="app.js">) trong
  // web/public/ luôn phân giải đúng theo tiền tố mount (vd /bittorrent/).
  router.get("/", (req, res, next) => {
    if (!req.originalUrl.endsWith("/"))
      return res.redirect(req.originalUrl + "/");
    next();
  });

  router.use(express.static(path.join(__dirname, "public")));

  // Error-handling middleware CỦA RIÊNG router này: bắt lỗi từ express.raw()
  // (vd PayloadTooLargeError khi file vượt MAX_UPLOAD_BYTES) và các lỗi khác
  // phát sinh trong các route ở trên, rồi trả về JSON thay vì để Express rơi
  // xuống trang lỗi HTML mặc định (khiến FE parse JSON bị lỗi "Unexpected
  // token '<'").
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const isTooLarge =
      err &&
      (err.status === 413 ||
        err.type === "entity.too.large" ||
        err.code === "LIMIT_FILE_SIZE");
    if (isTooLarge) {
      const maxMB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
      return res.status(413).json({ error: `File quá lớn, tối đa ${maxMB}MB` });
    }
    console.error("[bittorrent-api] lỗi:", err);
    res
      .status(err?.status || 500)
      .json({ error: err?.message || "Lỗi server" });
  });

  // Dọn peer khi process tắt (được gọi từ nơi mount router, xem web/server.js / server/index.js)
  router.stopAllPeers = () => {
    for (const { peer } of peers.values()) peer.stop();
  };

  return router;
}

module.exports = { createBittorrentRouter };
