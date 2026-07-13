// @ts-check
/**
 * cli.js — Điểm vào dòng lệnh cho hệ thống P2P.
 *
 * Các lệnh:
 *   node cli.js create <file> [--chunk 262144] [--out meta.json]
 *       → chia file thành chunk, tính hash, sinh file metadata (.meta.json)
 *
 *   node cli.js tracker [--port 4000]
 *       → chạy tracker server
 *
 *   node cli.js seed <file> <meta.json> [--tracker http://localhost:4000] [--port 0]
 *       → chạy peer SEEDER (đã có đủ file, chỉ phục vụ upload)
 *
 *   node cli.js download <meta.json> [--tracker ...] [--out file] [--port 0]
 *                        [--strategy rarest|random] [--exit-on-complete]
 *       → chạy peer LEECHER (tải file từ swarm)
 */

const path = require("path");
const {
  createMetadata,
  saveMetadata,
  loadMetadata,
  ChunkStore,
  DEFAULT_CHUNK_SIZE,
} = require("./src/torrent");
const { startTracker } = require("./tracker/tracker");
const { Peer } = require("./peer/peer");

/** Phân tích các cờ dạng --key value / --flag từ argv. */
function parseFlags(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true; // cờ boolean
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);

  switch (cmd) {
    case "create": {
      const file = pos[0];
      if (!file) return usage("thiếu <file>");
      const chunkSize = Number(flags.chunk) || DEFAULT_CHUNK_SIZE;
      const meta = createMetadata(file, chunkSize);
      const out = saveMetadata(meta, flags.out);
      console.log(`✅ Đã tạo metadata: ${out}`);
      console.log(
        `   name=${meta.name} size=${meta.size}B chunkSize=${meta.chunkSize}B ` +
          `chunks=${meta.chunkCount}`
      );
      console.log(`   infohash=${meta.infohash}`);
      break;
    }

    case "tracker": {
      await startTracker(Number(flags.port) || 4000);
      break; // giữ tiến trình chạy
    }

    case "seed": {
      const file = pos[0];
      const metaPath = pos[1];
      if (!file || !metaPath) return usage("cần <file> <meta.json>");
      const meta = loadMetadata(metaPath);
      const store = ChunkStore.openSeed(meta, file);
      const peer = new Peer({
        meta,
        store,
        trackerUrl: flags.tracker || "http://localhost:4000",
        port: Number(flags.port) || 0,
        peerId: flags.id,
        strategy: flags.strategy || "rarest",
        throttleKBps: Number(flags.throttle) || 0,
      });
      launch(peer);
      break;
    }

    case "download": {
      const metaPath = pos[0];
      if (!metaPath) return usage("cần <meta.json>");
      const meta = loadMetadata(metaPath);
      const outFile = flags.out || path.join(process.cwd(), meta.name);
      const store = ChunkStore.openLeech(meta, outFile);
      const peer = new Peer({
        meta,
        store,
        trackerUrl: flags.tracker || "http://localhost:4000",
        port: Number(flags.port) || 0,
        peerId: flags.id,
        strategy: flags.strategy || "rarest",
        throttleKBps: Number(flags.throttle) || 0,
        exitOnComplete: !!flags["exit-on-complete"],
        seedAfter: !flags["exit-on-complete"],
      });
      launch(peer);
      break;
    }

    default:
      return usage();
  }
}

/** Khởi động peer + dọn dẹp gọn gàng khi bị kill (harness mô phỏng churn). */
function launch(peer) {
  peer.start();
  const shutdown = () => {
    peer.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function usage(err) {
  if (err) console.error("Lỗi:", err);
  console.log(`
Hệ thống chia sẻ file P2P (mô phỏng BitTorrent)

  node cli.js create   <file> [--chunk <byte>] [--out <meta.json>]
  node cli.js tracker  [--port 4000]
  node cli.js seed     <file> <meta.json> [--tracker <url>] [--port 0] [--id <name>]
                       [--throttle <KB/s>]
  node cli.js download <meta.json> [--tracker <url>] [--out <file>] [--port 0]
                       [--strategy rarest|random] [--throttle <KB/s>]
                       [--exit-on-complete] [--id <name>]
`);
  process.exit(err ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
