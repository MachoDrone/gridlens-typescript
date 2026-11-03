/** Documentation wording does not change executable behavior. Changed commands,
 * fenced examples and normative sections still require executable verification.
 * This deliberately errs toward more coverage when prose states a requirement. */
function normalizedLinks(text: string): string {
  return text.replace(/(\[[^\]]*\])\([^)]*\)/g, "$1()");
}
function linePolicy(text: string): boolean[] {
  const headings: { level: number; policy: boolean }[] = [];
  let fence = "";
  return text.split("\n").map(line => {
    const boundary = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const fenced = !!fence || !!boundary;
    if (boundary) fence = fence ? "" : boundary[1]![0]!;
    if (!fence && !boundary) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1]!.length;
        while (headings.at(-1) && headings.at(-1)!.level >= level) headings.pop();
        headings.push({ level, policy: /\b(?:requirements?|polic(?:y|ies)|safety|security|boundaries|non-negotiable|invariants?|authorization|permissions?|verification gates)\b/i.test(heading[2]!) });
      }
    }
    return fenced || headings.some(heading => heading.policy)
      || /(?:^|[\s`])(?:npm|npx|node|bash|curl|docker|git|python3?|ssh)\s+\S/.test(line)
      || /\b(?:must|never|shall|always|cannot|required|prohibited|do not|exactly)\b/i.test(line)
      || /\d[\d.]*\s*(?:NOS|SOL|lamports|base.units|requests?\/(?:min|sec)|seconds?|minutes?)\b/.test(line);
  });
}
export function documentationPolicyChanged(before: string, after: string, patch: string, addedOrRemoved = false): boolean {
  if (normalizedLinks(before) === normalizedLinks(after)) return false;
  const oldPolicy = linePolicy(before), newPolicy = linePolicy(after);
  if (addedOrRemoved) return [...oldPolicy, ...newPolicy].some(Boolean);
  let oldLine = 0, newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]) - 1; newLine = Number(hunk[2]) - 1; continue; }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) { if (oldPolicy[oldLine]) return true; oldLine++; }
    else if (line.startsWith("+")) { if (newPolicy[newLine]) return true; newLine++; }
    else if (line.startsWith(" ")) { oldLine++; newLine++; }
  }
  return false;
}
