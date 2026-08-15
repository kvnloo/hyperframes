import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanActiveServers, type ActiveServer } from "../server/portUtils.js";
import type { BrowserGpuMode } from "../browser/gpuPolicy.js";
import { isProcessDescendant, killProcessTree, processIdentity } from "../utils/orphanCleanup.js";

export interface PreviewSession {
  pid: number;
  wrapperIdentity?: string;
  port: number;
  projectDir: string;
  logPath: string;
}

type SpawnResult = { pid?: number; unref(): void };
type SpawnPreview = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: ["ignore", number, number];
    env: NodeJS.ProcessEnv;
  },
) => SpawnResult;

interface LifecycleDependencies {
  argv?: string[];
  execPath?: string;
  scan?: (startPort?: number) => Promise<ActiveServer[]>;
  spawn?: SpawnPreview;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number) => void;
  isDescendant?: (childPid: number, ancestorPid: number) => boolean;
  identity?: (pid: number) => string | null;
  stateHome?: string;
  forceNew?: boolean;
  browserGpuMode?: BrowserGpuMode;
}

function defaultStateHome(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

function normalized(path: string): string {
  const resolved = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sessionDirectory(stateHome = defaultStateHome()): string {
  return join(stateHome, "hyperframes", "previews");
}

export function previewSessionPath(projectDir: string, stateHome = defaultStateHome()): string {
  const key = createHash("sha256").update(normalized(projectDir)).digest("hex").slice(0, 16);
  return join(sessionDirectory(stateHome), `${key}.json`);
}

function previewLogPath(projectDir: string, stateHome = defaultStateHome()): string {
  return previewSessionPath(projectDir, stateHome).replace(/\.json$/, ".log");
}

export function writePreviewSession(session: PreviewSession, stateHome = defaultStateHome()): void {
  const path = previewSessionPath(session.projectDir, stateHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

function readPreviewSession(
  projectDir: string,
  stateHome = defaultStateHome(),
): PreviewSession | null {
  const path = previewSessionPath(projectDir, stateHome);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PreviewSession;
    if (
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      normalized(parsed.projectDir) !== normalized(projectDir)
    ) {
      throw new Error("invalid preview session");
    }
    return parsed;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

function hasValidPreviewProcess(session: PreviewSession): boolean {
  return Number.isInteger(session.pid) && session.pid > 0;
}

function hasValidPreviewEndpoint(session: PreviewSession): boolean {
  return Number.isInteger(session.port) && session.port > 0 && session.port <= 65535;
}

function matchesPreviewSessionFile(
  session: PreviewSession,
  path: string,
  stateHome: string,
): boolean {
  return (
    typeof session.projectDir === "string" &&
    typeof session.logPath === "string" &&
    previewSessionPath(session.projectDir, stateHome) === path
  );
}

function readPreviewSessionFile(path: string, stateHome: string): PreviewSession | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PreviewSession;
    if (
      !hasValidPreviewProcess(parsed) ||
      !hasValidPreviewEndpoint(parsed) ||
      !matchesPreviewSessionFile(parsed, path, stateHome)
    ) {
      throw new Error("invalid preview session");
    }
    return parsed;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

function removePreviewSession(projectDir: string, stateHome = defaultStateHome()): void {
  rmSync(previewSessionPath(projectDir, stateHome), { force: true });
}

function matchingServer(
  servers: ActiveServer[],
  projectDir: string,
  browserGpuMode?: BrowserGpuMode,
): ActiveServer | null {
  return (
    servers.find(
      (server) =>
        normalized(server.projectDir) === normalized(projectDir) &&
        (browserGpuMode === undefined || server.browserGpuMode === browserGpuMode),
    ) ?? null
  );
}

function matchingServerAtPort(
  servers: ActiveServer[],
  projectDir: string,
  port: number,
): ActiveServer | null {
  return matchingServer(
    servers.filter((server) => server.port === port),
    projectDir,
  );
}

function sameProjectPorts(servers: ActiveServer[], projectDir: string): Set<number> {
  const project = normalized(projectDir);
  return new Set(
    servers
      .filter((server) => normalized(server.projectDir) === project)
      .map((server) => server.port),
  );
}

function stopProcess(pid: number): void {
  killProcessTree(pid);
  if (process.platform === "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function spawnDetachedPreview(
  projectDir: string,
  stateHome: string,
  dependencies: LifecycleDependencies,
): { pid: number; wrapperIdentity: string | undefined; logPath: string } {
  const logPath = previewLogPath(projectDir, stateHome);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a", 0o600);
  const spawn = dependencies.spawn ?? (nodeSpawn as unknown as SpawnPreview);
  let child: SpawnResult;
  try {
    child = spawn(
      dependencies.execPath ?? process.execPath,
      buildBackgroundPreviewArgs(dependencies.argv ?? process.argv.slice(1)),
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      },
    );
  } finally {
    closeSync(logFd);
  }
  if (!child.pid) throw new Error("background preview child did not report a PID");
  child.unref();
  return {
    pid: child.pid,
    wrapperIdentity: (dependencies.identity ?? processIdentity)(child.pid) ?? undefined,
    logPath,
  };
}

function startedServer(
  servers: ActiveServer[],
  projectDir: string,
  preLaunchPorts: Set<number>,
  browserGpuMode?: BrowserGpuMode,
): ActiveServer | null {
  const candidates = servers.filter((server) => !preLaunchPorts.has(server.port));
  return matchingServer(candidates, projectDir, browserGpuMode);
}

export function buildBackgroundPreviewArgs(argv: string[]): string[] {
  const filtered = argv.filter(
    (arg) =>
      arg !== "--background" &&
      !arg.startsWith("--background=") &&
      arg !== "--foreground" &&
      !arg.startsWith("--foreground=") &&
      arg !== "--open" &&
      arg !== "--no-open" &&
      arg !== "--json",
  );
  return [...filtered, "--foreground", "--no-open"];
}

export async function readBackgroundPreviewStatus(
  projectDir: string,
  startPort: number,
  dependencies: LifecycleDependencies = {},
): Promise<PreviewSession | null> {
  const scan = dependencies.scan ?? scanActiveServers;
  const stateHome = dependencies.stateHome ?? defaultStateHome();
  const saved = readPreviewSession(projectDir, stateHome);
  const server = matchingServer(await scan(saved?.port ?? startPort), projectDir);
  if (server) {
    const pid = Number(server.pid ?? saved?.pid);
    if (Number.isInteger(pid) && pid > 0) {
      return {
        pid,
        port: server.port,
        projectDir: resolve(projectDir),
        logPath: saved?.logPath ?? previewLogPath(projectDir, stateHome),
      };
    }
  }

  removePreviewSession(projectDir, stateHome);
  return null;
}

export async function listBackgroundPreviewStatuses(
  dependencies: LifecycleDependencies = {},
): Promise<PreviewSession[]> {
  const stateHome = dependencies.stateHome ?? defaultStateHome();
  const directory = sessionDirectory(stateHome);
  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }

  const saved = files
    .map((path) => readPreviewSessionFile(path, stateHome))
    .filter((session): session is PreviewSession => session !== null);
  const statuses = await Promise.all(
    saved.map((session) =>
      readBackgroundPreviewStatus(session.projectDir, session.port, {
        ...dependencies,
        stateHome,
      }),
    ),
  );
  return statuses.filter((status): status is PreviewSession => status !== null);
}

function readyPreviewSession(
  server: ActiveServer,
  pid: number,
  wrapperIdentity: string | undefined,
  projectDir: string,
  logPath: string,
  dependencies: LifecycleDependencies,
): { session: PreviewSession; publicPid: number } {
  const identity = wrapperIdentity ?? (dependencies.identity ?? processIdentity)(pid) ?? undefined;
  const liveServerPid = Number(server.pid);
  return {
    session: {
      pid,
      wrapperIdentity: identity,
      port: server.port,
      projectDir: resolve(projectDir),
      logPath,
    },
    publicPid: Number.isInteger(liveServerPid) && liveServerPid > 0 ? liveServerPid : pid,
  };
}

function ownedStopTargetPid(
  saved: PreviewSession | null,
  liveServerPid: number,
  dependencies: LifecycleDependencies,
): number {
  if (!saved?.wrapperIdentity) return liveServerPid;
  const identity = dependencies.identity ?? processIdentity;
  if (identity(saved.pid) !== saved.wrapperIdentity) return liveServerPid;
  if (saved.pid === liveServerPid) return saved.pid;
  const isDescendant = dependencies.isDescendant ?? isProcessDescendant;
  return isDescendant(liveServerPid, saved.pid) ? saved.pid : liveServerPid;
}

async function stopOwnedPreviewBeforeReplacement(
  owned: ActiveServer | null,
  projectDir: string,
  dependencies: LifecycleDependencies,
): Promise<void> {
  if (!owned) return;
  const stopped = await stopBackgroundPreview(projectDir, owned.port, dependencies);
  if (!stopped) throw new Error(`managed preview could not be replaced for ${resolve(projectDir)}`);
}

function savedOwnedPreview(
  servers: ActiveServer[],
  saved: PreviewSession | null,
  projectDir: string,
): ActiveServer | null {
  if (!saved) return null;
  // Ownership comes from the saved project+port, not the replacement's GPU
  // policy. Filtering here would miss an owned hardware→software replacement
  // and overwrite the only session record while leaving the old listener live.
  const savedPortServers = servers.filter((server) => server.port === saved.port);
  return matchingServer(savedPortServers, projectDir);
}

export async function startBackgroundPreview(
  projectDir: string,
  startPort: number,
  dependencies: LifecycleDependencies = {},
): Promise<
  | { type: "reused"; port: number; pid: number | null; logPath: string | null }
  | { type: "started"; port: number; pid: number; logPath: string }
> {
  const scan = dependencies.scan ?? scanActiveServers;
  const stateHome = dependencies.stateHome ?? defaultStateHome();
  const saved = readPreviewSession(projectDir, stateHome);
  // Always inspect a saved custom port first. `--force-new --port <new>` must
  // replace that owned server before recording the replacement, otherwise the
  // single per-project ownership record would orphan the old listener.
  const scanStart = saved?.port ?? startPort;
  const scanned = await scan(scanStart);
  const requestedExisting = matchingServer(scanned, projectDir, dependencies.browserGpuMode);
  const ownedExisting = savedOwnedPreview(scanned, saved, projectDir);
  // A saved managed preview is the authoritative same-project instance. An
  // explicit GPU-policy change replaces it; it must not silently adopt an
  // unmanaged sibling that happens to match the new policy.
  const reusableOwned = ownedExisting
    ? matchingServer([ownedExisting], projectDir, dependencies.browserGpuMode)
    : null;
  const reusableExisting = reusableOwned ?? (ownedExisting ? null : requestedExisting);
  if (reusableExisting && !dependencies.forceNew) {
    return {
      type: "reused",
      port: reusableExisting.port,
      pid: reusableExisting.pid ? Number(reusableExisting.pid) : null,
      logPath: null,
    };
  }
  await stopOwnedPreviewBeforeReplacement(ownedExisting, projectDir, dependencies);
  // Snapshot every same-project listener in the prospective launch range only
  // after the owned listener is gone. Readiness must identify a newly appeared
  // server, never a pre-existing unmanaged sibling.
  const preLaunchPorts = sameProjectPorts(await scan(startPort), projectDir);

  const { pid, wrapperIdentity, logPath } = spawnDetachedPreview(
    projectDir,
    stateHome,
    dependencies,
  );

  const sleep = dependencies.sleep ?? delay;
  for (let attempt = 0; attempt < 50; attempt++) {
    const server = startedServer(
      await scan(startPort),
      projectDir,
      preLaunchPorts,
      dependencies.browserGpuMode,
    );
    if (server) {
      const ready = readyPreviewSession(
        server,
        pid,
        wrapperIdentity,
        projectDir,
        logPath,
        dependencies,
      );
      writePreviewSession(ready.session, stateHome);
      return {
        type: "started",
        ...ready.session,
        pid: ready.publicPid,
      };
    }
    await sleep(200);
  }

  (dependencies.kill ?? stopProcess)(pid);
  throw new Error(`background preview did not become ready; see ${logPath}`);
}

export async function stopBackgroundPreview(
  projectDir: string,
  startPort: number,
  dependencies: LifecycleDependencies = {},
): Promise<boolean> {
  const scan = dependencies.scan ?? scanActiveServers;
  const stateHome = dependencies.stateHome ?? defaultStateHome();
  const saved = readPreviewSession(projectDir, stateHome);
  const scanStart = saved?.port ?? startPort;
  const scanned = await scan(scanStart);
  const server = saved
    ? matchingServerAtPort(scanned, projectDir, saved.port)
    : matchingServer(scanned, projectDir);
  if (!server) {
    removePreviewSession(projectDir, stateHome);
    return false;
  }
  // A saved PID can be reused after a crashed preview. The HTTP probe proves
  // the project, but only the live server's own metadata proves which process
  // owns it; never substitute the saved wrapper PID here.
  const pid = Number(server.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`preview ownership could not be proven for ${resolve(projectDir)}`);
  }

  const kill = dependencies.kill ?? stopProcess;
  kill(ownedStopTargetPid(saved, pid, dependencies));

  const sleep = dependencies.sleep ?? delay;
  for (let attempt = 0; attempt < 25; attempt++) {
    if (!matchingServerAtPort(await scan(scanStart), projectDir, server.port)) {
      removePreviewSession(projectDir, stateHome);
      return true;
    }
    await sleep(100);
  }
  throw new Error(`background preview did not stop for ${resolve(projectDir)}`);
}
