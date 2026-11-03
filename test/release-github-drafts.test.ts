import test from "node:test";
import assert from "node:assert/strict";
import { createGitHub } from "../scripts/release/github.ts";
import { REPOSITORY } from "../scripts/release/model.ts";
import type { CommandResult, CommandRunner } from "../scripts/release/commands.ts";

const tag = "modern-v0.1.0-dev.22", base = `repos/${REPOSITORY}`;
const release = (id: number, selectedTag = tag, draft = true) => ({ id, tag_name: selectedTag, target_commitish: "a".repeat(40), draft, prerelease: true, body: "Generated release notes" });
const okay = (value: unknown): CommandResult => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
const notFound = (): CommandResult => ({ stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)", exitCode: 1 });
function stub(respond: (path: string) => CommandResult | Promise<CommandResult>) {
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    assert.equal(command, "gh"); assert.equal(args[0], "api"); assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
    assert.equal(options?.env?.GH_HOST, "github.com");
    const method = args.indexOf("--method"); if (method >= 0) assert.equal(args[method + 1], "GET", "draft lookup must never mutate GitHub");
    const path = args.find(item => item.startsWith("repos/")); assert.ok(path); calls.push(path); return respond(path);
  };
  return { github: createGitHub("/generated-unused-release-directory", runner), calls };
}
test("tag 404 reconciles an exact authenticated draft on a later release page and reads its own assets", async () => {
  const selected = release(900), asset = { id: 901, name: "modern-release.json", size: 10, digest: `sha256:${"b".repeat(64)}`, state: "uploaded" };
  const f = stub(path => {
    if (path === `${base}/releases/tags/${tag}`) return notFound();
    if (path === base) return okay({ permissions: { push: true } });
    if (path === `${base}/releases?per_page=100&page=1`) return okay(Array.from({ length: 100 }, (_, index) => release(index + 1, `generated-${index}`, false)));
    if (path === `${base}/releases?per_page=100&page=2`) return okay([release(800, `${tag}-different`), selected]);
    assert.equal(path, `${base}/releases/900/assets?per_page=100&page=1`); return okay([asset]);
  });
  assert.deepEqual(await f.github.release(tag), { ...selected, assets: [asset] });
  assert.equal(f.calls.length, 5);
});
test("published tag lookup remains direct and validates exact tag identity", async () => {
  const selected = release(900, tag, false);
  const f = stub(path => {
    if (path === `${base}/releases/tags/${tag}`) return okay(selected);
    assert.equal(path, `${base}/releases/900/assets?per_page=100&page=1`); return okay([]);
  });
  assert.deepEqual(await f.github.release(tag), { ...selected, assets: [] }); assert.equal(f.calls.length, 2);
  const wrong = stub(() => okay(release(900, "another-tag", false)));
  await assert.rejects(wrong.github.release(tag), /release identity/); assert.equal(wrong.calls.length, 1);
});
test("duplicate same-tag drafts and repeated pagination IDs fail instead of choosing a release", async () => {
  for (const rows of [[release(900), release(901)], [release(900), release(900)], [release(900), release(901, tag, false)]]) {
    const f = stub(path => path.includes("/releases/tags/") ? notFound() : path === base ? okay({ permissions: { push: true } }) : okay(rows));
    await assert.rejects(f.github.release(tag), /Multiple GitHub releases|repeated an identity/);
    assert.equal(f.calls.some(path => path.includes("/assets?")), false);
  }
});
test("only a completed authenticated writer listing can establish release absence", async () => {
  const absent = stub(path => path.includes("/releases/tags/") ? notFound() : path === base ? okay({ permissions: { push: true } }) : okay([release(12, "other")]));
  assert.equal(await absent.github.release(tag), undefined);
  for (const permissions of [undefined, { push: false }]) {
    const denied = stub(path => path.includes("/releases/tags/") ? notFound() : okay({ permissions }));
    await assert.rejects(denied.github.release(tag), /visibility.*no absence/);
    assert.equal(denied.calls.some(path => path.includes("?per_page=")), false);
  }
});
test("tag and listing failures or malformed successful bodies are never absence", async () => {
  for (const failed of [403, 429, 500]) {
    const denied = stub(() => ({ stdout: "{}", stderr: `gh: Generated failure (HTTP ${failed})`, exitCode: 1 }));
    await assert.rejects(denied.github.release(tag), /no absence/); assert.equal(denied.calls.length, 1);
    const listFailure = stub(path => path.includes("/releases/tags/") ? notFound() : path === base ? okay({ permissions: { push: true } })
      : { stdout: "{}", stderr: `gh: Generated failure (HTTP ${failed})`, exitCode: 1 });
    await assert.rejects(listFailure.github.release(tag)); assert.equal(listFailure.calls.length, 3);
  }
  for (const malformed of [null, {}, [null], [{ id: 1, tag_name: tag }]]) {
    const f = stub(path => path.includes("/releases/tags/") ? notFound() : path === base ? okay({ permissions: { push: true } }) : okay(malformed));
    await assert.rejects(f.github.release(tag), /Invalid GitHub release page|Unexpected GitHub release identity/);
  }
  const tagNull = stub(() => okay(null)); await assert.rejects(tagNull.github.release(tag), /release identity/); assert.equal(tagNull.calls.length, 1);
});
test("draft lookup is bounded and does not return an early match from an incomplete listing", async () => {
  const f = stub(path => {
    if (path.includes("/releases/tags/")) return notFound();
    if (path === base) return okay({ permissions: { push: true } });
    const page = Number(new URL(`https://api.github.com/${path}`).searchParams.get("page"));
    return okay(Array.from({ length: 100 }, (_, index) => release(page * 100 + index, page === 1 && index === 0 ? tag : `other-${page}-${index}`)));
  });
  await assert.rejects(f.github.release(tag), /exceeded its bound.*no absence/);
  assert.equal(f.calls.filter(path => path.includes("/releases?per_page=")).length, 10);
});
