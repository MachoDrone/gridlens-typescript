// Copyright (c) 2026 MachoDrone. MIT License, as supplied with GridLens Android.
// Narrow Android adaptation of the reviewed GridLens in-container reward reader:
// exact approved node identity, one fixed GET, no key/header export or claims.
// Authentication has broader Nosana authority than this reader's fixed operation.
import fs from "node:fs";
import crypto from "node:crypto";
import https from "node:https";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const REWARDS_URL = 'https://dashboard.k8s.prd.nos.ci/api/nodes/rewards';
const ENV = Object.freeze({PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C'});
const MAX_RESPONSE_BYTES = 16384;
const MAX_RETRY_SECONDS = 2147483647;

export function base58(bytes: Uint8Array): string {
  let n = 0n, result = '';
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  while (n) { result = ALPHABET[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte) break; result = '1' + result; }
  return result;
}
export function ownerValid(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(ALPHABET.indexOf(char));
  let size = 0;
  while (n) { size++; n /= 256n; }
  return size + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
export function safeguards(): void {
  const limits = fs.readFileSync('/proc/self/limits', 'ascii');
  const filter = fs.readFileSync('/proc/self/coredump_filter', 'ascii').trim();
  if (!/^Max core file size\s+0\s+0\s+bytes[ \t]*$/m.test(limits) || !/^0+$/.test(filter)) throw Error();
  if (Object.keys(process.env).some(key => !(key in ENV) && key !== 'PWD') ||
      Object.entries(ENV).some(([key, value]) => process.env[key] !== value)) throw Error();
}
export function walletBytes(input: Buffer, used: number): Buffer {
  // Parse mutable JSON bytes without making a private-key string/number array.
  const result = Buffer.alloc(64);
  let i = 0, count = 0;
  function whitespace() { while (i < used && [9, 10, 13, 32].includes(input[i]!)) i++; }
  try {
    whitespace(); if (input[i++] !== 91) throw Error();
    for (;;) {
      whitespace(); if (count >= 64) throw Error();
      let value = 0, digits = 0;
      const leading = input[i];
      while (i < used && input[i]! >= 48 && input[i]! <= 57) {
        value = value * 10 + input[i++]! - 48; digits++;
        if (digits > 3 || value > 255 || (digits > 1 && leading === 48)) throw Error();
      }
      if (!digits) throw Error();
      result[count++] = value;
      whitespace();
      if (input[i] === 93) { i++; break; }
      if (input[i++] !== 44) throw Error();
    }
    whitespace(); if (i !== used || count !== 64) throw Error();
    return result;
  } catch { result.fill(0); throw Error(); }
}
export function sign(expectedOwner: string): Buffer {
  safeguards();
  if (!ownerValid(expectedOwner)) throw Error();
  const home = os.userInfo().homedir;
  if (typeof home !== 'string' || !home.startsWith('/') || home.includes('\0')) throw Error();
  for (const directory of [home, home + '/.nosana']) {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error();
  }
  let fd: number | undefined, secret: Buffer | undefined, der: Buffer | undefined, signature: Buffer | undefined;
  const input = Buffer.alloc(4097);
  try {
    fd = fs.openSync(home + '/.nosana/nosana_key.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw Error();
    let used = 0;
    for (;;) {
      const read = fs.readSync(fd, input, used, input.length - used, null);
      if (!read) break;
      used += read; if (used === input.length) throw Error();
    }
    secret = walletBytes(input, used);
    der = Buffer.alloc(48);
    Buffer.from('302e020100300506032b657004220420', 'hex').copy(der);
    secret.copy(der, 16, 0, 32);
    const key = crypto.createPrivateKey({key: der, format: 'der', type: 'pkcs8'});
    const publicKey = crypto.createPublicKey(key);
    const bytes = publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
    if (base58(bytes) !== expectedOwner || !bytes.equals(secret.subarray(32))) {
      const error = Object.assign(new Error(), {identityMismatch: true}); throw error;
    }
    const message = Buffer.from(expectedOwner, 'ascii');
    signature = crypto.sign(null, message, key);
    if (!crypto.verify(null, message, publicKey, signature)) throw Error();
    return Buffer.from(expectedOwner + ':' + base58(signature), 'ascii');
  } finally {
    input.fill(0); if (secret) secret.fill(0); if (der) der.fill(0); if (signature) signature.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
    // V8/OpenSSL copies can outlive these buffers until process exit; no erasure guarantee.
  }
}
export function signerSource(): string {
  return "'use strict';const fs=require('node:fs'),crypto=require('node:crypto'),os=require('node:os');" +
    'const ALPHABET=' + JSON.stringify(ALPHABET) + ';const ENV=' + JSON.stringify(ENV) + ';' +
    [base58, ownerValid, safeguards, walletBytes, sign].map(fn => fn.toString()).join('\n') +
    '\ntry { const auth=sign(process.argv[1]);process.stdout.write(auth,()=>{auth.fill(0);process.exit(0);}); }' +
    'catch(e) { process.exit(e.identityMismatch === true ? 2 : 1); }';
}
export function retryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  if (/^\d+$/.test(value.trim())) {
    const integer = BigInt(value.trim());
    // Very large deadlines fail closed for practical scheduling rather than retrying sooner.
    return Number(integer > BigInt(MAX_RETRY_SECONDS) ? BigInt(MAX_RETRY_SECONDS) : integer);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_SECONDS, Math.max(0, Math.ceil((date - now) / 1000))) : undefined;
}
export function exactAmount(token: unknown): string {
  if (typeof token !== 'string' || token.length > 128) throw Error();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw Error();
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw Error();
  const fractional = match[2] || '';
  let nanos = BigInt(match[1]! + fractional);
  const scale = fractional.length - exponent;
  if (scale > 6) {
    const divisor = 10n ** BigInt(scale - 6);
    if (nanos % divisor !== 0n) throw Error();
    nanos /= divisor;
  } else nanos *= 10n ** BigInt(6 - scale);
  if (nanos > 9223372036854775807n) throw Error();
  return String(nanos / 1000000n) + '.' + String(nanos % 1000000n).padStart(6, '0');
}
export function amountFromResponse(raw: unknown): string {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw Error();
  const data = JSON.parse(raw);
  if (!data || Array.isArray(data) || typeof data !== 'object') throw Error();
  // Capture the original top-level JSON number token, preserving all six NOS
  // decimals without floating-point rounding. Nested/duplicate fields do not count.
  const text = raw.trim();
  let i = 1, amount: string | undefined;
  const keys = new Set();
  const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  function stringEnd(start: number): number {
    let end = start + 1;
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '"') return end + 1;
    }
    throw Error();
  }
  for (;;) {
    ws(); if (text[i] === '}') break;
    if (text[i] !== '"') throw Error();
    const end = stringEnd(i);
    const key = JSON.parse(text.slice(i, end));
    if (keys.has(key)) throw Error();
    keys.add(key); i = end; ws(); if (text[i++] !== ':') throw Error(); ws();
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const char = text[i];
      if (char === '"') { i = stringEnd(i); continue; }
      if (char === '[' || char === '{') { depth++; if (depth > 32) throw Error(); }
      if (char === ']' || char === '}') { if (depth === 0) break; depth--; }
      if (char === ',' && depth === 0) break;
      i++;
    }
    if (key === 'claimableUptimeNosRewards') amount = exactAmount(text.slice(start, i).trim());
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '}') break;
    throw Error();
  }
  if (amount === undefined) throw Error();
  return amount;
}
export function request(authorization: string, deadline: number, deps: ReaderDeps = {}): Promise<ReaderResponse> {
  const transport = deps.https || https;
  const monotonic = deps.monotonic || (() => performance.now());
  return new Promise<ReaderResponse>(resolve => {
    let outgoing: ReturnType<typeof https.request> | undefined, timer: ReturnType<typeof setTimeout> | undefined, finished = false;
    const finish = (result: ReaderResponse): void => {
      if (finished) return;
      finished = true; clearTimeout(timer); outgoing?.destroy(); resolve(result);
    };
    const remaining = Math.floor(deadline - monotonic());
    if (remaining <= 0) { finish({status: 'unavailable'}); return; }
    timer = setTimeout(() => finish({status: 'unavailable'}), remaining);
    try {
      outgoing = transport.request(REWARDS_URL, {method: 'GET', agent: false, rejectUnauthorized: true,
        minVersion: 'TLSv1.2', headers: {Accept: 'application/json', Authorization: authorization}}, response => {
        const status = response.statusCode;
        response.on('error', () => finish({status: 'unavailable'}));
        response.on('aborted', () => finish({status: 'unavailable'}));
        const retry = retryAfter(response.headers?.['retry-after']);
        const cooldown = retry === undefined ? {} : {retryAfterSeconds: retry};
        if (status !== 200) {
          finish({status: status === 401 || status === 403 ? 'authentication-failed' : status === 429 ? 'rate-limited' : 'unavailable', ...cooldown});
          response.destroy(); return;
        }
        let length = 0;
        const chunks: Buffer[] = [];
        response.on('data', chunk => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) { finish({status: 'unavailable'}); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try { finish({status: 'ok', amount: amountFromResponse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))), ...cooldown}); }
          catch { finish({status: 'unavailable'}); }
        });
      });
      outgoing.on('error', () => finish({status: 'unavailable'}));
      outgoing.end();
    } catch { finish({status: 'unavailable'}); }
  });
}
export async function main(argv: string[], deps: ReaderDeps = {}): Promise<ReaderResult> {
  const now = deps.now || Date.now;
  const monotonic = deps.monotonic || (() => performance.now());
  const deadline = monotonic() + 12000;
  const owner = argv[1];
  const result: ReaderResult = {schema: 1, address: ownerValid(owner) ? owner : '', observedAtMs: now(), status: 'unavailable'};
  if (argv.length !== 2 || argv[0] !== '--gridlens-approved-rewards' || !ownerValid(owner)) return result;
  try { (deps.safeguards || safeguards)(); } catch { return result; }
  let child: ReturnType<typeof spawnSync> | undefined;
  try {
    child = (deps.spawnSync || spawnSync)(process.execPath, ['-e', signerSource(), owner!], {
      env: ENV, stdio: ['ignore', 'pipe', 'ignore'], timeout: Math.max(1, Math.floor(Math.min(3000, deadline - monotonic()))),
      killSignal: 'SIGKILL', maxBuffer: 256, encoding: 'buffer', windowsHide: true,
    });
    if (child.status === 2) return {...result, observedAtMs: now(), status: 'identity-mismatch'};
    if (child.error || child.status !== 0 || child.signal || !Buffer.isBuffer(child.stdout)) throw Error();
    const authorization = child.stdout.toString('ascii');
    if (!authorization.startsWith(owner! + ':') || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(authorization.slice(owner!.length + 1))) throw Error();
    const response = await request(authorization, deadline, deps);
    return {...result, observedAtMs: now(), ...response};
  } catch { return {...result, observedAtMs: now()}; }
  finally { if (Buffer.isBuffer(child?.stdout)) child.stdout.fill(0); }
}

export interface ReaderResponse { status: 'ok'|'authentication-failed'|'rate-limited'|'identity-mismatch'|'unavailable'; amount?: string; retryAfterSeconds?: number }
export interface ReaderResult extends ReaderResponse { schema: 1; address: string; observedAtMs: number }
export interface ReaderDeps { now?: ()=>number; monotonic?: ()=>number; safeguards?: ()=>void; spawnSync?: typeof spawnSync; https?: typeof https }
/** Source is executed only inside the exact approved node, never in the owner. */
export function rewardsReaderSource(): string {
 return '\'use strict\';const fs=require("node:fs"),crypto=require("node:crypto"),https=require("node:https"),os=require("node:os");const {spawnSync}=require("node:child_process"),{performance}=require("node:perf_hooks"),{TextDecoder}=require("node:util");'
 + 'const ALPHABET='+JSON.stringify(ALPHABET)+';const REWARDS_URL='+JSON.stringify(REWARDS_URL)+';const ENV='+JSON.stringify(ENV)+';const MAX_RESPONSE_BYTES='+MAX_RESPONSE_BYTES+';const MAX_RETRY_SECONDS='+MAX_RETRY_SECONDS+';'
 + [base58,ownerValid,safeguards,walletBytes,sign,signerSource,retryAfter,exactAmount,amountFromResponse,request,main].map(fn=>fn.toString()).join('\n')
 + '\nmain(process.argv.slice(1)).then(result=>{process.stdout.write(JSON.stringify(result)+"\\n");process.exitCode=0}).catch(()=>{process.exitCode=1});';
}
