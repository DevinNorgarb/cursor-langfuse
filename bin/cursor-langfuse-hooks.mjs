#!/usr/bin/env node

import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const GLOBAL_DIR = path.join(os.homedir(), ".cursor", "hooks", "langfuse");
const GLOBAL_HANDLER = path.join(GLOBAL_DIR, "hook-handler.js");

function printHelp(exitCode = 0) {
  // Keep output concise; this is an operator CLI.
  // eslint-disable-next-line no-console
  console.log(`
cursor-langfuse-hooks

Usage:
  cursor-langfuse-hooks install-global --from <path-to-cursor-langfuse-repo>
  cursor-langfuse-hooks init [--project <path>]
  cursor-langfuse-hooks doctor

Commands:
  install-global   Copy hook runtime to ~/.cursor/hooks/langfuse and npm install once
  init             Create/update .cursor/hooks.json in a project to point to global handler
  doctor           Print checks for global install + current project

Notes:
  - Credentials are read from ~/.cursor/.env first, then <project>/.env.
  - Cursor hooks are configured per-project via .cursor/hooks.json.
`.trim());
  process.exit(exitCode);
}

function fail(message, code = 1) {
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const flags = new Map();

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i++;
    }
  }

  return { cmd, flags };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(srcDir, destDir) {
  // Node 18+ supports fs.cp; use it for correctness + simplicity.
  await fsp.cp(srcDir, destDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (res.error) fail(res.error.message);
  if (typeof res.status === "number" && res.status !== 0) {
    fail(`Command failed: ${cmd} ${args.join(" ")}`, res.status);
  }
}

function hooksJsonForGlobalHandler() {
  const command = `node ${GLOBAL_HANDLER}`;
  return {
    version: 1,
    hooks: {
      beforeSubmitPrompt: [{ command }],
      afterAgentResponse: [{ command }],
      afterAgentThought: [{ command }],
      beforeShellExecution: [{ command }],
      afterShellExecution: [{ command }],
      beforeMCPExecution: [{ command }],
      afterMCPExecution: [{ command }],
      beforeReadFile: [{ command }],
      afterFileEdit: [{ command }],
      stop: [{ command }],
      beforeTabFileRead: [{ command }],
      afterTabFileEdit: [{ command }],
    },
  };
}

async function writeHooksJson(projectDir) {
  const cursorDir = path.join(projectDir, ".cursor");
  await ensureDir(cursorDir);

  const hooksJsonPath = path.join(cursorDir, "hooks.json");

  const next = JSON.stringify(hooksJsonForGlobalHandler(), null, 2) + "\n";

  // Backup if overwriting an existing file that differs.
  if (await pathExists(hooksJsonPath)) {
    const current = await fsp.readFile(hooksJsonPath, "utf8");
    if (current !== next) {
      const backupPath = `${hooksJsonPath}.bak`;
      await fsp.copyFile(hooksJsonPath, backupPath);
    }
  }

  await fsp.writeFile(hooksJsonPath, next, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${hooksJsonPath}`);
}

async function installGlobal(fromPath) {
  if (!fromPath) {
    fail("Missing required flag: --from <path-to-cursor-langfuse-repo>");
  }

  const repoPath = path.resolve(fromPath);
  const srcHooksDir = path.join(repoPath, ".cursor", "hooks");

  if (!(await pathExists(srcHooksDir))) {
    fail(`Not found: ${srcHooksDir}`);
  }

  await ensureDir(GLOBAL_DIR);
  await copyDir(srcHooksDir, GLOBAL_DIR);

  // Ensure the handler is executable if invoked directly.
  try {
    await fsp.chmod(path.join(GLOBAL_DIR, "hook-handler.js"), 0o755);
  } catch {
    // Non-fatal; node invocation still works.
  }

  // Install dependencies once globally.
  if (await pathExists(path.join(GLOBAL_DIR, "package.json"))) {
    run("npm", ["install", "--silent"], GLOBAL_DIR);
  } else {
    fail(`Global hook runtime missing package.json at ${GLOBAL_DIR}`);
  }

  // eslint-disable-next-line no-console
  console.log(`Global runtime installed at ${GLOBAL_DIR}`);
}

async function doctor(projectDir) {
  const checks = [];

  checks.push({
    name: "Global hook handler",
    ok: await pathExists(GLOBAL_HANDLER),
    detail: GLOBAL_HANDLER,
  });
  checks.push({
    name: "Global node_modules",
    ok: await pathExists(path.join(GLOBAL_DIR, "node_modules")),
    detail: path.join(GLOBAL_DIR, "node_modules"),
  });
  checks.push({
    name: "Global env (~/.cursor/.env)",
    ok: await pathExists(path.join(os.homedir(), ".cursor", ".env")),
    detail: path.join(os.homedir(), ".cursor", ".env"),
  });

  const hooksJsonPath = path.join(projectDir, ".cursor", "hooks.json");
  checks.push({
    name: "Project hooks.json",
    ok: await pathExists(hooksJsonPath),
    detail: hooksJsonPath,
  });

  // eslint-disable-next-line no-console
  console.log(`Project: ${projectDir}`);
  for (const c of checks) {
    // eslint-disable-next-line no-console
    console.log(`${c.ok ? "OK " : "ERR"} ${c.name}: ${c.detail}`);
  }

  const hasErr = checks.some((c) => !c.ok);
  process.exit(hasErr ? 2 : 0);
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv);

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp(0);
  }

  if (cmd === "install-global") {
    await installGlobal(flags.get("from"));
    return;
  }

  if (cmd === "init") {
    const project = flags.get("project")
      ? path.resolve(flags.get("project"))
      : process.cwd();
    if (!(await pathExists(GLOBAL_HANDLER))) {
      fail(
        `Global handler not found at ${GLOBAL_HANDLER}\nRun: cursor-langfuse-hooks install-global --from <path-to-cursor-langfuse-repo>`
      );
    }
    await writeHooksJson(project);
    return;
  }

  if (cmd === "doctor") {
    const project = flags.get("project")
      ? path.resolve(flags.get("project"))
      : process.cwd();
    await doctor(project);
    return;
  }

  printHelp(1);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
