#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { confirm, promptSecret, readStdin } from "./prompt.js";
import {
  assertProfileName,
  getConfigDir,
  getStorePath,
  type Profile,
  readStore,
  StoreError,
  writeStore,
} from "./store.js";
import {
  containsExplicitVercelToken,
  runVercel,
} from "./vercel.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

class CliError extends Error {
  override name = "CliError";
}

interface ParsedOptions {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

async function main(argv: string[]): Promise<number> {
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
    case "add":
      return await addProfile(args);
    case "login":
      return await loginProfile(args);
    case "use":
      return await useProfile(args);
    case "list":
      return await listProfiles(args);
    case "current":
      return await currentProfile(args);
    case "remove":
    case "rm":
      return await removeProfile(args);
    case "path":
      return showPath(args);
    case "exec":
    case "vercel":
      return await explicitExec(args);
    default:
      return await forwardToVercel(argv);
  }
}

async function addProfile(args: string[]): Promise<number> {
  const parsed = parseOptions(args, {
    boolean: ["--activate", "--force", "--no-verify", "--token-stdin"],
    aliases: new Map([
      ["-a", "--activate"],
      ["-f", "--force"],
    ]),
    values: ["--token"],
  });
  const name = expectSingleProfileName(parsed.positionals, "add");
  const configDir = getConfigDir();
  const store = await readStore(configDir);
  const existing = getProfile(store.profiles, name);
  if (existing && !parsed.flags.has("--force")) {
    throw new CliError(
      `Profile "${name}" already exists. Use --force to replace it.`,
    );
  }

  const inlineToken = parsed.values.get("--token");
  const fromStdin = parsed.flags.has("--token-stdin");
  if (inlineToken !== undefined && fromStdin) {
    throw new CliError("Use either --token or --token-stdin, not both.");
  }

  let token: string;
  if (inlineToken !== undefined) {
    token = inlineToken;
  } else if (fromStdin) {
    token = (await readStdin()).trim();
  } else {
    token = (await promptSecret("Vercel token: ")).trim();
  }
  assertToken(token);

  let username: string | undefined;
  if (!parsed.flags.has("--no-verify")) {
    username = await verifyToken(token);
  }

  const now = new Date().toISOString();
  const profile: Profile = {
    token,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(username ? { username } : {}),
  };
  store.profiles[name] = profile;
  if (
    store.activeProfile === null ||
    parsed.flags.has("--activate")
  ) {
    store.activeProfile = name;
  }
  await writeStore(store, configDir);

  process.stdout.write(
    `Added profile "${name}"${username ? ` (${username})` : ""}.` +
      `${store.activeProfile === name ? " It is now active." : ""}\n`,
  );
  return 0;
}

async function loginProfile(args: string[]): Promise<number> {
  const parsed = parseOptions(args, {
    boolean: ["--activate", "--force"],
    aliases: new Map([
      ["-a", "--activate"],
      ["-f", "--force"],
    ]),
  });
  const name = expectSingleProfileName(parsed.positionals, "login");
  const configDir = getConfigDir();
  const store = await readStore(configDir);
  const existing = getProfile(store.profiles, name);
  if (existing && !parsed.flags.has("--force")) {
    throw new CliError(
      `Profile "${name}" already exists. Use --force to log in again.`,
    );
  }

  const temporaryConfig = await mkdtemp(join(tmpdir(), "vcx-login-"));
  try {
    const result = await runVercel(
      ["--global-config", temporaryConfig, "login"],
      { clearToken: true },
    );
    if (result.missingBinary) throw missingVercelError();
    if (result.code !== 0) {
      throw new CliError(`Vercel login exited with code ${result.code}.`);
    }

    const authPath = join(temporaryConfig, "auth.json");
    let token: string;
    try {
      const auth = JSON.parse(await readFile(authPath, "utf8")) as {
        token?: unknown;
      };
      if (typeof auth.token !== "string") {
        throw new Error("auth.json does not contain a token");
      }
      token = auth.token;
    } catch (error) {
      throw new CliError(
        `Vercel login completed, but vcx could not read its token: ${errorMessage(error)}`,
      );
    }
    assertToken(token);
    const username = await verifyToken(token);
    const now = new Date().toISOString();
    store.profiles[name] = {
      token,
      username,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (
      store.activeProfile === null ||
      parsed.flags.has("--activate")
    ) {
      store.activeProfile = name;
    }
    await writeStore(store, configDir);
    process.stdout.write(
      `Added profile "${name}" (${username}).` +
        `${store.activeProfile === name ? " It is now active." : ""}\n`,
    );
  } finally {
    await rm(temporaryConfig, { recursive: true, force: true });
  }

  return 0;
}

async function useProfile(args: string[]): Promise<number> {
  const parsed = parseOptions(args);
  const name = expectSingleProfileName(parsed.positionals, "use");
  const configDir = getConfigDir();
  const store = await readStore(configDir);
  requireProfile(store.profiles, name);
  store.activeProfile = name;
  await writeStore(store, configDir);
  process.stdout.write(`Active profile: ${name}\n`);
  return 0;
}

async function listProfiles(args: string[]): Promise<number> {
  const parsed = parseOptions(args, { boolean: ["--json"] });
  expectNoPositionals(parsed.positionals, "list");
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
    process.stdout.write(
      `${JSON.stringify({ activeProfile: store.activeProfile, profiles }, null, 2)}\n`,
    );
    return 0;
  }

  if (profiles.length === 0) {
    process.stdout.write("No profiles. Add one with `vcx login <name>`.\n");
    return 0;
  }

  const nameWidth = Math.max(7, ...profiles.map((profile) => profile.name.length));
  process.stdout.write(
    `${"PROFILE".padEnd(nameWidth)}  ACCOUNT\n` +
      profiles
        .map(
          (profile) =>
            `${profile.active ? "*" : " "} ${profile.name.padEnd(nameWidth)}  ${profile.username ?? "unverified"}`,
        )
        .join("\n") +
      "\n",
  );
  return 0;
}

async function currentProfile(args: string[]): Promise<number> {
  const parsed = parseOptions(args, { boolean: ["--json"] });
  expectNoPositionals(parsed.positionals, "current");
  const store = await readStore();
  const name = process.env.VCX_PROFILE ?? store.activeProfile;
  const profile = name ? getProfile(store.profiles, name) : undefined;

  if (!name) {
    if (parsed.flags.has("--json")) {
      process.stdout.write("null\n");
      return 0;
    }
    throw new CliError("No active profile. Run `vcx use <name>`.");
  }
  if (!profile) {
    throw new CliError(
      `Unknown profile "${name}". Run \`vcx list\` to see saved profiles.`,
    );
  }

  if (parsed.flags.has("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          name,
          username: profile.username ?? null,
          source: process.env.VCX_PROFILE ? "environment" : "store",
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${name}${profile.username ? ` (${profile.username})` : ""}\n`);
  }
  return 0;
}

async function removeProfile(args: string[]): Promise<number> {
  const parsed = parseOptions(args, {
    boolean: ["--force"],
    aliases: new Map([["-f", "--force"]]),
  });
  const name = expectSingleProfileName(parsed.positionals, "remove");
  const configDir = getConfigDir();
  const store = await readStore(configDir);
  requireProfile(store.profiles, name);

  if (!parsed.flags.has("--force")) {
    const approved = await confirm(
      `Remove profile "${name}" and its plaintext token?`,
    );
    if (!approved) {
      if (!process.stdin.isTTY) {
        throw new CliError("Refusing non-interactive removal without --force.");
      }
      process.stdout.write("Cancelled.\n");
      return 0;
    }
  }

  delete store.profiles[name];
  if (store.activeProfile === name) {
    store.activeProfile = null;
  }
  await writeStore(store, configDir);
  process.stdout.write(`Removed profile "${name}".\n`);
  return 0;
}

function showPath(args: string[]): number {
  const parsed = parseOptions(args);
  expectNoPositionals(parsed.positionals, "path");
  process.stdout.write(`${getStorePath()}\n`);
  return 0;
}

async function explicitExec(args: string[]): Promise<number> {
  let index = 0;
  let profileName: string | undefined;

  while (index < args.length) {
    const argument = args[index];
    if (argument === "--") {
      index += 1;
      break;
    }
    if (argument === "--profile" || argument === "-p") {
      const value = args[index + 1];
      if (!value) throw new CliError(`${argument} requires a profile name.`);
      profileName = value;
      index += 2;
      continue;
    }
    if (argument?.startsWith("--profile=")) {
      profileName = argument.slice("--profile=".length);
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

async function forwardToVercel(
  args: string[],
  requestedProfile?: string,
): Promise<number> {
  if (containsExplicitVercelToken(args)) {
    throw new CliError(
      "Do not pass --token through vcx; select a profile or run `vercel` directly.",
    );
  }

  const store = await readStore();
  const profileName =
    requestedProfile ?? process.env.VCX_PROFILE ?? store.activeProfile;
  if (!profileName) {
    throw new CliError(
      "No active profile. Run `vcx login <name>` or `vcx use <name>`.",
    );
  }
  assertProfileName(profileName);
  const profile = requireProfile(store.profiles, profileName);
  const result = await runVercel(args, { token: profile.token });
  if (result.missingBinary) throw missingVercelError();
  return result.code;
}

async function verifyToken(token: string): Promise<string> {
  const result = await runVercel(["whoami"], { token, capture: true });
  if (result.missingBinary) throw missingVercelError();
  if (result.code !== 0) {
    const detail = cleanOutput(result.stderr);
    throw new CliError(
      `Vercel rejected the token${detail ? `: ${detail}` : "."}`,
    );
  }
  const username = cleanOutput(result.stdout).split("\n").filter(Boolean).at(-1);
  if (!username) {
    throw new CliError("Vercel verified the token but returned no account name.");
  }
  return username;
}

function parseOptions(
  args: string[],
  definition: {
    boolean?: string[];
    values?: string[];
    aliases?: Map<string, string>;
  } = {},
): ParsedOptions {
  const boolean = new Set(definition.boolean ?? []);
  const values = new Set(definition.values ?? []);
  const aliases = definition.aliases ?? new Map<string, string>();
  const parsed: ParsedOptions = {
    positionals: [],
    flags: new Set(),
    values: new Map(),
  };

  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
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
      const value = inlineValue ?? args[index + 1];
      if (value === undefined) throw new CliError(`${rawName} requires a value.`);
      parsed.values.set(name, value);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new CliError(`Unknown option: ${argument}`);
    }
    parsed.positionals.push(argument);
  }
  return parsed;
}

function splitOption(argument: string): [string, string | undefined] {
  if (!argument.startsWith("--")) return [argument, undefined];
  const equals = argument.indexOf("=");
  return equals === -1
    ? [argument, undefined]
    : [argument.slice(0, equals), argument.slice(equals + 1)];
}

function expectSingleProfileName(positionals: string[], command: string): string {
  if (positionals.length !== 1 || !positionals[0]) {
    throw new CliError(`Usage: vcx ${command} <profile>`);
  }
  assertProfileName(positionals[0]);
  return positionals[0];
}

function expectNoPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new CliError(`Usage: vcx ${command}`);
  }
}

function requireProfile(
  profiles: Record<string, Profile>,
  name: string,
): Profile {
  const profile = getProfile(profiles, name);
  if (!profile) {
    throw new CliError(
      `Unknown profile "${name}". Run \`vcx list\` to see saved profiles.`,
    );
  }
  return profile;
}

function getProfile(
  profiles: Record<string, Profile>,
  name: string,
): Profile | undefined {
  return Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}

function assertToken(token: string): void {
  if (!token) throw new CliError("The Vercel token cannot be empty.");
  if (!/^\w+$/.test(token)) {
    throw new CliError(
      "The Vercel token is invalid. Tokens may contain only letters, numbers, and underscores.",
    );
  }
}

function cleanOutput(output: string): string {
  return output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
}

function missingVercelError(): CliError {
  return new CliError(
    "Could not find the Vercel CLI. Install it with `npm install --global vercel`.",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  process.stdout.write(`vcx ${VERSION} — named accounts for the Vercel CLI

Usage:
  vcx login <profile> [--activate]       Sign in through Vercel's login flow
  vcx add <profile> [options]            Save an existing Vercel token
  vcx use <profile>                      Set the active profile
  vcx list [--json]                      List profiles (never prints tokens)
  vcx current [--json]                   Show the selected profile
  vcx remove <profile> [--force]         Delete a profile and its token
  vcx path                               Print the plaintext credential path
  vcx exec [-p <profile>] -- <args...>   Run Vercel with a selected profile
  vcx <vercel command...>                Run Vercel with the active profile

Add options:
  --token <token>       Read a token from the command line
  --token-stdin         Read a token from standard input
  --no-verify           Save without calling \`vercel whoami\`
  -a, --activate        Make the new profile active
  -f, --force           Replace an existing profile

Examples:
  vcx login personal
  vcx add work --token-stdin
  vcx use work
  vcx deploy --prod
  vcx exec --profile personal -- list

Environment:
  VCX_PROFILE           Override the active profile for one command
  VCX_CONFIG_DIR        Override the vcx data directory
  VCX_VERCEL_BIN        Override the Vercel executable (mainly for testing)

V1 stores tokens as plaintext JSON with user-only file permissions.
`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const prefix = error instanceof StoreError ? "vcx store" : "vcx";
    process.stderr.write(`${prefix}: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
