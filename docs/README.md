# Tài liệu dự án P2P (mô phỏng BitTorrent)

Đọc theo thứ tự:

1. [`01_PHAN_TICH_DU_AN.md`](01_PHAN_TICH_DU_AN.md) — Phân tích dự án cho người
   mới: đề bài, khái niệm BitTorrent, app WebRTC hiện có và vì sao chưa đủ, thiết
   kế hệ thống mới, cách chạy (kể cả web dashboard).
2. [`02_HARNESS.md`](02_HARNESS.md) — Khung thử nghiệm: vì sao cần, kiến trúc,
   cách chạy 4 kịch bản, số liệu đã đo, cách đưa vào báo cáo.
3. [`03_DANH_GIA_DE_BAI.md`](03_DANH_GIA_DE_BAI.md) — Đối chiếu từng yêu cầu đề
   bài (app WebRTC vs hệ mới), kết luận đạt chuẩn.
4. [`04_SLIDE_OUTLINE.md`](04_SLIDE_OUTLINE.md) — Dàn ý 16 slide thuyết trình.

## Cây thư mục chính
```
bittorrent/          # Hệ thống P2P swarm mới (Node.js, TCP)
  src/torrent.js       chia chunk + hash SHA-256 + metadata + ChunkStore
  src/protocol.js      wire protocol (length-prefixed)
  src/piece-picker.js  rarest-first / random
  tracker/tracker.js   tracker HTTP (peer discovery, churn)
  peer/peer.js         nút P2P: tải song song + re-upload + verify + xử lý lỗi
  cli.js               lệnh: create / tracker / seed / download
harness/             # Khung thử nghiệm tự động
  run-experiment.js    dựng swarm, chạy kịch bản, đo đạc, xuất CSV/JSON
  gen-file.js          sinh file test
  scenarios/*.json     baseline / scaling / rarest-vs-random / churn
web/                 # Giao diện Web cho hệ thống mới (upload→seed, tải xuống, tiến độ real-time)
  server.js            backend: tracker + Peer chạy trong tiến trình, API REST
  public/               index.html / app.js / style.css — bảng điều khiển
docs/                # 4 tài liệu này
server/, public/     # App WebRTC hiện có (đa peer, SHA-256, chunk-map — giữ lại để đối chiếu)
```

## Chạy thử nhanh
```bash
node harness/run-experiment.js harness/scenarios/baseline.json   # kịch bản tự động
node web/server.js                                               # dashboard: http://localhost:5000
npm run dev                                                       # app WebRTC hiện có: http://localhost:3005
```
