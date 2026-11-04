import assert from "node:assert/strict";
import test from "node:test";
import { readPcGpuDevices } from "../src/backend/pc-gpu-devices.ts";
import { createGpuRuntimeBindingReader, gpuAllocationCommand } from "../src/backend/gpu-runtime-binding.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { SshRun } from "../src/backend/ssh.ts";
import { pcGpuView } from "../src/fleet/pc-gpu-devices.ts";

const base = 1_800_000_000_000, pcId = "a".repeat(64), bootId = "b".repeat(32), fingerprint = "SHA256:" + "A".repeat(43);
const id = (n: number) => n.toString(16).padStart(64, "0");
const addresses = ["1".repeat(31) + "2", "1".repeat(31) + "3", "1".repeat(31) + "4"];
const gpuA = "GPU-11111111-1111-1111-1111-111111111111", gpuB = "GPU-22222222-2222-2222-2222-222222222222";
interface Node { id: string; address: string; image?: string; unreadable?: boolean }
interface Wrapper { id: string; nodes: Node[]; uuid: string | null; image?: string }
function association(wrapper: number, node: number, address = addresses[0]!): PcAssociation {
  return { address, binding: { pcId, runtime: "podman", wrapperId: id(wrapper), nodeContainerId: id(node) },
    name: "Generated PC", sshFingerprint: fingerprint, verifiedAtMs: base - 1000, privateIp: "10.0.0.2", gpuUuids: [] };
}
function fixture(wrappers: Wrapper[]) {
  const commands: string[] = [];
  // The command expectations below specify the measured nested architecture:
  // Docker wrapper owns GPU utility; the inner official Nosana node exposes
  // only its public HTTP identity. Auxiliary frpc/job containers are not nodes.
  const run: SshRun = async (command, options) => {
    commands.push(command); assert.ok(options?.maximum && options.timeoutMs && options.timeoutMs <= 5000);
    if (command === "/bin/cat /proc/sys/kernel/random/boot_id") return { code: 0, stdout: bootId };
    if (command === "/usr/bin/nvidia-smi --query-gpu=index,uuid,pci.bus_id --format=csv,noheader,nounits")
      return { code: 0, stdout: `0, ${gpuB}, 00000000:01:00.0\n1, ${gpuA}, 00000000:04:00.0\n`, stderrPresent: wrappers.some(wrapper => !wrapper.uuid) };
    if (command === "/usr/bin/docker ps --no-trunc --format '{{.ID}}\t{{.Image}}'")
      return { code: 0, stdout: wrappers.map(wrapper => `${wrapper.id}\t${wrapper.image ?? "nosana/podman:v1.1.2"}`).join("\n") };
    if (command === "/usr/bin/test -x /usr/bin/podman") return { code: 1, stdout: "" };
    if (command.startsWith("/usr/bin/journalctl ")) {
      if (command.includes("--lines=1 ")) return { code: 0, stdout: JSON.stringify({ _BOOT_ID: bootId, _TRANSPORT: "kernel" }) };
      return { code: 0, stdout: JSON.stringify({ _BOOT_ID: bootId, _TRANSPORT: "kernel", __REALTIME_TIMESTAMP: String((base - 1000) * 1000),
        __MONOTONIC_TIMESTAMP: "1000000", MESSAGE: "NVRM: Xid (PCI:0000:06:00): 79, GPU has fallen off the bus." }) };
    }
    const inspect = / inspect --format '\{\{\.Id\}\}\t\{\{\.State.Running\}\}\t\{\{\.Config.Image\}\}' ([a-f0-9]{64})$/.exec(command);
    if (inspect) {
      const target = inspect[1]!, wrapper = wrappers.find(row => row.id === target);
      if (wrapper && command.startsWith("/usr/bin/docker inspect ")) return { code: 0, stdout: `${target}\ttrue\t${wrapper.image ?? "nosana/podman:v1.1.2"}` };
      const owner = wrappers.find(row => command.includes(row.id) && row.nodes.some(node => node.id === target)), node = owner?.nodes.find(row => row.id === target);
      return node ? { code: 0, stdout: `${target}\ttrue\t${node.image ?? "docker.io/nosana/nosana-node:latest"}` } : { code: 1, stdout: "", stderrPresent: true };
    }
    if (command.endsWith("/usr/bin/podman ps --no-trunc --format '{{.ID}}\t{{.Image}}'")) {
      const wrapper = wrappers.find(row => command.includes(row.id)); assert.ok(wrapper);
      return { code: 0, stdout: [...wrapper.nodes.map(node => `${node.id}\t${node.image ?? "docker.io/nosana/nosana-node:latest"}`),
        `${id(999)}\tregistry.hub.docker.com/nosana/frpc:v1.0.45`, `${id(998)}\tnosana/job-runtime:v0.2.7`].join("\n") };
    }
    const identity = / ([a-f0-9]{64}) \/usr\/bin\/env -i \/usr\/local\/bin\/node -e /.exec(command);
    if (identity) {
      assert.ok(command.includes('path: "/"'), "the fixed identity reader uses the public HTTP endpoint");
      assert.ok(!command.includes("readFile"), "the identity reader does not access wallet files");
      const node = wrappers.flatMap(wrapper => wrapper.nodes).find(row => row.id === identity[1]); assert.ok(node);
      return node.unreadable ? { code: 1, stdout: "" } : { code: 0, stdout: node.address };
    }
    for (const wrapper of wrappers) {
      if (command === `/usr/bin/docker exec ${wrapper.id} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`)
        return wrapper.uuid ? { code: 0, stdout: wrapper.uuid } : { code: 6, stdout: "No devices were found", stderrPresent: true };
      if (command.includes("/usr/bin/podman exec") && command.includes("nvidia-smi")) return { code: 127, stdout: "", stderrPresent: true };
    }
    assert.fail(`Unexpected command in independent nested runtime fixture: ${command}`);
  };
  return { run, commands };
}
function view(gpu: Awaited<ReturnType<typeof readPcGpuDevices>>, anchor: PcAssociation) {
  return pcGpuView({ pcId, sshFingerprint: fingerprint, approvalAtMs: base - 1000, receivedAtMs: base, gpu }, anchor, base);
}

test("nested Nosana node without NVIDIA utility reads its unique wrapper and maps by host UUID", async () => {
  const anchor = association(1, 11), f = fixture([{ id: id(1), nodes: [{ id: id(11), address: anchor.address }], uuid: gpuA }]);
  const output = await readPcGpuDevices(f.run, f.run, [anchor], () => base);
  assert.equal(output.allocations[0]?.status, "ok"); assert.deepEqual(output.allocations[0]?.gpuUuids, [gpuA]);
  assert.deepEqual(output.allocations[0]?.binding, anchor.binding); assert.deepEqual(output.allocations[0]?.observedBinding, anchor.binding);
  assert.deepEqual(view(output, anchor).indices, [1]);
  assert.ok(f.commands.includes(`/usr/bin/docker exec ${id(1)} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`));
  assert.ok(!f.commands.some(command => command.includes("/usr/bin/podman exec") && command.includes("nvidia-smi")));
  assert.ok(!f.commands.some(command => command === "/usr/bin/docker ps --no-trunc --format '{{.ID}}\t{{.Image}}'"), "valid approved runtime needs no host rediscovery");
});

test("stale approved wrapper uniquely rediscovered on the same PC preserves the approved financial/source binding", async () => {
  const anchor = association(1, 11), before = JSON.stringify(anchor), f = fixture([{ id: id(2), nodes: [{ id: id(22), address: anchor.address }], uuid: gpuB }]);
  Object.freeze(anchor.binding); Object.freeze(anchor.gpuUuids); Object.freeze(anchor);
  const output = await readPcGpuDevices(f.run, f.run, [anchor], () => base);
  assert.equal(output.allocations[0]?.status, "ok"); assert.deepEqual(view(output, anchor).indices, [0]);
  assert.deepEqual(output.allocations[0]?.binding, anchor.binding);
  assert.deepEqual(output.allocations[0]?.observedBinding, { pcId, runtime: "podman", wrapperId: id(2), nodeContainerId: id(22) });
  assert.equal(JSON.stringify(anchor), before, "the binding shared by permission/financial sources is unchanged");
  assert.equal(f.commands.filter(command => command === "/usr/bin/docker ps --no-trunc --format '{{.ID}}\t{{.Image}}'").length, 1);
  assert.ok(!f.commands.some(command => /\b(create|start|restart|run|pull|update|rm|wallet|signer|guardian|readFile)\b/.test(command)), "GPU-only rediscovery neither mutates runtimes nor loads wallet helpers");
});

test("one bounded rediscovery serves several stale approved addresses and excludes other public identities from results", async () => {
  const anchors = [association(1, 11), association(2, 22, addresses[1]!)];
  const unapproved = "2".repeat(32), f = fixture([
    { id: id(3), nodes: [{ id: id(33), address: anchors[0]!.address }], uuid: gpuA },
    { id: id(4), nodes: [{ id: id(44), address: anchors[1]!.address }], uuid: gpuB },
    { id: id(5), nodes: [{ id: id(55), address: unapproved }], uuid: gpuA },
  ]);
  const output = await readPcGpuDevices(f.run, f.run, anchors, () => base);
  assert.deepEqual(output.allocations.map(row => row.status), ["ok", "ok"]);
  assert.equal(f.commands.filter(command => command === "/usr/bin/docker ps --no-trunc --format '{{.ID}}\t{{.Image}}'").length, 1);
  assert.ok(!JSON.stringify(output).includes(unapproved));
  assert.ok(!f.commands.includes(`/usr/bin/docker exec ${id(5)} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`));
});

test("duplicate public identity and multiple orchestrators never borrow a wrapper GPU allocation", async () => {
  for (const topology of [
    [{ id: id(2), nodes: [{ id: id(22), address: addresses[0]! }], uuid: gpuA }, { id: id(3), nodes: [{ id: id(33), address: addresses[0]! }], uuid: gpuB }],
    [{ id: id(2), nodes: [{ id: id(22), address: addresses[0]! }, { id: id(33), address: addresses[1]! }], uuid: gpuA }],
    [{ id: id(1), nodes: [{ id: id(11), address: addresses[0]! }, { id: id(33), address: addresses[1]! }], uuid: gpuA }],
  ]) {
    const f = fixture(topology), output = await readPcGpuDevices(f.run, f.run, [association(1, 11)], () => base);
    assert.equal(output.allocations[0]?.status, "unavailable"); assert.equal(output.allocations[0]?.observedBinding, undefined);
    assert.ok(!f.commands.some(command => command.endsWith("/usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader")));
  }
});

test("contrary public identity, unapproved image and unreadable still-running nodes do not trigger replacement", async () => {
  for (const bad of [
    { id: id(1), nodes: [{ id: id(11), address: addresses[1]! }], uuid: gpuA },
    { id: id(1), image: "example.invalid/other:latest", nodes: [{ id: id(11), address: addresses[0]! }], uuid: gpuA },
    { id: id(1), nodes: [{ id: id(11), address: addresses[0]!, unreadable: true }], uuid: gpuA },
  ]) {
    const f = fixture([bad, { id: id(2), nodes: [{ id: id(22), address: addresses[0]! }], uuid: gpuB }]);
    const output = await readPcGpuDevices(f.run, f.run, [association(1, 11)], () => base);
    assert.equal(output.allocations[0]?.status, "unavailable"); assert.equal(output.allocations[0]?.observedBinding, undefined);
    assert.ok(!f.commands.includes(`/usr/bin/docker exec ${id(2)} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`));
  }
});

test("two healthy wrapper GPUs remain mapped while the third device is inaccessible and keeps its exact Xid evidence", async () => {
  const anchors = [association(1, 11), association(2, 22, addresses[1]!), association(3, 33, addresses[2]!)];
  const f = fixture([
    { id: id(1), nodes: [{ id: id(11), address: addresses[0]! }], uuid: gpuA },
    { id: id(2), nodes: [{ id: id(22), address: addresses[1]! }], uuid: null },
    { id: id(3), nodes: [{ id: id(33), address: addresses[2]! }], uuid: gpuB },
  ]);
  const output = await readPcGpuDevices(f.run, f.run, anchors, () => base);
  assert.equal(output.status, "partial"); assert.deepEqual(output.allocations.map(row => row.status), ["ok", "unavailable", "ok"]);
  assert.deepEqual(view(output, anchors[0]!).indices, [1]); assert.deepEqual(view(output, anchors[2]!).indices, [0]);
  assert.deepEqual(view(output, anchors[1]!).indices, []); assert.deepEqual(output.allocations[1]?.gpuUuids, []);
  assert.deepEqual(output.allocations[1]?.observedBinding, anchors[1]!.binding, "verified runtime is separate from failed GPU measurement");
  assert.equal(output.journal.events[0]?.xid, 79); assert.equal(output.journal.events[0]?.gpuUuid, null);
  assert.ok(!JSON.stringify(output).includes('"index":2'), "numeric selector is never a substitute for measured UUID identity");
});

test("direct runtime commands stay direct and malformed or cross-PC bindings cannot enter rediscovery", async () => {
  assert.equal(gpuAllocationCommand({ pcId, runtime: "docker", wrapperId: null, nodeContainerId: id(11) }), `/usr/bin/docker exec ${id(11)} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`);
  assert.equal(gpuAllocationCommand({ pcId, runtime: "podman", wrapperId: null, nodeContainerId: id(11) }), `/usr/bin/podman exec ${id(11)} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`);
  const reader = createGpuRuntimeBindingReader(async () => assert.fail("No cross-PC SSH command is allowed"), pcId);
  assert.equal(await reader.resolve({ ...association(1, 11), binding: { ...association(1, 11).binding, pcId: "c".repeat(64) } }), null);
  assert.throws(() => gpuAllocationCommand({ pcId, runtime: "podman", wrapperId: "bad;command", nodeContainerId: id(11) }));
});
