// @ts-check
/**
 * piece-picker.js — Chọn chunk nào để tải tiếp theo (đề bài mục nâng cao).
 *
 * Hai chiến lược:
 *   - "rarest-first" (hiếm nhất trước): ưu tiên tải chunk mà ÍT peer trong
 *     swarm đang có nhất. Vì sao? Chunk hiếm có nguy cơ biến mất khi peer duy
 *     nhất giữ nó rời mạng. Tải nó trước giúp nhân bản nhanh → swarm khoẻ,
 *     mọi người cùng nhanh. Đây là bí quyết cốt lõi của BitTorrent.
 *   - "random": chọn ngẫu nhiên — dùng làm mốc so sánh trong thực nghiệm để
 *     chứng minh rarest-first tốt hơn.
 *
 * Lớp này chỉ quyết định THỨ TỰ chunk; việc gửi request cho peer nào do
 * peer.js điều phối.
 */

class PiecePicker {
  /**
   * @param {number} chunkCount tổng số chunk
   * @param {"rarest"|"random"} [strategy]
   */
  constructor(chunkCount, strategy = "rarest") {
    this.chunkCount = chunkCount;
    this.strategy = strategy;
    // availability[i] = số peer (đã biết) đang có chunk i → dùng cho rarest-first
    this.availability = new Array(chunkCount).fill(0);
  }

  /** Cộng dồn cả bitfield của 1 peer vào bảng độ phổ biến (khi nhận BITFIELD). */
  addBitfield(bitfield) {
    for (let i = 0; i < this.chunkCount; i++) {
      if (bitfield[i]) this.availability[i]++;
    }
  }

  /** Trừ đi bitfield của 1 peer khi peer đó rời mạng (giữ số liệu chính xác). */
  removeBitfield(bitfield) {
    for (let i = 0; i < this.chunkCount; i++) {
      if (bitfield[i] && this.availability[i] > 0) this.availability[i]--;
    }
  }

  /** Peer báo có thêm 1 chunk (khi nhận HAVE). */
  incHave(index) {
    this.availability[index]++;
  }

  /**
   * Chọn 1 chunk để tải: phải là chunk ta CHƯA có (have[i]=0), CHƯA đang tải
   * (inFlight không chứa i), và có ÍT NHẤT 1 peer đang giữ (availability>0).
   *
   * @param {Uint8Array} have bitfield của chính mình
   * @param {Set<number>} inFlight các chunk đang được request dở
   * @param {(index:number)=>boolean} [peerHas] lọc thêm: peer ứng viên có chunk này không
   * @returns {number} index chunk, hoặc -1 nếu không còn gì để chọn
   */
  pick(have, inFlight, peerHas) {
    const candidates = [];
    for (let i = 0; i < this.chunkCount; i++) {
      if (have[i]) continue;
      if (inFlight.has(i)) continue;
      if (this.availability[i] <= 0) continue;
      if (peerHas && !peerHas(i)) continue;
      candidates.push(i);
    }
    if (candidates.length === 0) return -1;

    if (this.strategy === "random") {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // rarest-first: tìm độ phổ biến nhỏ nhất, rồi chọn NGẪU NHIÊN trong nhóm
    // hiếm nhất (tránh mọi peer cùng lao vào đúng 1 chunk).
    let min = Infinity;
    for (const i of candidates) min = Math.min(min, this.availability[i]);
    const rarest = candidates.filter((i) => this.availability[i] === min);
    return rarest[Math.floor(Math.random() * rarest.length)];
  }
}

module.exports = { PiecePicker };
