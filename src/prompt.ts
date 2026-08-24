import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "Interactive token entry requires a TTY. Use --token-stdin for piped input.",
    );
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
    return await prompt.question("");
  } finally {
    muted = false;
    prompt.close();
    process.stderr.write("\n");
  }
}

export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }

  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await prompt.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    prompt.close();
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
