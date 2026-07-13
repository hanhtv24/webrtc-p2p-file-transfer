// @ts-check
/**
 * tracker.js — Tracker / Bootstrap server (đề bài mục 2 & 3).
 *
 * Tracker KHÔNG truyền dữ liệu file. Nhiệm vụ duy nhất của nó là làm "danh bạ":
 *   - Ghi nhận peer nào đang tham gia swarm của file nào (theo infohash).
 *   - Trả về danh sách peer cho peer mới → đó chính là "peer discovery".
 *   - Phát hiện peer rời mạng (churn) bằng cơ chế heartbeat + timeout.
 *
 * Dùng HTTP (module `http` built-in) cho đơn giản và dễ debug bằng trình duyệt/
 * curl. Mỗi peer gọi POST /announce định kỳ để vừa "điểm danh" vừa lấy danh
 * sách peer mới nhất.
 *
 * Trạng thái:
 *   swarms: Map<infohash, Map<peerId, { host, port, numHave, lastSeen }>>
 */

const http = require("http");

const PEER_TIMEOUT_MS = 15000; // quá 15s không heartbeat → coi như đã rời mạng

class Tracker {
  constructor() {
    /** @type {Map<string, Map<string, any>>} */
    this.swarms = new Map();
    // Định kỳ dọn các peer "chết" (churn) khỏi danh bạ.
    this.sweeper = setInterval(() => this._evictStale(), 5000);
    this.sweeper.unref?.();
  }

  _swarm(infohash) {
    if (!this.swarms.has(infohash)) this.swarms.set(infohash, new Map());
    return this.swarms.get(infohash);
  }

  _evictStale() {
    const now = Date.now();
    for (const [infohash, peers] of this.swarms) {
      for (const [peerId, p] of peers) {
        if (now - p.lastSeen > PEER_TIMEOUT_MS) {
          peers.delete(peerId);
          console.log(`[tracker] peer rời mạng (timeout): ${peerId} @ ${infohash.slice(0, 8)}`);
        }
      }
      if (peers.size === 0) this.swarms.delete(infohash);
    }
  }

  /**
   * Xử lý announce: cập nhật/đăng ký peer, trả về danh sách peer KHÁC.
   * @param {object} body { infohash, peerId, port, numHave, event }
   * @param {string} host địa chỉ IP nhìn thấy từ kết nối
   */
  announce(body, host) {
    const { infohash, peerId, port, numHave = 0, event } = body;
    const peers = this._swarm(infohash);

    if (event === "stopped") {
      peers.delete(peerId);
      console.log(`[tracker] peer rời swarm (chủ động): ${peerId}`);
      return { peers: [] };
    }

    const existed = peers.has(peerId);
    peers.set(peerId, { host, port, numHave, lastSeen: Date.now() });
    if (!existed) {
      console.log(
        `[tracker] peer tham gia: ${peerId} @ ${host}:${port} | file ${infohash.slice(0, 8)} | swarm=${peers.size}`
      );
    }

    // Trả về mọi peer khác để peer này kết nối tới (không gồm chính nó).
    const list = [];
    for (const [id, p] of peers) {
      if (id === peerId) continue;
      list.push({ peerId: id, host: p.host, port: p.port, numHave: p.numHave });
    }
    return { peers: list, interval: 5 };
  }

  /** Thống kê nhanh cho từng swarm (đề bài mục thống kê). */
  scrape() {
    const out = {};
    for (const [infohash, peers] of this.swarms) {
      out[infohash] = { peers: peers.size };
    }
    return out;
  }
}

/** Đọc toàn bộ body của request rồi parse JSON. */
function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

function clientHost(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket.remoteAddress || "").replace("::ffff:", "").replace("::1", "127.0.0.1");
}

/**
 * Khởi động tracker HTTP.
 * @param {number} port
 * @returns {Promise<{server: http.Server, tracker: Tracker}>}
 */
function startTracker(port = 4000) {
  const tracker = new Tracker();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/announce") {
      const body = await readJson(req);
      const result = tracker.announce(body, clientHost(req));
      res.end(JSON.stringify(result));
    } else if (req.method === "GET" && req.url.startsWith("/scrape")) {
      res.end(JSON.stringify(tracker.scrape()));
    } else if (req.method === "GET" && req.url === "/") {
      res.end(JSON.stringify({ ok: true, swarms: tracker.swarms.size }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[tracker] đang chạy tại http://localhost:${port}  (announce/scrape)`);
      resolve({ server, tracker });
    });
  });
}

module.exports = { Tracker, startTracker, PEER_TIMEOUT_MS };

// Cho phép chạy trực tiếp: node tracker.js [port]
if (require.main === module) {
  startTracker(Number(process.argv[2]) || 4000);
}
