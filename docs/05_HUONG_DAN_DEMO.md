# Hướng dẫn Demo — Test đầy đủ chức năng trên giao diện

> Kịch bản demo trực tiếp cho giảng viên, đi từng bước trên **trình duyệt**
> (không cần gõ lệnh, trừ phần D dành cho ai muốn xem thêm số liệu định lượng).
> Mỗi bước ghi rõ: **thao tác** → **quan sát gì** → **chứng minh chức năng nào**
> của đề bài.

---

## 0. Chuẩn bị (1 phút)

```bash
npm install     # nếu chưa cài
npm run dev
```

Mở trình duyệt: **http://localhost:5000**

> ⚠️ **Lưu ý quan trọng khi demo:** trên `localhost`, mạng nhanh tới mức file
> nhỏ (vài MB) có thể tải xong trong **dưới 50ms** — quá nhanh để mắt thường
> thấy progress bar hay cột "Nguồn" thay đổi. Để demo trực quan, **hãy dùng 1
> file khá lớn (100–300 MB, ví dụ 1 video hoặc file .iso/.zip bất kỳ)** — khi
> đó quá trình tải kéo dài vài giây, đủ để quan sát tiến độ real-time.

---

## Phần A — Hai giao diện trong 1 server (30 giây)

| Bước | Thao tác                                             | Quan sát                                                                                       | Chứng minh                                        |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| A1   | Trang mở ra là app WebRTC gốc (theme World Cup 2026) | Header có nút **"🧲 BitTorrent Engine"**                                                       | Giữ nguyên app cũ, không phá vỡ gì                |
| A2   | Bấm nút đó                                           | Chuyển sang `http://localhost:5000/bittorrent/` — dashboard tối màu, cùng font/màu với app gốc | Hệ BitTorrent-swarm mới đã tích hợp cùng 1 server |
| A3   | Bấm nút **"⇄ App WebRTC"** ở dashboard mới           | Quay lại `/`                                                                                   | 2 hệ chạy song song, độc lập, không xung đột cổng |

---

## Phần B — 7 chức năng bắt buộc của đề bài

Từ đây, làm việc trên dashboard `/bittorrent/`.

### B1. Chia file thành chunk + tạo metadata (tên, size, hash chunk)

1. Ở mục **"1. Chia sẻ file mới"**, bấm **Chọn tệp**, chọn file demo (khuyến
   nghị 100–300MB để thấy tiến trình — xem lưu ý ở mục 0).
2. Có thể chỉnh **"Kích thước chunk"** (mặc định 65536 = 64KB), hoặc để nguyên.
3. Bấm **"Tải lên & chia sẻ"**.
4. **Quan sát:** dòng thông báo xanh `✓ Đã chia sẻ "<tên file>" — N chunk. Đang
seed.` xuất hiện. Bảng **"2. Danh sách torrent"** hiện 1 dòng mới với **Kích
   thước**, **Số chunk**, và **Infohash** (định danh duy nhất — là hash SHA-256
   của toàn bộ metadata).

**→ Giải thích cho giảng viên:** ngay khi upload, server đã tự động (a) đọc
file, (b) cắt thành N mảnh cố định kích thước, (c) tính SHA-256 cho **từng
mảnh**, (d) đóng gói tất cả vào 1 "metadata" (tương đương file `.torrent`).
Việc này diễn ra ở `bittorrent/src/torrent.js` (hàm `createMetadata`).

### B2 + B3. Tracker / bootstrap server + Peer discovery

1. Nhìn lên **badge ở góc phải header** — hiển thị `http://localhost:4000 ·
chunk mặc định ...` — đó là địa chỉ **tracker**, server "danh bạ" chạy riêng.
2. Ở dòng torrent vừa tạo, bấm **"⬇ Tải xuống"** — thao tác này tạo ra 1
   **peer LEECHER hoàn toàn mới**, chưa hề biết trước ai đang giữ file.
3. **Quan sát:** bảng **"3. Peer đang chạy"** xuất hiện thêm 1 dòng `LEECH`.
   Sau vài trăm ms tới vài giây (tuỳ kích thước file), tiến độ tăng dần.

**→ Giải thích:** peer LEECHER này khi khởi động đã tự "announce" (đăng ký)
lên tracker `:4000` và **hỏi tracker: "ai đang giữ file này?"** — tracker trả
về danh sách peer (ở đây là SEED vừa tạo ở bước B1). Đây chính là **peer
discovery** — không cần biết địa chỉ IP/port của nhau trước, tracker làm trung
gian giới thiệu.

### B4 + B5. Tải từ nhiều peer song song + Upload lại (re-upload/swarm)

1. Với torrent đang có, bấm **"⬇ Tải xuống" 2–3 lần liên tiếp** để tạo thêm
   nhiều leecher cùng tải 1 lúc.
2. **Quan sát khi các leecher đang tải dở (chưa tới 100%):**
   - Cột **"↓ Tải xuống"**: mỗi leecher đang nhận dữ liệu (tốc độ tức thời;
     khi đã xong hiển thị nhãn `TB` kèm tốc độ trung bình cả quá trình).
   - Cột **"Nguồn"**: số này **tăng dần lên >1** — nghĩa là 1 leecher đang kéo
     chunk từ **nhiều peer khác nhau cùng lúc** (không chỉ từ seed gốc).
   - Cột **"↑ Chia sẻ"** của các leecher khác (không phải seed) cũng **>0** —
     nghĩa là leecher đó đang **tải chưa xong nhưng đã bắt đầu phục vụ ngược
     lại** chunk mình có cho leecher khác (khi không ai xin chunk, cột này hiện
     nhãn `Tổng` kèm tổng dung lượng đã chia sẻ, thay vì về 0 gây hiểu lầm).

**→ Giải thích:** đây là "trái tim" của BitTorrent — khác hẳn tải file kiểu
client–server (luôn 1 nguồn), ở đây **càng nhiều người tải, tổng băng thông
càng lớn**, vì mọi người vừa tải vừa chia lại ngay lập tức.

> Nếu file nhỏ nên tải xong quá nhanh không kịp nhìn cột "Nguồn": xem lại kết
> quả cuối — dù đã 100%, cột **"Nguồn"** vẫn giữ nguyên giá trị cuối cùng (số
> nguồn _khác nhau_ mà peer đó từng tải về trong suốt quá trình) — vẫn đủ để
> chứng minh với giảng viên dù không kịp xem lúc đang chạy.

### B6. Kiểm tra toàn vẹn dữ liệu bằng hash

Không có nút riêng cho bước này vì nó chạy **ngầm, tự động, với mọi chunk**:

1. Mở `bittorrent/peer/peer.js`, hàm `_onPiece()` — chỉ cho giảng viên thấy
   dòng `verifyChunk(this.meta, index, data)`: mỗi khi nhận 1 mảnh, peer tính
   lại SHA-256 và so với hash đã lưu trong metadata **trước khi ghi vào đĩa**.
2. Bằng chứng gián tiếp trên UI: mọi peer tải xong đều hiện **icon ✓ nhỏ cạnh
   badge SEED/LEECH** (rê chuột hiện tooltip "Đã hoàn tất") — chứng tỏ đã đi
   qua bước verify này cho **toàn bộ** chunk; nếu 1 chunk sai hash, nó sẽ bị
   loại và tải lại tự động (xem `bad-chunk` / `timeout-chunk` trong log nếu
   chạy qua CLI/harness — mục D).
3. **Cách chứng minh chắc chắn nhất:** tải file về (bước B7), rồi dùng công cụ
   tính hash bất kỳ (CertUtil trên Windows, hoặc `Get-FileHash`) so với file
   gốc trên máy — sẽ **khớp tuyệt đối**.
   ```powershell
   Get-FileHash "file_goc.ext"
   Get-FileHash "file_tai_ve.ext"
   ```

### B7. Ghép các chunk để tạo lại file hoàn chỉnh

1. Với 1 peer LEECH đã đạt **icon ✓ "Đã hoàn tất" (100%)**, bấm nút **"Tải file"**.
2. Trình duyệt tải file về máy — mở ra xem đúng nội dung (ảnh xem được, video
   phát được, zip giải nén được...).

**→ Giải thích:** file này được ghép từ N chunk nhận về không theo thứ tự cố
định (tuỳ chunk nào tới trước), mỗi chunk được ghi **đúng vị trí offset** của
nó trong file đích ngay khi verify xong — không cần đợi đủ để ghép 1 lần.

---

## Phần C — Yêu cầu kỹ thuật: xử lý lỗi (peer rời mạng / mất kết nối)

1. Tạo lại 1 torrent lớn (100–300MB) để có đủ thời gian thao tác.
2. Bấm **"⬇ Tải xuống"** để tạo 2–3 leecher.
3. **Trong lúc 1 leecher đang tải dở** (chưa tới 100%), bấm nút **"Dừng"** của
   đúng peer đó — mô phỏng peer đột ngột rời mạng/mất kết nối.
4. **Quan sát:** peer đó biến mất khỏi bảng, nhưng **các leecher còn lại vẫn
   tiếp tục tải bình thường, không bị treo/lỗi**.
5. Bấm lại **"⬇ Tải xuống"** trên torrent đó — 1 leecher mới được tạo, coi như
   peer "quay lại mạng", tải lại từ đầu bình thường.

**→ Giải thích:** khi 1 kết nối bị đóng đột ngột, mọi chunk đang chờ dở từ peer
đó được **tự động đưa lại vào hàng đợi** để xin từ peer khác — đây chính là cơ
chế đề bài yêu cầu ("xử lý lỗi... mất kết nối khi tải chunk").

---

## Phần D — Bằng chứng số liệu định lượng (tuỳ chọn, nếu giảng viên muốn xem sâu hơn)

Phần B/C chứng minh bằng **mắt thường trên UI**. Nếu muốn có **số liệu** (thời
gian, throughput, bao nhiêu nguồn chính xác) để đưa vào báo cáo hoặc trả lời
câu hỏi phản biện, mở thêm 1 cửa sổ terminal và chạy:

```bash
# Chứng minh B4+B5 (tải đa nguồn + re-upload) bằng số liệu chính xác
node harness/run-experiment.js harness/scenarios/baseline.json

# Chứng minh Phần C (xử lý churn) có kịch bản kill+restart tự động, có log rõ
node harness/run-experiment.js harness/scenarios/churn.json

# Chứng minh chức năng nâng cao: so sánh rarest-first vs random
node harness/run-experiment.js harness/scenarios/rarest-vs-random-A-rarest.json
node harness/run-experiment.js harness/scenarios/rarest-vs-random-B-random.json
```

Mỗi lệnh tự dựng 1 tracker + nhiều peer, in bảng tóm tắt, và ghi ra
`harness/results/*.json` + `.csv` — xem chi tiết cách đọc ở
[`02_HARNESS.md`](02_HARNESS.md).

> Các lệnh này dùng cổng tracker riêng (4001–4005, khai trong từng file
> `harness/scenarios/*.json`) nên **chạy song song thoải mái** với dashboard
> đang mở ở cổng 5000/4000, không xung đột.

---

## Phần E — Chức năng nâng cao khác (điểm cộng, nói nhanh)

| Chức năng                   | Cách chỉ ra                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Rarest-first**            | Giải thích khái niệm (ưu tiên tải chunk hiếm nhất trước) + chạy Phần D để có số liệu so sánh            |
| **Thống kê tốc độ up/down** | Đã thấy trực tiếp ở cột "↓ Tải xuống" / "↑ Chia sẻ" trong Phần B4                                       |
| **Giao diện (GUI)**         | Cả app WebRTC gốc **và** dashboard mới — 2 giao diện, chuyển qua lại bằng nút bấm (Phần A)              |
| **Mô phỏng churn**          | Đã demo trực tiếp ở Phần C; ngoài ra `harness/scenarios/churn.json` (Phần D) mô phỏng tự động theo lịch |

---

## Câu hỏi thường gặp khi demo

**"Sao tải nhanh quá, không thấy gì cả?"**
→ Đúng đặc điểm mạng `localhost` (không có độ trễ mạng thật). Dùng file lớn
hơn (mục 0), hoặc chạy Phần D — harness có tuỳ chọn giới hạn tốc độ upload
(`uploadKBps` trong file kịch bản) để mô phỏng mạng thật, kéo dài quá trình đủ
để quan sát.

**"Vậy hash sai thì sao, có thấy được không?"**
→ Cơ chế chạy ngầm và tự sửa nên bình thường không thấy lỗi (đúng như thiết
kế — mạng LAN/localhost sạch, dữ liệu không hỏng). Có thể chỉ code trực tiếp
(`peer.js`, hàm `_onPiece`) để giảng viên thấy logic verify, thay vì cố tạo
lỗi giả trên UI.

**"App WebRTC gốc và hệ BitTorrent này khác nhau thế nào?"**
→ Trả lời nhanh, xem chi tiết ở [`03_DANH_GIA_DE_BAI.md`](03_DANH_GIA_DE_BAI.md):
app gốc là **nhiều kết nối 1–1 song song** (mỗi file luôn do 1 peer gửi trọn),
còn hệ mới có **tracker theo file + tải 1 file từ nhiều nguồn + re-upload** —
đúng bản chất "swarm" của BitTorrent.

---

## Danh sách kiểm (checklist) trước khi demo

- [ ] `npm run dev` chạy không lỗi, mở được `http://localhost:5000`
- [ ] Đã chuẩn bị sẵn 1–2 file demo cỡ 100–300MB trên máy
- [ ] Đã thử chạy nháp toàn bộ kịch bản 1 lần trước khi trình bày thật
- [ ] Mở sẵn `bittorrent/peer/peer.js` (hàm `_onPiece`) trong editor để chỉ
      nhanh đoạn `verifyChunk` khi tới Phần B6
- [ ] (Tuỳ chọn) Mở sẵn 1 terminal khác để chạy Phần D nếu có thời gian
