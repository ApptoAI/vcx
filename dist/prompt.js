import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
export class PromptCancelledError extends Error {
    name = "PromptCancelledError";
    constructor() {
        super("Cancelled by user.");
    }
}
export async function promptSecret(label) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error("Interactive token entry requires a TTY. Use --token-stdin for piped input.");
    }
    let muted = false;
    const hiddenOutput = new Writable({
        write(chunk, encoding, callback) {
            if (!muted) {
                process.stderr.write(chunk, encoding);
            }
            callback();
        },
    });
    const prompt = createInterface({
        input: process.stdin,
        output: hiddenOutput,
        terminal: true,
    });
    process.stderr.write(label);
    muted = true;
    try {
        return await questionWithSignal(prompt, "");
    }
    finally {
        muted = false;
        prompt.close();
        process.stderr.write("\n");
    }
}
export async function confirm(message) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error("Confirmation requires an interactive terminal.");
    }
    const prompt = createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    try {
        const answer = await questionWithSignal(prompt, `${message} [y/N] `);
        return answer.trim().toLowerCase() === "y";
    }
    finally {
        prompt.close();
    }
}
export async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
}
async function questionWithSignal(prompt, question) {
    return await new Promise((resolve, reject) => {
        let settled = false;
        const onSignal = () => {
            if (settled)
                return;
            settled = true;
            reject(new PromptCancelledError());
        };
        prompt.once("SIGINT", onSignal);
        prompt.question(question).then((answer) => {
            if (settled)
                return;
            settled = true;
            prompt.removeListener("SIGINT", onSignal);
            resolve(answer);
        }, (error) => {
            if (settled)
                return;
            settled = true;
            prompt.removeListener("SIGINT", onSignal);
            reject(error);
        });
    });
}
//# sourceMappingURL=prompt.js.map