import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { addressAnswer, createAddressPromptResponder } from "../scripts/release/public-installer.ts";

const address = "192.168.55.5";
/** Real Node readline output, without SSH, Docker or a public installer. */
function readlinePrompt(term: "xterm" | "dumb"): string {
  const program = `
    import { PassThrough } from 'node:stream';
    import { createInterface } from 'node:readline/promises';
    const input = new PassThrough(), output = new PassThrough();
    output.isTTY = true; output.columns = 80; input.isTTY = true;
    let text = '1) 10.20.30.40 — recommended\\n\\n2) ${address}\\n\\n';
    output.on('data', chunk => text += chunk.toString());
    const line = createInterface({ input, output, terminal: true });
    const pending = line.question('Choose address number [1, recommended]: ');
    await new Promise(resolve => setImmediate(resolve));
    const captured = text;
    input.write('2\\n'); await pending;
    line.close(); input.end(); output.end();
    process.stdout.write(JSON.stringify(captured));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8", env: { ...process.env, TERM: term }, timeout: 5000, maxBuffer: 16384
  })) as string;
}
test("public installer matcher understands actual xterm cursor controls and dumb terminal output", () => {
  const xterm = readlinePrompt("xterm"), dumb = readlinePrompt("dumb");
  assert.match(xterm, /\x1b\[[0-9;]+G/);
  assert.equal(dumb.includes("\x1b"), false);
  assert.equal(addressAnswer(xterm, address), "2\n");
  assert.equal(addressAnswer(dumb, address), "2\n");
});
test("split prompt and CSI chunks yield exactly one answer, while a second prompt is rejected", () => {
  const output = readlinePrompt("xterm");
  for (let split = 1; split < output.length; split++) {
    const respond = createAddressPromptResponder(address), answers = [respond(output.slice(0, split)), respond(output)].filter(value => value !== undefined);
    assert.deepEqual(answers, ["2\n"], `SSH output split at ${split}`);
  }
  const trailing = /\x1b\[[0-9;]+G$/.exec(output);
  assert.ok(trailing);
  const prefix = output.slice(0, trailing.index), respond = createAddressPromptResponder(address);
  assert.equal(respond(prefix), "2\n");
  for (let length = 1; length <= trailing[0].length; length++) assert.equal(respond(prefix + trailing[0].slice(0, length)), undefined);
  assert.equal(respond(output + "\x1b[1G\x1b[0J"), undefined);
  assert.throws(() => respond(output + "\r\nEnter another number.\r\nChoose address number [1, recommended]: \x1b[41G"), /repeated its address prompt/);
});
test("terminal controls do not allow an ambiguous or absent declared fixture address", () => {
  const duplicate = `1) ${address}\r\n2) ${address}\r\n\x1b[1G\x1b[0JChoose address number: \x1b[24G`;
  assert.throws(() => addressAnswer(duplicate, address), /unambiguous/);
  assert.throws(() => createAddressPromptResponder(address)(duplicate), /unambiguous/);
  assert.throws(() => addressAnswer(readlinePrompt("xterm"), "192.168.55.9"), /unambiguous/);
});
