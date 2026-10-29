export type CliTone = "heading" | "success" | "action" | "pending" | "error" | "muted";
export interface CliOutput { color?: boolean; print(text: string): void }
const colors: Record<CliTone, string> = {
  heading: "1", success: "1;32", action: "1;34", pending: "33", error: "1;31", muted: "90",
};

/** Color supplements labels; NO_COLOR and noninteractive output stay readable. */
export function cliColorEnabled(tty: boolean, environment: NodeJS.ProcessEnv = process.env): boolean {
  return tty && environment.NO_COLOR === undefined && environment.TERM !== "dumb";
}
export function cliText(terminal: { color?: boolean }, tone: CliTone, value: string, environment: NodeJS.ProcessEnv = process.env): string {
  return cliColorEnabled(terminal.color === true, environment) ? `\u001b[${colors[tone]}m${value}\u001b[0m` : value;
}
export function cliSection(terminal: CliOutput, title: string): void {
  terminal.print(""); terminal.print(cliText(terminal, "heading", title)); terminal.print("");
}
export function cliFailure(message: string, tty = process.stderr.isTTY === true, environment: NodeJS.ProcessEnv = process.env): string {
  return `\n${cliText({ color: tty }, "error", `Error: ${message}`, environment)}\n`;
}
