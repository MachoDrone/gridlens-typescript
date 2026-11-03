/** Reviewed scope rules. Unknown paths and changes to this policy select all
 * tests. These rules select coverage; they never weaken individual assertions. */
export type VerificationGroup = "financial" | "access" | "persistence" | "collection" | "fleet-ui" | "installer" | "handoff" | "stress";
export const VERIFICATION_GROUPS: readonly VerificationGroup[] = ["financial", "access", "persistence", "collection", "fleet-ui", "installer", "handoff", "stress"];
export type AcceptanceKind = "docker-shared" | "docker-updater" | "docker-claims-shutdown" | "docker-claim-units" | "public-installer";
export interface ScopeSelection {
  full: boolean; documentationOnly: boolean; groups: VerificationGroup[]; nodeTests: string[]; browserTests: string[];
  reasons: { path: string; groups: string[]; reason: string }[]; requiredAcceptances: AcceptanceKind[];
}
const broad = /^(?:package(?:-lock)?\.json|\.nvmrc|\.gitignore|tsconfig[^/]*\.json|playwright\.config\.ts|AGENTS\.md|docs\/(?:DEVELOPMENT|COMPONENT_RULES|SECURITY|REQUIREMENTS|WALLET_PILOT|MODERN_INSTALL|AUTOMATIC_UPDATES)\.md|scripts\/(?:verify(?:\.ts|ication[^/]*\.ts)|build[^/]*\.ts)|src\/(?:backend\/(?:service|ipc|gateway)\.ts|server\/application\.ts|contracts\/(?:fleet|shared)\.ts|preview\/(?:main\.ts|index\.html|styles\.css|viewport\.ts|sidebar\.ts|table-scroll\.ts|webapp\.ts))|scripts\/(?:shared-owner|shared-gateway)\.ts|test\/verification[^/]*\.test\.ts|test\/browser\/(?:helpers|viewport-input)\.ts|test\/fixtures\/start-browser-preview\.ts)$/;
const docs = /^(?:README\.md|LICENSE|docs\/.*\.(?:md|txt))$/;
const financial = /^(?:src\/(?:backend\/(?:treasury[^/]*|claim-receipt|rewards-(?:reader|claimer)|pc-rewards)\.ts|contracts\/treasury[^/]*\.ts|preview\/wallet\.(?:ts|html|css))|test\/(?:treasury[^/]*|rewards-claimer)\.test\.ts|test\/browser\/(?:wallet|rewards-claims)\.spec\.ts)$/;
const access = /^(?:src\/backend\/(?:access|browser-security|apple-certificate|credential-vault|setup|ssh)\.ts|src\/contracts\/browser-security\.ts|src\/preview\/(?:secure[^/]*|shared-setup)\.(?:ts|html)|test\/(?:apple-certificate|browser-security|secure[^/]*|shared-(?:access|browser[^/]*|discovery|private-network|setup|terminal-setup|vpn-access|gateway-access))\.test\.ts|test\/browser\/(?:secure[^/]*|shared-setup[^/]*|hosts-navigation)\.spec\.ts)$/;
const persistence = /^(?:src\/(?:backend\/sqlite-state|server\/(?:file-snapshot-store|snapshot-store|snapshot-source))\.ts|scripts\/provider-checkpoint\.ts|test\/(?:shared-(?:backend-state|state-batch)|snapshot-store)\.test\.ts)$/;
const installer = /^(?:Dockerfile[^/]*|docker\/.*|src\/(?:installer|updater)\/.*|src\/contracts\/updates\.ts|src\/preview\/updates\.ts|scripts\/(?:modern-start\.sh|shared-(?:control|updater)\.ts|release-image-identity\.ts|test-(?:shared|updater|claims-shutdown|claim-units)-docker\.ts)|test\/(?:installer[^/]*|updater[^/]*|coordinator-updater-bundle)\.test\.ts|test\/fixtures\/updater-docker\.ts|test\/browser\/updates\.spec\.ts)$/;
const handoff = /^(?:scripts\/(?:hosted-server|hosting-lab|local-integration)\.ts|src\/server\/(?:contracts|snapshot-source|browser-assets|job-history-selection)\.ts|test\/(?:handoff-build|hosting-lab|fleet-application)\.test\.ts|test\/browser\/hosting\.spec\.ts)$/;
const collection = /^(?:scripts\/(?:demand-watch|host-address-file|host-metadata|jobs|market-queue|node-activity|node-info|nos|online-hosts|online-retention|preview-server|scheduling-priority|shared-progress|shared-read|sol|solana-rpc|staking)\.ts|src\/backend\/(?:collector|gpu[^/]*|android-recorder|observations|pc-(?:monitor|network))\.ts|src\/(?:fleet\/.*|contracts\/online-hosts\.ts|preview\/(?:fleet-transport|fleet-config|online-roster|shared-telemetry|state-refresh|evidence-clock|refresh-deadline)\.ts)|test\/(?!browser\/|fixtures\/)(?:connection|country-display|duration[^/]*|evidence-clock|fleet-contracts|fleet-transport|freshness|hardware-display|host[^/]*|ip-display|job[^/]*|live[^/]*|market[^/]*|metadata[^/]*|node[^/]*|nos[^/]*|online[^/]*|preview-server|provider[^/]*|queue[^/]*|refresh-deadline|scheduling[^/]*|shared-(?:gpu[^/]*|observations|pc-monitor|progress|read|docker-runner)|sol[^/]*|sort|staking[^/]*|state-refresh)\.test\.ts|test\/fixtures\/(?:host-addresses|inventory|jobs|nos|queue|sol|staking)\.ts)$/;
const fleetUi = /^(?:src\/preview\/(?!wallet\.|secure|shared-setup|updates\.)[^/]+\.(?:ts|html|css)|scripts\/webapp-assets\.ts|test\/(?:viewport|webapp-assets)\.test\.ts|test\/browser\/(?!wallet\.|rewards-claims\.|secure|shared-setup|hosts-navigation\.|updates\.|hosting\.)[^/]+\.spec\.ts)$/;
const stressFile = /(?:\.stress\.(?:test|spec)\.ts$|test\/(?:jobs-online-isolation|staking-budget)\.test\.ts$)/;

export function testOwner(path: string): VerificationGroup {
  if (stressFile.test(path)) return "stress";
  if (/^test\/(?:release[^/]*|verification)\.test\.ts$/.test(path)) return "installer";
  if (financial.test(path)) return "financial";
  if (access.test(path)) return "access";
  if (persistence.test(path)) return "persistence";
  if (installer.test(path)) return "installer";
  if (handoff.test(path)) return "handoff";
  if (fleetUi.test(path) || /^test\/connection\.test\.ts$/.test(path)) return "fleet-ui";
  if (path.startsWith("test/browser/")) return "fleet-ui";
  return "collection";
}

export function selectVerificationTests(changed: readonly { path: string; status: string; policyChange?: boolean }[], files: readonly string[], forceFull = false): ScopeSelection {
  const node = files.filter(path => /^test\/[^/]+\.test\.ts$/.test(path)).sort();
  const browser = files.filter(path => /^test\/browser\/[^/]+\.spec\.ts$/.test(path)).sort();
  const groups = new Set<VerificationGroup>(), reasons: ScopeSelection["reasons"] = [], accepts = new Set<AcceptanceKind>();
  let full = forceFull, executable = false;
  for (const change of changed) {
    const path = change.path;
    if (docs.test(path) && (change.policyChange === false || change.policyChange === undefined && !broad.test(path))) { reasons.push({ path, groups: [], reason: "documentation-only" }); continue; }
    executable = true;
    if (change.policyChange === true || broad.test(path) || change.status === "D" && /\.(?:test|spec)\.ts$/.test(path)) {
      full = true; reasons.push({ path, groups: ["full"], reason: "shared build, policy, composition or deleted-test coverage" }); continue;
    }
    const matched = new Set<VerificationGroup>();
    if (financial.test(path)) matched.add("financial");
    if (/^(?:scripts\/solana-rpc\.ts|src\/fleet\/nos\.ts)$/.test(path)) matched.add("financial");
    if (access.test(path)) matched.add("access");
    if (persistence.test(path)) { matched.add("persistence"); matched.add("collection"); matched.add("stress"); }
    if (installer.test(path)) matched.add("installer");
    if (handoff.test(path)) matched.add("handoff");
    if (collection.test(path)) { matched.add("collection"); matched.add("stress"); }
    if (/^src\/backend\/(?:pc-rewards|rewards-reader)\.ts$/.test(path)) { matched.add("collection"); matched.add("stress"); }
    if (fleetUi.test(path)) matched.add("fleet-ui");
    if (stressFile.test(path)) matched.add("stress");
    if (!matched.size) { full = true; reasons.push({ path, groups: ["full"], reason: "unmapped path; complete verification required" }); }
    else { for (const group of matched) groups.add(group); reasons.push({ path, groups: [...matched].sort(), reason: "reviewed subsystem rule" }); }
  }
  if (forceFull) reasons.push({ path: "--full", groups: ["full"], reason: "explicit complete verification" });
  // Financial and access changes must exercise the owner and retained-state
  // boundaries together; those fast groups exclude long collector simulations.
  if (groups.has("financial") || groups.has("access") || groups.has("installer")) {
    groups.add("financial"); groups.add("access"); groups.add("persistence");
  }
  if (groups.has("collection")) { groups.add("persistence"); groups.add("fleet-ui"); groups.add("stress"); }
  if (full) for (const group of VERIFICATION_GROUPS) groups.add(group);
  const allChanged = changed.map(row => row.path);
  if (allChanged.some(path => /^(?:src\/backend\/(?:collector|sqlite-state|setup)|src\/server\/(?:snapshot|file-snapshot)|src\/installer\/|Dockerfile|docker\/|scripts\/shared-owner)/.test(path))) accepts.add("docker-shared");
  if (allChanged.some(path => /^(?:src\/(?:installer|updater)\/|scripts\/(?:build-modern-release|build-coordinator|modern-start|shared-owner|shared-updater)|Dockerfile|docker\/)/.test(path))) { accepts.add("docker-updater"); accepts.add("public-installer"); }
  if (allChanged.some(path => /^(?:src\/backend\/treasury-claims\.ts|src\/installer\/coordinator\.ts|scripts\/shared-owner\.ts|scripts\/test-claims-shutdown-docker\.ts)$/.test(path))) accepts.add("docker-claims-shutdown");
  if (allChanged.some(path => /^(?:src\/backend\/(?:treasury-claims|claim-receipt|rewards-claimer|treasury-claim-driver)\.ts|scripts\/test-claim-units-docker\.ts)$/.test(path))) accepts.add("docker-claim-units");
  const chosenNode = full ? node : node.filter(path => groups.has(testOwner(path)));
  if (groups.has("financial")) for (const path of ["test/solana-rpc.test.ts", "test/solana-rpc-authorization.test.ts", "test/installer-treasury.test.ts"]) {
    if (node.includes(path) && !chosenNode.includes(path)) chosenNode.push(path);
  }
  const chosenBrowser = full ? browser : browser.filter(path => {
    const owner = testOwner(path);
    return groups.has(owner) || groups.has("financial") && /\/(?:secure-navigation|shared-setup-access)\.spec\.ts$/.test(path);
  });
  // An affected test always participates, regardless of its usual ownership.
  for (const { path, status } of changed) if (status !== "D") {
    if (node.includes(path) && !chosenNode.includes(path)) chosenNode.push(path);
    if (browser.includes(path) && !chosenBrowser.includes(path)) chosenBrowser.push(path);
  }
  return { full, documentationOnly: !full && !executable, groups: [...groups].sort(), nodeTests: [...new Set(chosenNode)].sort(),
    browserTests: [...new Set(chosenBrowser)].sort(), reasons, requiredAcceptances: [...accepts].sort() };
}
