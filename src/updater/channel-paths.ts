/** Channel wire format stays v1; filenames separate coordinator compatibility. */
export type ChannelFamily = "legacy" | "coordinator3";
export function channelFamilyForCoordinator(minimumCoordinator: number): ChannelFamily {
  if (!Number.isSafeInteger(minimumCoordinator) || minimumCoordinator < 1 || minimumCoordinator > 3) throw new Error("Unsupported coordinator channel family.");
  return minimumCoordinator <= 2 ? "legacy" : "coordinator3";
}
export function channelAssets(platform: "linux-x64" | "linux-arm64", family: ChannelFamily): { manifest: string; signature: string } {
  if (!["linux-x64", "linux-arm64"].includes(platform) || !["legacy", "coordinator3"].includes(family)) throw new Error("Unsupported channel asset family.");
  const stem = `modern-channel-${family === "coordinator3" ? "v3-" : ""}${platform}`;
  return { manifest: `${stem}.json`, signature: `${stem}.sig` };
}
