# Phân tích dự án: Hệ thống chia sẻ file P2P (mô phỏng BitTorrent)

> Tài liệu này viết cho **người mới**. Đọc từ trên xuống sẽ hiểu: đề bài muốn gì,
> BitTorrent hoạt động ra sao, dự án gốc (WebRTC) là gì và vì sao chưa đủ, rồi
> hệ thống mới được thiết kế thế nào để đạt chuẩn.

---

## 1. Đề bài muốn gì? (giải thích bằng ngôn ngữ đời thường)

Tưởng tượng bạn có 1 file lớn và muốn gửi cho 100 người. Cách thường (client–server):
mọi người tải từ **một** máy chủ → máy chủ nghẽn, ai cũng chậm.

**BitTorrent** giải quyết bằng ý tưởng: *"người tải cũng là người cho tải"*.
File được **cắt nhỏ** thành nhiều mảnh (chunk). Ai tải xong 1 mảnh thì lập tức
**chia lại** mảnh đó cho người khác. Càng đông người tải, tổng "băng thông cho"
càng lớn → **càng đông càng nhanh**, ngược hẳn với client–server.

Đề bài yêu cầu tự xây một hệ như vậy, với 7 chức năng bắt buộc:

| # | Chức năng | Ý nghĩa |
|---|-----------|---------|
| 1 | Chia file thành chunk + metadata (tên, size, **hash** chunk) | "Bản thiết kế" của file |
| 2 | Tracker / bootstrap server | "Danh bạ" biết ai đang chia sẻ file nào |
| 3 | Peer discovery | Peer mới tìm được các peer đang giữ file |
| 4 | Tải từ **nhiều peer song song** | Nhanh hơn, không phụ thuộc 1 nguồn |
| 5 | **Upload** chunk cho peer khác sau khi tải được | Cơ chế "swarm" cốt lõi |
| 6 | Kiểm tra toàn vẹn bằng **hash** | Chống dữ liệu hỏng/giả |
| 7 | **Ghép** chunk tạo lại file hoàn chỉnh | Kết quả cuối cùng |

Cộng thêm yêu cầu kỹ thuật (TCP socket, xử lý đồng thời, vừa tải vừa phục vụ,
xử lý lỗi peer rời mạng / mất kết nối) và các mục nâng cao (rarest-first, thống
kê tốc độ, mô phỏng churn, giao diện).

---

## 2. Các khái niệm nền tảng của BitTorrent

### 2.1. Chunk (mảnh) và Metadata (.torrent)
File được chia thành các mảnh **cố định kích thước** (dự án này: 256KB, cấu hình
được). Với mỗi mảnh ta tính một **hash SHA-256** — coi như "vân tay số" duy nhất.
Toàn bộ thông tin (tên, kích thước, số mảnh, danh sách hash) gói vào 1 file
**metadata** (`.meta.json`) — tương đương file `.torrent` thật.

```
File gốc:  [====================== 8 MB ======================]
Cắt chunk: [c0][c1][c2][c3] ... [c127]      (mỗi chunk 64KB)
Hash:      h0  h1  h2  h3  ...  h127        (SHA-256 mỗi chunk)
Metadata = { name, size, chunkSize, chunkCount, [h0..h127], infohash }
```

`infohash` = hash của metadata → **định danh duy nhất** của "torrent". Tracker và
peer dùng infohash để biết chúng đang nói về **cùng một file**.

### 2.2. Seeder và Leecher
- **Seeder** (người gieo): peer đã có **đủ 100%** file, chỉ phục vụ upload.
- **Leecher** (người hút): peer đang tải dở, vừa tải vừa chia lại phần đã có.
- **Swarm** (bầy): tập hợp tất cả seeder + leecher của cùng 1 file.

### 2.3. Tracker (danh bạ)
Tracker **không** truyền file. Nó chỉ trả lời câu hỏi *"ai đang ở trong swarm
của file X?"*. Peer mới hỏi tracker → nhận danh sách peer → tự kết nối trực tiếp
tới nhau để trao đổi chunk. Đây chính là **peer discovery**.

### 2.4. Kiểm tra toàn vẹn (integrity)
Mỗi khi nhận 1 chunk, peer tính lại SHA-256 và **so với hash trong metadata**.
Khớp → ghi vào file. Sai → vứt bỏ, tải lại từ peer khác. Nhờ vậy dù dữ liệu đi
qua nhiều nguồn lạ, file cuối cùng vẫn **đảm bảo đúng nguyên bản**.

### 2.5. Rarest-first (chọn mảnh hiếm nhất trước)
Khi tải, nên chọn chunk nào? BitTorrent ưu tiên chunk mà **ít peer đang có nhất**.
Lý do: chunk hiếm dễ "tuyệt chủng" nếu peer duy nhất giữ nó rời mạng. Nhân bản nó
sớm giúp **swarm khoẻ và cân bằng**, tránh nút thắt cổ chai.

---

## 3. Dự án gốc: ứng dụng WebRTC (và vì sao CHƯA đủ chuẩn)

Repo ban đầu (`server/`, `public/`) là một ứng dụng **chia sẻ file đa peer** qua
**WebRTC DataChannel**, với xác minh toàn vẹn SHA-256 và giao diện khá đầy đủ
(3 cột: danh sách peer / khu vực transfer / danh sách file; chunk-map trực quan;
dark/light theme; thống kê tốc độ realtime). Đây **không phải** bản 1–1 sơ khai —
nó đã hỗ trợ **nhiều kết nối P2P đồng thời**, mỗi kết nối là 1 `RTCPeerConnection`
độc lập quản lý qua `Map<socketId, PeerConnection>` (`public/webrtc.js`).

### 3.1. Kiến trúc gốc
```
 Browser A ──┐
 Browser B ──┼── WebSocket (SDP/ICE) ──► Signaling Server (Socket.io, server/index.js)
 Browser C ──┘

 Sau handshake, mỗi cặp peer có 1 kết nối P2P riêng:
 Browser A ◄══════ DataChannel (DTLS) ══════► Browser B
 Browser A ◄══════ DataChannel (DTLS) ══════► Browser C
```

- `server/index.js` — **Signaling Server**: quản lý peer online (cấp ID, avatar/tên
  cầu thủ theo chủ đề World Cup 2026), relay SDP Offer/Answer + ICE candidate.
  Đây **không phải tracker theo file** — nó không biết peer nào đang giữ file nào,
  chỉ biết "ai đang online".
- `public/webrtc.js` — lớp `PeerConnection` (1 kết nối) + `WebRTCHandler` (quản lý
  nhiều `PeerConnection` cùng lúc). Chia file thành chunk 16KB, mỗi chunk kèm
  **SHA-256 hash riêng** trong frame nhị phân `[chunkIdx][fileId][hash][data]`.
  Bên nhận verify hash **từng chunk ngay khi nhận**, rồi verify lại **hash toàn
  file** sau khi ghép — đây là điểm mạnh nhất của app gốc.
- `public/app.js`, `index.html` — giao diện: chunk-map (mỗi ô = 1 chunk, đổi màu
  theo trạng thái pending/receiving/ok/bad), stats bar tốc độ up/down, toast.

### 3.2. Cơ chế chia sẻ file: "đa peer" nhưng chưa phải "swarm"
Điểm mấu chốt cần hiểu rõ (đọc kỹ `_onFileRequest` trong `webrtc.js`): khi peer B
xin file X từ peer A, **toàn bộ file X luôn do một mình A gửi trọn vẹn** cho B.
Nếu sau đó peer C cũng xin file X từ B, B phải **có sẵn file X trong danh sách tự
chia sẻ** (`sharedFiles`) — nhưng file B *vừa tải về* từ A **không** tự động được
thêm vào `sharedFiles`. Nói cách khác: **người tải xong không tự động trở thành
nguồn phát lại** — đây chính là cơ chế còn thiếu so với BitTorrent thật.

→ Mô hình đúng của app gốc là **"multi-peer star-transfer"**: nhiều kết nối 1–1
chạy song song, mỗi kết nối vẫn là 1 nguồn → 1 đích trọn vẹn cho 1 lần tải, chứ
không phải 1 file được **ghép từ nhiều nguồn khác nhau theo từng chunk** (đặc
trưng cốt lõi của swarm BitTorrent).

### 3.3. Đối chiếu nhanh với đề bài
| Yêu cầu | App WebRTC (hiện có) |
|---------|----------------------|
| Chia chunk + metadata | ✅ chunk 16KB, kèm `totalChunks`, `fileHash` khi bắt đầu truyền |
| **Hash chunk** | ✅ SHA-256 mỗi chunk (Web Crypto API) — verify ngay khi nhận |
| Hash toàn file | ✅ verify lại sau khi ghép, hiển thị badge kết quả |
| **Tracker quản lý file→peer** | ⚠️ chỉ quản lý **peer online**, không map theo file |
| Peer discovery theo file | ❌ phải kết nối P2P trước rồi mới trao đổi danh sách file |
| **Tải 1 file song song từ nhiều nguồn** | ❌ mỗi file luôn do 1 peer gửi trọn vẹn |
| **Re-upload/swarm** (tải xong → tự phát lại) | ❌ file nhận về không tự vào `sharedFiles` |
| Ghép file | ✅ `Blob` reassemble |
| Rarest-first | ❌ không có khái niệm "chunk hiếm" (vì không có swarm) |
| Giao diện (GUI) | ✅ rất đầy đủ — vượt yêu cầu tối thiểu |

**Kết luận:** App WebRTC làm **rất tốt** phần toàn vẹn dữ liệu (hash/chunk +
hash/file) và giao diện, hơn hẳn một bài tập NAT/STUN/ICE cơ bản. Nhưng nó vẫn
**chưa có cơ chế swarm** — thứ định nghĩa "BitTorrent": không tracker theo file,
không tải 1 file từ nhiều nguồn, không re-upload. Đạt khoảng **3/7 chức năng bắt
buộc** (xem bảng chi tiết ở `03_DANH_GIA_DE_BAI.md`).

> App WebRTC được **giữ lại nguyên vẹn** trong repo — vẫn là một giải pháp chia
> sẻ file P2P dùng được, và làm phần "so sánh/đối chiếu" trong báo cáo.

---

## 4. Hệ thống mới: BitTorrent-like bằng Node.js + TCP

Để đạt chuẩn, ta xây một hệ mới trong thư mục `bittorrent/`. Điểm mấu chốt:
**peer là tiến trình dòng lệnh (CLI) dùng TCP socket** — nhờ đó có thể chạy hàng
chục peer trên 1 máy và **tự động hoá thử nghiệm** (xem `02_HARNESS.md`), điều
gần như bất khả thi nếu peer nằm trong trình duyệt.

### 4.1. Sơ đồ kiến trúc
```
                         ┌───────────────────────┐
                         │   TRACKER (HTTP)       │  bittorrent/tracker/tracker.js
                         │  Map<infohash,{peers}> │  - announce / get-peers / scrape
                         │  loại peer quá hạn      │  - phát hiện churn
                         └───────────┬───────────┘
             announce/heartbeat       │       announce/heartbeat
        ┌──────────────┬──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼               ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐    ┌─────────┐
   │ SEEDER  │   │ LEECHER │   │ LEECHER │   │ LEECHER │ …  │ LEECHER │
   └────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘    └────┬────┘
        └─────TCP─────┴──────TCP────┴──────TCP────┴─────TCP──────┘
          (trao đổi chunk trực tiếp: BITFIELD / REQUEST / PIECE / HAVE)
```

### 4.2. Các thành phần mã nguồn
| File | Vai trò | Đề bài |
|------|---------|--------|
| `src/torrent.js` | Chia chunk, **hash SHA-256**, tạo/đọc metadata, `ChunkStore` ghi/đọc chunk theo offset, verify, ghép file | 1, 6, 7 |
| `src/protocol.js` | **Wire protocol**: đóng/mở khung message length-prefixed (HANDSHAKE/BITFIELD/HAVE/REQUEST/PIECE) | kỹ thuật |
| `src/piece-picker.js` | Chọn chunk theo **rarest-first** (hoặc random để so sánh) | nâng cao |
| `tracker/tracker.js` | Tracker HTTP: announce, peer discovery, thống kê, loại peer churn | 2, 3 |
| `peer/peer.js` | Nút P2P: TCP server + client, **tải song song nhiều peer**, verify, **re-upload**, xử lý lỗi, throttle, thống kê | 3,4,5,6,7 |
| `cli.js` | Giao diện dòng lệnh: `create / tracker / seed / download` | chạy |

### 4.3. Vòng đời một lần tải (từ góc nhìn 1 leecher)
```
1. Đọc metadata (.meta.json) → biết cần 128 chunk, hash từng chunk.
2. announce lên tracker → nhận danh sách peer khác (peer discovery).
3. Kết nối TCP tới nhiều peer → HANDSHAKE (khớp infohash) → trao đổi BITFIELD.
4. Bộ điều phối: với mỗi peer còn "slot", chọn 1 chunk (rarest-first) mà peer
   đó có và ta thiếu → gửi REQUEST. → Nhiều chunk tải SONG SONG từ nhiều peer.
5. Nhận PIECE → verify SHA-256:
      khớp  → ghi đĩa, gửi HAVE cho mọi peer (ta thành nguồn mới → SWARM),
      sai   → bỏ, chọn lại chunk khác.
6. Nếu 1 peer rớt / quá hạn REQUEST → chunk đang chờ được đưa lại hàng đợi,
   thử peer khác (xử lý lỗi).
7. Đủ 128 chunk → so hash TOÀN FILE → HOÀN TẤT. Ở lại làm seeder phục vụ tiếp.
```

### 4.4. Wire protocol (khung message trên TCP)
TCP là luồng byte liên tục, không có ranh giới "gói tin". Ta bọc mỗi message bằng
**4 byte độ dài** ở đầu để bên nhận cắt đúng (xem `src/protocol.js`, lớp
`FrameParser`).

```
┌────────────┬────────┬─────────────────────┐
│ length(4B) │ type(1)│ payload             │
└────────────┴────────┴─────────────────────┘
 HANDSHAKE {infohash, peerId}   BITFIELD <bit mỗi chunk>
 HAVE <index>   REQUEST <index>   PIECE <index><data>
```

### 4.5. "Đa luồng" trong Node.js?
Node chạy **1 luồng** nhưng theo mô hình **event-loop bất đồng bộ** (non-blocking
I/O). Một peer có thể mở hàng chục kết nối TCP và xử lý đọc/ghi **đan xen** mà
không chặn nhau — đây là dạng **đồng thời (concurrency)** phù hợp cho ứng dụng
nặng I/O như P2P, và thoả yêu cầu "xử lý đồng thời" của đề bài. (Nếu muốn song
song thực sự trên nhiều CPU có thể dùng `worker_threads`, nhưng không cần cho bài
toán này.)

### 4.6. Giao diện Web cho hệ thống mới (`web/`)
Peer của hệ mới là tiến trình CLI (không có màn hình), nên để có **GUI** như đề
bài khuyến khích, `web/server.js` import thẳng các module `Peer`/`Tracker`/
`torrent` và chạy chúng **trong cùng tiến trình** với 1 web server (không dùng
framework, chỉ module built-in). Người dùng:
1. Tải file lên trình duyệt → server tự chia chunk, hash, và **tự làm seeder**.
2. Bấm "Tải xuống" → server tạo 1 **Peer leecher mới**, tải thật qua giao thức
   TCP/swarm (không giả lập), tiến độ hiển thị real-time (polling 1s).
3. Tải xong → tải file kết quả về máy qua trình duyệt.

Vì đây vẫn là **peer thật** nói chuyện qua TCP, các peer chạy từ `cli.js` (dòng
lệnh) trên máy khác có thể tham gia **cùng swarm** nếu trỏ đúng tracker — web UI
và CLI peer cùng tồn tại trong 1 hệ sinh thái, không tách biệt.

---

## 5. Cách chạy nhanh (thủ công)

```bash
# 0) Tạo file test 8MB
node harness/gen-file.js demo.bin 8

# 1) Tạo metadata (chia chunk + hash)
node bittorrent/cli.js create demo.bin --chunk 65536 --out demo.meta.json

# 2) Chạy tracker (cửa sổ 1)
node bittorrent/cli.js tracker --port 4000

# 3) Chạy seeder (cửa sổ 2) — máy đang giữ file gốc
node bittorrent/cli.js seed demo.bin demo.meta.json --tracker http://localhost:4000

# 4) Chạy 1..N leecher (mỗi cái 1 cửa sổ) — tải về file riêng
node bittorrent/cli.js download demo.meta.json --tracker http://localhost:4000 --out out1.bin
node bittorrent/cli.js download demo.meta.json --tracker http://localhost:4000 --out out2.bin
```

Muốn chạy **tự động nhiều peer + đo đạc**, dùng harness:
```bash
node harness/run-experiment.js harness/scenarios/baseline.json
```
→ Xem chi tiết ở [`02_HARNESS.md`](02_HARNESS.md).

Muốn dùng **giao diện Web** thay vì CLI:
```bash
node web/server.js            # mặc định cổng 5000, tracker cổng 4000
# mở trình duyệt: http://localhost:5000
```

---

## 6. Kết quả đã kiểm chứng (tóm tắt)
Hệ thống đã chạy thật qua harness (chi tiết & số liệu trong `02_HARNESS.md` và
`03_DANH_GIA_DE_BAI.md`):
- **baseline** (1 seed + 3 leech): mọi leecher tải từ **3 nguồn**, hash file khớp 100%.
- **scaling** (1 seed + 8 leech): tải từ **8 nguồn**, xong ~1.2s — *càng đông càng nhanh*.
- **churn**: kill 1 leecher giữa chừng → các peer còn lại **vẫn hoàn tất**; peer bị
  kill khi restart tự tải lại thành công.
- Tất cả file đích **trùng SHA-256** với bản gốc → toàn vẹn tuyệt đối.

---

## 7. Đọc tiếp
- [`02_HARNESS.md`](02_HARNESS.md) — Khung thử nghiệm: thiết kế, cách chạy, đọc số liệu.
- [`03_DANH_GIA_DE_BAI.md`](03_DANH_GIA_DE_BAI.md) — Đối chiếu chi tiết với từng yêu cầu đề bài.
- [`04_SLIDE_OUTLINE.md`](04_SLIDE_OUTLINE.md) — Dàn ý slide thuyết trình.
