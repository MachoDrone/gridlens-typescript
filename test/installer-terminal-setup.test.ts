import assert from "node:assert/strict";
import test from "node:test";
import { runTerminalSetup } from "../src/installer/setup-session.ts";
import type { TerminalPrompts } from "../src/installer/terminal.ts";

type Computer = { id: string; host: string; port: number; name: string; fingerprint: string };
type Phase = "scan" | "scanning" | "select" | "identities" | "credentials" | "review" | "inspecting" | "done";
type Scan = { range: string; port: number; total: number; completed: number; found: number; status: string };
const computers: Computer[] = ["a", "b", "c"].map((letter, index) => ({ id: letter.repeat(64),
  host: `192.168.42.${index + 10}`, port: 22, name: `Generated PC ${index + 1}`, fingerprint: `SHA256:${letter.toUpperCase().repeat(43)}` }));
const password = "generated-terminal-fixture-secret";

function harness({ phase = "scan", trusted = [], rounds = [computers.slice(0, 2)], savedHosts = 0 }: {
  phase?: Phase; trusted?: string[]; rounds?: (Computer[] | Error)[]; savedHosts?: number;
} = {}) {
  const view = { version: 1, scopeId: "default", revision: 7, phase,
    computers: phase === "scan" ? [] as Computer[] : computers.slice(0, 2),
    selected: ["identities", "credentials", "review", "inspecting", "done"].includes(phase) ? computers.slice(0, 2).map(row => row.id) : [] as string[],
    trusted: [...trusted], savedHosts, inspectedPcs: savedHosts ? 2 : 0, exclusions: [] as string[],
    automaticIp: true, fullMonitoring: false, monitoringStatus: "Not configured", terminalConnected: false,
    network: { backendName: "fixture-backend", backendAddress: "192.168.42.2", suggestedRange: "192.168.42.0/24", verifiedAtMs: 1_800_000_000_000 },
    scan: undefined as Scan | undefined };
  const calls: Record<string, unknown>[] = [], transitions: string[] = [];
  let round = 0, controlCount = 0, identityConfirmed = trusted.length > 0;
  const snapshot = () => structuredClone(view);
  function action(body: Record<string, unknown>) {
    assert.equal(body.revision, view.revision, "Terminal actions must use the current setup revision");
    if (body.action === "scan") {
      assert.ok(["scan", "select", "done"].includes(view.phase));
      assert.equal(body.range, "192.168.42.0/24"); assert.equal(body.port, 22);
      view.phase = "scanning"; view.scan = { range: String(body.range), port: Number(body.port), total: 256, completed: 0, found: 0, status: "running" };
      transitions.push("search");
    } else if (body.action === "select") {
      assert.equal(view.phase, "select");
      assert.ok(Array.isArray(body.selected) && body.selected.length > 0);
      assert.equal(new Set(body.selected).size, body.selected.length);
      assert.ok(body.selected.every(id => view.computers.some(row => row.id === id)), "Unrecognized numbers must never become selected identities");
      view.selected = [...body.selected] as string[];
      view.phase = view.selected.every(id => view.trusted.includes(id)) ? "credentials" : "identities";
      transitions.push("selection");
    } else if (body.action === "trust") {
      assert.equal(view.phase, "identities"); assert.ok(identityConfirmed, "New identities require an affirmative terminal answer");
      view.trusted = [...new Set([...view.trusted, ...view.selected])]; view.phase = "credentials";
      transitions.push("identity-review");
    } else if (body.action === "inspect") {
      assert.equal(view.phase, "review"); assert.equal(typeof body.automaticIp, "boolean"); assert.equal(typeof body.fullMonitoring, "boolean");
      view.automaticIp = body.automaticIp as boolean; view.fullMonitoring = body.fullMonitoring as boolean;
      view.phase = "inspecting"; transitions.push("monitoring-choice");
    } else if (body.action === "cancel-scan") {
      assert.equal(view.phase, "scanning"); view.phase = "scan";
      view.scan = { ...view.scan!, status: "cancelled" }; transitions.push("cancel");
    } else assert.fail(`Unexpected terminal action ${String(body.action)}`);
    view.revision++; return snapshot();
  }
  const control = (body: Record<string, unknown>) => {
    assert.ok(++controlCount < 150, "Setup must not spin indefinitely without an operator decision");
    calls.push(structuredClone(body)); assert.equal(body.scopeId, "default");
    if (body.operation === "setup-status") return snapshot();
    if (body.operation === "setup-terminal") { view.terminalConnected = body.connected !== false; return snapshot(); }
    if (body.operation === "setup-action") return action(body);
    if (body.operation === "setup-auth") {
      assert.equal(view.phase, "credentials"); assert.equal(body.revision, view.revision);
      assert.equal(body.username, "fixture"); assert.equal(body.password, password); assert.equal(body.remember, true);
      view.phase = "review"; view.revision++; transitions.push("credentials"); return snapshot();
    }
    if (body.operation === "setup-inspect") {
      assert.equal(view.phase, "inspecting", "Inspection cannot run before the terminal monitoring decision");
      view.phase = "done"; view.savedHosts += view.selected.length * 2; view.inspectedPcs = view.selected.length;
      view.revision++; transitions.push("inspection"); return snapshot();
    }
    assert.fail(`Unexpected control operation ${String(body.operation)}`);
  };
  const pause = async () => {
    if (view.phase === "scanning") {
      const found = rounds[Math.min(round++, rounds.length - 1)] ?? [];
      if (found instanceof Error) {
        view.phase = "scan"; view.scan = { ...view.scan!, status: "failed" }; view.exclusions = ["The selected network could not be scanned."];
        view.revision++; return;
      }
      view.computers = structuredClone(found); view.selected = view.selected.filter(id => found.some(row => row.id === id));
      view.scan = { ...view.scan!, completed: 256, found: found.length, status: "complete" };
      view.phase = "select"; view.revision++;
    }
  };
  return { view, calls, transitions, control, pause, confirmIdentity() { identityConfirmed = true; } };
}

type Reply = { match: RegExp; answers: string[] };
function terminal(h: ReturnType<typeof harness>, overrides: Reply[] = []) {
  const prompts: string[] = [], output: string[] = []; let asks = 0;
  const answer = (prompt: string): string => {
    assert.ok(++asks < 50, "Repeated prompts must not become an endless loop"); prompts.push(prompt);
    const rule = overrides.find(rule => rule.match.test(prompt) && rule.answers.length);
    let result: string;
    if (rule) result = rule.answers.shift()!;
    else if (/network|SSH port/i.test(prompt)) result = "";
    else if (/Computer username|Sign in with|Use sudo|Remember encrypted/i.test(prompt)) result = "";
    else if (/new.*identit|trust.*identit|confirm.*identit|fingerprint/i.test(prompt)) result = "yes";
    else if (/rewards|GPU|full monitoring/i.test(prompt)) result = "";
    else if (/monitoring|automatic IP|inspection mode|inspect.*only/i.test(prompt)) result = "";
    else if (/selection complete|selected computers|continue with|confirm.*selection/i.test(prompt)) result = "yes";
    else if (/^Computers\b|select|choose.*computer|computer.*number/i.test(prompt)) result = "";
    else if (/^Saved fleet|^Result|add.*computer|keep.*fleet|search again|try again|retry/i.test(prompt)) result = "";
    else assert.fail(`Unexpected operator prompt: ${prompt}`);
    if (/new.*identit|trust.*identit|confirm.*identit|fingerprint/i.test(prompt) && /^(?:yes|y)$/i.test(result)) h.confirmIdentity();
    return result;
  };
  const value: TerminalPrompts = { async ask(prompt) { return answer(prompt); }, async secret(prompt) { prompts.push(prompt); return password; },
    print(value) { assert.ok(!value.includes(password), "Passwords must never appear in terminal summaries"); output.push(value); }, close() {} };
  return { value, output, prompts };
}

test("fresh setup completes every decision in the terminal without a browser driving state", async () => {
  const h = harness(), t = terminal(h);
  const result = await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
  assert.equal(result.completed, true);
  assert.equal(h.view.phase, "done"); assert.equal(h.view.savedHosts, 4);
  assert.deepEqual(h.transitions, ["search", "selection", "identity-review", "credentials", "monitoring-choice", "inspection"]);
  assert.equal(h.view.automaticIp, true); assert.equal(h.view.fullMonitoring, false);
  assert.ok(t.output.some(value => /hosts/i.test(value) && /\b4\b/.test(value)));
  assert.ok(t.output.every(value => !/in the browser|return to the browser|waiting for.*browser/i.test(value)));
  assert.ok(!h.view.terminalConnected, "The completed wizard releases its display-only terminal presence");
});

test("full rewards and GPU monitoring requires a separate affirmative answer", async () => {
  const h = harness({ phase: "review" }), t = terminal(h, [{ match: /rewards|GPU|full monitoring/i, answers: ["yes"] }]);
  await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
  assert.equal(h.view.phase, "done"); assert.equal(h.view.fullMonitoring, true);
  assert.equal(h.calls.filter(body => body.operation === "setup-inspect").length, 1);
});

test("invalid computer numbers are rejected before selected identities are committed", async () => {
  const h = harness({ phase: "select" }), t = terminal(h, [{ match: /^Computers\b/i, answers: ["999", "2"] }]);
  await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
  assert.deepEqual(h.view.selected, [computers[1]!.id]);
  assert.equal(h.calls.filter(body => body.operation === "setup-action" && body.action === "select").length, 1);
});

test("filtering the terminal list retains already selected computers", async () => {
  const h = harness({ phase: "select" }), t = terminal(h, [{ match: /^Computers\b/i, answers: ["1", "/42.11", "all", "done"] }]);
  await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
  assert.deepEqual([...h.view.selected].sort(), computers.slice(0, 2).map(row => row.id).sort());
  assert.equal(h.calls.filter(body => body.operation === "setup-action" && body.action === "select").length, 1);
});

test("inspect-only does not approve automatic IP or full monitoring", async () => {
  const h = harness({ phase: "review" }), t = terminal(h, [{ match: /^Monitoring\b/i, answers: ["2"] }]);
  await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
  assert.equal(h.view.phase, "done"); assert.equal(h.view.automaticIp, false); assert.equal(h.view.fullMonitoring, false);
});

test("resuming credentials and matching saved identities does not repeat discovery or trust review", async () => {
  for (const phase of ["select", "credentials"] as const) {
    const h = harness({ phase, trusted: computers.slice(0, 2).map(row => row.id) }), t = terminal(h);
    await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
    assert.equal(h.view.phase, "done");
    assert.ok(!h.transitions.includes("search")); assert.ok(!h.transitions.includes("identity-review"));
  }
});

test("empty and failed searches can be retried in the same terminal", async () => {
  for (const first of [[], new Error("Generated unavailable network")] as (Computer[] | Error)[]) {
    const h = harness({ rounds: [first, computers.slice(0, 1)] }), t = terminal(h, [{ match: /search again|try again|retry/i, answers: ["yes"] }]);
    await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
    assert.equal(h.view.phase, "done"); assert.equal(h.transitions.filter(value => value === "search").length, 2);
    assert.equal(h.view.savedHosts, 2);
  }
});

test("declining new SSH identities leaves access and inspection unapproved", async () => {
  const h = harness({ phase: "identities" }), t = terminal(h, [{ match: /new.*identit|trust.*identit|confirm.*identit|fingerprint/i, answers: [""] }]);
  const result = await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
  assert.equal(result.completed, false);
  assert.equal(h.view.phase, "identities"); assert.deepEqual(h.view.trusted, []);
  assert.ok(!h.calls.some(body => body.operation === "setup-auth" || body.operation === "setup-inspect"));
  assert.ok(!h.view.terminalConnected);
});

test("quitting computer selection preserves saved state without authenticating or inspecting", async () => {
  const h = harness({ phase: "select" }), t = terminal(h, [{ match: /^Computers\b/i, answers: ["q"] }]);
  const result = await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
  assert.equal(result.completed, false); assert.equal(h.view.phase, "select");
  assert.deepEqual(h.view.selected, []); assert.deepEqual(h.view.trusted, []);
  assert.ok(!h.calls.some(body => body.operation === "setup-auth" || body.operation === "setup-inspect"));
});

test("Ctrl+C during search cancels the current scan and restores signal listeners", async () => {
  const h = harness({ phase: "scanning", savedHosts: 8, trusted: [computers[0]!.id] }), t = terminal(h);
  h.view.scan = { range: "192.168.42.0/24", port: 22, total: 256, completed: 32, found: 1, status: "running" };
  const before = { revision: h.view.revision, computers: structuredClone(h.view.computers), trusted: [...h.view.trusted], listeners: process.listenerCount("SIGINT") };
  let interrupted = false;
  const result = await runTerminalSetup(t.value, h.control, { defaultUsername: "fixture", async pause() {
    assert.equal(interrupted, false, "One interrupt should finish cancellation without another polling cycle");
    assert.equal(process.listenerCount("SIGINT"), before.listeners + 1);
    interrupted = true; process.emit("SIGINT");
  } });
  assert.ok(interrupted); assert.equal(result.completed, false);
  const cancel = h.calls.filter(body => body.operation === "setup-action" && body.action === "cancel-scan");
  assert.equal(cancel.length, 1); assert.equal(cancel[0]!.revision, before.revision);
  assert.equal(h.view.scan.status, "cancelled"); assert.equal(h.view.savedHosts, 8);
  assert.deepEqual(h.view.computers, before.computers); assert.deepEqual(h.view.trusted, before.trusted);
  assert.ok(!h.calls.some(body => body.operation === "setup-auth" || body.operation === "setup-inspect"));
  assert.equal(process.listenerCount("SIGINT"), before.listeners); assert.equal(h.view.terminalConnected, false);
});

test("keeping an existing completed fleet does not rescan or request credentials", async () => {
  const h = harness({ phase: "done", savedHosts: 8 }), t = terminal(h);
  await runTerminalSetup(t.value, h.control, { pause: h.pause, defaultUsername: "fixture" });
  assert.equal(h.view.savedHosts, 8); assert.deepEqual(h.transitions, []);
  assert.ok(!h.calls.some(body => body.operation === "setup-auth" || body.operation === "setup-inspect"));
});
