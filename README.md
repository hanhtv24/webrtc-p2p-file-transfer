# P2P Transfer — WebRTC File Sharing

Ứng dụng chia sẻ file peer-to-peer qua WebRTC với xác minh toàn vẹn dữ liệu SHA-256, hỗ trợ đa peer đồng thời và trực quan hóa chunk map realtime.

> Đồ án môn Các hệ thống phân tán — Học viện Công nghệ Bưu chính Viễn thông (PTIT)
> Nhóm 8 · Chủ đề 1: Hệ thống chia sẻ file ngang hàng kiểu BitTorrent

---

## Tính năng

### Kết nối P2P
- Kết nối trực tiếp giữa nhiều browser không qua server (multi-peer)
- Tự động phát hiện đường kết nối tốt nhất qua ICE: LAN → STUN → TURN
- Peer ID ngẫu nhiên dạng động vật để dễ nhận diện
- Kết nối/ngắt kết nối từng peer độc lập

### Chia sẻ file
- Kéo thả hoặc chọn file, chia thành chunk 16 KB qua WebRTC DataChannel
- Xác minh SHA-256 từng chunk và toàn bộ file sau khi reassemble
- Chunk map trực quan: mỗi ô 10×10px hiển thị trạng thái chunk (xám/cam/xanh/đỏ)
- Flow control: chờ khi `bufferedAmount > 8 MB` để tránh tràn buffer
- File list tự động đồng bộ tới tất cả peer đang kết nối

### Giao diện
- Dark theme mặc định (GitHub-inspired), có thể chuyển sang light theme
- Layout 3 cột: danh sách peer · khu vực transfer · danh sách file
- Stats bar realtime: upload/download speed, tổng bytes gửi/nhận
- Toast notifications với auto-dismiss

---

## Kiến trúc

```
┌─────────────┐    WebSocket (SDP + ICE)    ┌─────────────────────┐
│  Browser A  │ ◄──────────────────────────► │   Signaling Server  │
│  Browser B  │ ◄──────────────────────────► │   (Node.js + WS)    │
│  Browser C  │ ◄──────────────────────────► │   Port 3005         │
└──────┬──────┘                              └─────────────────────┘
       │
       │  Sau handshake — dữ liệu đi thẳng, không qua server
       │
┌──────▼──────────────────────────────────────┐
│         WebRTC P2P DataChannel              │
│  A ◄══════════════════════════════════► B   │
│  A ◄══════════════════════════════════► C   │
│         DTLS encrypted · SHA-256 verified   │
└─────────────────────────────────────────────┘
```

### Cấu trúc code

```
├── server/
│   ├── index.js        # Signaling server (Socket.io)
│   └── utils.js        # generatePeerId, formatBytes, parseUserAgent
└── public/
    ├── index.html      # UI: dark/light theme, 3-column layout, CSS variables
    ├── webrtc.js       # PeerConnection class + WebRTCHandler (multi-peer Map)
    └── app.js          # State management, chunk map, transfer cards, toasts
```

---

## Tech Stack

- **Frontend:** HTML, CSS, JavaScript thuần — không framework
- **Server:** Node.js, Express, Socket.io
- **WebRTC:** Native API — RTCPeerConnection, RTCDataChannel
- **Bảo mật:** SHA-256 qua Web Crypto API (`crypto.subtle.digest`)
- **STUN:** Google + Cloudflare STUN servers

---

## Cài đặt & Chạy

### Yêu cầu
- Node.js 16+
- Chrome, Firefox, hoặc Edge (hỗ trợ WebRTC + Web Crypto API)

### Chạy local

```bash
npm install
npm run dev
# Truy cập: http://localhost:3005
```

### Demo multi-peer (cùng mạng LAN)

```bash
# Máy A chạy server
npm run dev

# Máy B, C truy cập
http://<IP-máy-A>:3005
```

Kết nối LAN sẽ dùng Host Candidate — không đi qua STUN, tốc độ tối đa.

---

## Cách sử dụng

1. Mở `http://localhost:3005` trên nhiều tab hoặc nhiều máy
2. Nhấn vào peer trong danh sách bên trái hoặc nhập Peer ID để kết nối P2P
3. Kéo thả file vào vùng upload (xuất hiện sau khi có kết nối P2P)
4. Peer nhận file thấy chunk map cập nhật realtime, badge SHA-256 sau khi hoàn tất
5. Nhấn "Lưu" để download file về máy

---

## Cải tiến so với bản gốc

| Mục | Bản gốc | Bản cải tiến |
|-----|---------|-------------|
| Số peer | 1 | N peer đồng thời (Map-based) |
| Bảo mật | Không có | SHA-256 per-chunk + full-file |
| UI | Light, 1 cột | Dark/light toggle, 3 cột |
| Chunk visualization | Progress bar | Chunk map grid |
| Stats | Không có | Upload/download speed realtime |
| File list | Không có | Đồng bộ tới tất cả peer |
| Disconnect | Không có | Ngắt kết nối từng peer |
| Flow control | Không có | BufferedAmount guard |

---

## Hạn chế hiện tại

- Không có TURN server — symmetric NAT (~15-20% trường hợp) không kết nối được
- File load toàn bộ vào RAM — file >1 GB có thể crash tab
- Không có resume khi mất kết nối giữa chừng
- Signaling server là single point of failure

---

## Troubleshooting

**Stuck ở "Đang kết nối tới Signaling Server..."**
→ Mở `http://localhost:3005` (không phải mở file HTML trực tiếp)

**Không kết nối được P2P giữa 2 máy khác mạng**
→ Cả hai đều sau symmetric NAT — cần TURN server; thử cùng LAN trước

**File transfer không cập nhật progress**
→ Mở F12 > Console kiểm tra lỗi; hard refresh Ctrl+Shift+R

**Debug WebRTC chi tiết**
→ `chrome://webrtc-internals/`

---

## Tài liệu tham khảo

- [MDN WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [Web Crypto API — crypto.subtle](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)
- [Socket.io Documentation](https://socket.io/docs/)
- [RFC 5389 — STUN Protocol](https://tools.ietf.org/html/rfc5389)
- [RFC 8445 — ICE Protocol](https://tools.ietf.org/html/rfc8445)
- [WebRTC Samples](https://webrtc.github.io/samples/)
