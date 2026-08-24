import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile, } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export const STORE_VERSION = 2;
export const STORE_FILENAME = "profiles.json";
export const LEGACY_STORE_FILENAME = "credentials.json";
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOCK_FILENAME = ".vcx.lock";
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
export class StoreError extends Error {
    name = "StoreError";
}
export function emptyStore() {
    return {
        version: STORE_VERSION,
        activeProfile: null,
        profiles: {},
    };
}
export function getConfigDir(env = process.env, platform = process.platform, home = homedir()) {
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
export function getStorePath(configDir = getConfigDir()) {
    return join(configDir, STORE_FILENAME);
}
export function getLegacyStorePath(configDir = getConfigDir()) {
    return join(configDir, LEGACY_STORE_FILENAME);
}
export function getProfilesDir(configDir = getConfigDir()) {
    return join(configDir, "profiles");
}
export function getProfileDir(name, configDir = getConfigDir()) {
    assertProfileName(name);
    return join(getProfilesDir(configDir), name);
}
export function assertProfileName(name) {
    if (!PROFILE_NAME_PATTERN.test(name)) {
        throw new StoreError(`Invalid profile name "${name}". Use 1-64 lowercase letters, numbers, dots, dashes, or underscores, starting with a letter or number.`);
    }
}
export async function ensureConfigDir(configDir = getConfigDir()) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await restrictDirectoryPermissions(configDir);
    const profilesDir = getProfilesDir(configDir);
    await mkdir(profilesDir, { recursive: true, mode: 0o700 });
    await restrictDirectoryPermissions(profilesDir);
}
export async function readStore(configDir = getConfigDir()) {
    const path = getStorePath(configDir);
    let source;
    try {
        source = await readFile(path, "utf8");
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
            throw new StoreError(`Could not read ${path}: ${errorMessage(error)}`);
        }
        return await readOrMigrateLegacyStore(configDir);
    }
    await bestEffortReadPermissions(configDir, path);
    const value = parseJson(source, path);
    validateStore(value, path);
    return value;
}
export async function writeStore(store, configDir = getConfigDir()) {
    validateStore(store, getStorePath(configDir));
    await ensureConfigDir(configDir);
    await writeFileAtomic(getStorePath(configDir), Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8"));
}
export async function createStagedProfileDir(configDir = getConfigDir(), label = "profile") {
    await ensureConfigDir(configDir);
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "-");
    const path = await mkdtemp(join(getProfilesDir(configDir), `.${safeLabel}-`));
    await restrictDirectoryPermissions(path);
    return path;
}
export async function writeTokenAuth(profileDir, token) {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await restrictDirectoryPermissions(profileDir);
    await writeFileAtomic(join(profileDir, "auth.json"), Buffer.from(`${JSON.stringify({ token }, null, 2)}\n`, "utf8"));
}
export async function installStagedProfile(stagedDir, name, configDir = getConfigDir(), commit = async () => undefined) {
    assertProfileName(name);
    await ensureConfigDir(configDir);
    await restrictKnownProfilePermissions(stagedDir);
    const target = getProfileDir(name, configDir);
    const backup = join(getProfilesDir(configDir), `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.backup`);
    let backedUp = false;
    let installedTarget = false;
    try {
        try {
            await rename(target, backup);
            backedUp = true;
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT")
                throw error;
        }
        await rename(stagedDir, target);
        installedTarget = true;
        await commit();
        if (backedUp) {
            await rm(backup, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    catch (error) {
        if (installedTarget) {
            await rm(target, { recursive: true, force: true }).catch(() => undefined);
        }
        if (backedUp) {
            await rename(backup, target).catch(() => undefined);
        }
        throw new StoreError(`Could not install profile "${name}": ${errorMessage(error)}`);
    }
}
export async function removeProfileData(name, configDir = getConfigDir(), commit = async () => undefined) {
    const target = getProfileDir(name, configDir);
    const stagedRemoval = join(getProfilesDir(configDir), `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.removed`);
    let moved = false;
    try {
        try {
            await rename(target, stagedRemoval);
            moved = true;
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT")
                throw error;
        }
        await commit();
        if (moved)
            await rm(stagedRemoval, { recursive: true, force: true });
    }
    catch (error) {
        if (moved)
            await rename(stagedRemoval, target).catch(() => undefined);
        throw new StoreError(`Could not remove profile "${name}": ${errorMessage(error)}`);
    }
}
export async function withStoreLock(configDir, callback) {
    await ensureConfigDir(configDir);
    const lockPath = join(configDir, LOCK_FILENAME);
    const startedAt = Date.now();
    let handle;
    while (!handle) {
        try {
            handle = await open(lockPath, "wx", 0o600);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== "EEXIST") {
                throw new StoreError(`Could not acquire the vcx data lock: ${errorMessage(error)}`);
            }
            try {
                const details = await stat(lockPath);
                if (Date.now() - details.mtimeMs > STALE_LOCK_MS) {
                    await rm(lockPath, { force: true });
                    continue;
                }
            }
            catch (statError) {
                if (isNodeError(statError) && statError.code === "ENOENT")
                    continue;
            }
            if (Date.now() - startedAt >= LOCK_WAIT_MS) {
                throw new StoreError(`Timed out waiting for another vcx process. Remove ${lockPath} if no vcx process is running.`);
            }
            await delay(50);
        }
    }
    try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
        return await callback();
    }
    finally {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
    }
}
async function readOrMigrateLegacyStore(configDir) {
    const legacyPath = getLegacyStorePath(configDir);
    let source;
    try {
        source = await readFile(legacyPath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return emptyStore();
        throw new StoreError(`Could not read ${legacyPath}: ${errorMessage(error)}`);
    }
    const legacy = parseJson(source, legacyPath);
    validateLegacyStore(legacy, legacyPath);
    const migrated = {
        version: STORE_VERSION,
        activeProfile: legacy.activeProfile,
        profiles: {},
    };
    await ensureConfigDir(configDir);
    for (const [name, profile] of Object.entries(legacy.profiles)) {
        const profileDir = getProfileDir(name, configDir);
        await writeTokenAuth(profileDir, profile.token);
        migrated.profiles[name] = {
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
            ...(profile.username ? { username: profile.username } : {}),
        };
    }
    await writeStore(migrated, configDir);
    await rm(legacyPath, { force: true });
    return migrated;
}
function validateStore(value, path) {
    if (!isRecord(value) || value.version !== STORE_VERSION) {
        throw new StoreError(`Unsupported or invalid profile store at ${path}. Expected version ${STORE_VERSION}.`);
    }
    validateStoreShape(value, path, false);
}
function validateLegacyStore(value, path) {
    if (!isRecord(value) || value.version !== 1) {
        throw new StoreError(`Unsupported legacy credential store at ${path}.`);
    }
    validateStoreShape(value, path, true);
}
function validateStoreShape(value, path, expectToken) {
    if (value.activeProfile !== null &&
        typeof value.activeProfile !== "string") {
        throw new StoreError(`Invalid active profile in ${path}.`);
    }
    if (!isRecord(value.profiles)) {
        throw new StoreError(`Invalid profiles object in ${path}.`);
    }
    for (const [name, candidate] of Object.entries(value.profiles)) {
        assertProfileName(name);
        if (!isRecord(candidate) ||
            typeof candidate.createdAt !== "string" ||
            typeof candidate.updatedAt !== "string" ||
            (candidate.username !== undefined &&
                typeof candidate.username !== "string") ||
            (expectToken &&
                (typeof candidate.token !== "string" || candidate.token.length === 0))) {
            throw new StoreError(`Invalid profile "${name}" in ${path}.`);
        }
    }
    if (value.activeProfile !== null &&
        !Object.hasOwn(value.profiles, value.activeProfile)) {
        throw new StoreError(`Active profile "${value.activeProfile}" does not exist in ${path}.`);
    }
}
async function writeFileAtomic(path, contents) {
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
        await writeFile(tempPath, contents, { flag: "wx", mode: 0o600 });
        await rename(tempPath, path);
        await restrictFilePermissions(path);
    }
    catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw new StoreError(`Could not write ${path}: ${errorMessage(error)}`);
    }
}
async function restrictKnownProfilePermissions(path) {
    await restrictDirectoryPermissions(path);
    for (const filename of ["auth.json", "config.json"]) {
        const filePath = join(path, filename);
        try {
            await stat(filePath);
            await restrictFilePermissions(filePath);
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT")
                throw error;
        }
    }
}
async function bestEffortReadPermissions(configDir, filePath) {
    if (process.platform === "win32")
        return;
    await Promise.allSettled([
        chmod(configDir, 0o700),
        chmod(filePath, 0o600),
    ]);
}
async function restrictDirectoryPermissions(path) {
    if (process.platform === "win32")
        return;
    try {
        await chmod(path, 0o700);
    }
    catch (error) {
        throw new StoreError(`Could not restrict permissions on ${path}: ${errorMessage(error)}`);
    }
}
async function restrictFilePermissions(path) {
    if (process.platform === "win32")
        return;
    try {
        await chmod(path, 0o600);
    }
    catch (error) {
        throw new StoreError(`Could not restrict permissions on ${path}: ${errorMessage(error)}`);
    }
}
function parseJson(source, path) {
    try {
        return JSON.parse(source);
    }
    catch (error) {
        throw new StoreError(`Could not parse ${path}: ${errorMessage(error)}`);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=store.js.map