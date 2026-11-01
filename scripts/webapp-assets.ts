import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let result = 0xffffffff;
  for (const byte of bytes) { result ^= byte; for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1; }
  return (result ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, body: Uint8Array): Buffer {
  const name = Buffer.from(type), size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(body.length); check.writeUInt32BE(crc32(Buffer.concat([name, body])));
  return Buffer.concat([size, name, body, check]);
}
/** Deterministic local raster version of the small code-authored GridLens grid icon. */
function icon(size: number): Buffer {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x * 512 / size, py = y * 512 / size;
    let color = [16, 21, 28];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      const dx = px - (112 + col * 104), dy = py - (112 + row * 104);
      if (dx >= 0 && dx < 80 && dy >= 0 && dy < 80 && Math.hypot(Math.max(14 - dx, dx - 66, 0), Math.max(14 - dy, dy - 66, 0)) <= 14) color = col === 2 && row === 1 ? [21, 128, 61] : [16, 232, 12];
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4; pixels[offset] = color[0]!; pixels[offset + 1] = color[1]!; pixels[offset + 2] = color[2]!; pixels[offset + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** Public same-origin installation assets; no server address, identity or runtime data. */
export function writeWebappAssets(outputDirectory: string): void {
  const icons = join(outputDirectory, "icons");
  mkdirSync(icons, { recursive: true });
  for (const size of [192, 512]) writeFileSync(join(icons, `gridlens-${size}.png`), icon(size));
  writeFileSync(join(icons, "gridlens-maskable-512.png"), icon(512));
  writeFileSync(join(outputDirectory, "manifest.webmanifest"), JSON.stringify({
    id: "./", name: "GridLens", short_name: "GridLens", start_url: "./", scope: "./", display: "standalone",
    background_color: "#10151c", theme_color: "#10151c",
    description: "Your GridLens dashboard on your local network or VPN.",
    icons: [
      { src: "./icons/gridlens-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "./icons/gridlens-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "./icons/gridlens-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, null, 2) + "\n");
}
