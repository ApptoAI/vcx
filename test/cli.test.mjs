import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI_PATH = resolve("dist/cli.js");

async function createSandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "vcx-test-"));
  const configDir = join(root, "config");
  const logPath = join(root, "vercel.log");
  const vercelPath = join(root, "fake-vercel.mjs");
  const fakeVercel = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const token = process.env.VERCEL_TOKEN;
const logPath = process.env.FAKE_VERCEL_LOG;
if (logPath) appendFileSync(logPath, JSON.stringify({ args, token: token ?? null }) + "\\n");

const globalConfigIndex = args.indexOf("--global-config");
if (args.includes("login")) {
  const configDir = globalConfigIndex >= 0 ? args[globalConfigIndex + 1] : undefined;
  if (!configDir) process.exit(2);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({ token: "logintoken" }));
  console.log("Fake browser login complete");
  process.exit(0);
}

if (args.includes("whoami")) {
  if (!token || token === "badtoken") {
    console.error("invalid credentials");
    process.exit(9);
  }
  const names = { worktoken: "work-user", personaltoken: "personal-user", logintoken: "login-user" };
  console.log(names[token] ?? "test-user");
  process.exit(0);
}

if (args.includes("--version")) {
  console.log("99.0.0");
  process.exit(0);
}

console.log("fake vercel command");
`;
  await writeFile(vercelPath, fakeVercel, { mode: 0o755 });
  await chmod(vercelPath, 0o755);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, configDir, logPath, vercelPath };
}

function run(sandbox, args, options = {}) {
  const env = {
    ...process.env,
    VCX_CONFIG_DIR: sandbox.configDir,
    VCX_VERCEL_BIN: sandbox.vercelPath,
    FAKE_VERCEL_LOG: sandbox.logPath,
  };
  delete env.VERCEL_TOKEN;
  delete env.VCX_PROFILE;
  Object.assign(env, options.env);
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    input: options.input,
    env,
  });
}

async function readCredentials(sandbox) {
  return JSON.parse(
    await readFile(join(sandbox.configDir, "credentials.json"), "utf8"),
  );
}

async function readLog(sandbox) {
  try {
    return (await readFile(sandbox.logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("adds, verifies, lists, and stores a profile safely", async (t) => {
  const sandbox = await createSandbox(t);
  const added = run(sandbox, ["add", "work", "--token", "worktoken"]);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /Added profile "work" \(work-user\)/);

  const credentials = await readCredentials(sandbox);
  assert.equal(credentials.version, 1);
  assert.equal(credentials.activeProfile, "work");
  assert.equal(credentials.profiles.work.token, "worktoken");
  assert.equal(credentials.profiles.work.username, "work-user");

  if (process.platform !== "win32") {
    assert.equal((await stat(sandbox.configDir)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(sandbox.configDir, "credentials.json"))).mode & 0o777,
      0o600,
    );
  }

  const listed = run(sandbox, ["list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).activeProfile, "work");
  assert.doesNotMatch(listed.stdout, /worktoken/);
});

test("supports valid profile names that overlap object properties", async (t) => {
  const sandbox = await createSandbox(t);
  const added = run(sandbox, [
    "add",
    "constructor",
    "--token",
    "worktoken",
  ]);
  assert.equal(added.status, 0, added.stderr);
  const credentials = await readCredentials(sandbox);
  assert.equal(credentials.profiles.constructor.token, "worktoken");
});

test("prints the package version and command help", async (t) => {
  const sandbox = await createSandbox(t);
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const version = run(sandbox, ["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = run(sandbox, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /named accounts for the Vercel CLI/);
  assert.match(help.stdout, /V1 stores tokens as plaintext JSON/);
});

test("switches profiles and injects tokens through the environment only", async (t) => {
  const sandbox = await createSandbox(t);
  assert.equal(run(sandbox, ["add", "work", "--token", "worktoken"]).status, 0);
  assert.equal(
    run(sandbox, ["add", "personal", "--token", "personaltoken"]).status,
    0,
  );
  assert.equal(run(sandbox, ["use", "work"]).status, 0);

  const deploy = run(sandbox, ["deploy", "--prod"]);
  assert.equal(deploy.status, 0, deploy.stderr);
  const oneShot = run(sandbox, [
    "exec",
    "--profile",
    "personal",
    "--",
    "list",
  ]);
  assert.equal(oneShot.status, 0, oneShot.stderr);

  const environmentOverride = run(sandbox, ["whoami"], {
    env: { VCX_PROFILE: "personal" },
  });
  assert.equal(environmentOverride.status, 0, environmentOverride.stderr);

  const calls = await readLog(sandbox);
  const deployCall = calls.find((call) => call.args[0] === "deploy");
  assert.deepEqual(deployCall.args, ["deploy", "--prod"]);
  assert.equal(deployCall.token, "worktoken");
  assert.ok(!deployCall.args.includes("worktoken"));
  const listCall = calls.find((call) => call.args[0] === "list");
  assert.equal(listCall.token, "personaltoken");
});

test("captures Vercel's native login without inheriting a token", async (t) => {
  const sandbox = await createSandbox(t);
  const loggedIn = run(sandbox, ["login", "browser"], {
    env: { VERCEL_TOKEN: "must-not-leak" },
  });
  assert.equal(loggedIn.status, 0, loggedIn.stderr);
  const credentials = await readCredentials(sandbox);
  assert.equal(credentials.profiles.browser.token, "logintoken");
  assert.equal(credentials.profiles.browser.username, "login-user");

  const calls = await readLog(sandbox);
  const loginCall = calls.find((call) => call.args.includes("login"));
  assert.equal(loginCall.token, null);
});

test("rejects bad tokens and refuses non-interactive deletion by default", async (t) => {
  const sandbox = await createSandbox(t);
  const rejected = run(sandbox, ["add", "bad", "--token", "badtoken"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Vercel rejected the token/);

  assert.equal(run(sandbox, ["add", "work", "--token", "worktoken"]).status, 0);
  const refused = run(sandbox, ["remove", "work"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /without --force/);
  assert.equal((await readCredentials(sandbox)).activeProfile, "work");

  const removed = run(sandbox, ["remove", "work", "--force"]);
  assert.equal(removed.status, 0, removed.stderr);
  const credentials = await readCredentials(sandbox);
  assert.equal(credentials.activeProfile, null);
  assert.deepEqual(credentials.profiles, {});
});

test("reports invalid stores and protects profile selection semantics", async (t) => {
  const sandbox = await createSandbox(t);
  await mkdir(sandbox.configDir, { recursive: true });
  await writeFile(
    join(sandbox.configDir, "credentials.json"),
    JSON.stringify({ version: 2, profiles: {} }),
  );
  const corrupt = run(sandbox, ["list"]);
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /Expected version 1/);
  await rm(join(sandbox.configDir, "credentials.json"));

  const invalidName = run(sandbox, [
    "add",
    "Not Valid",
    "--token",
    "worktoken",
  ]);
  assert.equal(invalidName.status, 1);
  assert.match(invalidName.stderr, /Invalid profile name/);

  const noProfile = run(sandbox, ["deploy"]);
  assert.equal(noProfile.status, 1);
  assert.match(noProfile.stderr, /No active profile/);

  assert.equal(
    run(sandbox, ["add", "work", "--token", "worktoken"]).status,
    0,
  );
  const tokenOverride = run(sandbox, ["deploy", "--token", "personaltoken"]);
  assert.equal(tokenOverride.status, 1);
  assert.match(tokenOverride.stderr, /Do not pass --token/);
});
