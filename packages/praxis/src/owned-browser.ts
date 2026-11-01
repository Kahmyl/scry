import { chromium, type Browser, type BrowserServer } from "playwright";
import { chromium as mcpChromium } from "playwright-mcp-runtime";

export interface OwnedBrowserOptions {
  headless?: boolean;
  channel?: string;
  executablePath?: string;
  launchTimeoutMs?: number;
  connectTimeoutMs?: number;
  gracefulCloseMs?: number;
  killTimeoutMs?: number;
  /** A private custodian installs its own shutdown handlers. */
  handleSignals?: boolean;
  runtime?: "playwright_mcp";
  display?: string;
  proxyServer?: string;
  captureDirectory?: string;
}

export interface BrowserTerminationReceipt {
  readonly forced: boolean;
  readonly exitConfirmed: true;
}

function budget(value: number | undefined, fallback: number, maximum: number, allowZero = false) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1) || result > maximum)
    throw new Error("SCRY_BROWSER_PROCESS_CONFIGURATION_INVALID");
  return result;
}
export function assertBrowserProcessOptions(options: OwnedBrowserOptions): void {
  budget(options.launchTimeoutMs, 15000, 120000);
  budget(options.connectTimeoutMs, 5000, 30000);
  budget(options.gracefulCloseMs, 2000, 30000, true);
  budget(options.killTimeoutMs, 5000, 30000);
  if (
    (options.runtime !== undefined && options.runtime !== "playwright_mcp") ||
    (options.captureDirectory !== undefined &&
      (!options.captureDirectory.startsWith("/") || options.captureDirectory.length > 4096)) ||
    (options.display !== undefined && !/^:\d+$/u.test(options.display)) ||
    (options.proxyServer !== undefined && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(options.proxyServer))
  )
    throw new Error("SCRY_BROWSER_PROCESS_CONFIGURATION_INVALID");
  if (
    (options.headless !== undefined && typeof options.headless !== "boolean") ||
    (options.channel !== undefined &&
      (typeof options.channel !== "string" || !/^[a-z0-9-]{1,64}$/u.test(options.channel))) ||
    (options.executablePath !== undefined &&
      (typeof options.executablePath !== "string" || options.executablePath.length > 4096))
  )
    throw new Error("SCRY_BROWSER_PROCESS_CONFIGURATION_INVALID");
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns a local browser process, not merely a connection to it. A caller may
 * release execution authority only after an exit-confirmed receipt. Endpoint
 * credentials remain private. No authority is inferred from a timeout alone.
 */
export class BrowserProcessCustody {
  #disposal: Promise<BrowserTerminationReceipt> | undefined;
  #terminationState: "active" | "terminating" | "exited" | "unconfirmed" = "active";
  #forceRequested = false;
  #requestForce!: () => void;
  readonly #forced = new Promise<void>((resolve) => {
    this.#requestForce = resolve;
  });

  private constructor(
    private readonly server: BrowserServer,
    private readonly gracefulCloseMs: number,
    private readonly killTimeoutMs: number,
  ) {}

  static async launch(options: OwnedBrowserOptions = {}): Promise<BrowserProcessCustody> {
    assertBrowserProcessOptions(options);
    const launchTimeout = budget(options.launchTimeoutMs, 15000, 120000);
    budget(options.connectTimeoutMs, 5000, 30000);
    const grace = budget(options.gracefulCloseMs, 2000, 30000, true);
    const killTimeout = budget(options.killTimeoutMs, 5000, 30000);
    let server: BrowserServer;
    try {
      // The custodian loads both pinned drivers before accepting authority.
      const driver = options.runtime === "playwright_mcp" ? mcpChromium : chromium;
      server = await driver.launchServer({
        host: "127.0.0.1",
        port: 0,
        timeout: launchTimeout,
        headless: options.headless ?? true,
        ...(options.runtime === "playwright_mcp"
          ? {
              args: [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--window-position=0,0",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
              ],
              ...(options.display ? { env: { ...process.env, DISPLAY: options.display } } : {}),
              ...(options.proxyServer
                ? { proxy: { server: options.proxyServer, bypass: "<-loopback>" } }
                : {}),
            }
          : {}),
        ...(options.handleSignals === false
          ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }
          : {}),
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      });
    } catch {
      throw new Error("SCRY_BROWSER_PROCESS_LAUNCH_FAILED");
    }
    return new BrowserProcessCustody(server, grace, killTimeout);
  }

  /** Private loopback connection capability. Never persist or disclose it. */
  endpoint(): string {
    return this.server.wsEndpoint();
  }

  get exitConfirmed(): boolean {
    return exited(this.server);
  }
  get terminationState(): "active" | "terminating" | "exited" | "unconfirmed" {
    return this.#terminationState;
  }

  close(): Promise<BrowserTerminationReceipt> {
    if (!this.#disposal) {
      this.#terminationState = "terminating";
      this.#disposal = Promise.resolve()
        .then(() =>
          terminateServer(
            this.server,
            this.gracefulCloseMs,
            this.killTimeoutMs,
            this.#forceRequested,
            this.#forced,
          ),
        )
        .then(
          (receipt) => {
            this.#terminationState = "exited";
            return receipt;
          },
          () => {
            this.#terminationState = "unconfirmed";
            throw new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
          },
        );
    }
    return this.#disposal;
  }

  terminate(): Promise<BrowserTerminationReceipt> {
    this.#forceRequested = true;
    this.#requestForce();
    return this.close();
  }
}

/** Local client adapter retained for supported replay and native tests. The
 * exact BrowserServer custody is shared with the separate execution custodian. */
export class OwnedBrowser {
  private constructor(
    readonly browser: Browser,
    private readonly custody: BrowserProcessCustody,
  ) {
    browser.once("disconnected", () => {
      if (custody.terminationState === "active") void custody.terminate().catch(() => undefined);
    });
  }
  static async launch(options: OwnedBrowserOptions = {}): Promise<OwnedBrowser> {
    const connectTimeout = budget(options.connectTimeoutMs, 5000, 30000);
    const custody = await BrowserProcessCustody.launch(options);
    let code = "SCRY_BROWSER_PROCESS_CONNECT_FAILED";
    try {
      const endpointText = custody.endpoint();
      const endpoint = new URL(endpointText);
      if (
        endpoint.protocol !== "ws:" ||
        endpoint.hostname !== "127.0.0.1" ||
        !endpoint.port ||
        endpoint.username ||
        endpoint.password
      ) {
        code = "SCRY_BROWSER_PROCESS_ENDPOINT_INVALID";
        throw new Error(code);
      }
      const browser = await chromium.connect(endpointText, { timeout: connectTimeout });
      if (!browser.isConnected()) throw new Error(code);
      return new OwnedBrowser(browser, custody);
    } catch {
      // A failed client connection does not relinquish ownership of the child.
      await custody.close();
      throw new Error(code);
    }
  }

  get exitConfirmed(): boolean {
    return this.custody.exitConfirmed;
  }
  get terminationState(): "active" | "terminating" | "exited" | "unconfirmed" {
    return this.custody.terminationState;
  }

  close(): Promise<BrowserTerminationReceipt> {
    return this.custody.close();
  }

  /** Escalates an already-running graceful close, rather than starting a second
   * disposal or waiting out an unrelated grace interval. */
  terminate(): Promise<BrowserTerminationReceipt> {
    return this.custody.terminate();
  }
}

function exited(server: BrowserServer): boolean {
  const child = server.process();
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateServer(
  server: BrowserServer,
  grace: number,
  killTimeout: number,
  force = false,
  forceRequested?: Promise<void>,
): Promise<BrowserTerminationReceipt> {
  let forced = force || grace === 0;
  if (!exited(server) && !forced) {
    try {
      const closing = server.close();
      await bounded(forceRequested ? Promise.race([closing, forceRequested]) : closing, grace);
    } catch {
      forced = true;
    }
  }
  if (!exited(server)) {
    forced = true;
    try {
      await bounded(server.kill(), killTimeout);
    } catch {
      throw new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
    }
  }
  if (!exited(server)) throw new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
  return Object.freeze({ forced, exitConfirmed: true });
}
