import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { request } from "node:https";
import { writeWebappAssets } from "../scripts/webapp-assets.ts";
import { BROWSER_ASSETS } from "../src/server/browser-assets.ts";
import { closeFleetServer, startFleetServer } from "../src/server/application.ts";

test("local installation assets resolve within their serving origin and mount, with no external runtime inputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-local-webapp-"));
  try {
    writeWebappAssets(directory);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.webmanifest"), "utf8"));
    assert.equal(manifest.name, "GridLens"); assert.equal(manifest.display, "standalone");
    assert.equal(manifest.prefer_related_applications, undefined);
    for (const base of ["https://192.168.50.2:8790/", "https://192.168.50.2:8790/gridlens/"]) {
      const url = new URL("manifest.webmanifest", base);
      for (const field of ["id", "scope", "start_url"]) assert.equal(new URL(manifest[field], url).href, base);
      for (const entry of manifest.icons) {
        const asset = new URL(entry.src, url); assert.equal(asset.origin, url.origin);
        assert(asset.pathname.startsWith(new URL(base).pathname));
        const bytes = readFileSync(join(directory, entry.src));
        assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const size = Number(entry.sizes.split("x")[0]);
        assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
      }
    }
    assert.deepEqual(manifest.icons.map((entry: { sizes: string }) => entry.sizes), ["192x192", "512x512", "512x512"]);
    const first = createHash("sha256").update(readFileSync(join(directory, "manifest.webmanifest"))).digest("hex");
    writeWebappAssets(directory);
    assert.equal(createHash("sha256").update(readFileSync(join(directory, "manifest.webmanifest"))).digest("hex"), first);
    assert.deepEqual(readdirSync(directory).sort(), ["icons", "manifest.webmanifest"]);
    assert.doesNotMatch(JSON.stringify(manifest), /https?:|cloudflare|workers\.dev|backend|token|service-worker/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the actual local HTTPS server serves manifest and icons without weakening protected APIs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-webapp-https-"));
  let calls = 0;
  try {
    for (const [name] of Object.values(BROWSER_ASSETS)) {
      mkdirSync(join(directory, name, ".."), { recursive: true });
      writeFileSync(join(directory, name), name === "index.html"
        ? '<!doctype html><head><link rel="manifest" href="./manifest.webmanifest"><script type="module" src="/preview/webapp.js"></script></head><body>Local Fleet</body>'
        : "/* isolated public asset */");
    }
    writeWebappAssets(directory);
    const certPath = join(directory, "fixture-cert.pem"), keyPath = join(directory, "fixture-key.pem");
    const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
      "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "pipe" });
    assert.equal(generated.status, 0, "isolated TLS fixture certificate generation succeeds");
    const cert = readFileSync(certPath);
    const integration = { async resolveAccess() { calls++; return null; }, source: { async read(): Promise<never> { throw new Error("Unauthorized source read"); } } };
    const server = await startFleetServer({ directory, integration, host: "127.0.0.1", port: 0,
      publicOrigin: "https://localhost", basePath: "/gridlens", tls: { cert, key: readFileSync(keyPath) } });
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      const read = (path: string) => new Promise<{ status: number; type: string | undefined; body: Buffer }>((resolve, reject) => {
        const call = request({ hostname: "127.0.0.1", port: address.port, path, method: "GET", ca: cert,
          servername: "localhost", headers: { Host: "localhost" } }, response => {
          const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({ status: response.statusCode!, type: response.headers["content-type"], body: Buffer.concat(chunks) }));
          response.on("error", reject);
        }); call.on("error", reject); call.end();
      });
      const manifest = await read("/gridlens/manifest.webmanifest");
      assert.equal(manifest.status, 200); assert.match(manifest.type!, /^application\/manifest\+json/);
      assert.equal(JSON.parse(manifest.body.toString()).start_url, "./");
      const icon = await read("/gridlens/icons/gridlens-192.png"); assert.equal(icon.status, 200); assert.equal(icon.type, "image/png");
      const html = await read("/gridlens/"); assert.match(html.body.toString(), /src="\/gridlens\/preview\/webapp\.js"/);
      assert.equal(calls, 0, "installation assets do not read providers or establish an authorized session");
      assert.equal((await read("/gridlens/api/fleet/hosts.json")).status, 401);
      assert.equal(calls, 1);
    } finally { await closeFleetServer(server, integration); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
