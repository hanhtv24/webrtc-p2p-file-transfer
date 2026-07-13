# Harness (khung thử nghiệm) cho hệ P2P

> "Harness" = bộ khung tự động **dựng hệ thống, chạy kịch bản, đo đạc và xuất số
> liệu**. Với môn Hệ phân tán, phần "thử nghiệm" của báo cáo cần số liệu khách
> quan — harness chính là công cụ tạo ra số liệu đó một cách **lặp lại được**.

---

## 1. Vì sao hệ phân tán cần harness?

Một hệ phân tán có **nhiều tiến trình** chạy đồng thời, tương tác qua mạng, có
yếu tố **thời gian** và **ngẫu nhiên** (thứ tự message, peer vào/ra). Kiểm thử
thủ công (mở 5 cửa sổ terminal, tự bấm) có 3 vấn đề:

1. **Không lặp lại được** — mỗi lần chạy một khác, khó so sánh.
2. **Không đo được** — khó lấy con số "peer X tải xong sau bao nhiêu ms".
3. **Không mở rộng** — thử 20 peer bằng tay là bất khả thi.

Harness giải quyết cả ba: mô tả kịch bản bằng 1 file JSON, chạy 1 lệnh, nhận về
bảng số liệu + file CSV/JSON để vẽ biểu đồ đưa vào báo cáo.

> Đây cũng là **lý do kỹ thuật** khiến dự án chuyển từ WebRTC/trình duyệt sang
> peer dạng **CLI Node.js**: chỉ khi peer là tiến trình dòng lệnh thì harness mới
> có thể `spawn` hàng loạt và thu thập stdout tự động. Peer trong trình duyệt gần
> như không thể tự động hoá ở quy mô này.

---

## 2. Kiến trúc harness

```
                       harness/run-experiment.js  (bộ điều phối)
                                    │
   đọc kịch bản JSON ──────────────┤
                                    │ spawn (child_process)
     ┌──────────────┬──────────────┼───────────────┬──────────────┐
     ▼              ▼              ▼               ▼              ▼
  tracker         seed0          leech0          leech1   …    leechN
     │              │              │               │              │
     └── stdout ────┴──── "##EVT## {json}" ────────┴──────────────┘
                                    │
                          gom sự kiện, tính số liệu
                                    │
                    ┌───────────────┴────────────────┐
                    ▼                                 ▼
          in bảng tóm tắt              results/<tên>-<time>.json + .csv
```

**Cơ chế thu số liệu — "structured logging":** mỗi peer in ra các dòng đặc biệt
bắt đầu bằng `##EVT## ` kèm JSON (xem hàm `emit()` trong `bittorrent/peer/peer.js`).
Harness đọc stdout của từng tiến trình con, tách các dòng đó và parse JSON. Các
sự kiện chính:

| Sự kiện | Khi nào | Dữ liệu quan trọng |
|---------|---------|--------------------|
| `start` | peer khởi động | peerId, port, role (seed/leech), chunkCount |
| `stats` | mỗi 1s | have (số chunk đang có), peers, bytesDown/Up |
| `complete` | tải xong | ms, bytesDown, bytesUp, **sources**, throughputKBps, fileOk |
| `peer-disconnect` | 1 peer rớt | remote peerId |
| `bad-chunk` / `timeout-chunk` | verify sai / quá hạn | index, from |

Trường **`sources`** (số peer khác nhau mà leecher đã tải chunk về) chính là bằng
chứng định lượng cho "tải song song nhiều peer".

---

## 3. Các file trong `harness/`

| File | Chức năng |
|------|-----------|
| `run-experiment.js` | Bộ điều phối chính: dựng swarm, chạy churn, thu số liệu, kiểm tra hash, xuất kết quả |
| `gen-file.js` | Sinh file test kích thước tuỳ ý bằng dữ liệu ngẫu nhiên |
| `scenarios/*.json` | Mô tả từng kịch bản thử nghiệm |
| `results/*.json,*.csv` | Kết quả sinh ra (tự tạo khi chạy) |
| `tmp/*` | File nguồn/đích tạm khi chạy (tự tạo) |

### 3.1. Định dạng file kịch bản (scenario)
```jsonc
{
  "name": "baseline",     // tên → dùng đặt tên file kết quả
  "fileSizeMB": 4,        // kích thước file test
  "chunkSize": 65536,     // 64KB mỗi chunk
  "seeders": 1,           // số seeder (giữ đủ file)
  "leechers": 3,          // số leecher (tải file)
  "strategy": "rarest",   // "rarest" | "random"
  "uploadKBps": 2048,     // giới hạn tốc độ upload/peer (0 = không giới hạn)
  "trackerPort": 4001,    // cổng tracker (mỗi kịch bản 1 cổng khác nhau)
  "timeoutMs": 60000,     // thời gian tối đa chờ tải xong
  "churn": [              // lịch mô phỏng peer join/leave
    { "atMs": 2000, "action": "kill",    "target": "leech", "index": 0 },
    { "atMs": 5000, "action": "restart", "target": "leech", "index": 0 }
  ]
}
```

> **Vì sao có `uploadKBps` (throttle)?** Trên localhost mọi thứ nhanh tới mức 1
> file 8MB tải xong trong ~80ms — quá nhanh để đo hay để churn kịp xảy ra. Giới
> hạn tốc độ upload mỗi kết nối mô phỏng mạng thật, khiến thí nghiệm kéo dài vài
> giây (đo được) và biến cố churn rơi đúng giữa chừng.

---

## 4. Cách chạy

```bash
# Chạy 1 kịch bản
node harness/run-experiment.js harness/scenarios/baseline.json

# Các kịch bản có sẵn:
node harness/run-experiment.js harness/scenarios/scaling.json                 # mở rộng số peer
node harness/run-experiment.js harness/scenarios/churn.json                   # chịu lỗi peer rời mạng
node harness/run-experiment.js harness/scenarios/rarest-vs-random-A-rarest.json
node harness/run-experiment.js harness/scenarios/rarest-vs-random-B-random.json
```

Kết thúc, harness in bảng tóm tắt và ghi `harness/results/<tên>-<timestamp>.json`
(đầy đủ cấu hình + toàn bộ event + số liệu từng peer) và `.csv` (mở bằng Excel để
vẽ biểu đồ).

> **Lưu ý phân biệt `harness/` và `web/`:** harness dùng để **đo đạc tự động,
> không có màn hình** (chạy CLI, xuất số liệu cho báo cáo). `web/server.js` là
> **dashboard tương tác** cho người dùng cuối (upload, bấm tải xuống, xem tiến độ)
> — dùng cùng lõi `Peer`/`Tracker` nhưng phục vụ mục đích demo trực quan, không
> xuất CSV. Cả hai có thể chạy song song vì mỗi cái tự mở tracker/cổng riêng.

Mã thoát (exit code): `0` nếu **mọi leecher tải xong và hash khớp**, `1` nếu có
lỗi → tiện tích hợp CI/tự kiểm.

---

## 5. Bốn kịch bản và điều chúng chứng minh

| Kịch bản | Mục tiêu chứng minh | Yêu cầu đề bài |
|----------|---------------------|----------------|
| **baseline** | Swarm chạy đúng, tải đa nguồn, hash toàn vẹn | 4, 5, 6, 7 |
| **scaling** | Càng nhiều peer, mỗi peer càng nhanh (hiệu ứng BitTorrent) | 4, 5 |
| **rarest-vs-random** | So sánh chiến lược chọn chunk | nâng cao |
| **churn** | Peer rời mạng giữa chừng, hệ vẫn hoàn tất | xử lý lỗi |

---

## 6. Kết quả thực nghiệm đã chạy (máy Windows, Node v24, localhost)

> Số liệu dưới đây lấy từ lần chạy thật; file kết quả nằm trong `harness/results/`.
> Chạy lại có thể lệch nhẹ do yếu tố thời gian.

### 6.1. baseline — 1 seed + 3 leech, file 4MB
- 3/3 leecher hoàn tất, **hash khớp 100%**.
- Mỗi leecher tải từ **3 nguồn** (seeder + 2 leecher còn lại) → chứng minh
  **tải song song đa nguồn** và **re-upload/swarm**.

### 6.2. scaling — 1 seed + 8 leech, file 8MB, throttle 2048KB/s
| Chỉ số | Giá trị |
|--------|---------|
| Hoàn tất | 8/8, hash khớp 100% |
| Thời gian (peer chậm nhất) | **~1197 ms** |
| Throughput trung bình | **~7164 KB/s** / leecher |
| Số nguồn tối đa | 8 |

So với 6 leecher (~2601ms, ~3215KB/s) và 3 leecher: **thêm peer → nhanh hơn cho
tất cả**, vì tổng năng lực upload của swarm tăng theo số peer. Đây đúng là hiệu
ứng cốt lõi của BitTorrent (khác hẳn client–server: thêm client → chậm đi).

### 6.3. rarest vs random — 1 seed + 6 leech, file 8MB, throttle 1024KB/s
| Chiến lược | Thời gian | Throughput TB |
|-----------|-----------|---------------|
| rarest | ~2601 ms | ~3215 KB/s |
| random | ~2601 ms | ~3241 KB/s |

**Nhận xét trung thực:** trong kịch bản "flash crowd" (mọi leecher vào cùng lúc,
seeder ổn định giữ đủ file), rarest-first và random **gần như bằng nhau** — vì
mọi chunk đều sẵn có như nhau từ seeder, không có sự khan hiếm. Lợi thế của
rarest-first bộc lộ rõ khi có **khan hiếm chunk**: seeder rời đi sau khi gieo,
hoặc peer vào swarm lệch thời điểm. Đây là kết luận đúng với lý thuyết và là một
điểm phân tích tốt cho báo cáo (có thể mở rộng thành kịch bản "seed rời sớm").

### 6.4. churn — 1 seed + 4 leech, kill leech0 @2s, restart @5s
- leech1/2/3: **không bị ảnh hưởng**, hoàn tất ~3.2s (chunk đang chờ từ leech0
  được tự động xin lại từ peer khác).
- leech0: bị kill giữa chừng → khi restart **tải lại từ đầu và hoàn tất** (thậm
  chí nhanh hơn vì swarm giờ có nhiều nguồn hơn).
- Tất cả hash khớp → **hệ chịu được churn**.

---

## 7. Đưa số liệu vào báo cáo
1. Chạy các kịch bản → lấy `results/*.csv`.
2. Mở CSV bằng Excel/Google Sheets → vẽ:
   - Cột `throughputKBps` theo từng leecher.
   - Biểu đồ **thời gian hoàn tất vs số leecher** (chạy baseline/scaling với N khác nhau).
   - So sánh cột `ms` giữa rarest và random.
3. Chụp bảng tóm tắt terminal cho phần "kết quả".
4. Với churn: chụp log dòng `⚠️ KILL` / `♻️ RESTART` và các dòng `✓ ... hoàn tất`
   để minh hoạ khả năng chịu lỗi.

---

## 8. Mở rộng harness (gợi ý cho điểm nâng cao)
- **Quét tham số:** viết vòng lặp chạy `run-experiment` với `leechers = 2,4,8,16`
  rồi gộp CSV → 1 biểu đồ khả năng mở rộng.
- **Kịch bản "seed rời sớm":** thêm churn kill `seed0` sau khi các leecher có
  một phần chunk → làm nổi bật lợi thế rarest-first.
- **Đo tải tracker:** đếm số request announce/giây (thêm `emit` ở tracker).
- **Mạng lỗi:** ngẫu nhiên huỷ một số PIECE để kích hoạt nhánh verify-sai/timeout.
