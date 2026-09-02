import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstat, mkdir, realpath, rename, rmdir, symlink, unlink, } from "node:fs/promises";
import process from "node:process";
const VERCEL_APP_NAME = "com.vercel.cli";
/**
 * The directory Vercel CLI reads when no `--global-config` is given.
 * Mirrors `xdg-app-paths` `dataDirs()[0]`, which Vercel uses.
 */
export function getVercelGlobalDir(env = process.env) {
    if (env.VCX_VERCEL_GLOBAL_DIR)
        return resolve(env.VCX_VERCEL_GLOBAL_DIR);
    const home = homedir();
    let dataDir;
    if (env.XDG_DATA_HOME) {
        dataDir = env.XDG_DATA_HOME;
    }
    else if (process.platform === "win32") {
        const appData = env.APPDATA || join(home, "AppData", "Roaming");
        dataDir = join(appData, "xdg.data");
    }
    else if (process.platform === "darwin") {
        dataDir = join(home, "Library", "Application Support");
    }
    else {
        dataDir = join(home, ".local", "share");
    }
    return join(dataDir, VERCEL_APP_NAME);
}
/**
 * Point Vercel's global config directory at a profile directory so a plain
 * `vercel` command uses the same account as `vcx`. An existing real directory
 * is moved aside once, never deleted.
 */
export async function linkVercelGlobalDir(profileDir, env = process.env) {
    const globalDir = getVercelGlobalDir(env);
    const target = resolve(profileDir);
    const existing = await lstatOrUndefined(globalDir);
    let backupDir;
    if (existing?.isSymbolicLink()) {
        const current = await realpath(globalDir).catch(() => undefined);
        if (current !== undefined && current === (await realpath(target))) {
            return { globalDir };
        }
        await removeLink(globalDir);
    }
    else if (existing) {
        backupDir = await backupPath(globalDir);
        await rename(globalDir, backupDir);
    }
    else {
        await mkdir(dirname(globalDir), { recursive: true });
    }
    await symlink(target, globalDir, process.platform === "win32" ? "junction" : "dir");
    return backupDir === undefined ? { globalDir } : { globalDir, backupDir };
}
/** Remove the link vcx created. A real directory is left alone. */
export async function unlinkVercelGlobalDir(env = process.env) {
    const globalDir = getVercelGlobalDir(env);
    const existing = await lstatOrUndefined(globalDir);
    if (!existing?.isSymbolicLink())
        return undefined;
    await removeLink(globalDir);
    return globalDir;
}
async function lstatOrUndefined(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function removeLink(path) {
    // Junctions are directories on Windows and need rmdir instead of unlink.
    if (process.platform === "win32")
        await rmdir(path);
    else
        await unlink(path);
}
async function backupPath(globalDir) {
    const base = `${globalDir}.before-vcx`;
    if (!(await lstatOrUndefined(base)))
        return base;
    return `${base}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
//# sourceMappingURL=vercel-global.js.map