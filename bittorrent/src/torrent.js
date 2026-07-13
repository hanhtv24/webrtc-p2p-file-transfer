// @ts-check
/**
 * torrent.js — Chia file thành chunk, tạo metadata và kiểm tra toàn vẹn.
 *
 * Đây là "trái tim" của cơ chế BitTorrent, đáp ứng đề bài mục 1 & 6:
 *   - Chia file thành nhiều chunk (mảnh nhỏ cố định kích thước).
 *   - Với mỗi chunk, tính hash SHA-256 (vân tay số) để sau này KIỂM TRA
 *     dữ liệu tải về có bị hỏng/giả mạo không.
 *   - Đóng gói tất cả vào 1 file metadata (.meta.json) — tương đương file
 *     ".torrent" thật. Peer chỉ cần file này là biết cần tải bao nhiêu chunk,
 *     mỗi chunk hash gì, để tải từ swarm rồi ghép lại.
 */

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256KB — cân bằng giữa overhead và độ mịn

/** Tính SHA-256 (hex) của 1 Buffer. */
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Tạo metadata cho 1 file: đọc file, cắt chunk, hash từng chunk.
 * @param {string} filePath đường dẫn file gốc
 * @param {number} [chunkSize]
 * @returns {object} metadata
 */
function createMetadata(filePath, chunkSize = DEFAULT_CHUNK_SIZE) {
  const data = fs.readFileSync(filePath);
  const size = data.length;
  const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
  const chunkHashes = [];

  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, size);
    chunkHashes.push(sha256(data.subarray(start, end)));
  }

  const meta = {
    name: path.basename(filePath),
    size,
    chunkSize,
    chunkCount,
    chunkHashes,
    fileHash: sha256(data), // hash toàn file để kiểm tra lần cuối sau khi ghép
  };
  // infohash: định danh duy nhất của "torrent" này = hash của metadata lõi.
  // Peer & tracker dùng infohash để biết chúng đang nói về cùng một file.
  meta.infohash = sha256(
    Buffer.from(
      JSON.stringify({
        name: meta.name,
        size: meta.size,
        chunkSize: meta.chunkSize,
        chunkHashes: meta.chunkHashes,
      })
    )
  );
  return meta;
}

/**
 * Ghi metadata ra file <name>.meta.json cạnh file gốc (hoặc outPath tuỳ chọn).
 * @returns {string} đường dẫn file metadata đã ghi
 */
function saveMetadata(meta, outPath) {
  const p = outPath || meta.name + ".meta.json";
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
  return p;
}

/** Đọc metadata từ file .meta.json */
function loadMetadata(metaPath) {
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

/**
 * Kiểm tra 1 chunk tải về có đúng hash trong metadata không (đề bài mục 6).
 * @param {object} meta
 * @param {number} index vị trí chunk
 * @param {Buffer} data dữ liệu chunk nhận được
 * @returns {boolean} true nếu toàn vẹn
 */
function verifyChunk(meta, index, data) {
  return sha256(data) === meta.chunkHashes[index];
}

/** Kích thước (byte) của chunk thứ index (chunk cuối có thể ngắn hơn). */
function chunkLength(meta, index) {
  if (index < meta.chunkCount - 1) return meta.chunkSize;
  return meta.size - meta.chunkSize * (meta.chunkCount - 1);
}

/**
 * ChunkStore — nơi lưu các chunk của 1 file trên đĩa, cho cả seeder lẫn leecher.
 *
 * - Seeder: nạp từ file gốc, có sẵn toàn bộ chunk.
 * - Leecher: khởi tạo rỗng, ghi dần từng chunk khi tải & verify xong.
 *
 * Dùng 1 file duy nhất kích thước bằng file gốc, ghi chunk vào đúng offset
 * (random-access) — không cần giữ toàn bộ trong RAM.
 */
class ChunkStore {
  /**
   * @param {object} meta metadata
   * @param {string} filePath đường dẫn file dữ liệu (đích để ghép)
   * @param {Uint8Array} [have] bitfield ban đầu (1 = đã có chunk)
   */
  constructor(meta, filePath, have) {
    this.meta = meta;
    this.filePath = filePath;
    this.have = have || new Uint8Array(meta.chunkCount); // 0 = chưa có
  }

  /** Seeder: mở file gốc đã tồn tại, đánh dấu có đủ mọi chunk. */
  static openSeed(meta, filePath) {
    const store = new ChunkStore(meta, filePath, new Uint8Array(meta.chunkCount).fill(1));
    store.fd = fs.openSync(filePath, "r");
    store.seedOrigin = true; // là file gốc → không cần verify lại hash toàn file
    return store;
  }

  /** Leecher: tạo file đích rỗng (đúng kích thước) để ghi chunk vào. */
  static openLeech(meta, filePath) {
    // Cấp phát sẵn file đúng size để có thể ghi random-access theo offset.
    const fd = fs.openSync(filePath, "w+");
    if (meta.size > 0) {
      fs.ftruncateSync(fd, meta.size);
    }
    const store = new ChunkStore(meta, filePath, new Uint8Array(meta.chunkCount));
    store.fd = fd;
    return store;
  }

  /** Đọc chunk thứ index từ đĩa (để phục vụ upload cho peer khác). */
  readChunk(index) {
    const len = chunkLength(this.meta, index);
    const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, index * this.meta.chunkSize);
    return buf;
  }

  /**
   * Ghi chunk đã VERIFY thành công vào đĩa, cập nhật bitfield.
   * @returns {boolean} true nếu là chunk mới (trước đó chưa có)
   */
  writeChunk(index, data) {
    if (this.have[index]) return false;
    fs.writeSync(this.fd, data, 0, data.length, index * this.meta.chunkSize);
    this.have[index] = 1;
    return true;
  }

  /** Đã tải đủ toàn bộ chunk chưa? */
  isComplete() {
    return this.have.every((b) => b === 1);
  }

  /** Số chunk hiện có. */
  count() {
    return this.have.reduce((a, b) => a + b, 0);
  }

  close() {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch (_) {}
      this.fd = undefined;
    }
  }
}

module.exports = {
  DEFAULT_CHUNK_SIZE,
  sha256,
  createMetadata,
  saveMetadata,
  loadMetadata,
  verifyChunk,
  chunkLength,
  ChunkStore,
};
