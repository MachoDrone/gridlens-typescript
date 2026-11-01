interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Offers only the browser's installation action for this origin; never configures HTTPS or trust. */
export function startWebappInstall(page: Document = document, browser: Window = window): void {
  const button = page.querySelector<HTMLButtonElement>("#sidebar-install-app");
  if (!button) return;
  const standalone = browser.matchMedia("(display-mode: standalone)");
  let pending: InstallPrompt | undefined, installed = standalone.matches, prompting = false;
  const render = (): void => {
    button.hidden = !browser.isSecureContext || installed || standalone.matches || pending === undefined;
    button.disabled = prompting;
  };
  browser.addEventListener("beforeinstallprompt", event => {
    if (!browser.isSecureContext || installed || standalone.matches || prompting) return;
    const candidate = event as Partial<InstallPrompt>;
    if (typeof candidate.prompt !== "function" || typeof candidate.userChoice?.then !== "function") return;
    event.preventDefault(); pending = event as InstallPrompt; render();
  });
  browser.addEventListener("appinstalled", () => {
    installed = true; pending = undefined; render();
  });
  standalone.addEventListener("change", render);
  button.addEventListener("click", () => {
    if (prompting || !pending || !browser.isSecureContext || installed || standalone.matches) return;
    const prompt = pending; pending = undefined; prompting = true; render();
    void (async () => {
      try {
        await prompt.prompt();
        if ((await prompt.userChoice).outcome === "accepted") installed = true;
      } catch {
        // A declined or unavailable browser action leaves the ordinary dashboard usable.
      } finally { prompting = false; render(); }
    })();
  });
  render();
}

startWebappInstall();
