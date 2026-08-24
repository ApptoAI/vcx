import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const STORE_VERSION = 1 as const;
export const STORE_FILENAME = "credentials.json";
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface Profile {
  token: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoreV1 {
  version: typeof STORE_VERSION;
  activeProfile: string | null;
  profiles: Record<string, Profile>;
}

export class StoreError extends Error {
  override name = "StoreError";
}

export function emptyStore(): StoreV1 {
  return {
    version: STORE_VERSION,
    activeProfile: null,
    profiles: {},
  };
}

export function getConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.VCX_CONFIG_DIR) {
    return resolve(env.VCX_CONFIG_DIR);
  }

  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "vcx");
  }

  if (platform === "win32") {
    const windowsBase = env.LOCALAPPDATA ?? env.APPDATA;
    return join(windowsBase ?? join(home, "AppData", "Local"), "vcx");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "vcx");
  }

  return join(home, ".config", "vcx");
}

export function getStorePath(configDir: string = getConfigDir()): string {
  return join(configDir, STORE_FILENAME);
}

export function assertProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new StoreError(
      `Invalid profile name "${name}". Use 1-64 lowercase letters, numbers, dots, dashes, or underscores, starting with a letter or number.`,
    );
  }
}

export async function readStore(
  configDir: string = getConfigDir(),
): Promise<StoreV1> {
  const path = getStorePath(configDir);
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyStore();
    }
    throw new StoreError(`Could not read ${path}: ${errorMessage(error)}`);
  }

  await restrictDirectoryPermissions(configDir);
  await restrictFilePermissions(path);

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new StoreError(`Could not parse ${path}: ${errorMessage(error)}`);
  }

  validateStore(value, path);
  return value;
}

export async function writeStore(
  store: StoreV1,
  configDir: string = getConfigDir(),
): Promise<void> {
  validateStore(store, getStorePath(configDir));
  const path = getStorePath(configDir);
  const tempPath = join(
    dirname(path),
    `.${STORE_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await restrictDirectoryPermissions(configDir);

  try {
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, path);
    await restrictFilePermissions(path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new StoreError(`Could not write ${path}: ${errorMessage(error)}`);
  }
}

function validateStore(value: unknown, path: string): asserts value is StoreV1 {
  if (!isRecord(value) || value.version !== STORE_VERSION) {
    throw new StoreError(
      `Unsupported or invalid credential store at ${path}. Expected version ${STORE_VERSION}.`,
    );
  }

  if (
    value.activeProfile !== null &&
    typeof value.activeProfile !== "string"
  ) {
    throw new StoreError(`Invalid active profile in ${path}.`);
  }

  if (!isRecord(value.profiles)) {
    throw new StoreError(`Invalid profiles object in ${path}.`);
  }

  for (const [name, candidate] of Object.entries(value.profiles)) {
    assertProfileName(name);
    if (
      !isRecord(candidate) ||
      typeof candidate.token !== "string" ||
      candidate.token.length === 0 ||
      typeof candidate.createdAt !== "string" ||
      typeof candidate.updatedAt !== "string" ||
      (candidate.username !== undefined &&
        typeof candidate.username !== "string")
    ) {
      throw new StoreError(`Invalid profile "${name}" in ${path}.`);
    }
  }

  if (
    value.activeProfile !== null &&
    !Object.hasOwn(value.profiles, value.activeProfile)
  ) {
    throw new StoreError(
      `Active profile "${value.activeProfile}" does not exist in ${path}.`,
    );
  }
}

async function restrictDirectoryPermissions(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o700);
  } catch (error) {
    throw new StoreError(
      `Could not restrict permissions on ${path}: ${errorMessage(error)}`,
    );
  }
}

async function restrictFilePermissions(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o600);
  } catch (error) {
    throw new StoreError(
      `Could not restrict permissions on ${path}: ${errorMessage(error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
