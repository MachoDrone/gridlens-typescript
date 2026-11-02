import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { createSharedService } from "../src/backend/service.ts";
import { createGatewayIntegration, startSharedGateway } from "../src/backend/gateway.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { ownerCall, SharedHttpError, startOwnerSocket } from "../src/backend/ipc.ts";
import { openTreasuryVault } from "../src/backend/treasury-vault.ts";
import type { TreasuryDriver, TreasuryQuote } from "../src/backend/treasury.ts";
import { TreasuryPreflightError } from "../src/backend/treasury-errors.ts";
import { TREASURY_PREFLIGHT_CODES, parseTreasuryConfiguration, parseTreasuryOperation, parseTreasuryPlan, parseTreasuryPreflightFailure, parseTreasuryStatus, parseTreasuryUnlock, treasuryPreflightStatus } from "../src/contracts/treasury.ts";
import type { BrowserSecurityPublication } from "../src/contracts/browser-security.ts";
import { startFleetServer } from "../src/server/application.ts";
import { NOS_MINT } from "../src/fleet/nos.ts";
import { address as solanaAddress, getBase58Decoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { ClaimsDriver } from "../src/backend/treasury-claims.ts";
import { TREASURY_LEDGER_KEY } from "../src/backend/treasury.ts";
import { initializeClaimsMarker } from "../src/backend/treasury-claims-marker.ts";
import { parseClaimsPlan, parseClaimsOperation, parseClaimsStatus } from "../src/contracts/treasury-claims.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";

const address = (last: string) => "1".repeat(31) + last;
const SOURCE = address("2"), DESTINATION = address("3"), PASSWORD = "isolated owner Wallet password";
const stop = (server: Server) => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
interface Reply { code: number; text: string; headers: IncomingHttpHeaders }

/** Actual CA-validated loopback TLS and Unix sockets, with a transaction driver
 * that only returns synthetic values and never contacts a provider or wallet. */
async function fixture(t: TestContext, claimsEnabled = false, markerBroken = false) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-wallet-gateway-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3",
    "-subj", "/CN=Generated Wallet gateway fixture", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "server.key", "-out", "server.csr",
    "-subj", "/CN=Generated Wallet loopback", "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth", "-addext", "subjectAltName=IP:127.0.0.1"]);
  run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", "2", "-out", "server.crt", "-days", "1", "-copy_extensions", "copy"]);
  const ca = readFileSync(join(directory, "ca.crt"), "utf8"), leaf = readFileSync(join(directory, "server.crt"), "utf8");
  const publication: BrowserSecurityPublication = { version: 1, instance: "wallet-fixture", httpsOrigin: "https://127.0.0.1:18778", httpOrigin: "http://127.0.0.1:18770",
    certificatePem: ca, serverCertificatePem: leaf, serverCertificateSha256: createHash("sha256").update(new X509Certificate(leaf).raw).digest("hex") };
  const state = openSharedState(join(directory, "state")), vault = openTreasuryVault(directory, { create: true });
  const calls = { prepare: 0, sign: 0, submit: 0, reconcile: 0 };
  let prepareFailure: unknown, admissionFailure: unknown;
  const driver: TreasuryDriver = {
    assertReady() { if (admissionFailure !== undefined) throw admissionFailure; },
    async prepare(context, sourceAddress, destinationAddress) {
      calls.prepare++; if (prepareFailure !== undefined) throw prepareFailure;
      const now = Date.now();
      const quote: TreasuryQuote = { scopeId: context.scopeId, rosterRevision: context.rosterRevision, sourceAddress, destinationAddress,
        sourceTokenAddress: address("4"), destinationTokenAddress: address("5"), mintAddress: NOS_MINT, amountBaseUnits: "1000000", decimals: 6,
        feeLamports: "5000", rentLamports: "2039280", reserveLamports: "50000000", maxCostLamports: "5000000",
        createDestinationAta: true, sourceNosBaseUnits: "2000000", sourceSolLamports: "100000000", preparedAtMs: now, expiresAtMs: now + 60_000,
        sourceBinding: { pcId: "a".repeat(64), nodeId: "b".repeat(64), containerId: "c".repeat(64), sshIdentity: `SHA256:${"d".repeat(43)}` },
        messageBase64: Buffer.from("synthetic message").toString("base64"), blockhash: address("6"), lastValidBlockHeight: 1234 };
      return quote;
    },
    async sign(quote) { calls.sign++; return { quote, transactionBase64: Buffer.from("synthetic signed bytes").toString("base64"), signature: "2".repeat(88) }; },
    async submit() { calls.submit++; },
    async reconcile() { calls.reconcile++; return { status: "confirmed", observedAtMs: Date.now(), slot: 42 }; },
  };
  const claimCalls = { prepare: 0, dispatch: 0, reconcile: 0 };
  let uncertainClaim = false;
  const claimDriver: ClaimsDriver = {
    assertReady() { if (admissionFailure !== undefined) throw admissionFailure; },
    async prepare(context, sourceAddress) {
      claimCalls.prepare++; if (prepareFailure !== undefined) throw prepareFailure;
      const [sourceTokenAddress] = await findAssociatedTokenPda({ owner: solanaAddress(sourceAddress), mint: solanaAddress(NOS_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      return { scopeId: context.scopeId, rosterRevision: context.rosterRevision, sourceAddress, sourceTokenAddress, mintAddress: NOS_MINT, decimals: 6,
        lastReportedAmountBaseUnits: "42500000", checkedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
        sourceBinding: { pcId: "a".repeat(64), nodeId: "b".repeat(64), containerId: "c".repeat(64), sshIdentity: `SHA256:${"d".repeat(43)}` } };
    },
    async dispatch(_quote, authorize) {
      authorize(); claimCalls.dispatch++;
      if (uncertainClaim) throw new Error("Synthetic lost claim response");
      return { status: "acknowledged", success: true, amountUnit: "base-units", observedAtMs: Date.now(), claimedAmountAtoms: "43500000",
        signature: getBase58Decoder().decode(new Uint8Array(64).fill(claimCalls.dispatch)) };
    },
    async reconcile({ quote, dispatch }) {
      claimCalls.reconcile++;
      return { status: "confirmed", observedAtMs: Date.now(), slot: 123, paidAmountBaseUnits: dispatch.claimedAmountAtoms!,
        payoutOwner: quote.sourceAddress, payoutTokenAddress: quote.sourceTokenAddress, mintAddress: NOS_MINT };
    },
  };
  const service = createSharedService(state, { treasury: { vault, driver: () => driver, ...(claimsEnabled ? { claims: {
    driver: () => claimDriver, initialize(serverId: string) {
      if (markerBroken) throw new Error("Synthetic missing initialization witness");
      return initializeClaimsMarker(directory, serverId, vault.keyId, false);
    },
  } } : {}) } });
  const servers: Server[] = [];
  t.after(async () => {
    for (const server of servers.reverse()) await stop(server);
    await service.wallet?.close(); await service.claims?.close(); await service.setup.close(); vault.close(); await state.close(); rmSync(directory, { recursive: true, force: true });
  });
  const grant = randomBytes(32).toString("base64url");
  const context = service.access.setFleet("default", claimsEnabled ? [SOURCE, address("9")] : [SOURCE]); service.access.registerGateway("default", grant);
  if (claimsEnabled) {
    const associations = context.addresses.map(host => ({ address: host, name: "Generated host", sshFingerprint: `SHA256:${"d".repeat(43)}`,
      verifiedAtMs: Date.now(), privateIp: "192.168.42.10", gpuUuids: [], binding: { pcId: "a".repeat(64), runtime: "docker" as const,
        wrapperId: null, nodeContainerId: "c".repeat(64) } }));
    service.observations.associate(context, associations);
    // Only the permission fields exercised by the service host list are needed;
    // the injected fixture driver never connects or reads credentials.
    const permission: PcPermission = { version: 1, computer: { id: "a".repeat(64), fingerprint: `SHA256:${"d".repeat(43)}`,
      host: "192.168.42.10", port: 22, name: "Generated PC", hostKey: "generated-unused-public-host-key" }, associations,
      rosterRevision: context.rosterRevision, rewards: true, automaticIp: false, gpu: false, paused: false, revokedAtMs: null, approvedAtMs: Date.now() };
    state.set(`permission:default:${"a".repeat(64)}`, permission);
    for (const row of associations) service.observations.ingest(context, { address: row.address, binding: row.binding,
      rewards: { schema: 1, address: row.address, observedAtMs: Date.now(), status: "ok", amount: "42.500000" } });
  }
  const operator = service.access.pair(service.access.createCode("default", "operator").code, "Synthetic independent operator");
  await service.control({ operation: "browser-security-publish", ...publication });
  const readSocket = join(directory, "read.sock"), treasurySocket = join(directory, "treasury.sock"), controlSocket = join(directory, "control.sock");
  servers.push(await startOwnerSocket(readSocket, service.read), await startOwnerSocket(treasurySocket, service.treasury), await startOwnerSocket(controlSocket, service.control));
  const http = await startSharedGateway({ socketPath: readSocket, directory: resolve("dist"), host: "127.0.0.1", port: 0,
    transport: "vpn-http", publicOrigin: publication.httpOrigin!, privateNetworkToken: grant }); servers.push(http.server);
  const https = await startSharedGateway({ socketPath: readSocket, treasurySocketPath: treasurySocket, directory: resolve("dist"), host: "127.0.0.1", port: 0,
    publicOrigin: publication.httpsOrigin, certPath: join(directory, "server.crt"), keyPath: join(directory, "server.key") }); servers.push(https.server);
  const call = (secure: boolean, path: string, body?: unknown, extra: Record<string, string> = {}, omitOrigin = false, trusted = true): Promise<Reply> =>
    new Promise((done, reject) => {
      const origin = secure ? publication.httpsOrigin : publication.httpOrigin!, data = body === undefined ? undefined : JSON.stringify(body);
      const request = (secure ? httpsRequest : httpRequest)({ hostname: "127.0.0.1", port: ((secure ? https : http).server.address() as { port: number }).port,
        path, method: data === undefined ? "GET" : "POST", ...(secure && trusted ? { ca } : {}), headers: { Host: new URL(origin).host,
          ...(omitOrigin ? {} : { Origin: origin }), ...(data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }), ...extra } }, response => {
        let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => done({ code: response.statusCode!, text, headers: response.headers }));
      }); request.on("error", reject); request.end(data);
    });
  const issued = await call(false, "/secure-setup/connect-code", {}); assert.equal(issued.code, 200);
  const connected = await call(true, "/secure-setup/connect", { version: 1, code: JSON.parse(issued.text).code }); assert.equal(connected.code, 200);
  const cookie = connected.headers["set-cookie"]?.[0]?.split(";", 1)[0]; assert(cookie);
  const browser = { Cookie: cookie };
  const treasury = (path: string, body?: unknown, unlockToken?: string, extra: Record<string, string> = {}) =>
    call(true, `/api/shared/treasury/${path}`, body, { ...browser, ...(unlockToken ? { "X-GridLens-Wallet": unlockToken } : {}), ...extra });
  const setup = async () => {
    const ticket = await ownerCall<{ ticket: string; setupUrl: string }>(controlSocket, { operation: "treasury-setup", scopeId: "default" });
    assert.equal(ticket.setupUrl, `${publication.httpsOrigin}/wallet#ticket=${ticket.ticket}`);
    const result = await treasury("setup", { version: 1, ticket: ticket.ticket, password: PASSWORD, destinationAddress: DESTINATION });
    assert.equal(result.code, 200, result.text); return parseTreasuryUnlock(JSON.parse(result.text));
  };
  return { directory, service, state, calls, claimCalls, readSocket, treasurySocket, controlSocket, grant, operator, browser, publication, servers, call, treasury, setup,
    loseClaimResponse() { uncertainClaim = true; },
    failPreparation(error: unknown) { prepareFailure = error; }, failAdmission(error: unknown) { admissionFailure = error; } };
}

test("typed review failures cross real TLS and dedicated IPC without consuming the pilot or reaching a signer", async t => {
  const f = await fixture(t), unlock = await f.setup();
  for (const code of TREASURY_PREFLIGHT_CODES) {
    const retryAtMs = code === "budget-wait" || code === "provider-unavailable" ? Date.now() + 60_000 : undefined;
    f.failPreparation(new TreasuryPreflightError(code, retryAtMs));
    const response = await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken);
    assert.equal(response.code, treasuryPreflightStatus(code));
    assert.deepEqual(parseTreasuryPreflightFailure(JSON.parse(response.text)), { version: 1, kind: "preflight-failure", code,
      ...(retryAtMs === undefined ? {} : { retryAtMs }) });
    const configuration = await f.treasury("configuration", undefined, unlock.unlockToken);
    assert.equal(parseTreasuryConfiguration(JSON.parse(configuration.text)).pilotConsumed, false);
    assert.deepEqual(JSON.parse((await f.treasury("operations", undefined, unlock.unlockToken)).text).operations, []);
    assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0); assert.equal(f.calls.reconcile, 0);
  }
  f.failPreparation(undefined);
  const recovered = await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken);
  assert.equal(recovered.code, 200); assert.equal(parseTreasuryPlan(JSON.parse(recovered.text)).quote.amountBaseUnits, "1000000");
  assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0);
});

test("unknown provider errors are sanitized through TLS and IPC and preserve the unused allowance", async t => {
  const f = await fixture(t), unlock = await f.setup();
  f.failPreparation(Object.assign(new Error("Authorization: private-provider-value; https://private.invalid/account"),
    { code: "budget-wait", retryAtMs: Date.now() + 60_000, cause: { secret: "never expose this" } }));
  const response = await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken);
  assert.equal(response.code, 503);
  assert.deepEqual(JSON.parse(response.text), { version: 1, kind: "preflight-failure", code: "preflight-unavailable" });
  assert.doesNotMatch(response.text, /Authorization|private-provider|private\.invalid|never expose/);
  assert.equal(parseTreasuryConfiguration(JSON.parse((await f.treasury("configuration", undefined, unlock.unlockToken)).text)).pilotConsumed, false);
  assert.deepEqual(f.calls, { prepare: 1, sign: 0, submit: 0, reconcile: 0 });
});

test("known confirmation admission deferral returns a typed rejection and keeps the same reviewed plan usable", async t => {
  const f = await fixture(t), unlock = await f.setup();
  const prepared = await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken); assert.equal(prepared.code, 200);
  const plan = parseTreasuryPlan(JSON.parse(prepared.text)), retryAtMs = Date.now() + 1000;
  const body = { version: 1, planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey: "known_preflight_failure_retry" };
  f.failAdmission(new TreasuryPreflightError("budget-wait", retryAtMs));
  const deferred = await f.treasury("confirm", body, unlock.unlockToken);
  assert.equal(deferred.code, 429);
  assert.deepEqual(JSON.parse(deferred.text), { version: 1, kind: "preflight-failure", code: "budget-wait", retryAtMs });
  assert.equal(parseTreasuryConfiguration(JSON.parse((await f.treasury("configuration", undefined, unlock.unlockToken)).text)).pilotConsumed, false);
  assert.deepEqual(JSON.parse((await f.treasury("operations", undefined, unlock.unlockToken)).text).operations, []);
  assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0);
  f.failAdmission(undefined);
  const confirmed = await f.treasury("confirm", body, unlock.unlockToken); assert.equal(confirmed.code, 200);
  await f.service.wallet!.waitForIdle();
  assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
});

test("real HTTPS and dedicated IPC complete owner setup, bounded review, one send and verified receipt", async t => {
  const f = await fixture(t);
  const page = await f.call(true, "/wallet", undefined, f.browser); assert.equal(page.code, 200); assert.match(page.text, /Review 1 NOS transfer/);
  assert.equal(page.headers["cache-control"], "no-store"); assert.equal(page.headers["x-frame-options"], "DENY");
  const status = await f.treasury("status"); assert.equal(status.code, 200); assert.equal(parseTreasuryStatus(JSON.parse(status.text)).state, "setup-required");
  assert.equal((await f.treasury("configuration")).code, 401);
  const unlock = await f.setup(); assert.equal(unlock.configuration.destinationAddress, DESTINATION);
  await f.treasury("lock", { version: 1 }, unlock.unlockToken);
  assert.equal((await f.treasury("configuration", undefined, unlock.unlockToken)).code, 401);
  const reopened = await f.treasury("unlock", { version: 1, password: PASSWORD }); assert.equal(reopened.code, 200);
  const token = parseTreasuryUnlock(JSON.parse(reopened.text)).unlockToken;
  const prepared = await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, token); assert.equal(prepared.code, 200, prepared.text);
  const plan = parseTreasuryPlan(JSON.parse(prepared.text)); assert.equal(plan.quote.amountBaseUnits, "1000000");
  const body = { version: 1, planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey: "isolated_gateway_idempotency" };
  const confirmation = await f.treasury("confirm", body, token); assert.equal(confirmation.code, 200, confirmation.text);
  const id = parseTreasuryOperation(JSON.parse(confirmation.text).operation).id;
  await f.service.wallet!.waitForIdle();
  const result = await f.treasury(`operations/${id}`, undefined, token); assert.equal(result.code, 200);
  const operation = parseTreasuryOperation(JSON.parse(result.text).operation);
  assert.equal(operation.phase, "confirmed"); assert.equal(operation.sourceAddress, SOURCE); assert.equal(operation.destinationAddress, DESTINATION);
  assert.equal(operation.amountBaseUnits, "1000000"); assert.equal(operation.slot, 42);
  assert.equal((await f.treasury("confirm", body, token)).code, 200, "same approved request resolves its existing operation");
  assert.equal((await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, token)).code, 409);
  assert.equal((await f.treasury("operations/not-the-operation", undefined, token)).code, 404);
  assert.equal(JSON.parse((await f.treasury("operations", undefined, token)).text).operations.length, 1);
  assert.deepEqual(f.calls, { prepare: 1, sign: 1, submit: 1, reconcile: 1 });
  for (const secret of [PASSWORD, token, "messageBase64", "transactionBase64", "sourceBinding"]) assert.equal(result.text.includes(secret), false);
});

test("HTTP, forged TLS fields, wrong origins and the ordinary read socket cannot acquire financial authority", async t => {
  const f = await fixture(t);
  const redirect = await f.call(false, "/wallet"); assert.equal(redirect.code, 303); assert.equal(redirect.headers.location, "/secure-setup#return=wallet");
  for (const route of ["status", "setup", "unlock", "configuration", "prepare", "confirm", "operations"]) {
    const body = ["status", "operations"].includes(route) ? undefined : { version: 1, password: PASSWORD, https: true, secure: true };
    assert.equal((await f.call(false, `/api/shared/treasury/${route}`, body,
      { Authorization: `Bearer ${f.operator.token}`, "X-Forwarded-Proto": "https", Forwarded: "proto=https" })).code, 403);
  }
  await assert.rejects(f.call(true, "/api/shared/treasury/status", undefined, f.browser, false, false), /certificate|issuer|verify/i);
  assert.equal((await f.treasury("unlock", { version: 1, password: PASSWORD }, undefined, { Origin: "https://wrong.invalid" })).code, 403);
  assert.equal((await f.call(true, "/api/shared/treasury/unlock", { version: 1, password: PASSWORD }, f.browser, true)).code, 403);
  assert.equal((await f.treasury("setup", { version: 1, ticket: "x".repeat(43), password: PASSWORD, destinationAddress: DESTINATION, httpsOrigin: f.publication.httpsOrigin })).code, 400);
  for (const operation of ["treasury-setup", "treasury-reset", "confirm", "treasury"]) {
    await assert.rejects(ownerCall(f.readSocket, { operation, token: f.operator.token, scopeId: "default", httpsOrigin: f.publication.httpsOrigin,
      serverCertificateSha256: f.publication.serverCertificateSha256 }), SharedHttpError);
  }
  const integration = createGatewayIntegration(f.readSocket, Buffer.from("<head></head>"), Buffer.from(""), { transport: "https", treasurySocketPath: f.treasurySocket,
    serverCertificateSha256: f.publication.serverCertificateSha256, walletHtml: Buffer.from("<h1>Wallet</h1>") });
  const masquerading = await startFleetServer({ integration, host: "127.0.0.1", port: 0, publicOrigin: f.publication.httpsOrigin }); f.servers.push(masquerading);
  const code = await new Promise<number>((done, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: (masquerading.address() as { port: number }).port, path: "/api/shared/treasury/status",
      headers: { Host: new URL(f.publication.httpsOrigin).host, Origin: f.publication.httpsOrigin, ...f.browser } }, response => { response.resume(); response.on("end", () => done(response.statusCode!)); });
    request.on("error", reject); request.end();
  });
  assert.equal(code, 403, "configured transport and spoofed headers cannot replace an actual TLS socket");
  assert.deepEqual(f.calls, { prepare: 0, sign: 0, submit: 0, reconcile: 0 });
});

test("owner configuration changes relock reviews and parent browser revocation removes Wallet access", async t => {
  const f = await fixture(t), unlock = await f.setup();
  const prepared = await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken); assert.equal(prepared.code, 200);
  const plan = parseTreasuryPlan(JSON.parse(prepared.text));
  assert.equal((await f.treasury("configuration", { version: 1, destinationAddress: address("8") }, unlock.unlockToken)).code, 400);
  const changed = await f.treasury("configuration", { version: 1, currentPassword: PASSWORD, destinationAddress: address("8") }, unlock.unlockToken);
  assert.equal(changed.code, 200, changed.text); assert.equal(JSON.parse(changed.text).locked, true);
  assert.equal((await f.treasury("confirm", { version: 1, planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey: "invalidated_review_id" }, unlock.unlockToken)).code, 401);
  const reopened = parseTreasuryUnlock(JSON.parse((await f.treasury("unlock", { version: 1, password: PASSWORD })).text));
  const current = parseTreasuryConfiguration(JSON.parse((await f.treasury("configuration", undefined, reopened.unlockToken)).text));
  assert.equal(current.destinationAddress, address("8"));
  f.service.access.revokeGateway("default");
  assert.equal((await f.treasury("status")).code, 401);
  assert.equal((await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, reopened.unlockToken)).code, 401);
  assert.equal((await f.treasury("operations", undefined, reopened.unlockToken)).code, 401);
  assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0);
});

test("real TLS claims pay the reviewed host and permit a second host while preserving the completed NOS pilot", async t => {
  const f = await fixture(t, true), unlock = await f.setup();
  const transfer = parseTreasuryPlan(JSON.parse((await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken)).text));
  assert.equal((await f.treasury("confirm", { version: 1, planId: transfer.planId, reviewDigest: transfer.reviewDigest,
    idempotencyKey: "synthetic_transfer_once" }, unlock.unlockToken)).code, 200);
  await f.service.wallet!.waitForIdle();
  const original = f.state.get(TREASURY_LEDGER_KEY);
  assert.equal(parseTreasuryConfiguration(JSON.parse((await f.treasury("configuration", undefined, unlock.unlockToken)).text)).pilotConsumed, true);
  const initial = parseClaimsStatus(JSON.parse((await f.treasury("claims/status", undefined, unlock.unlockToken)).text));
  assert.deepEqual(initial.eligibleHosts.map(row => row.address), [SOURCE, address("9")]);
  for (const host of [SOURCE, address("9")]) {
    const prepared = await f.treasury("claims/prepare", { version: 1, sourceAddress: host }, unlock.unlockToken);
    assert.equal(prepared.code, 200, prepared.text);
    const plan = parseClaimsPlan(JSON.parse(prepared.text));
    assert.equal(plan.quote.payoutOwner, host); assert.notEqual(plan.quote.payoutOwner, DESTINATION);
    assert.equal(plan.quote.amountMode, "full-available");
    const body = { version: 1, planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey: `synthetic_claim_host_${host}` };
    const confirmed = await f.treasury("claims/confirm", body, unlock.unlockToken); assert.equal(confirmed.code, 200, confirmed.text);
    const operation = parseClaimsOperation(JSON.parse(confirmed.text).operation);
    await f.service.claims!.waitForIdle();
    const receiptReply = await f.treasury(`claims/operations/${operation.id}`, undefined, unlock.unlockToken);
    assert.equal(receiptReply.code, 200, receiptReply.text);
    const receipt = parseClaimsOperation(JSON.parse(receiptReply.text).operation);
    assert.equal(receipt.phase, "confirmed"); assert.equal(receipt.payoutOwner, host); assert.equal(receipt.paidAmountBaseUnits, "43500000");
    assert.equal((await f.treasury("claims/confirm", body, unlock.unlockToken)).code, 200, "same confirmation reads the durable receipt");
    assert.equal((await f.treasury("claims/prepare", { version: 1, sourceAddress: host }, unlock.unlockToken)).code, 409);
    assert.deepEqual(f.state.get(TREASURY_LEDGER_KEY), original);
  }
  assert.equal(f.claimCalls.dispatch, 2); assert.equal(f.claimCalls.reconcile, 2);
  const status = parseClaimsStatus(JSON.parse((await f.treasury("claims/status", undefined, unlock.unlockToken)).text));
  assert.equal(status.unresolvedOperationId, null); assert.deepEqual(status.eligibleHosts, []);
  assert.equal(JSON.parse((await f.treasury("claims/operations", undefined, unlock.unlockToken)).text).total, 2);
  assert.equal(f.calls.submit, 1);
});

test("claim endpoints enforce real HTTPS, exact requests and current owner unlock without read-socket authority", async t => {
  const f = await fixture(t, true), unlock = await f.setup();
  for (const route of ["claims/status", "claims/operations", "claims/prepare", "claims/confirm"]) {
    assert.equal((await f.call(false, `/api/shared/treasury/${route}`, undefined, { "X-Forwarded-Proto": "https", ...f.browser })).code, 403);
    assert.equal((await f.treasury(route, route.endsWith("prepare") ? { version: 1, sourceAddress: SOURCE }
      : route.endsWith("confirm") ? { version: 1, planId: "unreviewed", reviewDigest: "a".repeat(64), idempotencyKey: "synthetic_invalid_review" } : undefined)).code, 401);
  }
  assert.equal((await f.treasury("claims/prepare", { version: 1, sourceAddress: SOURCE, amount: "1" }, unlock.unlockToken)).code, 400);
  assert.equal((await f.treasury("claims/prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken, { Origin: "https://wrong.invalid" })).code, 403);
  for (const operation of ["claims-status", "claims-operations", "claims-prepare", "claims-confirm"]) {
    await assert.rejects(ownerCall(f.readSocket, { operation, token: f.operator.token, unlockToken: unlock.unlockToken,
      httpsOrigin: f.publication.httpsOrigin, serverCertificateSha256: f.publication.serverCertificateSha256 }), SharedHttpError);
  }
  const prepared = await f.treasury("claims/prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken);
  const plan = parseClaimsPlan(JSON.parse(prepared.text));
  await f.treasury("lock", { version: 1 }, unlock.unlockToken);
  assert.equal((await f.treasury("claims/confirm", { version: 1, planId: plan.planId, reviewDigest: plan.reviewDigest,
    idempotencyKey: "synthetic_locked_claim" }, unlock.unlockToken)).code, 401);
  assert.equal(f.claimCalls.dispatch, 0);
});

test("lost claim responses remain visible and block another host without a second POST", async t => {
  const f = await fixture(t, true), unlock = await f.setup(); f.loseClaimResponse();
  const plan = parseClaimsPlan(JSON.parse((await f.treasury("claims/prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken)).text));
  assert.equal((await f.treasury("claims/confirm", { version: 1, planId: plan.planId, reviewDigest: plan.reviewDigest,
    idempotencyKey: "synthetic_lost_claim_response" }, unlock.unlockToken)).code, 200);
  await f.service.claims!.waitForIdle();
  await f.service.claims!.reconcilePending();
  const history = JSON.parse((await f.treasury("claims/operations", undefined, unlock.unlockToken)).text);
  assert.equal(parseClaimsOperation(history.operations[0]).phase, "needs-verification");
  assert.equal((await f.treasury("claims/prepare", { version: 1, sourceAddress: address("9") }, unlock.unlockToken)).code, 409);
  assert.equal(f.claimCalls.dispatch, 1); assert.equal(f.claimCalls.reconcile, 0);
});

test("claims initialization recovery leaves the configured owner and original transfer pilot usable", async t => {
  const f = await fixture(t, true, true), unlock = await f.setup();
  const reply = await f.treasury("claims/status", undefined, unlock.unlockToken);
  assert.equal(reply.code, 200); assert.equal(parseClaimsStatus(JSON.parse(reply.text)).state, "recovery-required");
  assert.equal((await f.treasury("claims/prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken)).code, 503);
  assert.equal((await f.treasury("prepare", { version: 1, sourceAddress: SOURCE }, unlock.unlockToken)).code, 200);
  assert.equal((await f.treasury("configuration", undefined, unlock.unlockToken)).code, 200);
  assert.equal(f.claimCalls.dispatch, 0);
});

test("claim host choices exclude failed retained readings and paused permissions without additional provider reads", async t => {
  const f = await fixture(t, true), unlock = await f.setup(), context = f.service.access.contexts()[0]!;
  const association = f.service.observations.read(context).associations[0]!;
  f.service.observations.ingest(context, { address: SOURCE, binding: association.binding,
    rewards: { schema: 1, address: SOURCE, status: "unavailable", observedAtMs: Date.now() + 1 } });
  const status = () => f.treasury("claims/status", undefined, unlock.unlockToken).then(reply => parseClaimsStatus(JSON.parse(reply.text)));
  assert.deepEqual((await status()).eligibleHosts.map(row => row.address), [address("9")], "retained last-good amounts never authorize a claim choice");
  const key = `permission:default:${"a".repeat(64)}`, permission = f.state.get<PcPermission>(key)!;
  f.state.set(key, { ...permission, paused: true });
  assert.deepEqual((await status()).eligibleHosts, []);
  f.state.set(key, permission);
  f.state.set(`monitor:reward-denial:default:${"a".repeat(64)}:${address("9")}`, { approvedAtMs: permission.approvedAtMs });
  assert.deepEqual((await status()).eligibleHosts, []);
  assert.equal(f.claimCalls.prepare, 0); assert.equal(f.claimCalls.dispatch, 0); assert.equal(f.claimCalls.reconcile, 0);
});
