/**
 * WebRTC Handler - P2P File Transfer
 * Cải tiến: SHA-256 hash verification, multi-peer connections, chunk-level tracking
 */

// ─── Tiện ích hash ────────────────────────────────────────────────────────────

async function sha256Hex(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256File(file) {
  const buffer = await file.arrayBuffer();
  return sha256Hex(buffer);
}

// ─── Lớp quản lý một kết nối P2P ─────────────────────────────────────────────

class PeerConnection {
  constructor(socket, remoteSocketId, remotePeerId, handler) {
    this.socket         = socket;
    this.remoteSocketId = remoteSocketId;
    this.remotePeerId   = remotePeerId;
    this.handler        = handler;

    this.pc          = null;
    this.dataChannel = null;
    this.state       = 'connecting'; // connecting | open | closed

    this.receivingFiles = new Map(); // fileId -> { meta, chunks[], receivedSize, chunkStatus[] }
  }

  get isOpen() { return this.state === 'open'; }

  // ── Tạo kết nối (caller) ──────────────────────────────────────────────────
  async initiate() {
    this._createPC();
    this.dataChannel = this.pc.createDataChannel('p2p', { ordered: true });
    this._bindDataChannel(this.dataChannel);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.socket.emit('sdp-offer', { targetSocketId: this.remoteSocketId, sdp: offer });
  }

  // ── Xử lý offer đến (callee) ──────────────────────────────────────────────
  async handleOffer(sdp) {
    this._createPC();
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.socket.emit('sdp-answer', { targetSocketId: this.remoteSocketId, sdp: answer });
  }

  async handleAnswer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async addIceCandidate(candidate) {
    if (this.pc && candidate) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn('[ICE] addIceCandidate error:', e.message); }
    }
  }

  send(data) {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(data);
      return true;
    }
    return false;
  }

  sendJSON(obj) { return this.send(JSON.stringify(obj)); }

  // ── Gửi file với hash từng chunk ──────────────────────────────────────────
  async sendFile(file, fileId, onProgress) {
    const CHUNK       = 16384;
    const totalChunks = Math.ceil(file.size / CHUNK);
    const fileHash    = await sha256File(file);

    this.sendJSON({
      type: 'file-start', fileId,
      name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks, fileHash,
    });

    const buffer = await file.arrayBuffer();
    let chunkIndex = 0;
    let sentBytes  = 0;

    for (let offset = 0; offset < buffer.byteLength; offset += CHUNK) {
      const slice     = buffer.slice(offset, Math.min(offset + CHUNK, buffer.byteLength));
      const chunkHash = await sha256Hex(slice);

      // 🧪 DEMO: bật SIMULATE_CORRUPTION = true để giả lập chunk bị lỗi (hiển thị ô đỏ)
      // Chunk thứ 2 (index 1) sẽ có hash sai → bên nhận phát hiện ngay
      const SIMULATE_CORRUPTION = false;
      const corruptedHash = (SIMULATE_CORRUPTION && chunkIndex === 1)
        ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        : chunkHash;

      // Frame: [4B chunkIdx][4B fileIdLen][fileId][4B hashLen][hash][data]
      const fileIdB = new TextEncoder().encode(fileId);
      const hashB   = new TextEncoder().encode(corruptedHash);
      const frame   = new ArrayBuffer(4 + 4 + fileIdB.length + 4 + hashB.length + slice.byteLength);
      const view    = new DataView(frame);
      const u8      = new Uint8Array(frame);
      let pos = 0;
      view.setInt32(pos, chunkIndex, true);      pos += 4;
      view.setInt32(pos, fileIdB.length, true);  pos += 4;
      u8.set(fileIdB, pos);                      pos += fileIdB.length;
      view.setInt32(pos, hashB.length, true);    pos += 4;
      u8.set(hashB, pos);                        pos += hashB.length;
      u8.set(new Uint8Array(slice), pos);

      // Flow control
      while (this.dataChannel.bufferedAmount > 8 * 1024 * 1024) {
        await new Promise(r => setTimeout(r, 20));
      }

      this.send(frame);
      sentBytes += slice.byteLength;
      chunkIndex++;

      if (onProgress) {
        onProgress(fileId, sentBytes / file.size * 100, sentBytes, file.size, chunkIndex - 1, 'sending');
      }
    }

    this.sendJSON({ type: 'file-end', fileId, fileHash });
  }

  close() {
    this.state = 'closed';
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (e) { console.warn('[close] dataChannel.close() lỗi:', e.message); }
    }
    if (this.pc) {
      try { this.pc.close(); } catch (e) { console.warn('[close] pc.close() lỗi:', e.message); }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _createPC() {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302'  },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ]
    });

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit('ice-candidate', { targetSocketId: this.remoteSocketId, candidate });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      console.log(`[ICE ${this.remotePeerId}] ${s}`);
      if (s === 'connected' || s === 'completed') {
        this.handler._onPeerICEConnected(this);
      } else if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        this.handler._onPeerDisconnected(this);
      }
    };

    this.pc.ondatachannel = ({ channel }) => { this._bindDataChannel(channel); };
  }

  _bindDataChannel(dc) {
    this.dataChannel            = dc;
    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen  = () => {
      this.state = 'open';
      this.handler._onDataChannelOpen(this);
    };
    this.dataChannel.onclose = () => {
      this.state = 'closed';
      this.handler._onPeerDisconnected(this);
    };
    this.dataChannel.onerror   = err => console.error(`[DC ${this.remotePeerId}]`, err);
    this.dataChannel.onmessage = ({ data }) => this._onMessage(data);
  }

  _onMessage(data) {
    if (typeof data === 'string') {
      this._onJSON(JSON.parse(data));
    } else {
      this._onChunk(data);
    }
  }

  _onJSON(msg) {
    const h = this.handler;
    switch (msg.type) {
      case 'file-list':    h._onFileList(this, msg.files);            break;
      case 'file-request': h._onFileRequest(this, msg.fileId);        break;
      case 'file-start':
        this.receivingFiles.set(msg.fileId, {
          name: msg.name, size: msg.size, mimeType: msg.mimeType,
          totalChunks: msg.totalChunks, fileHash: msg.fileHash,
          chunks: new Array(msg.totalChunks),
          chunkStatus: new Array(msg.totalChunks).fill('pending'),
          receivedCount: 0, receivedSize: 0,
        });
        h._onFileStart(this, msg);
        break;
      case 'file-end': {
        const rf = this.receivingFiles.get(msg.fileId);
        if (rf) this._assembleFile(msg.fileId, rf, msg.fileHash);
        break;
      }
    }
  }

  _onChunk(raw) {
    const view = new DataView(raw);
    const u8   = new Uint8Array(raw);
    let pos = 0;

    const chunkIndex = view.getInt32(pos, true); pos += 4;
    const fileIdLen  = view.getInt32(pos, true); pos += 4;
    const fileId     = new TextDecoder().decode(u8.slice(pos, pos + fileIdLen)); pos += fileIdLen;
    const hashLen    = view.getInt32(pos, true); pos += 4;
    const sentHash   = new TextDecoder().decode(u8.slice(pos, pos + hashLen));   pos += hashLen;
    const chunkData  = u8.slice(pos);

    const rf = this.receivingFiles.get(fileId);
    if (!rf) return;

    // Verify hash async
    sha256Hex(chunkData.buffer).then(computed => {
      const ok = computed === sentHash;
      rf.chunkStatus[chunkIndex] = ok ? 'ok' : 'bad';
      if (!ok) console.warn(`[Hash] Chunk ${chunkIndex} của "${rf.name}" bị lỗi!`);

      rf.chunks[chunkIndex] = chunkData;
      rf.receivedCount++;
      rf.receivedSize += chunkData.length;

      const pct = rf.receivedSize / rf.size * 100;
      this.handler._onFileProgress(this, fileId, {
        pct, cur: rf.receivedSize, tot: rf.size,
        chunkIdx: chunkIndex, chunkStatus: [...rf.chunkStatus], dir: 'receiving',
      });
    });
  }

  async _assembleFile(fileId, rf, declaredHash) {
    const blob        = new Blob(rf.chunks, { type: rf.mimeType });
    const fileBuffer  = await blob.arrayBuffer();
    const actualHash  = await sha256Hex(fileBuffer);
    const hashOk      = actualHash === declaredHash;

    if (!hashOk) console.error(`[Hash] File "${rf.name}" hash mismatch!`);

    this.handler._onFileComplete(this, fileId, {
      blob, name: rf.name, size: rf.size,
      chunkStatus: [...rf.chunkStatus], hashOk, dir: 'receiving',
    });
    this.receivingFiles.delete(fileId);
  }
}

// ─── WebRTCHandler: quản lý nhiều PeerConnection ─────────────────────────────

class WebRTCHandler {
  constructor() {
    /** @type {Map<string, PeerConnection>} socketId → PeerConnection */
    this.connections = new Map();

    /** Files đang share: fileId → { file, id, name, size, type } */
    this.sharedFiles = new Map();

    // Callbacks
    this.onPeerConnected    = null; // (peerId, socketId)
    this.onPeerDisconnected = null; // (peerId, socketId)
    this.onFileList         = null; // (peerId, socketId, files[])
    this.onFileStart        = null; // (peerId, meta)
    this.onFileProgress     = null; // (peerId, fileId, {pct, cur, tot, chunkIdx, chunkStatus[], dir})
    this.onFileComplete     = null; // (peerId, fileId, {blob, name, size, chunkStatus[], hashOk, dir})
    this.onFileRequest      = null; // (peerId, fileId)
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async connect(socket, targetSocketId, targetPeerId) {
    if (this.connections.has(targetSocketId)) return;
    const conn = new PeerConnection(socket, targetSocketId, targetPeerId, this);
    this.connections.set(targetSocketId, conn);
    await conn.initiate();
  }

  async handleOffer(socket, sdp, fromSocketId, fromPeerId) {
    let conn = this.connections.get(fromSocketId);
    if (!conn) {
      conn = new PeerConnection(socket, fromSocketId, fromPeerId, this);
      this.connections.set(fromSocketId, conn);
    }
    await conn.handleOffer(sdp);
  }

  async handleAnswer(sdp, fromSocketId) {
    const conn = this.connections.get(fromSocketId);
    if (conn) await conn.handleAnswer(sdp);
  }

  async handleIceCandidate(candidate, fromSocketId) {
    const conn = this.connections.get(fromSocketId);
    if (conn) await conn.addIceCandidate(candidate);
  }

  /** Gửi danh sách file đang share cho một peer */
  sendFileList(socketId) {
    const conn = this.connections.get(socketId);
    if (!conn?.isOpen) return;
    const files = Array.from(this.sharedFiles.values()).map(f => ({
      id: f.id, name: f.name, size: f.size, type: f.type,
    }));
    conn.sendJSON({ type: 'file-list', files });
  }

  /** Gửi danh sách file cho tất cả peers đang kết nối */
  sendFileListToAll() {
    for (const [socketId] of this.connections) {
      this.sendFileList(socketId);
    }
  }

  /** Yêu cầu nhận file từ một peer */
  requestFile(socketId, fileId) {
    const conn = this.connections.get(socketId);
    if (conn?.isOpen) {
      conn.sendJSON({ type: 'file-request', fileId });
    }
  }

  /** Kiểm tra có kết nối P2P mở với socketId không */
  isConnected(socketId) {
    const conn = this.connections.get(socketId);
    return !!conn?.isOpen;
  }

  /** Số kết nối P2P đang mở */
  get activeCount() {
    let n = 0;
    for (const conn of this.connections.values()) {
      if (conn.isOpen) n++;
    }
    return n;
  }

  // ── Internal callbacks ────────────────────────────────────────────────────

  _onDataChannelOpen(conn) {
    // Data channel mở -> kết nối P2P hoàn tất (đây mới là thời điểm đúng)
    if (this.onPeerConnected) this.onPeerConnected(conn.remotePeerId, conn.remoteSocketId);
  }

  _onPeerICEConnected(conn) {
    // ICE connected — chờ data channel mở mới báo lên UI
    console.log(`[P2P ${conn.remotePeerId}] ICE connected, waiting for DataChannel...`);
  }

  _onPeerDisconnected(conn) {
    if (conn.state === 'closed') return; // đã xử lý
    conn.state = 'closed';
    this.connections.delete(conn.remoteSocketId);
    if (this.onPeerDisconnected) this.onPeerDisconnected(conn.remotePeerId, conn.remoteSocketId);
  }

  _onFileList(conn, files) {
    if (this.onFileList) this.onFileList(conn.remotePeerId, conn.remoteSocketId, files);
  }

  _onFileRequest(conn, fileId) {
    const shared = this.sharedFiles.get(fileId);
    if (!shared) return;
    if (this.onFileRequest) this.onFileRequest(conn.remotePeerId, fileId);
    // Bắt đầu gửi file
    conn.sendFile(shared.file, fileId, (fid, pct, cur, tot, idx, dir) => {
      if (this.onFileProgress) {
        this.onFileProgress(conn.remotePeerId, fid, { pct, cur, tot, chunkIdx: idx, chunkStatus: null, dir });
      }
    }).then(() => {
      if (this.onFileComplete) {
        this.onFileComplete(conn.remotePeerId, fileId, { blob: null, name: shared.name, size: shared.size, chunkStatus: [], hashOk: true, dir: 'sending' });
      }
    });
  }

  _onFileStart(conn, meta) {
    if (this.onFileStart) this.onFileStart(conn.remotePeerId, meta);
  }

  _onFileProgress(conn, fileId, info) {
    if (this.onFileProgress) {
      this.onFileProgress(conn.remotePeerId, fileId, info);
    }
  }

  _onFileComplete(conn, fileId, info) {
    if (this.onFileComplete) {
      this.onFileComplete(conn.remotePeerId, fileId, info);
    }
  }
}
