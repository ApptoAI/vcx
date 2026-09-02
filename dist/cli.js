#!/usr/bin/env node
import { access, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { confirm, promptSecret, readStdin } from "./prompt.js";
import { assertProfileName, createStagedProfileDir, getConfigDir, getProfileDir, installStagedProfile, readStore, removeProfileData, StoreError, withStoreLock, writeStore, writeTokenAuth, } from "./store.js";
import { findReservedVercelOption, runVercel } from "./vercel.js";
import { getVercelGlobalDir, linkVercelGlobalDir, unlinkVercelGlobalDir, } from "./vercel-global.js";
const { version: VERSION } = createRequire(import.meta.url)("../package.json");
class CliError extends Error {
    name = "CliError";
}
async function main(argv) {
    const [command, ...args] = argv;
    if (!command || command === "help" || command === "--help" || command === "-h") {
        printHelp();
        return 0;
    }
    if (command === "version" || command === "--version" || command === "-v") {
        process.stdout.write(`${VERSION}\n`);
        return 0;
    }
    switch (command) {
        case "profile":
        case "profiles":
            return await profileCommand(args);
        case "exec":
        case "vercel":
            return await explicitExec(args);
        default:
            return await forwardToVercel(argv);
    }
}
async function profileCommand(args) {
    const [command, ...commandArgs] = args;
    if (!command || command === "help" || command === "--help" || command === "-h") {
        printProfileHelp();
        return 0;
    }
    switch (command) {
        case "add":
            return await addProfile(commandArgs);
        case "login":
            return await loginProfile(commandArgs);
        case "use":
            return await useProfile(commandArgs);
        case "list":
        case "ls":
            return await listProfiles(commandArgs);
        case "current":
            return await currentProfile(commandArgs);
        case "remove":
        case "rm":
            return await removeProfile(commandArgs);
        case "path":
            return showPath(commandArgs);
        default:
            throw new CliError(`Unknown profile command "${command}". Run \`vcx profile --help\`.`);
    }
}
async function addProfile(args) {
    const parsed = parseOptions(args, {
        boolean: ["--activate", "--force", "--no-verify", "--token-stdin"],
        aliases: new Map([
            ["-a", "--activate"],
            ["-f", "--force"],
        ]),
        values: ["--token"],
    });
    const name = expectSingleProfileName(parsed.positionals, "profile add");
    const configDir = getConfigDir();
    const initialStore = await readStore(configDir);
    if (getProfile(initialStore.profiles, name) && !parsed.flags.has("--force")) {
        throw profileExistsError(name, "replace it");
    }
    const inlineToken = parsed.values.get("--token");
    const fromStdin = parsed.flags.has("--token-stdin");
    if (inlineToken !== undefined && fromStdin) {
        throw new CliError("Use either --token or --token-stdin, not both.");
    }
    let token;
    if (inlineToken !== undefined) {
        token = inlineToken;
    }
    else if (fromStdin) {
        token = (await readStdin()).trim();
    }
    else {
        token = (await promptSecret("Vercel token: ")).trim();
    }
    assertToken(token);
    const stagedDir = await createStagedProfileDir(configDir, `add-${name}`);
    let installed = false;
    try {
        await writeTokenAuth(stagedDir, token);
        const username = parsed.flags.has("--no-verify")
            ? undefined
            : await verifyProfile(stagedDir);
        await withStoreLock(configDir, async () => {
            const store = await readStore(configDir);
            const existing = getProfile(store.profiles, name);
            if (existing && !parsed.flags.has("--force")) {
                throw profileExistsError(name, "replace it");
            }
            const firstProfile = Object.keys(store.profiles).length === 0;
            const now = new Date().toISOString();
            store.profiles[name] = {
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                ...(username ? { username } : {}),
            };
            if (store.activeProfile === null || parsed.flags.has("--activate")) {
                store.activeProfile = name;
            }
            await installStagedProfile(stagedDir, name, configDir, async () => {
                await writeStore(store, configDir);
            });
            installed = true;
            if (firstProfile)
                warnPlaintextStorage(configDir);
            if (store.activeProfile === name)
                await syncVercelGlobalLink(name, configDir);
        });
        process.stdout.write(`Added profile "${name}"${username ? ` (${username})` : ""}.` +
            `${(await readStore(configDir)).activeProfile === name ? " It is now active." : ""}\n`);
    }
    finally {
        if (!installed)
            await rm(stagedDir, { recursive: true, force: true });
    }
    return 0;
}
async function loginProfile(args) {
    const parsed = parseOptions(args, {
        boolean: ["--activate", "--force"],
        aliases: new Map([
            ["-a", "--activate"],
            ["-f", "--force"],
        ]),
    });
    const name = expectSingleProfileName(parsed.positionals, "profile login");
    const configDir = getConfigDir();
    const initialStore = await readStore(configDir);
    if (getProfile(initialStore.profiles, name) && !parsed.flags.has("--force")) {
        throw profileExistsError(name, "log in again");
    }
    const stagedDir = await createStagedProfileDir(configDir, `login-${name}`);
    let installed = false;
    try {
        const result = await runVercel(["login"], { globalConfig: stagedDir });
        if (result.missingBinary)
            throw missingVercelError();
        if (result.code !== 0) {
            throw new CliError(`Vercel login exited with code ${result.code}.`);
        }
        try {
            await access(join(stagedDir, "auth.json"));
        }
        catch {
            throw new CliError("Vercel login completed without creating auth.json. Update Vercel CLI or report this compatibility issue.");
        }
        const username = await verifyProfile(stagedDir);
        await withStoreLock(configDir, async () => {
            const store = await readStore(configDir);
            const existing = getProfile(store.profiles, name);
            if (existing && !parsed.flags.has("--force")) {
                throw profileExistsError(name, "log in again");
            }
            const firstProfile = Object.keys(store.profiles).length === 0;
            const now = new Date().toISOString();
            store.profiles[name] = {
                username,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            };
            if (store.activeProfile === null || parsed.flags.has("--activate")) {
                store.activeProfile = name;
            }
            await installStagedProfile(stagedDir, name, configDir, async () => {
                await writeStore(store, configDir);
            });
            installed = true;
            if (firstProfile)
                warnPlaintextStorage(configDir);
            if (store.activeProfile === name)
                await syncVercelGlobalLink(name, configDir);
        });
        process.stdout.write(`Added profile "${name}" (${username}).` +
            `${(await readStore(configDir)).activeProfile === name ? " It is now active." : ""}\n`);
    }
    finally {
        if (!installed)
            await rm(stagedDir, { recursive: true, force: true });
    }
    return 0;
}
async function useProfile(args) {
    const parsed = parseOptions(args);
    const name = expectSingleProfileName(parsed.positionals, "profile use");
    const configDir = getConfigDir();
    let linked = false;
    await withStoreLock(configDir, async () => {
        const store = await readStore(configDir);
        requireProfile(store.profiles, name);
        store.activeProfile = name;
        await writeStore(store, configDir);
        linked = await syncVercelGlobalLink(name, configDir);
    });
    process.stdout.write(`Active profile: ${name}\n`);
    if (linked) {
        process.stdout.write(`Linked ${getVercelGlobalDir()} to this profile, so plain \`vercel\` uses it too.\n`);
    }
    return 0;
}
async function listProfiles(args) {
    const parsed = parseOptions(args, { boolean: ["--json"] });
    expectNoPositionals(parsed.positionals, "profile list");
    const store = await readStore();
    const profiles = Object.entries(store.profiles)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, profile]) => ({
        name,
        username: profile.username ?? null,
        active: name === store.activeProfile,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
    }));
    if (parsed.flags.has("--json")) {
        process.stdout.write(`${JSON.stringify({ activeProfile: store.activeProfile, profiles }, null, 2)}\n`);
        return 0;
    }
    if (profiles.length === 0) {
        process.stdout.write("No profiles. Add one with `vcx profile login <name>`.\n");
        return 0;
    }
    const nameWidth = Math.max(7, ...profiles.map((profile) => profile.name.length));
    process.stdout.write(`  ${"PROFILE".padEnd(nameWidth)}  ACCOUNT\n` +
        profiles
            .map((profile) => `${profile.active ? "*" : " "} ${profile.name.padEnd(nameWidth)}  ${profile.username ?? "unverified"}`)
            .join("\n") +
        "\n");
    return 0;
}
async function currentProfile(args) {
    const parsed = parseOptions(args, { boolean: ["--json"] });
    expectNoPositionals(parsed.positionals, "profile current");
    const store = await readStore();
    const name = process.env.VCX_PROFILE ?? store.activeProfile;
    if (!name) {
        if (parsed.flags.has("--json"))
            process.stdout.write("null\n");
        else
            process.stderr.write("vcx: No active profile. Run `vcx profile use <name>`.\n");
        return 1;
    }
    assertProfileName(name);
    const profile = requireProfile(store.profiles, name);
    if (parsed.flags.has("--json")) {
        process.stdout.write(`${JSON.stringify({
            name,
            username: profile.username ?? null,
            source: process.env.VCX_PROFILE ? "environment" : "store",
        }, null, 2)}\n`);
    }
    else {
        process.stdout.write(`${name}${profile.username ? ` (${profile.username})` : ""}\n`);
    }
    return 0;
}
async function removeProfile(args) {
    const parsed = parseOptions(args, {
        boolean: ["--force"],
        aliases: new Map([["-f", "--force"]]),
    });
    const name = expectSingleProfileName(parsed.positionals, "profile remove");
    const configDir = getConfigDir();
    const initialStore = await readStore(configDir);
    requireProfile(initialStore.profiles, name);
    if (!parsed.flags.has("--force")) {
        if (!process.stdin.isTTY || !process.stderr.isTTY) {
            throw new CliError("Refusing non-interactive removal without --force.");
        }
        const approved = await confirm(`Remove profile "${name}" and its plaintext Vercel config?`);
        if (!approved) {
            process.stderr.write("Cancelled.\n");
            return 1;
        }
    }
    await withStoreLock(configDir, async () => {
        const store = await readStore(configDir);
        requireProfile(store.profiles, name);
        delete store.profiles[name];
        const wasActive = store.activeProfile === name;
        if (wasActive)
            store.activeProfile = null;
        await removeProfileData(name, configDir, async () => {
            await writeStore(store, configDir);
        });
        if (wasActive)
            await syncVercelGlobalLink(null, configDir);
    });
    process.stdout.write(`Removed profile "${name}".\n`);
    return 0;
}
/**
 * Keep Vercel's default global config directory pointing at the active
 * profile. Failure is a warning: vcx commands still work through
 * `--global-config`, only plain `vercel` would use the wrong account.
 */
async function syncVercelGlobalLink(activeProfile, configDir) {
    try {
        if (activeProfile === null) {
            await unlinkVercelGlobalDir();
            return false;
        }
        const result = await linkVercelGlobalDir(getProfileDir(activeProfile, configDir));
        if (result.backupDir) {
            process.stderr.write(`Moved the previous Vercel global config to ${result.backupDir}.\n`);
        }
        return true;
    }
    catch (error) {
        process.stderr.write(`Warning: could not link ${getVercelGlobalDir()} to the active profile: ${errorMessage(error)}\n` +
            "Plain `vercel` commands keep their old login. `vcx <command>` still uses the profile.\n");
        return false;
    }
}
function showPath(args) {
    const parsed = parseOptions(args);
    expectNoPositionals(parsed.positionals, "profile path");
    process.stdout.write(`${getConfigDir()}\n`);
    return 0;
}
async function explicitExec(args) {
    let index = 0;
    let profileName;
    while (index < args.length) {
        const argument = args[index];
        if (argument === "--") {
            index += 1;
            break;
        }
        if (argument === "--profile" || argument === "-p") {
            const value = args[index + 1];
            if (!value)
                throw new CliError(`${argument} requires a profile name.`);
            profileName = value;
            index += 2;
            continue;
        }
        if (argument?.startsWith("--profile=")) {
            const value = argument.slice("--profile=".length);
            if (!value)
                throw new CliError("--profile requires a profile name.");
            profileName = value;
            index += 1;
            continue;
        }
        break;
    }
    const vercelArgs = args.slice(index);
    if (vercelArgs.length === 0) {
        throw new CliError("No Vercel command provided after `vcx exec`.");
    }
    return await forwardToVercel(vercelArgs, profileName);
}
async function forwardToVercel(args, requestedProfile) {
    const reservedOption = findReservedVercelOption(args);
    if (reservedOption) {
        throw new CliError(`Do not pass ${reservedOption} through vcx. Select a profile or run \`vercel\` directly.`);
    }
    const store = await readStore();
    const profileName = requestedProfile ?? process.env.VCX_PROFILE ?? store.activeProfile;
    if (!profileName) {
        throw new CliError("No active profile. Run `vcx profile login <name>` or `vcx profile use <name>`.");
    }
    assertProfileName(profileName);
    requireProfile(store.profiles, profileName);
    const result = await runVercel(args, {
        globalConfig: getProfileDir(profileName),
    });
    if (result.missingBinary)
        throw missingVercelError();
    return result.code;
}
async function verifyProfile(profileDir) {
    // Vercel resolves the team from a linked project in the working directory,
    // and an account outside that team gets "Not authorized". Verify from the
    // profile directory instead, which never holds a project link.
    const result = await runVercel(["whoami"], {
        globalConfig: profileDir,
        capture: true,
        cwd: profileDir,
    });
    if (result.missingBinary)
        throw missingVercelError();
    if (result.code !== 0) {
        const detail = cleanOutput(result.stderr);
        throw new CliError(`Vercel rejected the profile${detail ? `: ${detail}` : "."}`);
    }
    const username = cleanOutput(result.stdout).split("\n").filter(Boolean).at(-1);
    if (!username) {
        throw new CliError("Vercel verified the profile but returned no account name.");
    }
    return username;
}
function parseOptions(args, definition = {}) {
    const boolean = new Set(definition.boolean ?? []);
    const values = new Set(definition.values ?? []);
    const aliases = definition.aliases ?? new Map();
    const parsed = {
        positionals: [],
        flags: new Set(),
        values: new Map(),
    };
    let optionsEnded = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === undefined)
            continue;
        if (optionsEnded) {
            parsed.positionals.push(argument);
            continue;
        }
        if (argument === "--") {
            optionsEnded = true;
            continue;
        }
        const [rawName, inlineValue] = splitOption(argument);
        const name = aliases.get(rawName) ?? rawName;
        if (boolean.has(name)) {
            if (inlineValue !== undefined) {
                throw new CliError(`${rawName} does not accept a value.`);
            }
            parsed.flags.add(name);
            continue;
        }
        if (values.has(name)) {
            const nextValue = args[index + 1];
            const value = inlineValue ?? nextValue;
            if (value === undefined ||
                (inlineValue === undefined && value.startsWith("-"))) {
                throw new CliError(`${rawName} requires a value.`);
            }
            parsed.values.set(name, value);
            if (inlineValue === undefined)
                index += 1;
            continue;
        }
        if (argument.startsWith("-")) {
            throw new CliError(`Unknown option: ${argument}`);
        }
        parsed.positionals.push(argument);
    }
    return parsed;
}
function splitOption(argument) {
    if (!argument.startsWith("--"))
        return [argument, undefined];
    const equals = argument.indexOf("=");
    return equals === -1
        ? [argument, undefined]
        : [argument.slice(0, equals), argument.slice(equals + 1)];
}
function expectSingleProfileName(positionals, command) {
    if (positionals.length !== 1 || !positionals[0]) {
        throw new CliError(`Usage: vcx ${command} <profile>`);
    }
    assertProfileName(positionals[0]);
    return positionals[0];
}
function expectNoPositionals(positionals, command) {
    if (positionals.length > 0)
        throw new CliError(`Usage: vcx ${command}`);
}
function requireProfile(profiles, name) {
    const profile = getProfile(profiles, name);
    if (!profile) {
        throw new CliError(`Unknown profile "${name}". Run \`vcx profile list\` to see saved profiles.`);
    }
    return profile;
}
function getProfile(profiles, name) {
    return Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}
function profileExistsError(name, action) {
    return new CliError(`Profile "${name}" already exists. Use --force to ${action}.`);
}
function assertToken(token) {
    if (!token)
        throw new CliError("The Vercel token cannot be empty.");
    if (token.length > 8_192)
        throw new CliError("The Vercel token is too long.");
    if (/[\s\u0000-\u001f\u007f]/.test(token)) {
        throw new CliError("The Vercel token cannot contain whitespace or control characters.");
    }
}
function warnPlaintextStorage(configDir) {
    process.stderr.write(`Warning: vcx stores Vercel credentials as plaintext under ${configDir}.\n`);
}
function cleanOutput(output) {
    return output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
}
function missingVercelError() {
    return new CliError("Could not find the Vercel CLI. Install it with `npm install --global vercel`.");
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function printHelp() {
    process.stdout.write(`vcx ${VERSION} - named accounts for the Vercel CLI

Usage:
  vcx profile <command>                  Manage named profiles
  vcx exec [-p <profile>] -- <args...>   Run Vercel with one profile
  vcx <vercel command...>                Run Vercel with the active profile
  vcx help                               Show this help
  vcx version                            Print the vcx version

Examples:
  vcx profile login personal
  vcx profile use work
  vcx deploy --prod
  vcx exec --profile personal -- list

Run \`vcx profile --help\` for profile commands.

Environment:
  VCX_PROFILE           Override the active profile for one command
  VCX_CONFIG_DIR        Override the vcx data directory
  VCX_VERCEL_BIN        Override the Vercel executable
  VCX_VERCEL_GLOBAL_DIR Override Vercel's global config directory that vcx links

V1 stores each profile's Vercel config as plaintext with user-only permissions.
`);
}
function printProfileHelp() {
    process.stdout.write(`Manage vcx profiles

Usage:
  vcx profile login <name> [options]     Sign in through Vercel's login flow
  vcx profile add <name> [options]       Save an existing Vercel token
  vcx profile use <name>                 Set the active profile
  vcx profile list [--json]              List profiles without credentials
  vcx profile current [--json]           Show the selected profile
  vcx profile remove <name> [--force]    Delete a profile and its Vercel config
  vcx profile path                       Print the vcx data directory

Add options:
  --token <token>       Read a token from the command line
  --token-stdin         Read a token from standard input
  --no-verify           Save without a network call to \`vercel whoami\`
  -a, --activate        Make the new profile active
  -f, --force           Replace an existing profile

Login options:
  -a, --activate        Make the new profile active
  -f, --force           Replace an existing profile
`);
}
main(process.argv.slice(2))
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    const prefix = error instanceof StoreError ? "vcx store" : "vcx";
    process.stderr.write(`${prefix}: ${errorMessage(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map