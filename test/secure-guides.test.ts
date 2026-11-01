import assert from "node:assert/strict";
import test from "node:test";
import { browsersFor, normalizeSecureDevice, SECURE_DEVICES, secureGuide, suggestSecureDevice } from "../src/preview/secure-guides.ts";

test("Apple mobile identifiers precede desktop-looking tokens and preserve the actual browser choice", () => {
  const cases = [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1", "safari"],
    ["Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/142.0 Mobile/15E148 Safari/604.1", "chrome"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/142.0 Mobile Safari", "edge"],
    ["Mozilla/5.0 (iPod; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/144.0 Mobile Safari", "firefox"],
  ] as const;
  for (const [agent, browser] of cases) assert.deepEqual(suggestSecureDevice(agent), { device: "ios", browser });
});

test("desktop-mode iPad detection is a bounded editable hint rather than a blanket Mac classification", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15";
  assert.equal(suggestSecureDevice(mac, "MacIntel", 5).device, "ios");
  for (const touch of [0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(suggestSecureDevice(mac, "MacIntel", touch).device, "macos");
  assert.equal(suggestSecureDevice(mac, "Linux x86_64", 5).device, "macos");
  assert.equal(suggestSecureDevice("Android Chrome/142.0", "MacIntel", 5).device, "android");
  assert.equal(suggestSecureDevice("Windows NT 10.0 Chrome/142.0", "MacIntel", 5).device, "windows");
  // Stored/manual presentation choices remain available independently of a hint.
  assert.equal(normalizeSecureDevice("macos"), "macos"); assert.equal(normalizeSecureDevice("ios"), "ios");
  assert.equal(normalizeSecureDevice("samsung"), "android"); assert.equal(normalizeSecureDevice("unsupported"), undefined);
});

test("suggestions and manual browser choices stay inside each platform's supported instruction set", () => {
  assert.deepEqual(browsersFor("ios"), ["safari", "chrome", "edge", "firefox"]);
  for (const device of SECURE_DEVICES) {
    const browsers = browsersFor(device); assert.equal(new Set(browsers).size, browsers.length);
    assert.equal(browsers.includes("samsung"), device === "android");
    assert.equal(browsers.includes("safari"), device === "ios" || device === "macos");
    for (const browser of browsers) {
      const steps = secureGuide(device, browser, device === "ios" ? "generated.mobileconfig" : "generated.crt");
      assert.ok(steps.length >= 3 && steps.length <= 5); assert.ok(steps.every(step => step.title && step.instruction));
    }
  }
  for (const agent of ["", "Linux Chrome/142.0", "Windows NT 10.0 Edg/142.0", "Android SamsungBrowser/29.0", "iPhone FxiOS/144.0"]) {
    const choice = suggestSecureDevice(agent); assert.ok(browsersFor(choice.device).includes(choice.browser));
  }
});

test("iOS separates profile installation from full trust and keeps browser access outside that installation", () => {
  for (const browser of browsersFor("ios")) {
    const steps = secureGuide("ios", browser, "generated.mobileconfig");
    const install = steps.findIndex(step => step.title === "Review and install the certificate");
    const trust = steps.findIndex(step => step.title === "Enable certificate trust");
    assert.ok(install >= 0 && trust > install);
    assert.match(steps[0]!.instruction, /beyond GridLens/); assert.match(steps[0]!.help!, /Files alone does not prove/);
    assert.match(steps[0]!.help!, /eight minutes/); assert.match(steps[install]!.help!, /Not Signed/);
    assert.match(steps[trust]!.instruction, /General → About → Certificate Trust Settings/);
    assert.match(steps[trust]!.instruction, /normally GridLens Private Trust/);
    assert.match(steps.at(-1)!.help!, /do not share GridLens sessions automatically/);
    assert.doesNotMatch(steps.map(step => step.instruction).join(" "), /Current User|Destination Keychain|Authorities → Import|Install anyway/);
  }
});

test("desktop stores and mobile guidance remain isolated without prescribing system-wide or debug changes", () => {
  const windows = secureGuide("windows", "chrome", "generated.crt").map(step => step.instruction).join(" ");
  const mac = secureGuide("macos", "safari", "generated.crt").map(step => step.instruction).join(" ");
  assert.match(windows, /Current User and Next/); assert.match(windows, /Trusted Root Certification Authorities → OK/);
  assert.doesNotMatch(windows, /Local Machine|Computer Account/);
  assert.match(mac, /Destination Keychain set to login/); assert.match(mac, /Secure Sockets Layer \(SSL\) to Always Trust/);
  assert.doesNotMatch(mac, /When using this certificate.*Always Trust|System keychain/);
  const androidFirefox = secureGuide("android", "firefox", "generated.crt").map(step => `${step.instruction} ${step.help ?? ""}`).join(" ");
  assert.match(androidFirefox, /Current Firefox for Android normally uses CAs added to Android/);
  assert.doesNotMatch(androidFirefox, /about:config|View Certificates|Manage Certificates|Authorities → Import/);
  const linuxFirefox = secureGuide("linux", "firefox", "generated.crt");
  assert.match(linuxFirefox[0]!.instruction, /Manage Certificates or View Certificates/);
  assert.match(linuxFirefox[1]!.instruction, /Authorities → Import/);
  for (const browser of ["chrome", "edge"] as const) {
    const linux = secureGuide("linux", browser, "generated.crt");
    assert.match(linux[1]!.instruction, /Local certificates/); assert.match(linux[1]!.help!, /older.*Authorities/);
  }
});
