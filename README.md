# P2P File Sharing Suite

**Bộ 2 hệ thống chia sẻ file phân tán chạy trên cùng 1 server Node.js:**

1. **WebRTC P2P Transfer** — chia sẻ file trực tiếp giữa browser qua `RTCDataChannel`, không qua server sau khi kết nối, xác minh toàn vẹn bằng SHA-256.
2. **BitTorrent-swarm Engine** — mô phỏng BitTorrent thật: tracker điều phối peer, tải đa nguồn (multi-source), thuật toán rarest-first, chịu được peer rời/vào giữa chừng (churn).

Đồ án môn **Hệ thống phân tán**.

---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Ứng dụng 1 — WebRTC P2P Transfer](#ứng-dụng-1--webrtc-p2p-transfer)
- [Ứng dụng 2 — BitTorrent-swarm Engine](#ứng-dụng-2--bittorrent-swarm-engine)
- [Cấu trúc project](#cấu-trúc-project)
- [Cài đặt & chạy](#cài-đặt--chạy)
- [Tech stack](#tech-stack)
- [Giới hạn hiện tại](#giới-hạn-hiện-tại)
- [Tài liệu chi tiết](#tài-liệu-chi-tiết)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Cả 2 ứng dụng chạy chung 1 tiến trình Node.js (`server/index.js`, cổng `5000`):

|                   | WebRTC P2P Transfer                                         | BitTorrent-swarm Engine                                                          |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Route             | `/`                                                         | `/bittorrent/`                                                                   |
| Vai trò server    | Signaling (relay SDP/ICE) — dữ liệu **không** đi qua server | Tracker + peer chạy **trong** tiến trình Node — dữ liệu đi qua TCP giữa các peer |
| Mô hình           | 1-1 / mesh giữa browser, thủ công kết nối từng peer         | Swarm nhiều nguồn tự động, tải song song nhiều peer                              |
| Kiểm tra toàn vẹn | SHA-256 từng chunk + toàn file                              | SHA-256 từng chunk khi nhận                                                      |
| Điểm nổi bật      | Không cần cài gì, chạy ngay trên browser                    | Rarest-first, re-upload sau khi tải, mô phỏng churn                              |

---

## Ứng dụng 1 — WebRTC P2P Transfer

Chia sẻ file trực tiếp giữa các browser qua `RTCDataChannel`, có xác minh SHA-256, hỗ trợ nhiều peer đồng thời và trực quan hoá tiến trình truyền theo từng chunk.

**Tính năng**

- Nhiều peer đồng thời — mỗi kết nối là một `RTCPeerConnection` độc lập, quản lý qua `Map<socketId, PeerConnection>`
- ICE tự chọn đường tốt nhất: Host (LAN) → STUN (NAT traversal)
- Kéo thả hoặc chọn file, chia chunk 16 KB qua DataChannel
- SHA-256 xác minh từng chunk ngay khi nhận + xác minh toàn file sau khi reassemble
- Flow control: chờ khi `bufferedAmount > 8 MB` để tránh tràn bộ nhớ DataChannel
- Chunk map trực quan (mỗi chunk là 1 ô màu, đổi màu theo trạng thái realtime)
- Dark/Light theme, thống kê tốc độ upload/download mỗi giây

**Kiến trúc**

```
Browser A ──┐
Browser B ──┼── WebSocket (SDP Offer/Answer + ICE) ──► Signaling Server :5000
Browser C ──┘                                          (Node.js + Socket.io)

Sau handshake:
Browser A ◄══════════════════════════════════► Browser B
          WebRTC DataChannel · DTLS encrypted
          SHA-256 verified per chunk + full file
```

Signaling server chỉ relay SDP/ICE để thiết lập kết nối; sau khi P2P thành công, dữ liệu đi thẳng giữa các browser.

**Sử dụng:** mở `http://localhost:5000` trên nhiều tab/máy → mỗi tab nhận 1 Peer ID → chọn peer trong danh sách → Kết nối → kéo thả file để gửi.

---

## Ứng dụng 2 — BitTorrent-swarm Engine

Mô phỏng lại các cơ chế lõi của BitTorrent: cắt file thành chunk có hash riêng, 1 tracker điều phối danh sách peer, mỗi peer vừa tải vừa phục vụ (seed) cho peer khác, ưu tiên tải chunk hiếm nhất trước (rarest-first).

**Tính năng**

- Tracker HTTP quản lý danh sách peer theo từng file (`infohash`), hỗ trợ churn (peer rời/vào)
- Peer tải song song từ **nhiều nguồn** cùng lúc, tự động re-upload chunk đã có cho peer khác
- Thuật toán chọn chunk: **rarest-first** (ưu tiên chunk ít peer có nhất) hoặc random để so sánh
- Xác minh SHA-256 từng chunk khi nhận — sai thì tải lại; so hash toàn file khi ghép xong
- Dashboard web: upload file → tự động seed, bấm 1 nút để tải, theo dõi tiến độ/tốc độ/nguồn real-time
- Harness đo hiệu năng tự động (`harness/`) — xuất CSV/JSON cho các kịch bản baseline, scaling, rarest-vs-random, churn

**Kiến trúc**

```
                     ┌────────────┐
                     │  Tracker   │  HTTP: register / list peers theo infohash
                     └─────┬──────┘
              announce ▲   │  peer list
                        │   ▼
   ┌─────────┐   TCP    ┌─────────┐   TCP   ┌─────────┐
   │ Seeder  │◄────────►│  Peer   │◄───────►│  Peer   │  ...
   └─────────┘  chunk    └─────────┘  chunk   └─────────┘
             wire protocol length-prefixed, HAVE/REQUEST/PIECE, SHA-256/chunk
```

**Sử dụng:** truy cập `http://localhost:5000/bittorrent/` → tải file lên (tự động thành seed) → mở dashboard ở tab/máy khác → bấm "Tải xuống" để chạy leecher, xem tiến độ/tốc độ theo từng peer.

---

## Cấu trúc project

```
├── server/                # App WebRTC — Signaling Server + gắn route /bittorrent
│   ├── index.js
│   └── utils.js
├── public/                # UI app WebRTC (index.html, webrtc.js, app.js)
├── bittorrent/            # Engine BitTorrent-swarm (Node.js, TCP)
│   ├── src/torrent.js       chia chunk, hash SHA-256, metadata, ChunkStore
│   ├── src/protocol.js      wire protocol (length-prefixed)
│   ├── src/piece-picker.js  rarest-first / random
│   ├── tracker/tracker.js   tracker HTTP (peer discovery, churn)
│   ├── peer/peer.js         nút P2P: tải song song + re-upload + verify
│   └── cli.js               CLI: create / tracker / seed / download
├── web/                   # Dashboard cho BitTorrent-swarm
│   ├── api.js               Router Express (gắn vào server chính hoặc chạy độc lập)
│   ├── server.js            chạy dashboard độc lập (cổng 5050, khi debug riêng)
│   └── public/               index.html / app.js / style.css
├── harness/               # Khung thử nghiệm & đo hiệu năng tự động
│   ├── run-experiment.js
│   ├── gen-file.js
│   └── scenarios/*.json     baseline / scaling / rarest-vs-random / churn
├── docs/                  # Tài liệu phân tích, harness, đánh giá đề bài, slide, demo
├── deploy.sh              # git pull + pm2 restart trên server production
└── package.json
```

---

## Cài đặt & chạy

**Yêu cầu:** Node.js 16+, Chrome / Firefox / Edge

```bash
git clone https://github.com/hanhtv24/p2p-file-sharing-suite.git
cd p2p-file-sharing-suite
npm install
npm run dev
```

| URL                                 | Nội dung                   |
| ----------------------------------- | -------------------------- |
| `http://localhost:5000/`            | App WebRTC P2P Transfer    |
| `http://localhost:5000/bittorrent/` | Dashboard BitTorrent-swarm |

Hướng dẫn chi tiết từng bước (cho người mới clone lần đầu, kèm xử lý sự cố):
[`docs/07_HUONG_DAN_CAI_DAT.md`](docs/07_HUONG_DAN_CAI_DAT.md).

**Chạy kịch bản đo hiệu năng (không cần mở web):**

```bash
node harness/run-experiment.js harness/scenarios/baseline.json
```

**Demo LAN nhiều máy:** máy A chạy `npm run dev`, máy B/C truy cập `http://<IP-máy-A>:5000`.

---

## Tech stack

| Thành phần            | Công nghệ                                             |
| --------------------- | ----------------------------------------------------- |
| Server                | Node.js, Express, Socket.io                           |
| P2P transport (App 1) | WebRTC `RTCPeerConnection`, `RTCDataChannel`          |
| P2P transport (App 2) | TCP thuần (Node `net`), wire protocol tự định nghĩa   |
| Toàn vẹn dữ liệu      | SHA-256 (Web Crypto API / Node `crypto`)              |
| STUN                  | `stun.l.google.com:19302`, `stun.cloudflare.com:3478` |
| Frontend              | HTML, CSS, JavaScript thuần — không framework         |

---

## Giới hạn hiện tại

**WebRTC P2P Transfer**

- Không có TURN server — peer sau symmetric NAT có thể không kết nối được
- File load toàn bộ vào RAM trước khi gửi — không phù hợp file > 1 GB
- Không có cơ chế resume nếu mất kết nối giữa chừng

**BitTorrent-swarm Engine**

- Tracker là điểm tập trung duy nhất (single point of failure) — chưa có DHT
- Chưa có endgame mode cho các chunk cuối

---

## Tài liệu chi tiết

Xem [`docs/README.md`](docs/README.md) — bắt đầu từ [`docs/06_GIOI_THIEU_DU_AN.md`](docs/06_GIOI_THIEU_DU_AN.md) để có tổng quan đầy đủ, phân tích kỹ thuật, kịch bản đo hiệu năng và hướng dẫn demo.

---

## Tài liệu tham khảo

- [MDN — WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [MDN — SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)
- [RFC 8445 — ICE](https://tools.ietf.org/html/rfc8445)
- [RFC 5389 — STUN](https://tools.ietf.org/html/rfc5389)
- [BEP 3 — BitTorrent Protocol Specification](https://www.bittorrent.org/beps/bep_0003.html)
- [Socket.io docs](https://socket.io/docs/)
