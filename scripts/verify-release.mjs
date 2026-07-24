import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const executable = resolve(
  "src-tauri",
  "target",
  "release",
  "atlas-desktop-toolkit.exe",
);
const bytes = readFileSync(executable);
const text = bytes.toString("latin1");
const indexHtml = readFileSync(resolve("dist", "index.html"), "utf8");
const assets = [...indexHtml.matchAll(/(?:src|href)="\/([^"]+)"/g)].map(
  (match) => match[1],
);
if (assets.length === 0 || assets.some((asset) => !text.includes(asset))) {
  throw new Error("发布程序没有嵌入当前 dist 前端资源，请使用 npm run release 构建");
}

if (bytes.toString("ascii", 0, 2) !== "MZ") {
  throw new Error("发布目标不是有效的 Windows PE 程序");
}
const peOffset = bytes.readUInt32LE(0x3c);
const optionalHeaderOffset = peOffset + 24;
const subsystem = bytes.readUInt16LE(optionalHeaderOffset + 68);
if (subsystem !== 2) {
  throw new Error(`发布程序不是 Windows GUI 子系统（实际值 ${subsystem}）`);
}

console.log("release-smoke: current frontend embedded; Windows GUI subsystem confirmed");
