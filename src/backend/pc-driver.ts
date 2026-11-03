import type { SshRun } from "./ssh.ts";
import { CUDA_DRIVER_VERSION, DRIVER_VERSION, parsePcDriver } from "../fleet/pc-drivers.ts";
import type { PcDriverObservation } from "../fleet/pc-drivers.ts";

export const PC_DRIVER_COMMAND = "/usr/bin/nvidia-smi --version";
/** NVIDIA-SMI reports NVML separately; only the DRIVER line identifies the
 * installed driver. CUDA is driver support, not toolkit or GPU-health proof. */
export function parseNvidiaVersionOutput(output: string): { driverVersion: string; cudaDriverVersion: string } {
  if (Buffer.byteLength(output) > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(output)) throw new Error("Invalid NVIDIA version response.");
  const lines = output.split(/\r?\n/), extract = (label: string): string => {
    const values = lines.flatMap(line => { const match = new RegExp(`^\\s*${label}\\s*:\\s*(\\S+)\\s*$`, "i").exec(line); return match ? [match[1]!] : []; });
    if (values.length !== 1) throw new Error("Missing or ambiguous NVIDIA version response.");
    return values[0]!;
  };
  const driverVersion = extract("DRIVER version"), cudaDriverVersion = extract("CUDA version");
  if (!DRIVER_VERSION.test(driverVersion) || !CUDA_DRIVER_VERSION.test(cudaDriverVersion)) throw new Error("Invalid NVIDIA version values.");
  return { driverVersion, cudaDriverVersion };
}
export async function readPcDriver(run: SshRun, now = Date.now): Promise<PcDriverObservation> {
  let status: PcDriverObservation["status"] = "unavailable", values = { driverVersion: null, cudaDriverVersion: null } as Pick<PcDriverObservation, "driverVersion" | "cudaDriverVersion">;
  try {
    const result = await run(PC_DRIVER_COMMAND, { maximum: 4096, timeoutMs: 5000 });
    if (result.code !== 0) status = result.code === 127 ? "missing-command" : "query-failed";
    else {
      try { values = parseNvidiaVersionOutput(result.stdout); status = "ok"; }
      catch { status = "invalid-response"; }
    }
  } catch { /* Only a finite public status leaves this reader. */ }
  return parsePcDriver({ schema: 1, source: "pc-nvidia-smi-version", observedAtMs: now(), status, ...values });
}
