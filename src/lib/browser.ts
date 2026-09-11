import { existsSync } from "node:fs";
import { type Browser, chromium } from "playwright-core";

/**
 * The one place a browser is started.
 *
 * Two capabilities drive Chrome — the design fidelity review screenshots the
 * preview, and the web importer renders a page the administrator wants
 * replicated — and both need the same two accommodations, so neither should
 * own them privately.
 *
 * `playwright-core` rather than `playwright`: the full package downloads its
 * own Chromium on install, which is ~150MB nobody asked for and a postinstall
 * step that fails behind a proxy. This drives the Chrome already on the machine.
 */

export const DEFAULT_CHROME_PATH = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

/**
 * A user agent that is not obviously a robot.
 *
 * Not an affectation. The careers API this studio talks to sits behind a WAF
 * that answers `HeadlessChrome` with a 403 HTML page — so a capture that
 * announced itself honestly would screenshot an error page and report it as
 * the site. Chrome's own default in headless mode carries that token.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function launchChrome(chromePath = DEFAULT_CHROME_PATH): Promise<Browser> {
  // --no-sandbox because the studio is frequently run as root in a container,
  // where Chrome's own sandbox refuses to start at all.
  const args = ["--no-sandbox"];
  try {
    return await chromium.launch({ channel: "chrome", args });
  } catch (channelError) {
    if (!existsSync(chromePath)) throw channelError;
    return chromium.launch({ executablePath: chromePath, args });
  }
}

export function describeLaunchFailure(error: unknown, chromePath = DEFAULT_CHROME_PATH): string {
  if (!existsSync(chromePath)) {
    return (
      `Google Chrome was not found at ${chromePath}. ` +
      `Install Google Chrome, or point CHROME_PATH at an existing install.`
    );
  }
  return `Google Chrome is installed at ${chromePath} but would not start: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
