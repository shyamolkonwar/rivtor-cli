import { createInterface } from "node:readline";

/** Asks a question on stderr (stdout stays clean for --json / piping). */
export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: Boolean(process.stdin.isTTY) });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
    rl.on("close", () => {
      if (!answered) resolve("");
    });
  });
}

/** Reads a secret without echoing it (TTY), or one line from piped stdin. */
export function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask("");
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(Object.assign(new Error("Cancelled"), { code: "ABORT" }));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
