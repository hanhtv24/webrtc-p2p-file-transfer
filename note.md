# Ứng dụng chia sẻ file qua WebRTC

## 1. Mô tả dự án
Ứng dụng web cho phép người dùng chia sẻ file trực tiếp peer-to-peer (P2P) qua giao thức WebRTC. Tự triển khai từ đầu để hiểu rõ cơ chế Signaling, STUN/ICE và Data Channel.

## 2. Technology Stack
- **Frontend:** HTML + CSS + JavaScript (thuần), Tailwind CSS, Animation (thể hiện hiệu ứng chuyển động, gửi file, nhận file,...) -> tương thích PC, Mobile. Toàn bộ nội dung dùng Tiếng Việt.
- **Server:** Node.js + Express  -> Signaling Server, Static file server
- **WebRTC:** Native API (không dùng PeerJS, simple-peer)
- **STUN:** Google STUN servers (miễn phí)

## 3. Kiến trúc hệ thống

```
┌─────────────┐                              ┌─────────────┐
│  Browser A  │                              │  Browser B  │
│  (HTML/JS)  │                              │  (HTML/JS)  │
└──────┬──────┘                              └──────┬──────┘
       │                                            │
       │  WebSocket                      WebSocket  │
       │  (SDP + ICE)                   (SDP + ICE) │
       ▼                                            ▼
┌──────────────────────────────────────────────────────────┐
│                 SIGNALING SERVER                         │
│                 (Node.js )                    │
│  - Quản lý rooms/peers                                   │
│  - Relay SDP Offer/Answer                                │
│  - Relay ICE Candidates                                  │
└──────────────────────────────────────────────────────────┘

       ┌─────────────────────────────────────┐
       │          STUN SERVER                │
       │   (stun:stun.l.google.com:19302)   │
       │   → Giúp peers tìm public IP       │
       └─────────────────────────────────────┘

Sau handshake thành công:
┌─────────────┐                              ┌─────────────┐
│  Browser A  │ ◄═══ P2P Data Channel ═════► │  Browser B  │
└─────────────┘      (trực tiếp, không       └─────────────┘
                      qua server)
```

## 4. Các khái niệm

### 4.1 Vấn đề NAT (Network Address Translation)
Hầu hết thiết bị đều nằm sau NAT (router), sử dụng IP private (192.168.x.x). Hai thiết bị ở khác mạng không thể kết nối trực tiếp vì không biết IP public của nhau.

```
┌─────────────┐                              ┌─────────────┐
│  Device A   │           ❌                 │  Device B   │
│ 192.168.1.5 │  ← Không thể kết nối →       │ 192.168.0.10│
└─────────────┘                              └─────────────┘
      │                                            │
   [Router A]                                 [Router B]
   IP: 1.2.3.4                               IP: 5.6.7.8
```

### 4.2 STUN (Session Traversal Utilities for NAT)
**Mục đích:** Giúp thiết bị tìm ra IP public và port của mình.

**Cách hoạt động:**
```
Device A ──── "IP của tôi là gì?" ────► STUN Server
         ◄─── "Bạn là 1.2.3.4:54321" ───
```

1. Device gửi request đến STUN server (có IP public)
2. STUN server nhìn thấy IP:port public của device và trả về
3. Device dùng thông tin này để trao đổi với peer qua signaling
4. Hai peers thực hiện "hole punching" để kết nối P2P trực tiếp

**Hole Punching:**
```
Thời điểm T1 (gần như đồng thời):
   A gửi packet đến B → Router A mở "lỗ" cho B
   B gửi packet đến A → Router B mở "lỗ" cho A

Thời điểm T2:
   Packet của A đến Router B → được chấp nhận ✅
   Packet của B đến Router A → được chấp nhận ✅
```

**Đặc điểm:**
- Miễn phí (Google cung cấp public STUN servers)
- Nhẹ, chỉ trả về IP:port, không relay data
- Thành công ~80-85% trường hợp

**STUN servers miễn phí:**
```javascript
const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};
```

### 4.3 TURN (Traversal Using Relays around NAT)
**Mục đích:** Relay dữ liệu khi STUN thất bại (NAT symmetric, firewall chặt).

**Cách hoạt động:**
```
Device A ◄────► TURN Server ◄────► Device B
         (relay toàn bộ data qua server)
```

**Khi nào cần TURN:**
- NAT Symmetric (thay đổi port cho mỗi destination)
- Firewall chặt, chặn UDP
- Corporate networks

**Đặc điểm:**
- Tốn bandwidth server (relay toàn bộ data)
- Có chi phí nếu traffic lớn
- Fallback cuối cùng, đảm bảo kết nối 100%

**Lưu ý:** Trong scope dự án này, không triển khai TURN. Chấp nhận ~15-20% trường hợp không kết nối được.

### 4.4 ICE (Interactive Connectivity Establishment)
**Mục đích:** Tự động tìm đường kết nối tốt nhất giữa 2 peers.

**Thứ tự ưu tiên:**
1. **Host candidate** - Kết nối trực tiếp (cùng mạng LAN)
2. **Server reflexive (srflx)** - Qua STUN (khác mạng, NAT thông thường)
3. **Relay** - Qua TURN (fallback khi 1, 2 thất bại)

```
ICE tự động thử theo thứ tự:
   Host (LAN) → STUN (P2P qua NAT) → TURN (relay)
        ↓              ↓                  ↓
     Nhanh nhất    Vẫn P2P           Chậm nhất
                                   (qua server)
```

**ICE Candidate types:**
- `host` - IP private (192.168.x.x)
- `srflx` - IP public từ STUN ✅
- `relay` - IP từ TURN server

### 4.5 Signaling Server
**Mục đích:** Trung gian để 2 peers trao đổi thông tin trước khi kết nối P2P. Là "người mai mối" giúp 2 peers tìm nhau.

**3 nhiệm vụ chính:**

**1. Quản lý peers online**
- Khi client kết nối → cấp Peer ID unique
- Lưu danh sách peers đang online
- Thông báo khi có peer mới join/leave

**2. Relay SDP (Session Description Protocol)**
```
Client A                Signaling               Client B
    │                      │                        │
    │── SDP Offer ────────►│── Forward ───────────►│
    │                      │                        │
    │◄─────── Forward ─────│◄──── SDP Answer ──────│
```
- **SDP Offer:** "Tôi hỗ trợ codec X, Y, Z, muốn tạo data channel"
- **SDP Answer:** "OK, tôi cũng hỗ trợ codec Y, đồng ý kết nối"

**3. Relay ICE Candidates**
```
Client A                Signaling               Client B
    │                      │                        │
    │── ICE Candidate ────►│── Forward ───────────►│
    │   (1.2.3.4:5000)     │                        │
    │                      │                        │
    │◄─────── Forward ─────│◄── ICE Candidate ─────│
    │                      │   (5.6.7.8:6000)       │
```

**Signaling Server KHÔNG làm gì:**
- ❌ Không truyền file
- ❌ Không relay data sau khi kết nối P2P thành công
- ❌ Không lưu trữ nội dung

### 4.6 WebRTC Data Channel
**Mục đích:** Kênh truyền dữ liệu P2P trực tiếp giữa 2 browsers.

**Đặc điểm:**
- Truyền trực tiếp, không qua server
- Mã hóa DTLS mặc định
- Hỗ trợ cả reliable (TCP-like) và unreliable (UDP-like)
- Giới hạn message size ~64KB → cần chunk file

### 4.7 WebRTC Handshake Flow

```
┌──────────┐         ┌───────────┐         ┌──────────┐
│ Client A │         │ Signaling │         │ Client B │
└────┬─────┘         └─────┬─────┘         └────┬─────┘
     │                     │                    │
     │── 1. Connect ──────►│                    │
     │◄─ 2. Your ID: "A1" ─│                    │
     │                     │                    │
     │                     │◄─── 3. Connect ────│
     │                     │─ 4. Your ID: "B2" ►│
     │                     │                    │
     │── 5. Connect to B2 ►│                    │
     │                     │                    │
     │  6. createOffer()                        │
     │  7. setLocalDescription()                │
     │── 8. SDP Offer ────►│── 9. Forward ─────►│
     │                     │                    │ 10. setRemoteDescription()
     │                     │                    │ 11. createAnswer()
     │                     │                    │ 12. setLocalDescription()
     │◄──── 14. Forward ───│◄── 13. SDP Answer ─│
     │ 15. setRemoteDescription()               │
     │                     │                    │
     │── 16. ICE ─────────►│── 17. Forward ────►│
     │◄──── 19. Forward ───│◄── 18. ICE ────────│
     │                     │                    │
     │◄═══════════ 20. P2P Connected ══════════►│
     │         (Data Channel ready)             │
```

### 4.8 Tóm tắt

```
┌─────────────────┬────────────────────────────┬─────────────────────┐
│ Thành phần      │ Chức năng                  │ Triển khai          │
├─────────────────┼────────────────────────────┼─────────────────────┤
│ Signaling       │ Giúp 2 peers tìm nhau      │ Tự code (Socket.io) │
│ STUN            │ Tìm IP public              │ Google (miễn phí)   │
│ TURN            │ Relay khi STUN fail        │ Không cần           │
│ ICE             │ Chọn đường tốt nhất        │ WebRTC tự xử lý     │
│ Data Channel    │ Kênh truyền file P2P       │ Tự code             │
└─────────────────┴────────────────────────────┴─────────────────────┘
```

## 5. Test STUN Server

**Dùng trình duyệt (DevTools Console):**
```javascript
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

pc.createDataChannel('test');
pc.createOffer().then(offer => pc.setLocalDescription(offer));

pc.onicecandidate = (e) => {
  if (e.candidate) {
    console.log('ICE Candidate:', e.candidate.candidate);
    
    // Tìm dòng có "srflx" = public IP từ STUN
    if (e.candidate.candidate.includes('srflx')) {
      const match = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (match) {
        console.log('🎉 Public IP từ STUN:', match[1]);
      }
    }
  }
};
```

**Online tool:** https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

## 6. Tài liệu tham khảo
- [MDN WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [WebRTC.org](https://webrtc.org/)
- [Socket.io Documentation](https://socket.io/docs/)
- [RFC 5389 - STUN Protocol](https://tools.ietf.org/html/rfc5389)

