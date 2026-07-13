# Dàn ý slide thuyết trình

> Đề xuất **16 slide** cho buổi bảo vệ ~12–15 phút. Mỗi slide ghi rõ: **tiêu đề**,
> **nội dung chính** (gạch đầu dòng để đưa lên slide), **gợi ý hình/diagram**, và
> **ý nói** (nói thêm, không đưa lên slide). Nguyên tắc: slide ít chữ, nhiều hình;
> mỗi slide 1 ý chính.

---

### Slide 1 — Trang bìa
- **Nội dung:** Tên đề tài "Hệ thống chia sẻ file P2P (mô phỏng BitTorrent)";
  môn Các hệ thống phân tán; tên nhóm & thành viên; GVHD; ngày.
- **Hình:** logo trường + 1 icon mạng P2P.

### Slide 2 — Đặt vấn đề & mục tiêu
- **Nội dung:** Client–server: 1 nguồn → nghẽn khi đông. P2P/BitTorrent: người
  tải cũng là người cho tải → càng đông càng nhanh. Mục tiêu: tự xây hệ P2P đạt
  7 chức năng đề bài.
- **Hình:** 2 sơ đồ đối lập (server nghẽn ⟷ swarm phân tán).
- **Ý nói:** nêu bối cảnh phân phối file lớn.

### Slide 3 — BitTorrent hoạt động thế nào (khái niệm)
- **Nội dung:** chunk + hash; seeder/leecher/swarm; tracker (danh bạ); rarest-first.
- **Hình:** file → cắt chunk → hash; sơ đồ swarm nhiều peer trao đổi mảnh.
- **Ý nói:** giải thích "trao đổi mảnh" bằng ẩn dụ ghép hình.

### Slide 4 — Xuất phát điểm: app WebRTC & vì sao chưa đủ
- **Nội dung:** app WebRTC hiện có đã hỗ trợ **đa peer**, xác minh **SHA-256**
  từng chunk + toàn file, GUI đầy đủ (chunk-map, theme, stats) — làm tốt phần
  toàn vẹn dữ liệu. Nhưng vẫn **thiếu bản chất swarm**: tracker chỉ biết peer
  online (không map theo file), 1 file luôn do 1 peer gửi trọn (không tải đa
  nguồn), người tải xong không tự re-upload → 3/7 chức năng bắt buộc.
- **Hình:** sơ đồ đa peer (star) + bảng ✅/⚠️/❌ ngắn.
- **Ý nói:** trung thực về điểm mạnh (toàn vẹn, GUI) và điểm thiếu (swarm), dẫn
  tới quyết định xây thêm hệ engine BitTorrent thật.

### Slide 5 — Kiến trúc hệ thống mục tiêu
- **Nội dung:** Tracker (HTTP) + N peer (TCP) dạng CLI; peer vừa server vừa client.
- **Hình:** sơ đồ tracker ở giữa, các peer nối TCP với nhau (lấy từ
  `01_PHAN_TICH_DU_AN.md` §4.1).
- **Ý nói:** vì sao chọn CLI/TCP → để tự động hoá thử nghiệm.

### Slide 6 — Metadata & hash chunk (chức năng 1, 6)
- **Nội dung:** cắt chunk 256KB (cấu hình), SHA-256 mỗi chunk, `.meta.json`,
  infohash. Verify khi nhận → chống hỏng/giả.
- **Hình:** cấu trúc `.meta.json` + mũi tên "chunk → SHA-256 → so khớp".
- **Ý nói:** demo nhanh lệnh `cli.js create`.

### Slide 7 — Tracker & peer discovery (chức năng 2, 3)
- **Nội dung:** `Map<infohash, peers>`; announce/heartbeat; trả danh sách peer;
  loại peer quá hạn (churn).
- **Hình:** sơ đồ announce → nhận list peer.
- **Ý nói:** nhấn mạnh tracker **không** truyền dữ liệu.

### Slide 8 — Wire protocol & tải song song (chức năng 4)
- **Nội dung:** khung message length-prefixed (HANDSHAKE/BITFIELD/HAVE/REQUEST/
  PIECE); điều phối request nhiều peer cùng lúc; giới hạn in-flight.
- **Hình:** khung byte của message + sơ đồ 1 leecher kéo chunk từ 3 peer.
- **Ý nói:** vì sao cần length-prefix (TCP là stream).

### Slide 9 — Re-upload / swarm (chức năng 5)
- **Nội dung:** tải xong chunk → gửi HAVE → phục vụ REQUEST → trở thành nguồn mới.
- **Hình:** timeline: leecher dần biến thành nguồn phát.
- **Ý nói:** đây là "trái tim" khiến càng đông càng nhanh.

### Slide 10 — Rarest-first (nâng cao)
- **Nội dung:** chọn chunk ít peer có nhất; vì sao (chống tuyệt chủng chunk, cân
  bằng swarm); có cờ random để so sánh.
- **Hình:** biểu đồ cột "độ phổ biến chunk" + đánh dấu chunk hiếm.

### Slide 11 — Toàn vẹn & xử lý lỗi / churn (kỹ thuật)
- **Nội dung:** verify SHA-256; timeout request + requeue; peer rớt → xin lại từ
  peer khác; tracker loại peer chết.
- **Hình:** sơ đồ luồng "PIECE → verify → OK/Sai"; mũi tên requeue.

### Slide 12 — Harness: phương pháp thử nghiệm
- **Nội dung:** 1 lệnh dựng tracker + seeder + N leecher; thu số liệu qua log
  `##EVT##`; kịch bản JSON; xuất CSV/JSON; throttle để mô phỏng mạng thật.
- **Hình:** sơ đồ harness (`02_HARNESS.md` §2).
- **Ý nói:** nhấn "lặp lại được, đo được, mở rộng được".

### Slide 13 — Kết quả (1): tải đa nguồn & mở rộng
- **Nội dung:** baseline 3 leech → 3 nguồn, hash khớp; scaling 8 leech → ~1.2s,
  ~7000 KB/s — càng đông càng nhanh.
- **Hình:** **biểu đồ** thời gian/throughput theo số leecher (vẽ từ CSV).

### Slide 14 — Kết quả (2): rarest-vs-random & churn
- **Nội dung:** flash-crowd: rarest≈random (giải thích khan hiếm); churn: kill 1
  leecher → còn lại vẫn xong, peer restart tự tải lại. Tất cả hash khớp.
- **Hình:** bảng so sánh + ảnh log churn (KILL/RESTART/✓ hoàn tất).
- **Ý nói:** trung thực về khi nào rarest-first có lợi.

### Slide 15 — Đối chiếu đạt chuẩn đề bài
- **Nội dung:** bảng 7/7 chức năng bắt buộc ✅ + kỹ thuật ✅ + nâng cao 5/5 (hệ
  mới); app WebRTC hiện có ~3/7 (mạnh về toàn vẹn dữ liệu & GUI, thiếu swarm).
- **Hình:** bảng ✅ rút gọn từ `03_DANH_GIA_DE_BAI.md`.

### Slide 16 — Demo trực tiếp + Kết luận & hướng phát triển
- **Nội dung demo:** mở `web/` (upload file → tự seed → bấm tải xuống → xem
  tiến độ/tốc độ real-time) **và/hoặc** chạy `node harness/run-experiment.js
  .../churn.json` để thấy log realtime + hash khớp.
- **Kết luận:** đã đạt chuẩn; **hướng phát triển:** nâng cấp app WebRTC để peer
  tải xong tự re-upload (bước đầu có swarm trong browser), kịch bản "seed rời
  sớm", endgame mode, choke/unchoke (tit-for-tat).
- **Hình:** ảnh terminal kết quả + lời cảm ơn/hỏi đáp.

---

## Mẹo trình bày
- **Chuẩn bị sẵn** file kết quả & ảnh chụp log phòng khi demo trực tiếp trục trặc.
- Mỗi slide kết quả nên có **1 con số nổi bật** (vd "8 leecher, 1.2 giây").
- Nếu hỏi "sao không dùng WebRTC?": trả lời — app WebRTC đã làm tốt đa peer +
  toàn vẹn dữ liệu, nhưng WebRTC trong trình duyệt khó tự động hoá spawn hàng
  chục "peer" để đo đạc, và việc thêm cơ chế swarm (re-upload, tải đa nguồn theo
  chunk) vào kiến trúc trình duyệt phức tạp hơn nhiều so với peer CLI/TCP; app
  WebRTC được giữ lại làm giải pháp song song và phần đối chiếu.
- Nếu hỏi về "đa luồng": Node đơn luồng nhưng **đồng thời** nhờ event-loop
  non-blocking, đủ cho bài toán nặng I/O (§4.5 tài liệu phân tích).
- Thời lượng gợi ý: slide 1–4 (~3'), 5–11 (~6'), 12–15 (~4'), 16 demo (~2').
