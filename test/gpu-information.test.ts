import assert from "node:assert/strict";
import test from "node:test";
import { GPU_FRESH_MS, pcGpuView } from "../src/fleet/pc-gpu-devices.ts";
import type { PcGpuDevice, PcGpuEvent, PcGpuObservation, PcGpuRecord } from "../src/fleet/pc-gpu-devices.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import { gpuInformation, pcGpuInformation } from "../src/preview/gpu-information.ts";
import { infoText } from "../src/preview/info-content.ts";
import type { InfoContent } from "../src/preview/info-content.ts";

const at = Date.UTC(2026, 10, 4, 15, 20, 30), pcId = "a".repeat(64), bootId = "b".repeat(32);
const uuids = ["GPU-11111111-1111-1111-1111-111111111111", "GPU-22222222-2222-2222-2222-222222222222"];
const association: PcAssociation = {
  address: "1".repeat(31) + "2", name: "nn01", sshFingerprint: "SHA256:" + "A".repeat(43),
  binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: "c".repeat(64) },
  verifiedAtMs: at - 1000, privateIp: "10.0.0.2", gpuUuids: [uuids[0]!],
};
const device: PcGpuDevice = { uuid: uuids[0]!, index: 0, pciBusId: "0000:01:00.0", observedAtMs: at, status: "responds" };
const event: PcGpuEvent = { bootId, pciBusId: "0000:01:00", xid: 79, atMs: at - 60_000, gpuUuid: uuids[0]! };

function fixture(changes: Partial<PcGpuObservation> = {}, owner = association): PcGpuRecord {
  const gpu: PcGpuObservation = {
    schema: 1, source: "pc-nvidia-smi", observedAtMs: at, bootId, status: "ok", devices: [{ ...device }],
    allocations: [{ address: owner.address, binding: owner.binding, observedAtMs: at, status: "ok", gpuUuids: [...owner.gpuUuids] }],
    journal: { status: "ok", events: [] }, ...changes,
  };
  return { pcId, sshFingerprint: owner.sshFingerprint, approvalAtMs: at - 1000, receivedAtMs: at, gpu };
}

function visible(content: InfoContent): string {
  return [infoText(content.summary), ...(content.facts ?? []).map(infoText)].join("\n");
}

test("a measured physical GPU ID of zero is green and readable, without a health claim", () => {
  const result = gpuInformation(pcGpuView(fixture(), association, at), "nn01", at, "Original provenance.");
  assert.equal(result.tone, "positive");
  assert.equal(result.warning, false);
  assert.equal(result.label, "GPU ID 0 read successfully");
  assert.match(visible(result.content), /mapped to this host on nn01/);
  assert.ok(visible(result.content).includes(new Date(at).toLocaleString()));
  const checked = result.content.facts?.find(fact => infoText(fact).startsWith("Checked:"));
  assert.equal(typeof checked === "string" ? undefined : checked?.[0]?.tone, "muted");
  assert.doesNotMatch(visible(result.content), /\bhealthy\b/i);
  assert.equal(result.content.source, "Original provenance.");
});

test("multiple physical IDs remain exact and a partial mapping is amber", () => {
  const owner = { ...association, gpuUuids: uuids };
  const good = fixture({ devices: [device, { ...device, uuid: uuids[1]!, index: 4, pciBusId: "0000:04:00.0" }] }, owner);
  const complete = gpuInformation(pcGpuView(good, owner, at), "nn01", at, "");
  assert.equal(complete.label, "GPU IDs 0, 4 read successfully");
  good.gpu.devices.pop(); good.gpu.status = "partial";
  const partial = gpuInformation(pcGpuView(good, owner, at), "nn01", at, "");
  assert.equal(partial.tone, "warning");
  assert.equal(partial.warning, true);
  assert.equal(partial.label, "Only some GPU IDs could be read");
  assert.match(visible(partial.content), /GPU ID 0 read successfully/);
  assert.doesNotMatch(visible(partial.content), /GPU ID 4/);
});

test("only a recent explicit inaccessible-device result is red", () => {
  const record = fixture({ status: "partial", devices: [{ ...device, index: null, pciBusId: null, status: "inaccessible" }] });
  const recent = gpuInformation(pcGpuView(record, association, at), "nn01", at, "");
  assert.equal(recent.label, "GPU cannot be accessed");
  assert.equal(recent.tone, "negative");
  assert.equal(recent.warning, true);
  assert.doesNotMatch(visible(recent.content), /fell off the bus|GPU ID 0|restart|reset|reboot/i);
  const expiredAt = at + GPU_FRESH_MS;
  const expired = gpuInformation(pcGpuView(record, association, expiredAt), "nn01", expiredAt, "");
  assert.equal(expired.tone, "warning");
  assert.equal(expired.label, "GPU ID reading is out of date");
});

test("failed GPU reads and unconfirmed host assignments have amber explanations", () => {
  const query = fixture({ status: "query-failed", devices: [{ ...device, index: null, pciBusId: null, status: "query-failed" }] });
  const failed = gpuInformation(pcGpuView(query, association, at), "nn01", at, "");
  assert.equal(failed.label, "GPU ID could not be read");
  assert.equal(failed.tone, "warning");
  assert.equal(failed.warning, true);
  const unmapped = fixture({ status: "partial", allocations: [] });
  const unknown = gpuInformation(pcGpuView(unmapped, association, at), "nn01", at, "");
  assert.equal(unknown.label, "GPU ID unavailable");
  assert.equal(unknown.tone, "warning");
  assert.doesNotMatch(visible(unknown.content), /GPU ID 0/);
});

test("transport failure never presents an old device failure as current", () => {
  for (const status of ["responds", "inaccessible"] as const) {
    const row = fixture({ status: status === "responds" ? "ok" : "partial", devices: [{ ...device, status,
      index: status === "responds" ? 0 : null, pciBusId: status === "responds" ? device.pciBusId : null }] });
    const view = { ...pcGpuView(row, association, at, true), transportFailed: true };
    const result = gpuInformation(view, "nn01", at, "");
    assert.equal(result.label, "GPU data is unavailable");
    assert.equal(result.tone, "warning");
  }
});

test("stale IDs retain their dated evidence without presenting them as current", () => {
  const now = at + GPU_FRESH_MS;
  const result = gpuInformation(pcGpuView(fixture(), association, now), "nn01", now, "");
  assert.equal(result.tone, "warning");
  assert.equal(result.warning, true);
  assert.match(visible(result.content), /Last read GPU ID 0/);
  assert.match(visible(result.content), /not confirmed current/);
  assert.ok(visible(result.content).includes(new Date(at).toLocaleString()));
});

test("partial readings preserve the earlier dates of retained GPU IDs", () => {
  const oldAt = at - 120_000, owner = { ...association, verifiedAtMs: oldAt - 1000, gpuUuids: uuids };
  const older = fixture({ observedAtMs: oldAt, devices: [
    { ...device, observedAtMs: oldAt }, { ...device, uuid: uuids[1]!, index: 4, pciBusId: "0000:04:00.0", observedAtMs: oldAt },
  ], allocations: [{ address: owner.address, binding: owner.binding, observedAtMs: oldAt, status: "ok", gpuUuids: [...uuids] }] }, owner).gpu;
  const record = { ...fixture({ status: "partial", devices: [device] }, owner), approvalAtMs: oldAt - 1000, lastGood: older };
  const result = gpuInformation(pcGpuView(record, owner, at), "nn01", at, "");
  assert.equal(result.tone, "warning");
  const retained = result.content.facts?.map(infoText).find(fact => fact.startsWith("Last read"));
  assert.ok(retained?.includes(`GPU ID 4 — ${new Date(oldAt).toLocaleString()}`));
  assert.ok(!retained?.includes(new Date(at).toLocaleString()));
});

test("a first reading stays muted and does not acquire a warning from missing data", () => {
  for (const view of [undefined, pcGpuView(undefined, association, at)]) {
    const result = gpuInformation(view, "nn01", at, "");
    assert.equal(result.tone, "muted");
    assert.equal(result.warning, false);
    assert.equal(result.label, "GPU ID is waiting for its first reading");
    assert.doesNotMatch(visible(result.content), /GPU ID 0|cannot be accessed/);
  }
});

test("historical GPU events stay in source details and never cause a row warning", () => {
  const record = fixture({ journal: { status: "ok", events: [event, { ...event, xid: 154 }, { ...event, xid: 31 }] } });
  const result = gpuInformation(pcGpuView(record, association, at), "nn01", at, "Raw event evidence.");
  assert.equal(result.tone, "positive");
  assert.equal(result.warning, false);
  assert.doesNotMatch(visible(result.content), /fell off the bus|Driver recovery event|Xid/);
  assert.match(result.content.source!, /GPU fell off the bus on nn01/);
  assert.match(result.content.source!, /Driver recovery event on nn01/);
  assert.match(result.content.source!, /Driver event \(Xid 31\) on nn01/);
  assert.ok(result.content.source!.includes(new Date(event.atMs).toLocaleString()));
  assert.ok(result.content.source!.endsWith("Raw event evidence."));
});

test("unassigned PC events cannot become a warning or an invented ID on a host row", () => {
  const record = fixture({ journal: { status: "ok", events: [{ ...event, gpuUuid: null }] } });
  const result = gpuInformation(pcGpuView(record, association, at), "nn01", at, "");
  assert.equal(result.label, "GPU ID 0 read successfully");
  assert.equal(result.warning, false);
  assert.doesNotMatch(visible(result.content), /fell off the bus|Xid|PC-level GPU/);
  const content = pcGpuInformation([{ pcName: "nn01", events: record.gpu.journal.events }]);
  assert.match(infoText(content.summary), /PC-level GPU warning for nn01/);
  assert.match(visible(content), /A GPU on nn01 fell off the bus — recorded/);
  assert.match(visible(content), /not assigned to a host row/);
  assert.ok(visible(content).includes(new Date(event.atMs).toLocaleString()));
  assert.doesNotMatch(visible(content), /GPU ID [01]|GPU [01]/);
  assert.equal(typeof content.summary === "string" ? undefined : content.summary[0]?.tone, "warning");
  const fact = content.facts?.[0];
  assert.deepEqual(typeof fact === "string" ? undefined : fact?.map(part => part.tone), ["warning", "muted"]);
  assert.equal(typeof fact === "string" ? undefined : fact?.[1]?.text, ` — recorded ${new Date(event.atMs).toLocaleString()}.`);
});

test("PC details retain every event and PC beyond the four visible facts", () => {
  const groups = Array.from({ length: 6 }, (_, index) => ({ pcName: `nn0${index + 1}`, events: [{ ...event, gpuUuid: null, atMs: event.atMs + index }] }));
  const content = pcGpuInformation(groups, "Raw PC evidence.");
  assert.match(infoText(content.summary), /6 PCs/);
  assert.equal(content.facts?.length, 4);
  for (const group of groups) {
    assert.ok(content.source!.includes(`A GPU on ${group.pcName} fell off the bus`));
    assert.ok(content.source!.includes(new Date(group.events[0]!.atMs).toLocaleString()));
  }
  assert.ok(content.source!.endsWith("Raw PC evidence."));
});

test("missing or invalid dates stay unknown without throwing or inventing an ID", () => {
  const view = { ...pcGpuView(fixture({ devices: [], status: "query-failed" }), association, at), attemptedAtMs: Number.NaN };
  const result = gpuInformation(view, "nn01", at, "");
  assert.match(visible(result.content), /unknown time/);
  assert.doesNotMatch(visible(result.content), /Invalid Date|GPU ID 0/);
  for (const atMs of [Number.NaN, Number.POSITIVE_INFINITY, 9_000_000_000_000_000]) {
    const content = pcGpuInformation([{ pcName: "nn01", events: [{ ...event, atMs, gpuUuid: null }] }]);
    assert.match(visible(content), /recorded unknown time/);
  }
});
