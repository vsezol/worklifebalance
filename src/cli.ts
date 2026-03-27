import readline from "readline";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

// --- Paths ---

const CONFIG_DIR = path.join(process.env.HOME ?? "", ".worklifebalance");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const PID_FILE = path.join(CONFIG_DIR, "pid");
const CAFFEINATE_PID_FILE = path.join(CONFIG_DIR, "caffeinate.pid");
const LOG_FILE = path.join(CONFIG_DIR, "bot.log");

// --- Env file helpers ---

function parseEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    env[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return env;
}

function writeEnvFile(filePath: string, env: Record<string, string>) {
  const content = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

// --- Interactive prompts ---

function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function interactiveSetup(): Promise<Record<string, string>> {
  console.log("\nworklifebalance — first-time setup\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const token = await ask(rl, "Telegram bot token (from @BotFather)");
  if (!token) {
    rl.close();
    console.error("Bot token is required.");
    process.exit(1);
  }

  const users = await ask(rl, "Allowed Telegram user IDs (comma-separated)");
  if (!users) {
    rl.close();
    console.error("At least one allowed user ID is required.");
    process.exit(1);
  }

  const defaultCwd = await ask(rl, "Default working directory for sessions", process.cwd());
  const claudePath = await ask(rl, "Path to claude CLI binary", "claude");

  rl.close();

  const env: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: token,
    ALLOWED_USERS: users,
    DEFAULT_CWD: defaultCwd,
    CLAUDE_PATH: claudePath,
  };

  writeEnvFile(ENV_FILE, env);
  console.log(`\nConfig saved to ${ENV_FILE}\n`);
  return env;
}

// --- Process management ---

function readPid(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  return pid;
}

function isRunning(): { running: boolean; pid: number | null } {
  const pid = readPid();
  if (pid === null) return { running: false, pid: null };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Stale PID file — clean up
    try { fs.unlinkSync(PID_FILE); } catch {}
    return { running: false, pid: null };
  }
}

// --- Commands ---

function cmdStart(env: Record<string, string>) {
  const { running, pid } = isRunning();
  if (running) {
    console.log(`Bot is already running (PID: ${pid})`);
    console.log(`Logs: ${LOG_FILE}`);
    return;
  }

  const botScript = path.join(__dirname, "index.js");
  if (!fs.existsSync(botScript)) {
    console.error(`Bot script not found: ${botScript}`);
    console.error("Run 'npm run build' first if developing locally.");
    process.exit(1);
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [botScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...env },
  });

  child.unref();
  fs.closeSync(logFd);

  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(`Bot started (PID: ${child.pid})`);
    console.log(`Logs: ${LOG_FILE}`);

    // Keep Mac awake while bot is running (like Amphetamine)
    // caffeinate -i prevents idle sleep, -w exits when bot process dies
    const caffeinate = spawn("caffeinate", ["-i", "-w", String(child.pid)], {
      detached: true,
      stdio: "ignore",
    });
    caffeinate.unref();
    if (caffeinate.pid) {
      fs.writeFileSync(CAFFEINATE_PID_FILE, String(caffeinate.pid));
      console.log(`Keep-awake enabled (caffeinate PID: ${caffeinate.pid})`);
    }
  } else {
    console.error("Failed to start bot process.");
    process.exit(1);
  }
}

function cmdStop() {
  const { running, pid } = isRunning();
  if (!running) {
    console.log("Bot is not running.");
    return;
  }

  try {
    process.kill(pid!, "SIGTERM");
    console.log(`Bot stopped (PID: ${pid})`);
  } catch (err: any) {
    console.error(`Failed to stop bot: ${err.message}`);
  }

  // Stop caffeinate (it should auto-exit via -w, but clean up just in case)
  try {
    const caffPid = parseInt(fs.readFileSync(CAFFEINATE_PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(caffPid)) {
      process.kill(caffPid, "SIGTERM");
      console.log("Keep-awake disabled.");
    }
  } catch {}
  try { fs.unlinkSync(CAFFEINATE_PID_FILE); } catch {}

  try { fs.unlinkSync(PID_FILE); } catch {}
}

function cmdStatus() {
  const { running, pid } = isRunning();
  if (running) {
    console.log(`Bot is running (PID: ${pid})`);
  } else {
    console.log("Bot is not running.");
  }

  // Check caffeinate status
  let keepAwake = false;
  try {
    const caffPid = parseInt(fs.readFileSync(CAFFEINATE_PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(caffPid)) {
      process.kill(caffPid, 0);
      keepAwake = true;
    }
  } catch {}
  console.log(`Awake:  ${keepAwake ? `yes (caffeinate)` : "no"}`);

  console.log(`Config: ${ENV_FILE}${fs.existsSync(ENV_FILE) ? "" : " (not found)"}`);
  console.log(`Logs:   ${LOG_FILE}${fs.existsSync(LOG_FILE) ? "" : " (not found)"}`);
  console.log(`PID:    ${PID_FILE}`);
}

function cmdLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log("No log file found.");
    return;
  }
  const content = fs.readFileSync(LOG_FILE, "utf-8");
  const lines = content.split("\n");
  const tail = lines.slice(-50).join("\n");
  process.stdout.write(tail + "\n");
}

function cmdHelp() {
  console.log(`
worklifebalance — Claude Code remote session manager via Telegram

Usage:
  worklifebalance              Start bot (interactive setup on first run)
  worklifebalance start        Start bot in background
  worklifebalance stop         Stop bot
  worklifebalance status       Show bot status
  worklifebalance logs         Show last 50 log lines
  worklifebalance help         Show this help

Config: ${ENV_FILE}
Logs:   ${LOG_FILE}
`);
}

// --- Main ---

async function main() {
  const command = process.argv[2] ?? "start";

  if (command === "help" || command === "--help" || command === "-h") {
    cmdHelp();
    return;
  }

  if (command === "stop") {
    cmdStop();
    return;
  }

  if (command === "status") {
    cmdStatus();
    return;
  }

  if (command === "logs") {
    cmdLogs();
    return;
  }

  if (command === "start" || !process.argv[2]) {
    let env: Record<string, string>;
    if (fs.existsSync(ENV_FILE)) {
      env = parseEnvFile(ENV_FILE);
    } else {
      env = await interactiveSetup();
    }
    cmdStart(env);
    return;
  }

  console.error(`Unknown command: ${command}`);
  cmdHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
