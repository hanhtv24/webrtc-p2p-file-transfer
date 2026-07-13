// @ts-check
/**
 * protocol.js — Giao thức truyền tin giữa các peer (wire protocol)
 *
 * Vì sao cần: TCP là một luồng byte liên tục (stream), KHÔNG có khái niệm
 * "gói tin". Nếu ta cứ socket.write() nhiều lần thì bên nhận có thể nhận dính
 * (2 message gộp làm 1) hoặc bị chẻ (1 message tách làm nhiều lần onData).
 * Giải pháp kinh điển: "length-prefix framing" — mỗi message được bọc bởi
 * 4 byte độ dài ở đầu, nhờ đó bên nhận biết chính xác ranh giới từng message.
 *
 * Khung 1 message trên dây:
 *   ┌──────────────┬────────┬───────────────────────────┐
 *   │ length (4B)  │ type(1)│ payload (length-1 byte)    │
 *   └──────────────┴────────┴───────────────────────────┘
 *   length = số byte của (type + payload), big-endian (BE).
 */

// Các loại message. Giống tinh thần của BitTorrent peer wire protocol.
const MSG = {
  HANDSHAKE: 0, // Bắt tay: gửi { infohash, peerId } để xác nhận cùng 1 file
  BITFIELD: 1, // Gửi bản đồ chunk mình đang có (mỗi bit = 1 chunk)
  HAVE: 2, // Báo "tôi vừa có thêm chunk index N"
  REQUEST: 3, // Yêu cầu "cho tôi xin chunk index N"
  PIECE: 4, // Trả dữ liệu 1 chunk: [index(4B)][data]
  INTERESTED: 5, // (tuỳ chọn) báo quan tâm — giữ để mở rộng
};

const MSG_NAME = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));

/**
 * Đóng gói 1 message thành Buffer đã có 4 byte length ở đầu.
 * @param {number} type một trong MSG.*
 * @param {Buffer} [payload] dữ liệu kèm theo
 * @returns {Buffer}
 */
function encode(type, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([type]), payload]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

// ---- Các helper tạo từng loại message cho gọn ----

function handshake(infohash, peerId) {
  return encode(MSG.HANDSHAKE, Buffer.from(JSON.stringify({ infohash, peerId })));
}

/** @param {Uint8Array} bitfield mảng byte, mỗi bit = 1 chunk (1 = có) */
function bitfield(bitfield) {
  return encode(MSG.BITFIELD, Buffer.from(bitfield));
}

function have(index) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(index, 0);
  return encode(MSG.HAVE, b);
}

function request(index) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(index, 0);
  return encode(MSG.REQUEST, b);
}

/** @param {number} index @param {Buffer} data dữ liệu chunk */
function piece(index, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(index, 0);
  return encode(MSG.PIECE, Buffer.concat([head, data]));
}

/**
 * Giải mã phần "body" (type + payload) đã tách khung thành object dễ dùng.
 * @param {Buffer} body
 */
function decode(body) {
  const type = body[0];
  const payload = body.subarray(1);
  switch (type) {
    case MSG.HANDSHAKE:
      return { type, ...JSON.parse(payload.toString()) };
    case MSG.BITFIELD:
      return { type, bitfield: new Uint8Array(payload) };
    case MSG.HAVE:
      return { type, index: payload.readUInt32BE(0) };
    case MSG.REQUEST:
      return { type, index: payload.readUInt32BE(0) };
    case MSG.PIECE:
      return { type, index: payload.readUInt32BE(0), data: payload.subarray(4) };
    case MSG.INTERESTED:
      return { type };
    default:
      return { type, payload };
  }
}

/**
 * FrameParser — bộ gom byte từ TCP và cắt ra từng message hoàn chỉnh.
 *
 * Cách dùng:
 *   const parser = new FrameParser(msg => { ... });
 *   socket.on('data', chunk => parser.push(chunk));
 *
 * Nó tự xử lý trường hợp message bị dính/chẻ.
 */
class FrameParser {
  /** @param {(msg: any) => void} onMessage callback cho mỗi message decode được */
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  /** @param {Buffer} chunk dữ liệu vừa nhận từ socket */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Lặp: chừng nào còn đủ 4 byte header và đủ cả body thì cắt ra
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break; // chưa nhận đủ, chờ thêm
      const body = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len); // cắt phần đã dùng
      try {
        this.onMessage(decode(body));
      } catch (e) {
        // message hỏng — bỏ qua, không làm sập peer
        console.error("[protocol] decode error:", e.message);
      }
    }
  }
}

module.exports = {
  MSG,
  MSG_NAME,
  encode,
  decode,
  handshake,
  bitfield,
  have,
  request,
  piece,
  FrameParser,
};
