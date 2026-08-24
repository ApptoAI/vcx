import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
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
import test from "node:test";

const CLI_PATH = resolve("dist/cli.js");

async function createSandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "vcx-test-"));
  const configDir = join(root, "config");
  const logPath = join(root, "vercel.log");
  const scriptPath = join(root, "fake-vercel.mjs");
  const launcherPath =
    process.platform === "win32"
      ? join(root, "fake-vercel.cmd")
      : join(root, "fake-vercel");

  const fakeVercel = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const globalConfigIndex = args.indexOf("--global-config");
const globalConfig = globalConfigIndex >= 0 ? args[globalConfigIndex + 1] : undefined;
const commandArgs = globalConfigIndex >= 0
  ? [...args.slice(0, globalConfigIndex), ...args.slice(globalConfigIndex + 2)]
  : args;
const command = commandArgs[0];
const logPath = process.env.FAKE_VERCEL_LOG;
if (logPath) {
  appendFileSync(logPath, JSON.stringify({
    args,
    commandArgs,
    globalConfig: globalConfig ?? null,
    envToken: process.env.VERCEL_TOKEN ?? null,
  }) + "\\n");
}

if (command === "login") {
  if (!globalConfig) process.exit(2);
  mkdirSync(globalConfig, { recursive: true });
  writeFileSync(join(globalConfig, "auth.json"), JSON.stringify({ token: "logintoken" }));
  writeFileSync(join(globalConfig, "config.json"), JSON.stringify({ telemetry: { enabled: false } }));
  console.log("Fake browser login complete");
  process.exit(0);
}

let token;
if (globalConfig && existsSync(join(globalConfig, "auth.json"))) {
  token = JSON.parse(readFileSync(join(globalConfig, "auth.json"), "utf8")).token;
}

if (command === "whoami") {
  if (!token || token === "badtoken") {
    console.error("invalid credentials");
    process.exit(9);
  }
  const names = {
    worktoken: "work-user",
    personaltoken: "personal-user",
    logintoken: "login-user",
  };
  console.log(names[token] ?? "test-user");
  process.exit(0);
}

if (command === "logout") {
  if (globalConfig) rmSync(join(globalConfig, "auth.json"), { force: true });
  console.log("Logged out");
  process.exit(0);
}

if (command === "exit-7") process.exit(7);
if (command === "wait-for-signal") setInterval(() => {}, 1_000);
if (commandArgs.includes("--version")) {
  console.log("99.0.0");
  process.exit(0);
}

console.log("fake vercel command");
`;
  await writeFile(scriptPath, fakeVercel, { mode: 0o755 });

  if (process.platform === "win32") {
    const nodePath = process.execPath.replaceAll("%", "%%");
    await writeFile(
      launcherPath,
      `@echo off\r\n"${nodePath}" "%~dp0\\fake-vercel.mjs" %*\r\n`,
    );
  } else {
    await writeFile(
      launcherPath,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
      { mode: 0o755 },
    );
    await chmod(launcherPath, 0o755);
  }

  if (process.env.VCX_KEEP_TEST_TEMP) {
    process.stderr.write(`vcx test sandbox: ${root}\n`);
  } else {
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
  }
  return { root, configDir, logPath, launcherPath };
}

function childEnv(sandbox, overrides = {}) {
  const env = {
    ...process.env,
    VCX_CONFIG_DIR: sandbox.configDir,
    VCX_VERCEL_BIN: sandbox.launcherPath,
    FAKE_VERCEL_LOG: sandbox.logPath,
  };
  delete env.VERCEL_TOKEN;
  delete env.VCX_PROFILE;
  Object.assign(env, overrides);
  return env;
}

function run(sandbox, args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    input: options.input,
    env: childEnv(sandbox, options.env),
  });
}

function runAsync(sandbox, args, options = {}) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    env: childEnv(sandbox, options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolveResult) => {
    child.on("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  });
  return { child, completed };
}

async function readProfiles(sandbox) {
  return JSON.parse(
    await readFile(join(sandbox.configDir, "profiles.json"), "utf8"),
  );
}

async function readAuth(sandbox, name) {
  return JSON.parse(
    await readFile(
      join(sandbox.configDir, "profiles", name, "auth.json"),
      "utf8",
    ),
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

test("stores and verifies a profile in an isolated Vercel config", async (t) => {
  const sandbox = await createSandbox(t);
  const added = run(sandbox, [
    "profile",
    "add",
    "work",
    "--token",
    "worktoken",
  ]);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /Added profile "work" \(work-user\)/);
  assert.match(added.stderr, /stores Vercel credentials as plaintext/);

  const profiles = await readProfiles(sandbox);
  assert.equal(profiles.version, 2);
  assert.equal(profiles.activeProfile, "work");
  assert.equal(profiles.profiles.work.username, "work-user");
  assert.equal("token" in profiles.profiles.work, false);
  assert.equal((await readAuth(sandbox, "work")).token, "worktoken");

  if (process.platform !== "win32") {
    assert.equal((await stat(sandbox.configDir)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(sandbox.configDir, "profiles.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (
        await stat(
          join(sandbox.configDir, "profiles", "work", "auth.json"),
        )
      ).mode & 0o777,
      0o600,
    );
  }

  const listed = run(sandbox, ["profile", "list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).activeProfile, "work");
  assert.doesNotMatch(listed.stdout, /worktoken/);
});

test("uses profile configs and clears inherited tokens", async (t) => {
  const sandbox = await createSandbox(t);
  assert.equal(
    run(sandbox, ["profile", "add", "work", "--token", "worktoken"]).status,
    0,
  );
  assert.equal(
    run(sandbox, [
      "profile",
      "add",
      "personal",
      "--token",
      "personaltoken",
    ]).status,
    0,
  );
  assert.equal(run(sandbox, ["profile", "use", "work"]).status, 0);

  const deploy = run(sandbox, ["deploy", "--prod"], {
    env: { VERCEL_TOKEN: "must-not-leak" },
  });
  assert.equal(deploy.status, 0, deploy.stderr);
  const oneShot = run(sandbox, [
    "exec",
    "--profile",
    "personal",
    "--",
    "list",
  ]);
  assert.equal(oneShot.status, 0, oneShot.stderr);
  const alias = run(sandbox, ["vercel", "-p", "personal", "whoami"]);
  assert.equal(alias.status, 0, alias.stderr);

  const calls = await readLog(sandbox);
  const deployCall = calls.find((call) => call.commandArgs[0] === "deploy");
  assert.equal(deployCall.envToken, null);
  assert.match(deployCall.globalConfig, /profiles[/\\]work$/);
  assert.ok(!deployCall.args.includes("worktoken"));
  const listCall = calls.find((call) => call.commandArgs[0] === "list");
  assert.match(listCall.globalConfig, /profiles[/\\]personal$/);
});

test("does not shadow Vercel list, login, logout, or rm", async (t) => {
  const sandbox = await createSandbox(t);
  assert.equal(
    run(sandbox, ["profile", "add", "work", "--token", "worktoken"]).status,
    0,
  );

  for (const command of ["list", "rm", "login"]) {
    const result = run(sandbox, [command, "target"]);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
  const logout = run(sandbox, ["logout"]);
  assert.equal(logout.status, 0, logout.stderr);
  await assert.rejects(access(join(sandbox.configDir, "profiles", "work", "auth.json")));

  const calls = await readLog(sandbox);
  for (const command of ["list", "rm", "login", "logout"]) {
    assert.ok(calls.some((call) => call.commandArgs[0] === command));
  }
});

test("captures native login inside the selected profile", async (t) => {
  const sandbox = await createSandbox(t);
  const loggedIn = run(sandbox, ["profile", "login", "browser"], {
    env: { VERCEL_TOKEN: "must-not-leak" },
  });
  assert.equal(loggedIn.status, 0, loggedIn.stderr);
  assert.equal((await readAuth(sandbox, "browser")).token, "logintoken");
  assert.equal((await readProfiles(sandbox)).profiles.browser.username, "login-user");

  const calls = await readLog(sandbox);
  const loginCall = calls.find((call) => call.commandArgs[0] === "login");
  assert.equal(loginCall.envToken, null);
  assert.notEqual(
    loginCall.globalConfig,
    join(sandbox.configDir, "profiles", "browser"),
  );
  await assert.rejects(access(loginCall.globalConfig));
});

test("migrates the old plaintext token store without retaining duplicate tokens", async (t) => {
  const sandbox = await createSandbox(t);
  await mkdir(sandbox.configDir, { recursive: true });
  await writeFile(
    join(sandbox.configDir, "credentials.json"),
    JSON.stringify({
      version: 1,
      activeProfile: "work",
      profiles: {
        work: {
          token: "worktoken",
          username: "work-user",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );

  const listed = run(sandbox, ["profile", "list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal((await readProfiles(sandbox)).version, 2);
  assert.equal((await readAuth(sandbox, "work")).token, "worktoken");
  await assert.rejects(access(join(sandbox.configDir, "credentials.json")));
});

test("accepts opaque tokens and supports offline storage", async (t) => {
  const sandbox = await createSandbox(t);
  const missingBinary = join(sandbox.root, "missing-vercel");
  const added = run(
    sandbox,
    ["profile", "add", "offline", "--token", "future-token.value", "--no-verify"],
    { env: { VCX_VERCEL_BIN: missingBinary } },
  );
  assert.equal(added.status, 0, added.stderr);
  assert.equal((await readAuth(sandbox, "offline")).token, "future-token.value");

  const forwarded = run(sandbox, ["whoami"], {
    env: { VCX_VERCEL_BIN: missingBinary },
  });
  assert.equal(forwarded.status, 1);
  assert.match(forwarded.stderr, /Could not find the Vercel CLI/);
});

test("rejects reserved auth options and malformed profile selection", async (t) => {
  const sandbox = await createSandbox(t);
  assert.equal(
    run(sandbox, ["profile", "add", "work", "--token", "worktoken"]).status,
    0,
  );

  for (const args of [
    ["deploy", "--token", "other"],
    ["deploy", "--token=other"],
    ["deploy", "-t", "other"],
    ["deploy", "--global-config", "elsewhere"],
    ["deploy", "-Q", "elsewhere"],
  ]) {
    const result = run(sandbox, args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /Do not pass/);
  }
  const emptyProfile = run(sandbox, ["exec", "--profile=", "--", "list"]);
  assert.equal(emptyProfile.status, 1);
  assert.match(emptyProfile.stderr, /requires a profile name/);
});

test("uses consistent failure codes for no selection and cancelled deletion", async (t) => {
  const sandbox = await createSandbox(t);
  const current = run(sandbox, ["profile", "current", "--json"]);
  assert.equal(current.status, 1);
  assert.equal(current.stdout.trim(), "null");

  assert.equal(
    run(sandbox, ["profile", "add", "work", "--token", "worktoken"]).status,
    0,
  );
  const refused = run(sandbox, ["profile", "remove", "work"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /without --force/);

  const removed = run(sandbox, ["profile", "remove", "work", "--force"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal((await readProfiles(sandbox)).activeProfile, null);
  await assert.rejects(access(join(sandbox.configDir, "profiles", "work")));
});

test("serializes concurrent profile updates", async (t) => {
  const sandbox = await createSandbox(t);
  const first = runAsync(sandbox, [
    "profile",
    "add",
    "first",
    "--token",
    "first.token",
    "--no-verify",
  ]);
  const second = runAsync(sandbox, [
    "profile",
    "add",
    "second",
    "--token",
    "second.token",
    "--no-verify",
  ]);
  const [firstResult, secondResult] = await Promise.all([
    first.completed,
    second.completed,
  ]);
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.equal(secondResult.code, 0, secondResult.stderr);
  const profiles = await readProfiles(sandbox);
  assert.deepEqual(Object.keys(profiles.profiles).sort(), ["first", "second"]);
});

test("propagates Vercel exit codes and termination signals", async (t) => {
  const sandbox = await createSandbox(t);
  assert.equal(
    run(sandbox, ["profile", "add", "work", "--token", "worktoken"]).status,
    0,
  );
  assert.equal(run(sandbox, ["exit-7"]).status, 7);

  if (process.platform !== "win32") {
    const waiting = runAsync(sandbox, ["wait-for-signal"]);
    await waitForLog(sandbox, "wait-for-signal");
    waiting.child.kill("SIGTERM");
    const result = await waiting.completed;
    assert.equal(result.code, 143, result.stderr);
  }
});

test("reports version, help, profile path, and unknown profiles", async (t) => {
  const sandbox = await createSandbox(t);
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal(run(sandbox, ["--version"]).stdout.trim(), packageJson.version);
  assert.match(run(sandbox, ["--help"]).stdout, /vcx profile <command>/);
  assert.match(
    run(sandbox, ["profile", "--help"]).stdout,
    /profile login <name>/,
  );
  assert.equal(
    run(sandbox, ["profile", "path"]).stdout.trim(),
    sandbox.configDir,
  );
  const unknown = run(sandbox, ["exec", "-p", "missing", "whoami"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown profile/);
});

async function waitForLog(sandbox, command) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const calls = await readLog(sandbox);
    if (calls.some((call) => call.commandArgs[0] === command)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${command}`);
}
