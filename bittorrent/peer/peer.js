// @ts-check
/**
 * peer.js — Một nút (peer) trong mạng P2P: VỪA tải VỪA phục vụ upload.
 *
 * Đáp ứng các mục đề bài:
 *   (3) peer discovery  — lấy danh sách peer từ tracker.
 *   (4) tải song song nhiều peer — mở nhiều kết nối TCP, request các chunk
 *       khác nhau tới các peer khác nhau cùng lúc.
 *   (5) upload chunk sau khi tải được — mọi peer đều phục vụ REQUEST của peer
 *       khác (cơ chế swarm), báo HAVE khi có chunk mới.
 *   (6) kiểm tra toàn vẹn — verify SHA-256 từng chunk trước khi ghi.
 *   (7) ghép file — ChunkStore ghi chunk đúng offset, so hash toàn file.
 *   Xử lý lỗi — peer rời mạng / mất kết nối khi tải: chunk đang tải dở được
 *       đưa lại hàng đợi và thử peer khác; có timeout cho mỗi request.
 *
 * Về "đa luồng": Node.js chạy 1 luồng nhưng theo mô hình event-loop bất đồng
 * bộ (non-blocking I/O) nên xử lý HÀNG CHỤC kết nối/tải song song hiệu quả —
 * đây là dạng "đồng thời" (concurrency) mà đề bài chấp nhận.
 */

const net = require("net");
const http = require("http");
const { URL } = require("url");
const proto = require("../src/protocol");
const { PiecePicker } = require("../src/piece-picker");
const { verifyChunk, sha256 } = require("../src/torrent");
const fs = require("fs");

const MAX_INFLIGHT_PER_PEER = 8; // số request đồng thời tối đa gửi tới 1 peer
const REQUEST_TIMEOUT_MS = 8000; // quá hạn coi như mất chunk → thử lại
const ANNOUNCE_INTERVAL_MS = 5000; // nhịp heartbeat + xin peer mới từ tracker

/** In 1 dòng sự kiện dạng máy-đọc-được để harness thu thập số liệu. */
function emit(evt, data) {
  process.stdout.write("##EVT## " + JSON.stringify({ evt, t: Date.now(), ...data }) + "\n");
}

class Peer {
  /**
   * @param {object} opts
   * @param {object} opts.meta metadata của file
   * @param {import('../src/torrent').ChunkStore} opts.store kho chunk (seed hoặc leech)
   * @param {string} opts.trackerUrl vd http://localhost:4000
   * @param {number} opts.port cổng TCP peer này lắng nghe
   * @param {"rarest"|"random"} [opts.strategy]
   * @param {string} [opts.peerId]
   * @param {boolean} [opts.seedAfter] hoàn tất xong vẫn ở lại phục vụ (mặc định true)
   * @param {boolean} [opts.exitOnComplete] tải xong thì thoát tiến trình
   */
  constructor(opts) {
    this.meta = opts.meta;
    this.store = opts.store;
    this.trackerUrl = opts.trackerUrl;
    this.port = opts.port;
    this.host = opts.host || "127.0.0.1";
    this.strategy = opts.strategy || "rarest";
    this.peerId = opts.peerId || "P" + Math.random().toString(36).slice(2, 8).toUpperCase();
    this.seedAfter = opts.seedAfter !== false;
    this.exitOnComplete = !!opts.exitOnComplete;
    // Giới hạn tốc độ UPLOAD (KB/s) trên mỗi kết nối để mô phỏng mạng thật.
    // 0 = không giới hạn. Nhờ throttle, thí nghiệm kéo dài đủ để đo & để churn
    // xảy ra giữa chừng (localhost quá nhanh nếu không hạn chế).
    this.throttleKBps = Number(opts.throttleKBps) || 0;

    this.picker = new PiecePicker(this.meta.chunkCount, this.strategy);
    /** @type {Map<string, any>} peerId -> connection */
    this.conns = new Map();
    /** chunk đang được request dở: index -> { peerId, timer } */
    this.inFlight = new Map();

    this.bytesUp = 0;
    this.bytesDown = 0;
    this.sources = new Set(); // các peer mà ta đã tải chunk về → chứng minh tải đa nguồn
    this.startTime = Date.now();
    this.completeTime = null;
    this._announceTimer = null;
    this._statsTimer = null;
  }

  // ===================== KHỞI ĐỘNG =====================

  start() {
    // 1) Mở TCP server để phục vụ upload cho peer khác.
    this.server = net.createServer((socket) => this._onInbound(socket));
    this.server.listen(this.port, () => {
      // Nếu truyền port=0, hệ điều hành tự cấp cổng trống → đọc lại cổng thực
      // để announce đúng (quan trọng khi harness spawn nhiều peer trên 1 máy).
      this.port = this.server.address().port;
      emit("start", {
        peerId: this.peerId,
        port: this.port,
        role: this.store.isComplete() ? "seed" : "leech",
        have: this.store.count(),
        chunkCount: this.meta.chunkCount,
      });
      // 2) Announce lên tracker và lặp định kỳ (heartbeat + xin peer mới).
      this._announce("started");
      this._announceTimer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL_MS);
      // 3) In thống kê định kỳ.
      this._statsTimer = setInterval(() => this._printStats(), 1000);
      if (this.store.isComplete()) this._onComplete(); // seeder: xong ngay từ đầu
    });
  }

  stop() {
    clearInterval(this._announceTimer);
    clearInterval(this._statsTimer);
    this._announce("stopped");
    for (const c of this.conns.values()) c.socket.destroy();
    this.server?.close();
    this.store.close();
  }

  // ===================== GIAO TIẾP TRACKER =====================

  _announce(event) {
    const payload = JSON.stringify({
      infohash: this.meta.infohash,
      peerId: this.peerId,
      port: this.port,
      numHave: this.store.count(),
      event,
    });
    let u;
    try {
      u = new URL("/announce", this.trackerUrl);
    } catch (_) {
      return;
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (event === "stopped") return;
          try {
            const { peers } = JSON.parse(data);
            for (const p of peers || []) this._connectTo(p);
          } catch (_) {}
        });
      }
    );
    req.on("error", () => {}); // tracker tạm thời không phản hồi → bỏ qua nhịp này
    req.end(payload);
  }

  // ===================== KẾT NỐI PEER =====================

  /** Chủ động kết nối tới 1 peer lấy từ tracker (nếu chưa có). */
  _connectTo(info) {
    if (info.peerId === this.peerId) return;
    if (this.conns.has(info.peerId)) return; // đã có kết nối
    const socket = net.connect(info.port, info.host, () => {
      socket.write(proto.handshake(this.meta.infohash, this.peerId));
    });
    this._setupConn(socket, info.peerId, true);
  }

  /** Peer khác chủ động kết nối đến ta. */
  _onInbound(socket) {
    // Chưa biết peerId cho đến khi nhận HANDSHAKE.
    this._setupConn(socket, null, false);
  }

  _setupConn(socket, knownPeerId, isOutbound) {
    const conn = {
      socket,
      peerId: knownPeerId,
      isOutbound,
      remoteHave: new Uint8Array(this.meta.chunkCount),
      handshaked: false,
      inFlightCount: 0,
    };
    const parser = new proto.FrameParser((msg) => this._onMessage(conn, msg));
    socket.on("data", (chunk) => parser.push(chunk));
    socket.on("error", () => {}); // lỗi socket sẽ dẫn tới 'close'
    socket.on("close", () => this._onConnClose(conn));

    // Bên inbound gửi handshake đáp lại ngay; bên outbound đã gửi khi connect.
    if (!isOutbound) socket.write(proto.handshake(this.meta.infohash, this.peerId));
  }

  _registerConn(conn) {
    // Chống trùng: nếu đã có kết nối tới peerId này, đóng cái mới.
    if (this.conns.has(conn.peerId)) {
      conn.socket.destroy();
      return false;
    }
    this.conns.set(conn.peerId, conn);
    return true;
  }

  _onConnClose(conn) {
    if (!conn.peerId || this.conns.get(conn.peerId) !== conn) return;
    this.conns.delete(conn.peerId);
    // Gỡ đóng góp của peer này khỏi bảng độ phổ biến rarest-first.
    this.picker.removeBitfield(conn.remoteHave);
    // XỬ LÝ LỖI: mọi chunk đang tải dở từ peer này → đưa lại hàng đợi.
    for (const [index, rec] of this.inFlight) {
      if (rec.peerId === conn.peerId) {
        clearTimeout(rec.timer);
        this.inFlight.delete(index);
      }
    }
    emit("peer-disconnect", { peerId: this.peerId, remote: conn.peerId });
    this._schedule(); // thử tải lại từ peer khác
  }

  // ===================== XỬ LÝ MESSAGE =====================

  _onMessage(conn, msg) {
    switch (msg.type) {
      case proto.MSG.HANDSHAKE: {
        if (msg.infohash !== this.meta.infohash) {
          conn.socket.destroy();
          return;
        }
        conn.peerId = msg.peerId;
        conn.handshaked = true;
        if (!this._registerConn(conn)) return;
        // Trao đổi bitfield: cho peer biết ta đang có những chunk nào.
        conn.socket.write(proto.bitfield(this.store.have));
        break;
      }
      case proto.MSG.BITFIELD: {
        conn.remoteHave = msg.bitfield;
        this.picker.addBitfield(msg.bitfield);
        this._schedule(); // có thông tin mới → lên lịch tải
        break;
      }
      case proto.MSG.HAVE: {
        conn.remoteHave[msg.index] = 1;
        this.picker.incHave(msg.index);
        this._schedule();
        break;
      }
      case proto.MSG.REQUEST: {
        // Peer khác xin chunk → PHỤC VỤ UPLOAD nếu ta có.
        if (this.store.have[msg.index]) {
          const data = this.store.readChunk(msg.index);
          this._serve(conn, msg.index, data);
        }
        break;
      }
      case proto.MSG.PIECE: {
        this._onPiece(conn, msg.index, msg.data);
        break;
      }
    }
  }

  /**
   * Gửi 1 chunk cho peer, có áp dụng giới hạn tốc độ upload nếu bật throttle.
   * Cơ chế: nối các lần gửi trên cùng kết nối thành hàng đợi thời gian; mỗi
   * chunk chỉ được gửi khi "khe thời gian" tới, nhờ đó tốc độ upload ≈ throttle.
   */
  _serve(conn, index, data) {
    const send = () => {
      if (conn.socket.destroyed) return;
      conn.socket.write(proto.piece(index, data));
      this.bytesUp += data.length;
    };
    if (this.throttleKBps <= 0) return send();
    const delayMs = (data.length / (this.throttleKBps * 1024)) * 1000;
    const now = Date.now();
    conn.nextSendAt = Math.max(now, conn.nextSendAt || 0);
    const at = conn.nextSendAt;
    conn.nextSendAt += delayMs;
    setTimeout(send, at - now);
  }

  _onPiece(conn, index, data) {
    const rec = this.inFlight.get(index);
    // Chỉ nhận nếu ta thực sự đang chờ chunk này.
    if (!rec) return;
    clearTimeout(rec.timer);
    this.inFlight.delete(index);
    conn.inFlightCount = Math.max(0, conn.inFlightCount - 1);

    // KIỂM TRA TOÀN VẸN (mục 6): sai hash → coi như chưa có, thử lại sau.
    if (!verifyChunk(this.meta, index, data)) {
      emit("bad-chunk", { peerId: this.peerId, index, from: conn.peerId });
      this._schedule();
      return;
    }

    const isNew = this.store.writeChunk(index, data);
    if (isNew) {
      this.bytesDown += data.length;
      this.sources.add(conn.peerId);
      // Báo HAVE cho TẤT CẢ peer → ta trở thành nguồn phát chunk này (swarm).
      for (const c of this.conns.values()) {
        if (c.handshaked) c.socket.write(proto.have(index));
      }
    }

    if (this.store.isComplete()) {
      this._onComplete();
    } else {
      this._schedule();
    }
  }

  // ===================== ĐIỀU PHỐI TẢI SONG SONG =====================

  /**
   * Với mỗi kết nối còn "slot" trống, chọn 1 chunk peer đó có mà ta thiếu và
   * gửi REQUEST. Nhờ chạy trên nhiều kết nối, các chunk khác nhau được tải
   * SONG SONG từ nhiều peer (đề bài mục 4).
   */
  _schedule() {
    if (this.store.isComplete()) return;
    for (const conn of this.conns.values()) {
      if (!conn.handshaked) continue;
      while (conn.inFlightCount < MAX_INFLIGHT_PER_PEER) {
        const index = this.picker.pick(
          this.store.have,
          new Set(this.inFlight.keys()),
          (i) => !!conn.remoteHave[i] // chỉ chọn chunk mà peer NÀY đang có
        );
        if (index < 0) break; // peer này không còn chunk nào ta cần
        this._sendRequest(conn, index);
      }
    }
  }

  _sendRequest(conn, index) {
    conn.socket.write(proto.request(index));
    conn.inFlightCount++;
    // Timeout: nếu quá hạn chưa nhận PIECE → mất chunk, đưa lại hàng đợi.
    const timer = setTimeout(() => {
      if (this.inFlight.get(index)) {
        this.inFlight.delete(index);
        conn.inFlightCount = Math.max(0, conn.inFlightCount - 1);
        emit("timeout-chunk", { peerId: this.peerId, index, from: conn.peerId });
        this._schedule();
      }
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    this.inFlight.set(index, { peerId: conn.peerId, timer });
  }

  // ===================== HOÀN TẤT & THỐNG KÊ =====================

  _onComplete() {
    if (this.completeTime) return;
    this.completeTime = Date.now();
    // Kiểm tra hash TOÀN FILE lần cuối sau khi ghép (đề bài mục 7).
    let fileOk = true;
    if (!this.store.seedOrigin) {
      try {
        const full = fs.readFileSync(this.store.filePath);
        fileOk = sha256(full) === this.meta.fileHash;
      } catch (_) {
        fileOk = false;
      }
    }
    const ms = this.completeTime - this.startTime;
    emit("complete", {
      peerId: this.peerId,
      ms,
      bytesDown: this.bytesDown,
      bytesUp: this.bytesUp,
      fileOk,
      sources: this.sources.size, // số peer khác nhau đã tải về → tải song song đa nguồn
      throughputKBps: ms > 0 ? Math.round((this.bytesDown / 1024 / ms) * 1000) : 0,
    });
    console.log(
      `[peer ${this.peerId}] ✅ HOÀN TẤT trong ${ms}ms | tải ${(this.bytesDown / 1024).toFixed(0)}KB | ` +
        `up ${(this.bytesUp / 1024).toFixed(0)}KB | hash file: ${fileOk ? "OK ✓" : "SAI ✗"}`
    );
    if (this.exitOnComplete && !this.seedAfter) {
      setTimeout(() => this.stop(), 200);
    }
  }

  _printStats() {
    emit("stats", {
      peerId: this.peerId,
      have: this.store.count(),
      chunkCount: this.meta.chunkCount,
      peers: this.conns.size,
      bytesDown: this.bytesDown,
      bytesUp: this.bytesUp,
      done: !!this.completeTime,
    });
  }
}

module.exports = { Peer, emit };
