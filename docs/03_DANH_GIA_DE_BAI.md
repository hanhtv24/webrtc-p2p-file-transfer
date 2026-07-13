# Đánh giá mức độ đạt chuẩn đề bài

> Đối chiếu **từng yêu cầu** của đề bài với (A) app WebRTC gốc và (B) hệ thống
> BitTorrent-like mới. Cột "Trạng thái" đánh giá cho **hệ thống mới** (bản nộp
> chính). Ký hiệu: ✅ đạt · ⚠️ đạt một phần · ❌ chưa có.

---

## 1. Bảng đối chiếu chức năng bắt buộc (mục 2 đề bài)

| # | Yêu cầu | (A) App WebRTC hiện có | (B) Hệ thống mới | Bằng chứng (B) |
|---|---------|------------------------|------------------|----------------|
| 1 | Chia file thành chunk + metadata (tên, size, **hash chunk**) | ✅ chunk 16KB, kèm `totalChunks`/`fileHash` khi bắt đầu truyền (không xuất file `.torrent` riêng) | ✅ chunk cấu hình + **SHA-256 mỗi chunk** + `.meta.json` (name/size/chunkSize/chunkCount/chunkHashes/infohash) | `src/torrent.js` (`createMetadata`), lệnh `cli.js create` |
| 2 | Tracker / bootstrap server quản lý danh sách peer | ⚠️ signaling server chỉ quản lý **peer online**, không map theo file | ✅ Tracker HTTP `Map<infohash, peers>`, announce/scrape, loại peer quá hạn | `tracker/tracker.js` |
| 3 | Peer discovery: tìm peer đang chia sẻ file | ❌ phải kết nối P2P trước, rồi mới trao đổi `file-list` (không tìm "ai có file X" trước) | ✅ announce → tracker trả danh sách peer cùng infohash | `peer.js _announce()` |
| 4 | Tải **1 file** từ **nhiều peer song song** | ❌ mỗi file luôn do 1 peer gửi trọn vẹn (`_onFileRequest` gửi `shared.file`) — không chia nguồn theo chunk | ✅ nhiều kết nối TCP, điều phối request chunk khác nhau tới peer khác nhau | `peer.js _schedule()`; harness: `sources = 3..8` |
| 5 | **Upload** chunk cho peer khác sau khi tải được (re-upload/swarm) | ❌ file nhận về (`receivingFiles`) không tự thêm vào `sharedFiles` — người tải xong không tự phát lại | ✅ nhận xong chunk → gửi `HAVE`, phục vụ `REQUEST` (swarm) | `peer.js _onPiece/_serve` |
| 6 | Kiểm tra toàn vẹn bằng **hash** | ✅ verify SHA-256 **từng chunk khi nhận** + verify lại **hash toàn file** sau khi ghép, hiển thị trực quan (ô đỏ/xanh) | ✅ verify SHA-256 mỗi chunk; sai → tải lại; so hash toàn file khi xong | `torrent.js verifyChunk`, `peer.js _onPiece` |
| 7 | **Ghép** chunk tạo lại file hoàn chỉnh | ✅ `Blob` reassemble | ✅ ghi chunk theo offset vào file đích, hash toàn file khớp bản gốc | `ChunkStore`, harness kiểm `hashMatchesSource` |

**Tổng kết chức năng bắt buộc:** App WebRTC đạt **3/7** đầy đủ + **1/7** một phần
(mạnh nhất ở toàn vẹn dữ liệu & ghép file, yếu ở phần "swarm": tracker theo file,
tải đa nguồn, re-upload). **Hệ thống mới đạt 7/7.**

---

## 2. Yêu cầu kỹ thuật (mục 3 đề bài)

| Yêu cầu | (A) WebRTC | (B) Hệ thống mới | Ghi chú |
|---------|-----------|------------------|---------|
| TCP socket hoặc giao thức tương đương | ⚠️ WebRTC DataChannel (SCTP/UDP) + WebSocket | ✅ **TCP thuần** (`net`) cho dữ liệu, HTTP cho tracker | Dùng đúng "TCP socket" như đề bài nêu |
| Đa luồng / xử lý đồng thời | ✅ nhiều `RTCPeerConnection` đồng thời qua event-loop trình duyệt | ✅ event-loop Node, hàng chục kết nối đồng thời non-blocking | Xem §4.5 của `01_PHAN_TICH_DU_AN.md` |
| Vừa tải vừa phục vụ upload | ⚠️ 1 peer có thể vừa gửi file mình chia sẻ vừa nhận file khác cùng lúc, nhưng **không tiếp tục phát lại** file vừa nhận | ✅ mỗi peer là TCP **server + client** cùng lúc, kể cả sau khi vừa tải xong | `peer.js start()` |
| Xử lý lỗi: peer rời mạng | ✅ phát hiện qua `oniceconnectionstatechange` (disconnected/failed/closed) | ✅ tracker loại peer quá hạn; peer gỡ kết nối, cập nhật rarest | `tracker _evictStale`, `peer _onConnClose` |
| Xử lý lỗi: mất kết nối khi tải chunk | ❌ README tự nhận: "không có cơ chế resume nếu mất kết nối giữa chừng" | ✅ chunk đang chờ được đưa lại hàng đợi + timeout request → thử peer khác | `peer _sendRequest` timeout, `_onConnClose` requeue |

**Bằng chứng chịu lỗi:** kịch bản `churn` — kill 1 leecher giữa chừng, các peer
còn lại vẫn hoàn tất, hash khớp.

---

## 3. Chức năng nâng cao (mục 4 đề bài — khuyến khích)

| Yêu cầu | (B) Hệ thống mới | Bằng chứng |
|---------|------------------|-----------|
| Thuật toán **rarest-first** | ✅ có (kèm cờ chuyển sang random để so sánh) | `src/piece-picker.js` |
| Tải song song nhiều peer tối ưu | ✅ giới hạn `MAX_INFLIGHT_PER_PEER`, chia đều theo bitfield | `peer.js _schedule()` |
| Giao diện web / GUI | ✅ **2 GUI trong repo**: app WebRTC gốc (chunk-map, theme, stats) **và** dashboard mới `web/` (upload → auto-seed, tải xuống 1 click, tiến độ/tốc độ real-time cho đúng hệ swarm) | `public/`, `web/public/`, `web/server.js` |
| Thống kê tốc độ upload/download | ✅ bytesUp/Down, throughputKBps, in định kỳ + xuất CSV + hiển thị real-time trên `web/` | `peer _printStats`, harness CSV, `web/public/app.js` |
| Mô phỏng peer join/leave (churn) | ✅ harness kill/restart theo lịch | `harness churn.json` |

**Nâng cao đạt: 5/5.**

---

## 4. Sản phẩm cần nộp (mục 5 đề bài)

| Yêu cầu | Trạng thái |
|---------|-----------|
| Mã nguồn + hướng dẫn chạy | ✅ `bittorrent/`, `harness/`, hướng dẫn ở `01_PHAN_TICH_DU_AN.md` §5 và `02_HARNESS.md` §4 |
| Báo cáo: kiến trúc | ✅ `01_PHAN_TICH_DU_AN.md` §4 |
| Báo cáo: giao thức | ✅ wire protocol `01_...md` §4.4 + `src/protocol.js` |
| Báo cáo: thử nghiệm | ✅ `02_HARNESS.md` §5–7 + số liệu `results/` |
| Slide thuyết trình | ✅ dàn ý `04_SLIDE_OUTLINE.md` |

---

## 5. Kết luận đánh giá

**App WebRTC hiện có: CHƯA đạt chuẩn đề bài, nhưng không phải bản sơ khai.** Nó
là ứng dụng chia sẻ file **đa peer** qua trình duyệt, làm **rất tốt** phần toàn
vẹn dữ liệu (SHA-256 từng chunk + toàn file) và giao diện (chunk-map, theme,
stats), nhưng vẫn **thiếu bản chất swarm** của BitTorrent: tracker chỉ biết peer
online (không biết ai giữ file gì), không tải 1 file song song từ nhiều nguồn,
không re-upload/redistribute sau khi tải xong, không rarest-first. Đạt khoảng
**3/7** đầy đủ + **1/7** một phần trong 7 chức năng bắt buộc.

**Hệ thống BitTorrent-like mới: ĐẠT đầy đủ chuẩn đề bài** — 7/7 chức năng bắt
buộc, toàn bộ yêu cầu kỹ thuật, và 5/5 chức năng nâng cao (kể cả GUI, nhờ dashboard
`web/` mới bổ sung); mọi khẳng định đều **có bằng chứng định lượng** từ harness
(số nguồn tải, thời gian, throughput, hash khớp 100%, chịu churn).

### Việc còn có thể làm để hoàn thiện thêm (không bắt buộc)
- Nâng cấp chính app WebRTC: khi 1 peer tải xong 1 file, tự thêm vào `sharedFiles`
  của nó để trở thành nguồn phát tiếp (bước đầu tiên để có "swarm" thật trong
  WebRTC) — xem lựa chọn "nâng cấp app WebRTC" đã cân nhắc khi lên kế hoạch.
- Thêm kịch bản **"seed rời sớm"** để làm nổi bật lợi thế rarest-first bằng số liệu.
- **Endgame mode** (khi gần xong, request chunk cuối từ mọi peer để tránh "đợi
  peer chậm") — tối ưu kinh điển của BitTorrent.
- Cơ chế **choke/unchoke + tit-for-tat** (chống free-rider) — mức nâng cao sâu hơn.
