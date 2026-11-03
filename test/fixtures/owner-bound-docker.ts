/** Serialized fixture programs use only the candidate image's application files.
 * Every private source key below is generated inside the disposable source volume. */
export async function ownerBoundSourceFixture(input: { instance: string }): Promise<void> {
  const fs = await import("node:fs"), crypto = await import("node:crypto"), http = await import("node:http");
  const { getBase58Decoder } = await import("@solana/kit");
  if (!/^fixture-[a-f0-9]{12}$/.test(input.instance)) throw Error("Invalid isolated source fixture.");
  const root = "/home/node/.nosana", publicPath = `${root}/fixture-public.json`;
  process.umask(0o077);
  if (!fs.existsSync(publicPath)) {
    if (fs.readdirSync(root).length) throw Error("Source fixture volume is not empty.");
    const source = crypto.generateKeyPairSync("ed25519"), receiver = crypto.generateKeyPairSync("ed25519"), other = crypto.generateKeyPairSync("ed25519");
    const rawPublic = (key: typeof source) => key.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const bytes = Buffer.concat([source.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32), rawPublic(source)]);
    fs.writeFileSync(`${root}/nosana_key.json`, JSON.stringify([...bytes]), { mode: 0o600, flag: "wx" }); bytes.fill(0);
    fs.writeFileSync(publicPath, JSON.stringify({ version: 1, instance: input.instance, build: JSON.parse(fs.readFileSync("/app/build.json", "utf8")), sourceAddress: getBase58Decoder().decode(rawPublic(source)),
      destinationAddress: getBase58Decoder().decode(rawPublic(receiver)), wrongDestination: getBase58Decoder().decode(rawPublic(other)) }), { mode: 0o600, flag: "wx" });
    fs.writeFileSync(`${root}/fixture-claims.json`, JSON.stringify({ posts: 0, authorizationVerified: false }), { mode: 0o600, flag: "wx" });
  }
  const info = JSON.parse(fs.readFileSync(publicPath, "utf8")); if (info.instance !== input.instance) throw Error("Source fixture identity changed.");
  const server = http.createServer((request, response) => { if (request.method !== "GET" || request.url !== "/") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(info.sourceAddress)); });
  await new Promise<void>(done => server.listen(5001, "127.0.0.1", done));
  fs.writeFileSync(`${root}/fixture-ready`, input.instance, { mode: 0o600 });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  console.log(JSON.stringify({ ready: true, instance: input.instance }));
}
export async function ownerBoundClaimFixture(owner: string): Promise<void> {
  const fs = await import("node:fs"), crypto = await import("node:crypto"), { EventEmitter } = await import("node:events");
  const { getBase58Encoder, getBase58Decoder } = await import("@solana/kit");
  const { claimMain } = await import("/app/src/backend/rewards-claimer.ts" as string) as typeof import("../../src/backend/rewards-claimer.ts");
  const { sourcePublicKey } = await import("/app/src/backend/treasury-transaction.ts" as string) as typeof import("../../src/backend/treasury-transaction.ts");
  const root = "/home/node/.nosana", info = JSON.parse(fs.readFileSync(`${root}/fixture-public.json`, "utf8"));
  if (owner !== info.sourceAddress || !/^fixture-[a-f0-9]{12}$/.test(info.instance)) throw Error("Claim fixture source changed.");
  const signature = getBase58Decoder().decode(Buffer.alloc(64, 7));
  const fake = { request(url: unknown, options: { method: string; rejectUnauthorized: boolean; headers: Record<string, string> }, callback: (response: unknown) => void) {
    if (url !== "https://dashboard.k8s.prd.nos.ci/api/nodes/payment" || options.method !== "POST" || options.rejectUnauthorized !== true
      || options.headers["Content-Length"] !== "0") throw Error("Fixture rejected an unexpected claim request.");
    const authorization = options.headers.Authorization ?? "", prefix = owner + ":";
    if (!authorization.startsWith(prefix) || !crypto.verify(null, Buffer.from(owner), sourcePublicKey(owner), Buffer.from(getBase58Encoder().encode(authorization.slice(prefix.length)))))
      throw Error("Generated source authorization did not verify.");
    const counter = JSON.parse(fs.readFileSync(`${root}/fixture-claims.json`, "utf8")); if (counter.posts !== 0) throw Error("A claim helper was repeated.");
    fs.writeFileSync(`${root}/fixture-claims.json`, JSON.stringify({ posts: 1, authorizationVerified: true }), { mode: 0o600 });
    const outgoing = Object.assign(new EventEmitter(), { destroy() {}, end(...args: unknown[]) {
      if (args.length) throw Error("A claim request body was supplied.");
      queueMicrotask(() => { const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy() {} });
        callback(response); response.emit("data", Buffer.from(JSON.stringify({ success: true, claimableAmount: 2_345_678, transactionSignature: signature }))); response.emit("end"); });
    } }); return outgoing;
  } } as unknown as typeof import("node:https");
  // The real short-lived authentication child reads only the generated source
  // key. Only its HTTPS dependency is replaced; the reusable header never leaves.
  const result = await claimMain(["--gridlens-approved-uptime-claim", owner], { https: fake });
  process.stdout.write(JSON.stringify(result));
}
export async function ownerBoundGuardianFixture(input: { instance: string; sourceContainerId: string; nowMs: number; claimProgram: string }): Promise<void> {
  const fs = await import("node:fs");
  const { startSourceGuardianServer } = await import("/app/scripts/source-guardian.ts" as string) as typeof import("../../scripts/source-guardian.ts");
  const { createGuardianExecutor, guardianLocalRun } = await import("/app/src/backend/guardian-executor.ts" as string) as typeof import("../../src/backend/guardian-executor.ts");
  const { shellQuote } = await import("/app/src/backend/ssh.ts" as string) as typeof import("../../src/backend/ssh.ts");
  if (!/^fixture-[a-f0-9]{12}$/.test(input.instance) || !/^[a-f0-9]{64}$/.test(input.sourceContainerId) || !Number.isSafeInteger(input.nowMs)) throw Error("Invalid guardian fixture identity.");
  const counterPath = "/guardian/fixture-counters.json";
  if (!fs.existsSync(counterPath)) fs.writeFileSync(counterPath, JSON.stringify({ transferHelpers: 0, claimHelpers: 0 }), { mode: 0o600, flag: "wx" });
  const increment = (field: "transferHelpers" | "claimHelpers") => {
    const value = JSON.parse(fs.readFileSync(counterPath, "utf8")); value[field]++;
    const fd = fs.openSync(counterPath, "w", 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const run: import("../../src/backend/ssh.ts").SshRun = async (command, options) => {
    if (!command.startsWith("/usr/bin/docker ") || !command.includes(input.sourceContainerId)) throw Error("Fixture refused a non-fixture runtime operation.");
    const ownership = await guardianLocalRun(`/usr/bin/docker inspect --format '{{json .Config.Labels}}' ${input.sourceContainerId}`, { maximum: 4096, timeoutMs: 4000 });
    const labels = JSON.parse(ownership.stdout);
    if (ownership.code !== 0 || labels["io.gridlens.instance"] !== input.instance || labels["io.gridlens.product"] !== "shared-backend" || labels["io.gridlens.role"] !== "fixture-source") throw Error("Fixture source ownership changed.");
    if (command.includes("--gridlens-approved-uptime-claim")) {
      increment("claimHelpers");
      const status = JSON.parse(fs.readFileSync("/guardian/owner-pin.json", "utf8"));
      const source = status.sources.find((row: { binding: { nodeContainerId: string } }) => row.binding.nodeContainerId === input.sourceContainerId);
      const prelude = 'ulimit -S -c 0 && ulimit -H -c 0 && printf 0 > /proc/self/coredump_filter && exec /usr/local/bin/node --input-type=module -e "$1" "$2"';
      return guardianLocalRun(`/usr/bin/docker exec ${input.sourceContainerId} /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /bin/sh -c ${shellQuote(prelude)} generated-claim-fixture ${shellQuote(input.claimProgram)} ${shellQuote(source.address)}`, options);
    }
    if (command.includes("--gridlens-one-nos-transfer")) increment("transferHelpers");
    return guardianLocalRun(command, options);
  };
  const server = await startSourceGuardianServer({ directory: "/guardian", socketPath: "/tmp/guardian.sock", executor: createGuardianExecutor(run) });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
  console.log(JSON.stringify({ ready: true, instance: input.instance }));
}
