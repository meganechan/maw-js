import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { tmpdir } from "os";

const CHILD_WRAPPER = `
const { writeFileSync } = await import("fs");
const { dirname, join } = await import("path");
const decoder = new TextDecoder();
const resultFile = process.env.MAW_CHILD_RESULT_FILE;
// The script is a FILE next to resultFile, not a data: URL. Bun caps an import
// specifier at 1536 bytes, so \`import("data:text/javascript;base64," + b64)\`
// blew up with "ResolveMessage: NameTooLong" once the encoded script passed
// 1508 chars — and every script here embeds process.cwd() several times, so
// the same test crossed that line purely by being checked out at a longer
// path (fine at /Users/tony/maw-js, fatal in a deep worktree). A file path
// carries no such ceiling.
const scriptFile = join(dirname(resultFile), "script.mjs");
const stdout = [];
const stderr = [];
const push = (bucket, chunk) => {
  bucket.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
};
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);
const originalExit = process.exit.bind(process);
console.log = (...args) => { stdout.push(args.map(String).join(" ") + "\\n"); };
console.error = (...args) => { stderr.push(args.map(String).join(" ") + "\\n"); };
console.warn = (...args) => { stderr.push(args.map(String).join(" ") + "\\n"); };
process.stdout.write = (chunk) => { push(stdout, chunk); return true; };
process.stderr.write = (chunk) => { push(stderr, chunk); return true; };
class ExitSignal extends Error {
  constructor(code) {
    super("__exit__:" + code);
    this.code = code;
  }
}
let code = 0;
process.exit = (value) => { throw new ExitSignal(Number(value ?? 0)); };
try {
  await import(scriptFile);
} catch (error) {
  if (error instanceof ExitSignal) {
    code = error.code;
  } else {
    code = 1;
    stderr.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
} finally {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exit = originalExit;
  writeFileSync(resultFile, JSON.stringify({ code, stdout: stdout.join(""), stderr: stderr.join("") }));
}
`;

// kobo-482 — only what the child bun process itself needs to run at all
// (find its own binary, resolve homedir, place tempfiles). Everything else
// a test needs (MAW_HOME, MAW_TEST_MODE, CLAUDE_AGENT_NAME, ...) must be
// passed explicitly via opts.env — never inherited from whatever happens to
// be set in the shell that ran `bun test`.
const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"] as const;

function allowlistedChildEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return base;
}

export function runBunChild(opts: {
  script: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): { code: number; stdout: string; stderr: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "maw-bun-child-"));
  const resultFile = join(tempDir, "result.json");
  writeFileSync(join(dirname(resultFile), "script.mjs"), opts.script);
  const proc = spawnSync(process.execPath, ["-e", CHILD_WRAPPER], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: {
      ...allowlistedChildEnv(),
      ...opts.env,
      MAW_CHILD_RESULT_FILE: resultFile,
    },
  });

  try {
    return JSON.parse(readFileSync(resultFile, "utf8")) as {
      code: number;
      stdout: string;
      stderr: string;
    };
  } catch {
    return {
      code: proc.status ?? 1,
      stdout: proc.stdout ?? "",
      stderr: `${proc.stderr ?? ""}${proc.error ? `${proc.stderr ? "\n" : ""}${proc.error.message}` : ""}`,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
