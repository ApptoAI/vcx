import { spawn } from "node:child_process";

export interface VercelRunOptions {
  token?: string;
  capture?: boolean;
  clearToken?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface VercelRunResult {
  code: number;
  stdout: string;
  stderr: string;
  missingBinary: boolean;
}

export async function runVercel(
  args: string[],
  options: VercelRunOptions = {},
): Promise<VercelRunResult> {
  const baseEnv = options.env ?? process.env;
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv };
  const binary = baseEnv.VCX_VERCEL_BIN || "vercel";

  delete childEnv.VCX_VERCEL_BIN;
  if (options.clearToken) {
    delete childEnv.VERCEL_TOKEN;
  }
  if (options.token !== undefined) {
    childEnv.VERCEL_TOKEN = options.token;
  }

  return await new Promise((resolve) => {
    const capture = options.capture === true;
    const child = spawn(binary, args, {
      env: childEnv,
      stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
      windowsHide: false,
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve({
        code: 1,
        stdout,
        stderr: error.message,
        missingBinary: error.code === "ENOENT",
      });
    });

    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        missingBinary: false,
      });
    });
  });
}

export function containsExplicitVercelToken(args: string[]): boolean {
  return args.some(
    (argument) =>
      argument === "--token" ||
      argument === "-t" ||
      argument.startsWith("--token="),
  );
}
