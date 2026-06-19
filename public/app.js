/**
 * P2P Transfer — Main Application
 * Multi-peer, SHA-256 hash verification, chunk map visualization
 */

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  socket:       null,
  mySocketId:   null,
  myPeerId:     null,
  myName:       '',
  peers:        [],           // danh sách từ server [{socketId, id, name, avatar, ...}]
  webrtc:       null,

  // file management
  myShared:     new Map(),    // fileId → { file, id, name, size, type }
  peerFiles:    new Map(),    // socketId → Map(fileId → {id,name,size,type})
  received:     new Map(),    // fileId → { blob, name, size, hashOk }

  // transfer tracking
  transfers:    new Map(),    // fileId → { name, size, dir, peerId, startTime, progress, chunkStatus[] }

  // stats
  sentBytes:    0,
  recvBytes:    0,
  lastSent:     0,
  lastRecv:     0,
  lastTime:     Date.now(),
};

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  state.socket = io();
  state.webrtc = new WebRTCHandler();
  setupSocket();
  setupUI();
  setupWebRTC();
  setInterval(updateStats, 1000);
}

// ─── Socket ───────────────────────────────────────────────────────────────────

function setupSocket() {
  const { socket } = state;

  socket.on('connect', () => { state.mySocketId = socket.id; });

  socket.on('your-id', async data => {
    state.myPeerId = data.peerId;
    state.myName   = `${data.animalName} ${data.peerId}`;

    // Show header elements
    $('my-peer-id').textContent = data.peerId;
    $('id-badge').style.display = '';
    $('ip-badge').style.display = '';
    $('conn-overlay').classList.add('hidden');
    $('name-edit').style.display = '';
    $('name-input').value = state.myName;

    // Local IP từ server
    $('my-ip').textContent = data.ip;

    // Lấy public IP qua STUN
    getPublicIP().then(ip => {
      if (ip) $('my-ip').textContent = ip;
    });

    toast('info', `${data.avatar} Đã kết nối`, `${data.animalName} · ${data.deviceIcon} ${data.device}`);
  });

  socket.on('peer-list', list => {
    state.peers = list;
    renderPeerList();
    $('stat-peers').textContent = list.filter(p => p.socketId !== state.mySocketId).length;
  });

  socket.on('peer-not-found', id => toast('error', 'Không tìm thấy', `Peer "${id}" không tồn tại`));

  socket.on('name-changed', name => { state.myName = name; });

  // WebRTC signaling relay
  socket.on('sdp-offer', ({ sdp, fromSocketId, fromPeerId }) => {
    state.webrtc.handleOffer(socket, sdp, fromSocketId, fromPeerId);
  });
  socket.on('sdp-answer', ({ sdp, fromSocketId }) => {
    state.webrtc.handleAnswer(sdp, fromSocketId);
  });
  socket.on('ice-candidate', ({ candidate, fromSocketId }) => {
    state.webrtc.handleIceCandidate(candidate, fromSocketId);
  });

  socket.on('disconnect', () => {
    $('conn-overlay').classList.remove('hidden');
  });
}

// ─── WebRTC callbacks ─────────────────────────────────────────────────────────

function setupWebRTC() {
  const { webrtc } = state;

  webrtc.onPeerConnected = (peerId, socketId) => {
    toast('success', 'P2P kết nối', `Đã kết nối với ${peerId}`);
    $('drop-zone').classList.remove('hidden');
    $('empty-state').style.display = 'none';
    $('stat-connections').textContent = webrtc.activeCount;
    renderPeerList();
    // Gửi danh sách file hiện có ngay
    webrtc.sendFileList(socketId);
    // Tạo section file cho peer
    renderPeerFilesSection(socketId, peerId, []);
  };

  webrtc.onPeerDisconnected = (peerId, socketId) => {
    toast('error', 'Mất kết nối', `${peerId} đã ngắt kết nối`);
    state.peerFiles.delete(socketId);
    $(`peer-section-${socketId}`)?.remove();
    $('stat-connections').textContent = webrtc.activeCount;
    if (webrtc.activeCount === 0) {
      $('drop-zone').classList.add('hidden');
      if (state.transfers.size === 0 && state.received.size === 0) {
        $('empty-state').style.display = '';
      }
    }
    renderPeerList();
  };

  webrtc.onFileList = (peerId, socketId, files) => {
    state.peerFiles.set(socketId, new Map(files.map(f => [f.id, f])));
    renderPeerFilesSection(socketId, peerId, files);
  };

  webrtc.onFileStart = (peerId, meta) => {
    addTransferCard(meta.fileId, meta.name, meta.size, meta.totalChunks, 'receiving', peerId);
  };

  webrtc.onFileProgress = (peerId, fileId, pct, cur, tot, chunkIdx, chunkStatus, dir) => {
    updateTransferCard(fileId, pct, cur, tot, chunkIdx, chunkStatus);
    if (dir === 'receiving') state.recvBytes += (tot / (tot / 16384 || 1) * 0.01);
    else                     state.sentBytes += (tot / (tot / 16384 || 1) * 0.01);
  };

  webrtc.onFileComplete = (peerId, fileId, blob, name, size, chunkStatus, hashOk, dir) => {
    finishTransferCard(fileId, hashOk);
    if (dir === 'receiving' && blob) {
      state.received.set(fileId, { blob, name, size, hashOk });
      addReceivedRow(fileId, name, size, hashOk);
      state.recvBytes += size;
      toast(hashOk ? 'success' : 'error',
        hashOk ? `Nhận xong: ${name}` : `Cảnh báo hash: ${name}`,
        hashOk ? `SHA-256 ✓ · ${fmtBytes(size)}` : 'Hash không khớp — file có thể bị hỏng');
    } else if (dir === 'sending') {
      state.sentBytes += size;
      toast('success', `Gửi xong: ${name}`, fmtBytes(size));
    }
    $('stat-sent').textContent     = fmtBytes(state.sentBytes);
    $('stat-received').textContent = fmtBytes(state.recvBytes);
  };

  webrtc.onFileRequest = (peerId, fileId) => {
    const f = state.myShared.get(fileId);
    if (f) addTransferCard(fileId, f.name, f.size, Math.ceil(f.size / 16384), 'sending', peerId);
  };
}

// ─── UI handlers ──────────────────────────────────────────────────────────────

function setupUI() {
  // Connect button
  $('connect-btn').onclick = () => {
    const id = $('target-id-input').value.trim().toUpperCase();
    if (!id || id === state.myPeerId) return;
    connectToPeer(id);
  };
  $('target-id-input').onkeydown = e => { if (e.key === 'Enter') $('connect-btn').click(); };
  $('target-id-input').oninput   = e => { e.target.value = e.target.value.toUpperCase(); };

  // Copy ID
  $('copy-id-btn').onclick = () => {
    navigator.clipboard.writeText(state.myPeerId);
    toast('info', 'Đã sao chép', 'Peer ID đã sao chép vào clipboard');
  };

  // Name
  $('save-name-btn').onclick = () => {
    const n = $('name-input').value.trim();
    if (n && n !== state.myName) state.socket.emit('change-name', n);
  };
  $('name-input').onkeydown = e => { if (e.key === 'Enter') $('save-name-btn').click(); };

  // Drop zone
  const dz = $('drop-zone');
  dz.onclick = () => $('file-input').click();
  dz.ondragover  = e => { e.preventDefault(); dz.classList.add('dragover'); };
  dz.ondragleave = () => dz.classList.remove('dragover');
  dz.ondrop      = e => { e.preventDefault(); dz.classList.remove('dragover'); addFiles(e.dataTransfer.files); };
  $('file-input').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
}

// ─── Peers list ───────────────────────────────────────────────────────────────

function renderPeerList() {
  const others = state.peers.filter(p => p.socketId !== state.mySocketId);
  $('peer-count').textContent = others.length;

  if (!others.length) {
    $('peers-list').innerHTML = '<div class="no-peers">Chưa có peer nào trực tuyến</div>';
    return;
  }

  $('peers-list').innerHTML = others.map(p => {
    const connected = state.webrtc.isConnected(p.socketId);
    return `
      <div class="peer-item ${connected ? 'active' : ''}"
           data-sid="${p.socketId}" data-pid="${p.id}">
        <div class="peer-emoji" onclick="connectToPeer('${p.id}')" style="cursor:pointer">${p.avatar || '🐾'}</div>
        <div class="peer-info" onclick="connectToPeer('${p.id}')" style="cursor:pointer;flex:1;min-width:0">
          <div class="peer-name">${esc(p.name)}</div>
          <div class="peer-id">${p.id} · ${p.deviceIcon || '💻'} ${p.device || ''}</div>
        </div>
        ${connected
          ? `<button class="btn-disconnect" onclick="disconnectPeer('${p.socketId}','${p.id}')" title="Ngắt kết nối">✕</button>`
          : `<div class="peer-online"></div>`}
      </div>`;
  }).join('');
}

function connectToPeer(targetId) {
  const peer = state.peers.find(p => p.id === targetId);
  if (!peer) { toast('error', 'Không tìm thấy', `Peer "${targetId}" không online`); return; }
  if (state.webrtc.isConnected(peer.socketId)) {
    toast('info', 'Đã kết nối', `Đang kết nối với ${targetId}`); return;
  }
  toast('info', 'Đang kết nối…', targetId);
  state.webrtc.connect(state.socket, peer.socketId, targetId);
}

window.disconnectPeer = (socketId, peerId) => {
  const conn = state.webrtc.connections.get(socketId);
  if (conn) conn.close();
  state.webrtc.connections.delete(socketId);
  state.peerFiles.delete(socketId);
  $(`peer-section-${socketId}`)?.remove();
  $('stat-connections').textContent = state.webrtc.activeCount;
  if (state.webrtc.activeCount === 0) {
    $('drop-zone').classList.add('hidden');
    if (state.transfers.size === 0 && state.received.size === 0)
      $('empty-state').style.display = '';
  }
  renderPeerList();
  toast('info', 'Đã ngắt kết nối', peerId);
};

// ─── File management ──────────────────────────────────────────────────────────

function addFiles(fileList) {
  for (const file of fileList) {
    const id = Math.random().toString(36).slice(2, 10);
    state.myShared.set(id, { file, id, name: file.name, size: file.size, type: file.type });
  }
  // Gán vào handler để phục vụ yêu cầu từ peer
  state.webrtc.sharedFiles = state.myShared;
  state.webrtc.sendFileListToAll();
  renderMyFiles();
  toast('success', `Đã thêm ${fileList.length} file`, 'Sẵn sàng chia sẻ với tất cả peers');
}

function renderMyFiles() {
  const section = $('my-files-section');
  const list    = $('my-files-list');

  if (!state.myShared.size) { section.style.display = 'none'; return; }
  section.style.display = '';
  list.innerHTML = Array.from(state.myShared.values()).map(f => `
    <div class="my-file-row">
      <span class="my-file-emoji">${fileEmoji(f.type)}</span>
      <div class="my-file-info">
        <div class="my-file-name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="my-file-meta">${fmtBytes(f.size)}</div>
      </div>
      <button class="btn-remove" onclick="removeFile('${f.id}')" title="Xóa">✕</button>
    </div>`).join('');
}

window.removeFile = id => {
  state.myShared.delete(id);
  state.webrtc.sharedFiles = state.myShared;
  state.webrtc.sendFileListToAll();
  renderMyFiles();
};

// ─── Peer files section ───────────────────────────────────────────────────────

function renderPeerFilesSection(socketId, peerId, files) {
  const container = $('peer-files-sections');
  const existingId = `peer-section-${socketId}`;

  // Remove existing section for this peer
  $(existingId)?.remove();

  if (!files.length) return;

  const section = document.createElement('div');
  section.id = existingId;
  section.innerHTML = `
    <div class="peer-section-title">📥 File của ${esc(peerId)}</div>
    <div id="peer-list-${socketId}">
      ${files.map(f => peerFileRowHTML(socketId, f)).join('')}
    </div>`;
  container.appendChild(section);
}

function peerFileRowHTML(socketId, f) {
  return `
    <div class="peer-file-row" id="pf-${f.id}"
         onclick="downloadFile('${socketId}','${f.id}')">
      <span style="font-size:18px">${fileEmoji(f.type)}</span>
      <div class="my-file-info">
        <div class="my-file-name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="my-file-meta">${fmtBytes(f.size)} · nhấp để tải</div>
      </div>
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:var(--blue);flex-shrink:0">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
      </svg>
    </div>`;
}

window.downloadFile = (socketId, fileId) => {
  const fileMap = state.peerFiles.get(socketId);
  if (!fileMap) return;
  const f = fileMap.get(fileId);
  if (!f) return;
  const el = $(`pf-${fileId}`);
  if (el) el.classList.add('downloading');
  state.webrtc.requestFile(socketId, fileId);
};

// ─── Transfer cards ───────────────────────────────────────────────────────────

function addTransferCard(fileId, name, size, totalChunks, dir, peerId) {
  state.transfers.set(fileId, {
    name, size, dir, peerId, startTime: Date.now(),
    progress: 0, chunkStatus: new Array(totalChunks).fill('pending'),
  });

  const card = document.createElement('div');
  card.className = 'transfer-card';
  card.id = `tc-${fileId}`;

  const chunkCells = Array.from({ length: totalChunks }, (_, i) =>
    `<div class="chunk-cell" id="cc-${fileId}-${i}"></div>`
  ).join('');

  card.innerHTML = `
    <div class="transfer-card-header">
      <span class="transfer-direction direction-${dir}">${dir === 'sending' ? '↑ GỬI' : '↓ NHẬN'}</span>
      <span class="transfer-filename" title="${esc(name)}">${esc(name)}</span>
      ${peerId ? `<span class="transfer-peer">${peerId}</span>` : ''}
    </div>
    <div class="transfer-body">
      <div class="progress-track">
        <div class="progress-fill ${dir}" id="pf-bar-${fileId}" style="width:0%"></div>
      </div>
      <div class="transfer-stats">
        <span id="ts-bytes-${fileId}">0 B / ${fmtBytes(size)}</span>
        <span id="ts-speed-${fileId}">— B/s</span>
        <span id="ts-pct-${fileId}">0%</span>
      </div>
      <div class="chunk-map-label">Chunk map (${totalChunks} chunks × 16 KB)</div>
      <div class="chunk-map" id="cm-${fileId}">${chunkCells}</div>
    </div>`;

  $('transfer-list').prepend(card);
  $('empty-state').style.display = 'none';
}

function updateTransferCard(fileId, pct, cur, tot, chunkIdx, chunkStatus) {
  const t = state.transfers.get(fileId);
  if (!t) return;

  t.progress = pct;
  if (chunkStatus) t.chunkStatus = chunkStatus;

  // Progress bar
  const bar = $(`pf-bar-${fileId}`);
  if (bar) bar.style.width = pct.toFixed(1) + '%';

  // Stats text
  const elapsed = (Date.now() - t.startTime) / 1000 || 0.001;
  const speed   = cur / elapsed;
  const bEl = $(`ts-bytes-${fileId}`);
  const sEl = $(`ts-speed-${fileId}`);
  const pEl = $(`ts-pct-${fileId}`);
  if (bEl) bEl.textContent = `${fmtBytes(cur)} / ${fmtBytes(tot)}`;
  if (sEl) sEl.textContent = `${fmtBytes(speed)}/s`;
  if (pEl) pEl.textContent = `${Math.round(pct)}%`;

  // Chunk cell
  if (chunkIdx != null) {
    const cell = $(`cc-${fileId}-${chunkIdx}`);
    if (cell) {
      const status = chunkStatus ? chunkStatus[chunkIdx] : 'ok';
      cell.className = `chunk-cell ${status === 'ok' ? 'ok' : status === 'bad' ? 'bad' : 'in'}`;
    }
  }
}

function finishTransferCard(fileId, hashOk) {
  const t = state.transfers.get(fileId);
  if (!t) return;

  const bar = $(`pf-bar-${fileId}`);
  if (bar) bar.style.width = '100%';

  // Cập nhật tất cả chunk còn pending → ok
  if (t.chunkStatus) {
    t.chunkStatus.forEach((s, i) => {
      if (s === 'pending') {
        const cell = $(`cc-${fileId}-${i}`);
        if (cell) cell.className = 'chunk-cell ok';
      }
    });
  }

  const pEl = $(`ts-pct-${fileId}`);
  if (pEl) pEl.textContent = '100%';

  // Hash badge
  const body = document.querySelector(`#tc-${fileId} .transfer-body`);
  if (body) {
    const badge = document.createElement('div');
    badge.className = `hash-badge ${hashOk ? 'hash-ok' : 'hash-bad'}`;
    badge.innerHTML = hashOk
      ? '✓ SHA-256 hash hợp lệ — toàn vẹn dữ liệu đảm bảo'
      : '✗ SHA-256 hash không khớp — file có thể bị hỏng';
    body.appendChild(badge);
  }
}

// ─── Received files ───────────────────────────────────────────────────────────

function addReceivedRow(fileId, name, size, hashOk) {
  $('received-section').style.display = '';
  const list = $('received-list');
  const row  = document.createElement('div');
  row.className = 'file-row';
  row.innerHTML = `
    <span class="file-emoji">${fileEmoji('')}</span>
    <div class="file-info">
      <div class="file-name">${esc(name)}</div>
      <div class="file-meta">${fmtBytes(size)} · ${hashOk ? '✓ SHA-256 OK' : '⚠ Hash lỗi'}</div>
    </div>
    <button class="btn-dl" onclick="saveFile('${fileId}')">⬇ Lưu</button>`;
  list.appendChild(row);
}

window.saveFile = fileId => {
  const f = state.received.get(fileId);
  if (!f) return;
  const url = URL.createObjectURL(f.blob);
  const a   = document.createElement('a');
  a.href = url; a.download = f.name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ─── Stats ────────────────────────────────────────────────────────────────────

function updateStats() {
  const now     = Date.now();
  const elapsed = (now - state.lastTime) / 1000;
  state.lastTime = now;

  const ulSpeed = (state.sentBytes - state.lastSent) / elapsed;
  const dlSpeed = (state.recvBytes - state.lastRecv) / elapsed;
  state.lastSent = state.sentBytes;
  state.lastRecv = state.recvBytes;

  $('stat-upload').textContent   = fmtBytes(Math.max(0, ulSpeed)) + '/s';
  $('stat-download').textContent = fmtBytes(Math.max(0, dlSpeed)) + '/s';
}

// ─── STUN public IP ───────────────────────────────────────────────────────────

async function getPublicIP() {
  return new Promise(resolve => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    let ip = null;
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) { pc.close(); resolve(ip); return; }
      const m = candidate.candidate.match(/\d+ \d+ \w+ \d+ ([0-9.]+) .* typ srflx/);
      if (m) ip = m[1];
    };
    pc.createDataChannel('');
    pc.createOffer().then(o => pc.setLocalDescription(o));
    setTimeout(() => { pc.close(); resolve(ip); }, 5000);
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function $(id)       { return document.getElementById(id); }
function esc(s)      { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtBytes(b) {
  if (b < 1024) return b.toFixed(0) + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(2) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}
function fileEmoji(type) {
  if (!type) return '📄';
  if (type.startsWith('image/'))  return '🖼️';
  if (type.startsWith('video/'))  return '🎬';
  if (type.startsWith('audio/'))  return '🎵';
  if (type.includes('pdf'))       return '📕';
  if (type.includes('zip') || type.includes('rar') || type.includes('7z')) return '📦';
  if (type.includes('word') || type.includes('document')) return '📝';
  if (type.includes('excel') || type.includes('spreadsheet')) return '📊';
  return '📄';
}

function toast(type, title, msg) {
  const icons = {
    success: `<svg class="toast-icon success" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
    error:   `<svg class="toast-icon error"   fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`,
    info:    `<svg class="toast-icon info"    fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  };
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `${icons[type] || icons.info}<div><div class="toast-title">${title}</div><div class="toast-msg">${msg}</div></div>`;
  $('toast-container').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 4000);
}

document.addEventListener('DOMContentLoaded', init);

// ─── Theme ────────────────────────────────────────────────────────────────────

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.getElementById('theme-dark').classList.toggle('active', theme === 'dark');
  document.getElementById('theme-light').classList.toggle('active', theme === 'light');
}

// Khởi tạo theme từ localStorage hoặc system preference
(function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefer = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  setTheme(saved || prefer);
})();
