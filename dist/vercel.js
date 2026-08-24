import { constants } from "node:os";
import spawn from "cross-spawn";
export async function runVercel(args, options = {}) {
    const baseEnv = options.env ?? process.env;
    const childEnv = { ...baseEnv };
    const binary = baseEnv.VCX_VERCEL_BIN || "vercel";
    const vercelArgs = options.globalConfig
        ? ["--global-config", options.globalConfig, ...args]
        : args;
    delete childEnv.VCX_VERCEL_BIN;
    delete childEnv.VERCEL_TOKEN;
    return await new Promise((resolve) => {
        const capture = options.capture === true;
        const child = spawn(binary, vercelArgs, {
            env: childEnv,
            stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
            windowsHide: false,
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        if (capture) {
            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", (chunk) => {
                stdout += chunk;
            });
            child.stderr?.on("data", (chunk) => {
                stderr += chunk;
            });
        }
        const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
        const signalHandlers = new Map();
        for (const signal of forwardedSignals) {
            const handler = () => {
                if (!child.killed)
                    child.kill(signal);
            };
            signalHandlers.set(signal, handler);
            process.once(signal, handler);
        }
        const cleanup = () => {
            for (const [signal, handler] of signalHandlers) {
                process.removeListener(signal, handler);
            }
        };
        child.once("error", (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve({
                code: 1,
                signal: null,
                stdout,
                stderr: error.message,
                missingBinary: error.code === "ENOENT",
            });
        });
        child.once("close", (code, signal) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve({
                code: code ?? signalExitCode(signal),
                signal,
                stdout,
                stderr,
                missingBinary: false,
            });
        });
    });
}
export function findReservedVercelOption(args) {
    for (const argument of args) {
        if (argument === "--")
            return undefined;
        if (argument === "--token" ||
            argument === "-t" ||
            argument.startsWith("--token=")) {
            return "--token";
        }
        if (argument === "--global-config" ||
            argument === "-Q" ||
            argument.startsWith("--global-config=")) {
            return "--global-config";
        }
    }
    return undefined;
}
function signalExitCode(signal) {
    if (!signal)
        return 1;
    const number = constants.signals[signal];
    return typeof number === "number" ? 128 + number : 1;
}
//# sourceMappingURL=vercel.js.map