# webrtc-p2p-file-transfer

Browser-based peer-to-peer file sharing over WebRTC DataChannel with SHA-256 integrity verification, multi-peer support, and real-time chunk map visualization.

---

## Demo

| Dark theme                                    | Light theme                        |
| --------------------------------------------- | ---------------------------------- |
| Peers sidebar · Transfer center · Files panel | Toggle với button ☀/🌙 trên header |

---

## Tính năng

**Kết nối P2P**

- Nhiều peer đồng thời — mỗi kết nối là một `RTCPeerConnection` độc lập, quản lý qua `Map<socketId, PeerConnection>`
- ICE tự chọn đường tốt nhất: Host (LAN) → STUN (NAT traversal)
- Kết nối / ngắt kết nối từng peer độc lập
- Peer identity: ảnh cờ quốc gia + tên cầu thủ nổi bật World Cup 2026 — ví dụ `🏴 Cristiano Ronaldo (Portugal)`

**Truyền file**

- Kéo thả hoặc chọn file, chia thành chunk 16 KB qua DataChannel
- SHA-256 xác minh từng chunk ngay khi nhận — chunk lỗi hiển thị đỏ ngay lập tức
- SHA-256 xác minh toàn bộ file sau khi reassemble — badge kết quả hiển thị rõ ràng
- Flow control: chờ khi `bufferedAmount > 8 MB` để tránh tràn bộ nhớ DataChannel
- File list tự động đồng bộ tới tất cả peer sau mỗi lần thêm/xoá

**Giao diện**

- Layout 3 cột: danh sách peer · khu vực transfer · danh sách file
- Chunk map: mỗi chunk là một ô 10×10px, màu thay đổi realtime theo trạng thái
- Dark theme mặc định, chuyển Light theme bằng button trên header — lưu vào `localStorage`
- Stats bar: upload/download speed tính mỗi giây, tổng bytes gửi/nhận
- Toast notifications với auto-dismiss 4 giây

---

## Kiến trúc

```
Browser A ──┐
Browser B ──┼── WebSocket (SDP Offer/Answer + ICE) ──► Signaling Server :3005
Browser C ──┘                                          (Node.js + Socket.io)

Sau handshake:

Browser A ◄══════════════════════════════════► Browser B
Browser A ◄══════════════════════════════════► Browser C
          WebRTC DataChannel · DTLS encrypted
          SHA-256 verified per chunk + full file
```

**Signaling server** chỉ làm nhiệm vụ relay SDP và ICE candidate để thiết lập kết nối. Sau khi P2P thành công, dữ liệu đi thẳng giữa các browser, không đi qua server.

---

## Cấu trúc project

```
├── server/
│   ├── index.js          # Signaling server — quản lý peer, relay SDP/ICE
│   └── utils.js          # generatePeerId, formatBytes, parseUserAgent
├── public/
│   ├── index.html        # UI — layout, CSS variables, dark/light theme
│   ├── webrtc.js         # PeerConnection class + WebRTCHandler (multi-peer)
│   └── app.js            # State, chunk map, transfer cards, toasts, stats
├── package.json
└── README.md
```

---

## Cài đặt

**Yêu cầu:** Node.js 16+, Chrome / Firefox / Edge

```bash
git clone https://github.com/hanhtv24/webrtc-p2p-file-transfer.git
cd webrtc-p2p-file-transfer
npm install
npm run dev
```

Truy cập `http://localhost:3005`

---

## Sử dụng

**Kết nối peer**

Mở `http://localhost:3005` trên nhiều tab hoặc nhiều máy cùng mạng. Mỗi tab nhận một Peer ID. Nhấn vào peer trong danh sách hoặc nhập Peer ID thủ công → nhấn Kết nối.

**Gửi file**

Sau khi có kết nối P2P, vùng kéo thả xuất hiện. Thêm file → file list tự đồng bộ tới peer. Peer nhận thấy file trong panel Files bên phải, nhấn để bắt đầu tải.

**Xác minh toàn vẹn**

Trong quá trình nhận, chunk map hiển thị từng ô theo màu:

- ⬜ Xám — chưa nhận
- 🟠 Cam — đang nhận
- 🟢 Xanh — nhận OK, hash khớp
- 🔴 Đỏ — hash không khớp

Sau khi hoàn tất, badge SHA-256 xác nhận toàn vẹn của toàn bộ file.

**Demo LAN (nhiều máy)**

```bash
# Máy A chạy server
npm run dev

# Máy B, C truy cập
http://<IP-máy-A>:3005
```

---

## Giới hạn hiện tại

- Không có TURN server — các peer sau symmetric NAT (~15-20% trường hợp) có thể không kết nối được
- File được load toàn bộ vào RAM trước khi gửi — không phù hợp với file > 1 GB
- Không có cơ chế resume nếu mất kết nối giữa chừng
- Signaling server là single point of failure

---

## Tech stack

| Thành phần       | Công nghệ                                             |
| ---------------- | ----------------------------------------------------- |
| Signaling server | Node.js, Express, Socket.io                           |
| P2P transport    | WebRTC RTCPeerConnection, RTCDataChannel              |
| Integrity        | SHA-256 qua Web Crypto API (`crypto.subtle`)          |
| STUN             | `stun.l.google.com:19302`, `stun.cloudflare.com:3478` |
| Frontend         | HTML, CSS, JavaScript — không framework               |

---

## Tài liệu tham khảo

- [MDN — WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [MDN — SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)
- [RFC 8445 — ICE](https://tools.ietf.org/html/rfc8445)
- [RFC 5389 — STUN](https://tools.ietf.org/html/rfc5389)
- [Socket.io docs](https://socket.io/docs/)
