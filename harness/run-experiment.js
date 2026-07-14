// @ts-check
/**
 * run-experiment.js — Khung thử nghiệm (harness) tự động cho hệ P2P.
 *
 * Nó dựng cả một "phòng thí nghiệm" trên 1 máy:
 *   1. Sinh file test → tạo metadata (chia chunk + hash).
 *   2. Spawn 1 tracker + K seeder + N leecher (mỗi peer là 1 tiến trình con).
 *   3. Đọc sự kiện "##EVT##" mà mỗi peer in ra để THU THẬP SỐ LIỆU.
 *   4. (Tuỳ chọn) Mô phỏng churn: kill/restart peer theo lịch.
 *   5. Chờ mọi leecher tải xong → KIỂM TRA hash file khớp bản gốc.
 *   6. Xuất kết quả ra results/*.json + *.csv và in bảng tóm tắt.
 *
 * Chạy:  node harness/run-experiment.js harness/scenarios/baseline.json
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bittorrent", "cli.js");
const TMP = path.join(__dirname, "tmp");
const RESULTS = path.join(__dirname, "results");

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {string} p */
const sha256File = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** Bọc 1 tiến trình con: parse stdout tìm dòng sự kiện ##EVT##. */
class Proc {
  /**
   * @param {string} label
   * @param {string[]} args
   * @param {(label: string, evt: any) => void} onEvent
   */
  constructor(label, args, onEvent) {
    this.label = label;
    this.args = args;
    this.onEvent = onEvent;
    this.child = null;
    this.buf = "";
  }
  start() {
    // Dùng process.execPath (đường dẫn tuyệt đối tới binary Node hiện tại)
    // thay vì chuỗi "node" tra cứu qua PATH, tránh rủi ro PATH bị thao túng.
    this.child = spawn(process.execPath, [CLI, ...this.args], { cwd: ROOT });
    this.child.stdout.on("data", (d) => this._parse(d));
    this.child.stderr.on("data", (d) => process.stderr.write(`[${this.label}] ${d}`));
    return this;
  }
  /** @param {Buffer} d */
  _parse(d) {
    this.buf += d.toString();
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const i = line.indexOf("##EVT## ");
      if (i >= 0) {
        try {
          this.onEvent(this.label, JSON.parse(line.slice(i + 8)));
        } catch (err) {
          console.error(`[${this.label}] dòng sự kiện không hợp lệ, bỏ qua:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }
  kill() {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }
}

/**
 * Lên lịch churn: kill/restart peer theo cfg.churn để mô phỏng peer join/leave.
 * @param {any} cfg
 * @param {Map<string, Proc>} procs
 * @param {(i: number) => Proc} spawnLeecher
 */
function scheduleChurn(cfg, procs, spawnLeecher) {
  for (const ev of cfg.churn) {
    setTimeout(() => {
      const label = `${ev.target}${ev.index}`;
      if (ev.action === "kill") {
        console.log(`  ⚠️  churn: KILL ${label} @ +${ev.atMs}ms`);
        procs.get(label)?.kill();
      } else if (ev.action === "restart" && ev.target === "leech") {
        console.log(`  ♻️  churn: RESTART ${label} @ +${ev.atMs}ms`);
        spawnLeecher(ev.index);
      }
    }, ev.atMs);
  }
}

/**
 * Tính danh sách leecher CÒN ĐƯỢC MONG ĐỢI hoàn tất (loại các leecher bị kill
 * vĩnh viễn — kill mà không có restart sau đó — vì chúng sẽ không bao giờ xong).
 * @param {any} cfg
 * @returns {string[]}
 */
function computeExpectedLeechers(cfg) {
  const killedForever = new Set(
    cfg.churn
      .filter(
        (/** @type {any} */ e) =>
          e.action === "kill" &&
          !cfg.churn.some(
            (/** @type {any} */ r) =>
              r.action === "restart" && r.target === e.target && r.index === e.index && r.atMs > e.atMs
          )
      )
      .map((/** @type {any} */ e) => `${e.target}${e.index}`)
  );
  const expected = [];
  for (let i = 0; i < cfg.leechers; i++) {
    if (!killedForever.has(`leech${i}`)) expected.push(`leech${i}`);
  }
  return expected;
}

/**
 * Chờ tất cả leecher trong `expected` xong (có trong `completions`) hoặc hết `timeoutMs`.
 * @param {string[]} expected
 * @param {Map<string, any>} completions
 * @param {number} timeoutMs
 */
async function waitForCompletions(expected, completions, timeoutMs) {
  const startWait = Date.now();
  while (Date.now() - startWait < timeoutMs) {
    if (expected.every((l) => completions.has(l))) break;
    await sleep(200);
  }
}

/**
 * Kiểm tra file đích có tồn tại và hash SHA-256 khớp với file gốc không.
 * @param {string} label
 * @param {string | undefined} outFile
 * @param {string} srcHash
 */
function checkHashMatches(label, outFile, srcHash) {
  try {
    return !!outFile && fs.existsSync(outFile) && sha256File(outFile) === srcHash;
  } catch (err) {
    console.error(`[${label}] lỗi khi kiểm tra hash file đích:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * So hash file đích với file gốc cho từng leecher, dựng bảng kết quả.
 * @param {string[]} expected
 * @param {Map<string, any>} completions
 * @param {Map<string, string>} outFiles
 * @param {string} srcHash
 */
function buildRows(expected, completions, outFiles, srcHash) {
  const rows = [];
  for (const label of expected) {
    const e = completions.get(label);
    const outFile = outFiles.get(label);
    rows.push({
      label,
      completed: !!e,
      ms: e ? e.ms : null,
      bytesDown: e ? e.bytesDown : null,
      bytesUp: e ? e.bytesUp : null,
      sources: e ? e.sources : null,
      throughputKBps: e ? e.throughputKBps : null,
      hashMatchesSource: checkHashMatches(label, outFile, srcHash),
    });
  }
  return rows;
}

async function main() {
  const scenarioPath = process.argv[2] || path.join(__dirname, "scenarios", "baseline.json");
  const cfg = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  cfg.name = cfg.name || path.basename(scenarioPath, ".json");
  cfg.fileSizeMB = cfg.fileSizeMB || 4;
  cfg.chunkSize = cfg.chunkSize || 65536;
  cfg.seeders = cfg.seeders || 1;
  cfg.leechers = cfg.leechers || 3;
  cfg.strategy = cfg.strategy || "rarest";
  cfg.trackerPort = cfg.trackerPort || 4000;
  cfg.timeoutMs = cfg.timeoutMs || 60000;
  cfg.uploadKBps = cfg.uploadKBps || 0; // 0 = không giới hạn tốc độ upload
  cfg.churn = cfg.churn || [];

  console.log(`\n=== KỊCH BẢN: ${cfg.name} ===`);
  console.log(
    `file=${cfg.fileSizeMB}MB chunk=${cfg.chunkSize}B seeders=${cfg.seeders} ` +
      `leechers=${cfg.leechers} strategy=${cfg.strategy}\n`
  );

  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(RESULTS, { recursive: true });

  // 1) Sinh file + metadata
  const srcFile = path.join(TMP, `src-${cfg.name}.bin`);
  runNode([path.join(__dirname, "gen-file.js"), srcFile, String(cfg.fileSizeMB)]);
  const srcHash = sha256File(srcFile);
  const metaPath = path.join(TMP, `${cfg.name}.meta.json`);
  runCli(["create", srcFile, "--chunk", String(cfg.chunkSize), "--out", metaPath]);

  const trackerUrl = `http://localhost:${cfg.trackerPort}`;
  /** @type {any[]} */
  const events = []; // toàn bộ sự kiện thu được (để phân tích/ghi log)
  const completions = new Map(); // label -> event 'complete'
  const procs = new Map();

  /**
   * @param {string} label
   * @param {any} e
   */
  const onEvent = (label, e) => {
    events.push({ label, ...e });
    if (e.evt === "complete" && !completions.has(label)) {
      completions.set(label, e);
      console.log(
        `  ✓ ${label} xong sau ${e.ms}ms | ${(e.bytesDown / 1024).toFixed(0)}KB ` +
          `| từ ${e.sources} nguồn | throughput ${e.throughputKBps}KB/s | hash ${e.fileOk ? "OK" : "SAI"}`
      );
    }
  };

  // 2) Tracker
  const tracker = new Proc("tracker", ["tracker", "--port", String(cfg.trackerPort)], onEvent).start();
  procs.set("tracker", tracker);
  await sleep(500); // chờ tracker sẵn sàng

  // 3) Seeders (mỗi seeder giữ đủ file gốc)
  for (let i = 0; i < cfg.seeders; i++) {
    const label = `seed${i}`;
    const p = new Proc(
      label,
      ["seed", srcFile, metaPath, "--tracker", trackerUrl, "--id", label,
        "--strategy", cfg.strategy, "--throttle", String(cfg.uploadKBps)],
      onEvent
    ).start();
    procs.set(label, p);
  }
  await sleep(500);

  // 4) Leechers (mỗi leecher ghi ra file đích riêng)
  const outFiles = new Map();
  /** @param {number} i */
  const spawnLeecher = (i) => {
    const label = `leech${i}`;
    const outFile = path.join(TMP, `out-${cfg.name}-${i}.bin`);
    outFiles.set(label, outFile);
    const p = new Proc(
      label,
      ["download", metaPath, "--tracker", trackerUrl, "--out", outFile, "--id", label,
        "--strategy", cfg.strategy, "--throttle", String(cfg.uploadKBps)],
      onEvent
    ).start();
    procs.set(label, p);
    return p;
  };
  for (let i = 0; i < cfg.leechers; i++) spawnLeecher(i);

  // 5) Lịch churn: kill/restart peer để mô phỏng peer join/leave.
  scheduleChurn(cfg, procs, spawnLeecher);

  // 6) Chờ tất cả leecher (không bị kill vĩnh viễn) tải xong hoặc hết giờ.
  const expected = computeExpectedLeechers(cfg);
  await waitForCompletions(expected, completions, cfg.timeoutMs);

  // 7) Kiểm tra toàn vẹn: file đích trùng hash bản gốc?
  await sleep(300);
  const rows = buildRows(expected, completions, outFiles, srcHash);

  // 8) Tổng hợp + xuất kết quả
  const done = rows.filter((r) => r.completed);
  const summary = {
    scenario: cfg.name,
    config: cfg,
    srcHash,
    peersExpected: expected.length,
    peersCompleted: done.length,
    allHashOk: rows.every((r) => r.hashMatchesSource),
    wallClockMs: done.length ? Math.max(...done.map((r) => r.ms)) : null,
    avgThroughputKBps: done.length
      ? Math.round(done.reduce((a, r) => a + r.throughputKBps, 0) / done.length)
      : 0,
    maxSources: done.length ? Math.max(...done.map((r) => r.sources)) : 0,
    rows,
  };

  printSummary(summary);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(RESULTS, `${cfg.name}-${stamp}`);
  fs.writeFileSync(base + ".json", JSON.stringify({ summary, events }, null, 2));
  fs.writeFileSync(base + ".csv", toCsv(rows));
  console.log(`\n📁 Kết quả: ${base}.json / .csv`);

  // 9) Dọn dẹp
  for (const p of procs.values()) p.kill();
  await sleep(300);
  process.exit(summary.allHashOk && done.length === expected.length ? 0 : 1);
}

/** @param {any} s */
function printSummary(s) {
  console.log(`\n--- TÓM TẮT: ${s.scenario} ---`);
  console.log(`  Hoàn tất : ${s.peersCompleted}/${s.peersExpected} leecher`);
  console.log(`  Hash khớp: ${s.allHashOk ? "TẤT CẢ OK ✓" : "CÓ LỖI ✗"}`);
  console.log(`  Thời gian: ${s.wallClockMs ?? "-"}ms (peer chậm nhất)`);
  console.log(`  Throughput TB: ${s.avgThroughputKBps} KB/s`);
  console.log(`  Số nguồn tối đa 1 leecher dùng: ${s.maxSources} (chứng minh tải đa nguồn)`);
}

/** @param {any[]} rows */
function toCsv(rows) {
  const cols = ["label", "completed", "ms", "bytesDown", "bytesUp", "sources", "throughputKBps", "hashMatchesSource"];
  return [cols.join(","), ...rows.map((/** @type {any} */ r) => cols.map((c) => r[c]).join(","))].join("\n");
}

/** @param {string[]} args */
function runCli(args) {
  runNode([CLI, ...args]);
}
/** @param {string[]} args */
function runNode(args) {
  // Dùng process.execPath (đường dẫn tuyệt đối) thay vì chuỗi "node" tra cứu
  // qua PATH, tránh rủi ro PATH bị thao túng.
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
