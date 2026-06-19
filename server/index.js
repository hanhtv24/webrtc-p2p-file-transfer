/// @ts-check

/**
 * Signaling Server cho ứng dụng chia sẻ file P2P
 *
 * Nhiệm vụ:
 * 1. Quản lý peers online (cấp ID, lưu danh sách)
 * 2. Relay SDP Offer/Answer giữa các peers -> Kết nối P2P
 * 3. Relay ICE Candidates -> Kết nối P2P ổn định
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const {
  generatePeerId,
  formatBytes,
  getClientIP,
  getRandomAnimal,
  parseUserAgent,
} = require("./utils");
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Serve static files từ thư mục public
app.use(express.static(path.join(__dirname, "../public")));

// Lưu trữ thông tin các peers đang online
const peers = new Map(); // Map<socketId, { id, name, status, ip, avatar }>

io.on("connection", (socket) => {
  const peerId = generatePeerId();
  const clientIP = getClientIP(socket);
  const avatar = getRandomAnimal();
  const userAgent = socket.handshake.headers["user-agent"] || "";
  const deviceInfo = parseUserAgent(userAgent);

  console.log(
    `[${new Date().toLocaleTimeString()}] Peer kết nối: ${avatar.emoji} ${
      avatar.name
    } ${peerId} | ${deviceInfo.icon} ${deviceInfo.device} (IP: ${clientIP})`
  );

  // Lưu thông tin peer
  peers.set(socket.id, {
    id: peerId,
    name: `${avatar.name} ${peerId}`,
    status: "online",
    ip: clientIP,
    avatar: avatar.emoji,
    device: deviceInfo.device,
    deviceIcon: deviceInfo.icon,
  });

  // Gửi ID, IP, avatar và device cho peer vừa kết nối
  socket.emit("your-id", {
    peerId,
    ip: clientIP,
    avatar: avatar.emoji,
    animalName: avatar.name,
    device: deviceInfo.device,
    deviceIcon: deviceInfo.icon,
  });

  // Thông báo danh sách peers cho tất cả
  broadcastPeerList();

  // ===== XỬ LÝ ĐỔI TÊN =====

  socket.on("change-name", (newName) => {
    const peer = peers.get(socket.id);
    if (peer && newName && newName.trim()) {
      peer.name = newName.trim().substring(0, 30); // Giới hạn 30 ký tự
      console.log(
        `[${new Date().toLocaleTimeString()}] ${peerId} đổi tên thành: ${
          peer.name
        }`
      );
      broadcastPeerList();
      socket.emit("name-changed", peer.name);
    }
  });

  // ===== XỬ LÝ SIGNALING =====

  // Peer muốn kết nối với peer khác
  socket.on("connect-to-peer", (targetPeerId) => {
    const targetSocket = findSocketByPeerId(targetPeerId);
    if (targetSocket) {
      console.log(
        `[${new Date().toLocaleTimeString()}] ${peerId} muốn kết nối với ${targetPeerId}`
      );
      // Thông báo cho peer đích
      targetSocket.emit("connection-request", {
        fromPeerId: peerId,
        fromSocketId: socket.id,
      });
    } else {
      socket.emit("peer-not-found", targetPeerId);
    }
  });

  // Relay SDP Offer
  socket.on("sdp-offer", ({ targetSocketId, sdp }) => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      console.log(
        `[${new Date().toLocaleTimeString()}] Relay SDP Offer: ${peerId} -> ${
          peers.get(targetSocketId)?.id
        }`
      );
      targetSocket.emit("sdp-offer", {
        sdp,
        fromSocketId: socket.id,
        fromPeerId: peerId,
      });
    }
  });

  // Relay SDP Answer
  socket.on("sdp-answer", ({ targetSocketId, sdp }) => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      console.log(
        `[${new Date().toLocaleTimeString()}] Relay SDP Answer: ${peerId} -> ${
          peers.get(targetSocketId)?.id
        }`
      );
      targetSocket.emit("sdp-answer", {
        sdp,
        fromSocketId: socket.id,
        fromPeerId: peerId,
      });
    }
  });

  // Relay ICE Candidates
  socket.on("ice-candidate", ({ targetSocketId, candidate }) => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit("ice-candidate", {
        candidate,
        fromSocketId: socket.id,
      });
    }
  });

  // ===== XỬ LÝ FILE TRANSFER =====

  // Yêu cầu gửi file
  socket.on("file-request", ({ targetSocketId, fileInfo }) => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      console.log(
        `[${new Date().toLocaleTimeString()}] Yêu cầu gửi file: ${
          fileInfo.name
        } (${formatBytes(fileInfo.size)})`
      );
      targetSocket.emit("file-request", {
        fileInfo,
        fromSocketId: socket.id,
        fromPeerId: peerId,
      });
    }
  });

  // Chấp nhận nhận file
  socket.on("file-accept", ({ targetSocketId }) => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      console.log(
        `[${new Date().toLocaleTimeString()}] Chấp nhận nhận file từ ${peerId}`
      );
      targetSocket.emit("file-accepted", {
        fromSocketId: socket.id,
      });
    }
  });

  // Từ chối nhận file
  socket.on("file-reject", ({ targetSocketId }) => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit("file-rejected", {
        fromSocketId: socket.id,
      });
    }
  });

  // ===== NGẮT KẾT NỐI =====

  socket.on("disconnect", () => {
    console.log(
      `[${new Date().toLocaleTimeString()}] Peer ngắt kết nối: ${peerId}`
    );
    peers.delete(socket.id);
    broadcastPeerList();
  });
});

// Tìm socket theo Peer ID
/// @ts-ignore
function findSocketByPeerId(peerId) {
  for (const [socketId, peer] of peers) {
    if (peer.id === peerId) {
      return io.sockets.sockets.get(socketId);
    }
  }
  return null;
}

// Broadcast danh sách peers cho tất cả
function broadcastPeerList() {
  const peerList = Array.from(peers.entries()).map(([socketId, peer]) => ({
    socketId,
    ...peer,
  }));
  io.emit("peer-list", peerList);
}

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
  console.log(
    `║   Server đang chạy tại: http://localhost:${PORT}             ║`
  );
});
