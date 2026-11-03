import test from "node:test";
import assert from "node:assert/strict";
import { viewerDockerOptions } from "../scripts/test-viewer-docker.ts";
import { viewerFixtureNames } from "../scripts/release/fixture-viewer.ts";
import { invitationDirectory } from "../scripts/release/public-viewer.ts";
const args = ["--bundle", "/generated/bundle", "--public-key", "/generated/public.pem", "--address", "192.168.55.5", "--ssh-target", "generated@192.168.55.5",
  "--https-port", "25961", "--web-port", "25963", "--viewer-port", "25965", "--report", "/generated/report.json"];
test("viewer Docker acceptance requires three distinct nonproduction ports and an isolated instance", () => {
  assert.equal(viewerDockerOptions(args).viewerPort, 25965);
  assert.equal(viewerDockerOptions([...args, "--instance", "fixture-123456abcdef"]).instance, "fixture-123456abcdef");
  for (const [field, value] of [["--viewer-port", "25963"], ["--web-port", "8789"], ["--address", "10.999.1.1"], ["--ssh-target", "--command"]]) {
    const changed = [...args]; changed[changed.indexOf(field!) + 1] = value!; assert.throws(() => viewerDockerOptions(changed));
  }
  assert.throws(() => viewerDockerOptions([...args, "--instance", "default"]));
});
test("viewer cleanup and invitation files stay inside their declared unique fixture namespace", () => {
  const fixture = { instance: "fixture-view-123456abcdef", port: 25965 };
  assert.equal(viewerFixtureNames(fixture).container, "gridlens-viewer-fixture-view-123456abcdef-gateway");
  assert.equal(invitationDirectory(fixture, "/tmp/gridlens-fixture-view-123456abcdef-Ab12Cd"), "/tmp/gridlens-fixture-view-123456abcdef-Ab12Cd");
  assert.throws(() => viewerFixtureNames({ ...fixture, instance: "default" }));
  for (const path of ["/tmp", "/home/generated", "/tmp/gridlens-fixture-view-fedcba654321-Ab12Cd", "/tmp/gridlens-fixture-view-123456abcdef-Ab12Cd/../other"]) assert.throws(() => invitationDirectory(fixture, path));
});
