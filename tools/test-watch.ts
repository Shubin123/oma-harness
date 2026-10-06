/** Persistent offline checks. Source changes during a run trigger another complete run. */
import fs from "node:fs";
import crypto from "node:crypto";
fs.mkdirSync(".build_cache", { recursive: true });
fs.writeFileSync(".build_cache/test-watch.pid", String(process.pid));
const historyFile = ".build_cache/test-history.json",
  statusFile = ".build_cache/test-status.json";
let running: ReturnType<typeof Bun.spawn> | undefined,
  stopping = false;
for (const name of ["SIGINT", "SIGTERM"] as const)
  process.on(name, () => {
    stopping = true;
    running?.kill();
  });
function signature(): string {
  const files = new Bun.Glob("{packages,apps,tools,tests}/**/*.ts").scanSync({
    cwd: process.cwd(),
    onlyFiles: true,
  });
  const paths = [...files]
    .filter((p) => !p.includes("/generated/"))
    .concat(["package.json", "bun.lock", "tsconfig.json", "bunfig.toml"])
    .sort();
  const hash = crypto.createHash("sha256");
  for (const p of paths) {
    hash.update(p);
    hash.update(fs.readFileSync(p));
  }
  return hash.digest("hex");
}
function writeStatus(value: Record<string, unknown>) {
  fs.writeFileSync(
    statusFile,
    JSON.stringify({ pid: process.pid, ...value }, null, 2),
  );
}
let last = "";
while (!stopping) {
  const current = signature();
  if (current !== last) {
    last = current;
    const started = Date.now();
    writeStatus({
      status: "running",
      started_at: new Date(started).toISOString(),
    });
    console.log(
      "\n[" +
        new Date().toISOString() +
        "] Running type checks, Bun builds, unit/integration and browser tests.",
    );
    running = Bun.spawn(["bun", "run", "check"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let output = "";
    const forward = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder(),
        reader = stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        output += text;
        process.stdout.write(text);
      }
    };
    await Promise.all([
      forward(running.stdout as ReadableStream<Uint8Array>),
      forward(running.stderr as ReadableStream<Uint8Array>),
    ]);
    const code = await running.exited;
    running = undefined;
    const passed = [...output.matchAll(/(?:^|\n)\s*(\d+) pass\b/g)].reduce(
      (n, m) => n + Number(m[1]),
      0,
    );
    const failed = [...output.matchAll(/(?:^|\n)\s*(\d+) fail\b/g)].reduce(
      (n, m) => n + Number(m[1]),
      0,
    );
    const result = {
      status: code === 0 ? "passed" : "failed",
      started_at: new Date(started).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      passed,
      failed,
      exit_code: code,
    };
    let history: Array<Record<string, unknown>> = [];
    try {
      history = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    } catch {}
    fs.writeFileSync(
      historyFile,
      JSON.stringify([...history, result].slice(-50), null, 2),
    );
    writeStatus({ ...result, watching: true });
    console.log(
      "Watching for changes. Live subscriptions are tested only with bun run test:live.",
    );
  }
  await Bun.sleep(1000);
}
writeStatus({ status: "stopped" });
