#!/usr/bin/env node
// 把 src/ui/web 下的前端资源打包成 src/ui/web/assets.generated.ts
// 用法：node scripts/embed-web.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "src", "ui", "web");
const OUT = path.join(WEB, "assets.generated.ts");

const FILES = [
  { src: "index.html", key: "/", type: "text/html; charset=utf-8", binary: false },
  { src: "index.html", key: "/index.html", type: "text/html; charset=utf-8", binary: false },
  { src: "app.js", key: "/app.js", type: "text/javascript; charset=utf-8", binary: false },
  { src: "style.css", key: "/style.css", type: "text/css; charset=utf-8", binary: false },
  { src: "icon.svg", key: "/icon.svg", type: "image/svg+xml", binary: false },
  { src: "icon.png", key: "/icon.png", type: "image/png", binary: true },
];

function escapeBody(s) {
  // JSON.stringify 已经处理了 \n \" 等转义，再去掉首尾引号即可嵌入 TS 字符串字面量
  return JSON.stringify(s).slice(1, -1);
}

const entries = [];
for (const f of FILES) {
  if (f.binary) {
    // Binary files: read as Buffer, encode as base64, store with encoding marker
    const buf = fs.readFileSync(path.join(WEB, f.src));
    const b64 = buf.toString("base64");
    entries.push(`  "${f.key}": { type: "${f.type}", body: "${b64}", encoding: "base64" as const }`);
  } else {
    const raw = fs.readFileSync(path.join(WEB, f.src), "utf-8");
    const body = escapeBody(raw);
    entries.push(`  "${f.key}": { type: "${f.type}", body: "${body}" }`);
  }
}

const out = `// 自动生成：scripts/embed-web.mjs（不要手改，也不入库）\nexport const ASSETS: Record<string, { type: string; body: string; encoding?: "base64" }> = {\n${entries.join(",\n")},\n};\n`;

fs.writeFileSync(OUT, out, "utf-8");
const kb = (Buffer.byteLength(out, "utf-8") / 1024).toFixed(1);
console.log(`已生成 ${path.relative(ROOT, OUT)}（${FILES.length} 个资源，${kb} KB）`);
