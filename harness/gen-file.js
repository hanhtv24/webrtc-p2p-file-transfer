// @ts-check
/**
 * gen-file.js — Sinh file test kích thước tuỳ ý bằng dữ liệu ngẫu nhiên.
 * Dùng: node harness/gen-file.js <đường_dẫn> <sốMB>
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const out = process.argv[2] || "harness/tmp/testfile.bin";
const sizeMB = Number(process.argv[3]) || 4;

fs.mkdirSync(path.dirname(out), { recursive: true });

const fd = fs.openSync(out, "w");
const CANK = 1024 * 1024; // ghi từng 1MB để không ngốn RAM
for (let i = 0; i < sizeMB; i++) {
  fs.writeSync(fd, crypto.randomBytes(CANK));
}
fs.closeSync(fd);
console.log(`Đã sinh ${out} (${sizeMB}MB)`);
