# Tài liệu dự án P2P (mô phỏng BitTorrent)

Đọc theo thứ tự:

0. [`06_GIOI_THIEU_DU_AN.md`](06_GIOI_THIEU_DU_AN.md) — **Bắt đầu từ đây.** Văn
   giới thiệu tổng quan (dùng làm mở đầu báo cáo): app WebRTC có chức năng gì,
   hệ BitTorrent-swarm thêm mới những gì, vì sao tách thành 2 hệ riêng.
1. [`07_HUONG_DAN_CAI_DAT.md`](07_HUONG_DAN_CAI_DAT.md) — Hướng dẫn cài đặt
   từng bước cho người mới `git clone` về: cài Node.js, `npm install`,
   `npm run dev`, cách kiểm tra đã chạy đúng, xử lý sự cố thường gặp.
2. [`01_PHAN_TICH_DU_AN.md`](01_PHAN_TICH_DU_AN.md) — Phân tích kỹ thuật chi
   tiết: đề bài, khái niệm BitTorrent, kiến trúc, wire protocol, cách chạy.
3. [`02_HARNESS.md`](02_HARNESS.md) — Khung thử nghiệm: vì sao cần, kiến trúc,
   cách chạy 4 kịch bản, số liệu đã đo, cách đưa vào báo cáo.
4. [`03_DANH_GIA_DE_BAI.md`](03_DANH_GIA_DE_BAI.md) — Đối chiếu từng yêu cầu đề
   bài (app WebRTC vs hệ mới), kết luận đạt chuẩn.
5. [`04_SLIDE_OUTLINE.md`](04_SLIDE_OUTLINE.md) — Dàn ý 16 slide thuyết trình.
6. [`05_HUONG_DAN_DEMO.md`](05_HUONG_DAN_DEMO.md) — Kịch bản demo trực tiếp trên
   giao diện cho giảng viên: từng bước bấm gì, quan sát gì, chứng minh chức
   năng nào của đề bài.

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
  api.js                Router Express dùng chung: gắn vào server chính (/bittorrent) hoặc chạy độc lập
  server.js             chạy dashboard ĐỘC LẬP (mount api.js ở "/", cổng 5050) — dùng khi debug riêng
  public/               index.html / app.js / style.css — bảng điều khiển (cùng bảng màu với app WebRTC)
docs/                # 7 tài liệu này
server/, public/     # App WebRTC hiện có (đa peer, SHA-256, chunk-map) — server/index.js giờ
                     # gắn thêm route /bittorrent (qua web/api.js), cổng mặc định đã đổi 3005 → 5000
```

## Chạy thử nhanh
```bash
npm run dev                                                      # 1 lệnh duy nhất, cổng 5000:
                                                                  #   http://localhost:5000/            app WebRTC
                                                                  #   http://localhost:5000/bittorrent/  dashboard mới
node harness/run-experiment.js harness/scenarios/baseline.json   # kịch bản tự động (không cần web)
node web/server.js                                               # dashboard BitTorrent độc lập: http://localhost:5050
```
