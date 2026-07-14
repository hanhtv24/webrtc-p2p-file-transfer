# Hướng dẫn cài đặt — Build & chạy dự án từ đầu

> Dành cho người **chưa từng đụng vào code này**, vừa `git clone` về và cần tự
> tay dựng lên chạy được. Làm theo đúng thứ tự, mỗi bước có cách kiểm tra đã
> đúng hay chưa trước khi sang bước kế tiếp.
>
> Muốn xem **demo tính năng** sau khi đã chạy được rồi, đọc tiếp
> [`05_HUONG_DAN_DEMO.md`](05_HUONG_DAN_DEMO.md).

---

## 1. Yêu cầu trước khi bắt đầu

| Công cụ | Phiên bản tối thiểu | Kiểm tra bằng lệnh |
|---------|---------------------|---------------------|
| **Node.js** | 16.x trở lên (khuyến nghị bản LTS mới nhất, vd 18/20/22) | `node -v` |
| **npm** | đi kèm sẵn với Node.js | `npm -v` |
| **Git** | bất kỳ bản gần đây | `git --version` |
| **Trình duyệt** | Chrome / Edge / Firefox bản mới | — |

Nếu `node -v` báo lỗi "không tìm thấy lệnh" hoặc phiên bản dưới 18 → tải cài
tại [nodejs.org](https://nodejs.org) (chọn bản **LTS**), cài xong **mở lại
terminal** rồi thử lại `node -v`.

> Dự án dùng cú pháp `require("node:fs")` (tiền tố `node:`) — cú pháp này cần
> Node.js từ bản 16 trở lên, nên **bắt buộc không được dùng Node quá cũ**.

---

## 2. Tải mã nguồn về máy

```bash
git clone https://github.com/hanhtv24/p2p-file-sharing-suite.git
cd p2p-file-sharing-suite
```

Không có Git? Vào trang GitHub của repo → nút xanh **Code** → **Download ZIP**
→ giải nén → mở terminal tại đúng thư mục vừa giải nén.

**Kiểm tra đã vào đúng thư mục:** chạy lệnh sau, phải thấy các thư mục dưới đây:

```bash
ls
# Kết quả mong đợi có: bittorrent/  docs/  harness/  public/  server/  web/
# package.json  README.md
```

---

## 3. Cài đặt thư viện phụ thuộc

```bash
npm install
```

Lệnh này đọc `package.json`, tải 2 thư viện cần thiết (`express`,
`socket.io`) vào thư mục `node_modules/` (tự sinh ra, không cần quan tâm nội
dung bên trong).

**Kiểm tra:** sau khi lệnh chạy xong (không có dòng `npm ERR!` màu đỏ), gõ:

```bash
ls node_modules | wc -l   # (Windows PowerShell: (Get-ChildItem node_modules).Count)
```

Phải ra một con số lớn (vài chục/trăm) — nếu báo lỗi "No such file or
directory" nghĩa là `npm install` chưa chạy thành công, xem lại thông báo lỗi
phía trên và cài lại.

---

## 4. Chạy dự án

Dự án có **2 ứng dụng chạy chung 1 lệnh, 1 cổng**:

```bash
npm run dev
```

Nếu chạy đúng, terminal sẽ in ra gần giống thế này (không thoát ra prompt, cứ
để terminal đó chạy):

```
[tracker] đang chạy tại http://localhost:4000  (announce/scrape)
║   Server đang chạy tại: http://localhost:5000             ║
║   Hệ BitTorrent-swarm : http://localhost:5000/bittorrent/  ║
```

- Cổng **5000** — cổng chính, phục vụ cả 2 giao diện web.
- Cổng **4000** — tracker nội bộ của hệ BitTorrent-swarm (không cần mở tay,
  chỉ cần biết nó cũng đang chạy song song).

> `npm run dev` dùng `node --watch` — mỗi lần sửa file server, tự khởi động
> lại, tiện khi vừa code vừa test. Dùng `npm start` nếu chỉ muốn chạy 1 lần,
> không tự reload.

### Dừng server

Bấm `Ctrl + C` trong terminal đang chạy.

---

## 5. Kiểm tra đã chạy đúng chưa

Mở trình duyệt, lần lượt vào 2 địa chỉ:

| Địa chỉ | Phải thấy |
|---------|-----------|
| **http://localhost:5000/** | App WebRTC P2P Transfer — theme tối World Cup 2026, có ô nhập Peer ID, danh sách peer bên trái |
| **http://localhost:5000/bittorrent/** | Dashboard BitTorrent-swarm — form "Chia sẻ file mới", 2 bảng "Danh sách torrent" / "Peer đang chạy" |

Ở app WebRTC (`/`) có nút **"🧲 BitTorrent Engine"** trên header để bấm sang
trang kia, và ngược lại có nút **"⇄ App WebRTC"** để quay về — bấm thử, nếu
chuyển qua lại được là đã dựng đúng.

**Test nhanh 1 vòng đầy đủ (không cần 2 máy):**
1. Vào `http://localhost:5000/bittorrent/`.
2. Bấm **Chọn tệp**, chọn 1 file bất kỳ trên máy (vài MB cho nhanh) → bấm
   **Tải lên & chia sẻ**.
3. Thấy dòng chữ xanh `✓ Đã chia sẻ "..." — N chunk. Đang seed.` và 1 dòng mới
   xuất hiện ở bảng "Danh sách torrent" → **build thành công**.
4. Bấm **⬇ Tải xuống** ở dòng đó → bảng "Peer đang chạy" xuất hiện 1 peer
   LEECH, tiến độ chạy lên 100% → chứng tỏ 2 "peer" (seed vừa tạo + leech vừa
   tải) đã nói chuyện được với nhau qua giao thức TCP nội bộ.

Nếu cả 4 bước trên đều đúng như mô tả → dự án đã dựng lên hoàn chỉnh.

---

## 6. Sự cố thường gặp

### "Port 5000 đã được sử dụng" / `EADDRINUSE`
Có chương trình khác (hoặc phiên `npm run dev` cũ chưa tắt hẳn) đang chiếm
cổng 5000. Cách xử lý:
- Đóng hẳn terminal cũ đang chạy server (nếu còn), hoặc
- Đổi sang cổng khác:
  ```bash
  # macOS/Linux
  PORT=5001 npm run dev
  # Windows PowerShell
  $env:PORT=5001; npm run dev
  ```
  rồi vào `http://localhost:5001` thay vì 5000.

### Trình duyệt báo "Không thể truy cập trang web này" dù server đã chạy
- Kiểm tra lại đúng cổng terminal in ra (không phải lúc nào cũng là 5000 nếu
  đã đổi qua biến môi trường `PORT`).
- **Một số cổng bị chính trình duyệt chặn mặc định** vì lý do bảo mật (gọi là
  "unsafe ports") — ví dụ cổng `6000` (trùng cổng dịch vụ X11). Nếu đổi `PORT`
  sang một số cụ thể mà trình duyệt luôn từ chối kết nối dù server chắc chắn
  đang chạy (kiểm tra bằng `curl http://localhost:<port>` thấy có phản hồi),
  hãy đổi sang cổng khác (vd 5001, 7000, 8080).
- Có popup **Windows Firewall** hỏi "Cho phép node.exe truy cập mạng" mà bị bỏ
  qua/chặn — tìm lại popup đó (có thể ẩn sau cửa sổ khác) và bấm **Allow**.

### `npm install` báo lỗi liên quan `node-gyp` / biên dịch native
Dự án **không dùng module native nào cần biên dịch** (chỉ `express`,
`socket.io` — thuần JavaScript). Nếu vẫn gặp lỗi dạng này, khả năng cao do
phiên bản Node quá cũ hoặc cache npm hỏng — thử:
```bash
npm cache clean --force
rm -rf node_modules package-lock.json   # Windows: rmdir /s node_modules & del package-lock.json
npm install
```

### Upload file lớn bị lỗi / trang báo `Unexpected token '<'`
Giới hạn dung lượng upload mặc định trong `web/api.js` là **2GB** — nếu vẫn
gặp lỗi này với file nhỏ hơn, khả năng do máy hết RAM tạm thời khi xử lý file
(server đọc cả file vào bộ nhớ trước khi ghi đĩa). Thử lại với file nhỏ hơn để
xác nhận server hoạt động bình thường trước.

### Chạy trên máy khác trong cùng mạng LAN (không phải localhost)
Server lắng nghe trên mọi địa chỉ mạng (`0.0.0.0`), nên máy khác cùng mạng có
thể truy cập qua `http://<IP-máy-chủ>:5000` (thay `<IP-máy-chủ>` bằng IP LAN
của máy đang chạy `npm run dev`, xem bằng `ipconfig` trên Windows hoặc
`ifconfig`/`ip addr` trên macOS/Linux). App WebRTC cần cả 2 máy vào đúng địa
chỉ này để signaling server nối được 2 bên.

---

## 7. Các lệnh nâng cao (không bắt buộc để "build lên web")

Chỉ cần mục 1–5 ở trên là đã có web chạy đầy đủ. Các lệnh dưới đây dành cho ai
muốn khai thác sâu hơn hệ BitTorrent-swarm bằng dòng lệnh, không qua giao diện:

```bash
# Chạy dashboard BitTorrent-swarm ĐỘC LẬP, không kèm app WebRTC (cổng 5050)
node web/server.js

# Bộ công cụ dòng lệnh: tạo metadata / chạy tracker / seed / tải file
node bittorrent/cli.js --help

# Khung thử nghiệm tự động: dựng hàng chục peer, đo throughput, xuất CSV
node harness/run-experiment.js harness/scenarios/baseline.json
```

Chi tiết xem [`01_PHAN_TICH_DU_AN.md`](01_PHAN_TICH_DU_AN.md) (kiến trúc) và
[`02_HARNESS.md`](02_HARNESS.md) (khung thử nghiệm).

---

## 8. Tóm tắt siêu ngắn (cho ai chỉ muốn copy-paste)

```bash
git clone https://github.com/hanhtv24/p2p-file-sharing-suite.git
cd p2p-file-sharing-suite
npm install
npm run dev
# Mở trình duyệt: http://localhost:5000 (app WebRTC) và http://localhost:5000/bittorrent/ (dashboard mới)
```
