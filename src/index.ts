import "dotenv/config";
import { Bot } from "grammy";
import { spawn, ChildProcess } from "child_process";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import pino from "pino";

// --- Config ---

export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  allowedUsers: (process.env.ALLOWED_USERS ?? "")
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id)),
  defaultCwd: process.env.DEFAULT_CWD ?? process.cwd(),
  claudePath: process.env.CLAUDE_PATH ?? "claude",
  claudeConfigPath: process.env.CLAUDE_CONFIG_PATH ?? path.join(process.env.HOME ?? "", ".claude.json"),
};

// --- Logger ---

export const log = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

// --- Types ---

export interface SessionInfo {
  name: string;
  pid: number;
  process: ChildProcess;
  cwd: string;
  url: string | null;
  startedAt: Date;
  lastOutput: string;
  statusMessageId: number | null;
  statusChatId: number | null;
  updateInterval: ReturnType<typeof setInterval> | null;
  lastSentText: string;
}

export const sessions = new Map<string, SessionInfo>();

// --- URL extraction ---

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export const URL_PATTERNS = [
  /https:\/\/claude\.ai\/code\?bridge=[^\s\])>"']*/,
  /https:\/\/claude\.ai\/code\/session\/[^\s\])>"']*/,
  /https:\/\/claude\.ai\/code[^\s\])>"']*/,
];

export function extractUrl(text: string): string | null {
  const clean = stripAnsi(text);
  for (const pattern of URL_PATTERNS) {
    const match = clean.match(pattern);
    if (match) return match[1] ?? match[0];
  }
  return null;
}

// --- MCP config resolution ---

// Read project-specific MCP servers from ~/.claude.json and create a temp config file
export function resolveMcpConfig(cwd: string, configPath: string): string | null {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const projects = config.projects ?? {};

    // Try exact match first, then parent directories
    let mcpServers: Record<string, unknown> | null = null;
    let searchDir = cwd;
    while (searchDir !== path.dirname(searchDir)) {
      if (projects[searchDir]?.mcpServers) {
        mcpServers = projects[searchDir].mcpServers;
        break;
      }
      searchDir = path.dirname(searchDir);
    }

    if (!mcpServers || Object.keys(mcpServers).length === 0) return null;

    // Write to a temp file that remote-control can read
    const tmpFile = path.join(cwd, `.mcp-rc-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ mcpServers }, null, 2));
    log.info({ cwd, mcpServers: Object.keys(mcpServers), tmpFile }, "Resolved MCP config");
    return tmpFile;
  } catch {
    return null;
  }
}

// --- Arg parsing ---

export function generateName(): string {
  return crypto.randomBytes(3).toString("hex");
}

export function parseNewArgs(args: string, defaultCwd: string): { name: string; cwd: string } {
  const trimmed = args.trim();

  if (!trimmed) {
    return { name: generateName(), cwd: defaultCwd };
  }

  const parts = trimmed.split(/\s+/);
  const dirArg = parts[0];
  const name = parts[1] ?? generateName();

  let cwd: string;
  if (path.isAbsolute(dirArg)) {
    cwd = dirArg;
  } else {
    cwd = path.join(defaultCwd, dirArg);
  }

  return { name, cwd };
}

// --- Session management ---

export async function startSession(name: string, cwd: string): Promise<SessionInfo> {
  if (!fs.existsSync(cwd)) {
    throw new Error(`Directory not found: ${cwd}`);
  }

  log.info({ name, cwd, claudePath: config.claudePath }, "Starting claude remote-control");

  const rcArgs = [
    "remote-control",
    "--name", name,
    "--permission-mode", "bypassPermissions",
    "--spawn", "session",
  ];

  const shellCmd = `cd ${JSON.stringify(cwd)} && ${config.claudePath} ${rcArgs.join(" ")}`;
  log.info({ name, shellCmd }, "Spawn command");

  const proc = spawn("/bin/zsh", ["-l", "-c", shellCmd], {
    cwd,
    env: { ...process.env, CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    proc.on("spawn", () => resolve());
    proc.on("error", (err) => reject(err));
  });

  log.info({ name, pid: proc.pid }, "Process spawned");

  const session: SessionInfo = {
    name,
    pid: proc.pid!,
    process: proc,
    cwd,
    url: null,
    startedAt: new Date(),
    lastOutput: "",
    statusMessageId: null,
    statusChatId: null,
    updateInterval: null,
    lastSentText: "",
  };

  const outputBuffer: string[] = [];
  const MAX_LINES = 100;

  const handleOutput = (data: Buffer) => {
    const text = data.toString();
    const clean = stripAnsi(text).trim();
    if (clean) log.info({ name, output: clean.slice(0, 300) }, "Process output");

    const lines = text.split("\n");
    outputBuffer.push(...lines);
    while (outputBuffer.length > MAX_LINES) outputBuffer.shift();
    session.lastOutput = outputBuffer.join("\n");

    // Auto-confirm any (y/n) prompts
    if (text.includes("(y/n)")) {
      log.info({ name }, "Auto-confirming prompt");
      proc.stdin?.write("y\n");
    }

    if (!session.url) {
      const url = extractUrl(text);
      if (url) {
        session.url = url;
        log.info({ name, url }, "Session URL captured");
      }
    }
  };

  proc.stdout?.on("data", handleOutput);
  proc.stderr?.on("data", handleOutput);

  proc.on("error", (err) => {
    log.error({ name, error: err.message }, "Process error");
    session.lastOutput += `\nProcess error: ${err.message}`;
  });

  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log.error({ name, code, lastOutput: stripAnsi(session.lastOutput).slice(-500) }, "Process exited with error");
    } else {
      log.info({ name, code }, "Process exited");
    }
    stopAutoUpdate(session);
    sessions.delete(name);
    notifySessionExit(name, code);
  });

  sessions.set(name, session);
  return session;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(session: SessionInfo): Promise<void> {
  log.info({ name: session.name, pid: session.pid }, "Killing session");
  stopAutoUpdate(session);

  try {
    process.kill(session.pid, "SIGTERM");
  } catch { /* already dead */ }

  // Wait up to 5s for graceful exit
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (isProcessAlive(session.pid)) {
        log.warn({ name: session.name, pid: session.pid }, "SIGTERM timeout, sending SIGKILL");
        try { process.kill(session.pid, "SIGKILL"); } catch { /* ok */ }
      }
      resolve();
    }, 5000);

    const check = setInterval(() => {
      if (!isProcessAlive(session.pid)) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 200);
  });

  sessions.delete(session.name);
}

export function formatUptime(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Wait for URL ---

export function waitForUrl(session: SessionInfo, timeoutMs = 30000): Promise<string | null> {
  return new Promise((resolve) => {
    if (session.url) return resolve(session.url);

    const interval = setInterval(() => {
      if (session.url) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve(session.url);
      }
    }, 1000);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      resolve(session.url);
    }, timeoutMs);
  });
}

// --- Status message ---

function buildStatusText(session: SessionInfo): string {
  const alive = isProcessAlive(session.pid);
  const urlLine = session.url ?? "no URL";
  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return [
    `<b>${session.name}</b>  ${alive ? "🟢" : "🔴"}  up ${formatUptime(session.startedAt)}`,
    urlLine,
    `dir: <code>${session.cwd}</code>`,
    `PID: ${session.pid}`,
    `updated: ${now}`,
  ].join("\n");
}

const NO_PREVIEW = { is_disabled: true } as const;

// --- Auto-update ---

function startAutoUpdate(session: SessionInfo) {
  if (session.updateInterval) return;

  session.updateInterval = setInterval(async () => {
    if (!bot || !session.statusMessageId || !session.statusChatId) return;

    const text = buildStatusText(session);
    if (text === session.lastSentText) return;

    try {
      await bot.api.editMessageText(session.statusChatId, session.statusMessageId, text, {
        parse_mode: "HTML",
        link_preview_options: NO_PREVIEW,
      });
      session.lastSentText = text;
    } catch (err: any) {
      if (!err.description?.includes("message is not modified")) {
        log.error({ name: session.name, error: err.message }, "Auto-update failed");
      }
    }
  }, 10_000);
}

function stopAutoUpdate(session: SessionInfo) {
  if (session.updateInterval) {
    clearInterval(session.updateInterval);
    session.updateInterval = null;
  }
}

// --- Bot setup ---

let botChatIds: number[] = [];
let bot: Bot | null = null;

async function notifySessionExit(name: string, code: number | null) {
  if (!bot) return;
  for (const chatId of botChatIds) {
    try {
      await bot.api.sendMessage(chatId, `Session <b>${name}</b> exited (code: ${code})`, {
        parse_mode: "HTML",
        link_preview_options: NO_PREVIEW,
      });
    } catch {
      // Chat might not be available
    }
  }
}

export function createBot(token: string) {
  bot = new Bot(token);

  bot.catch((err) => {
    log.error({ error: err.message }, "Bot error");
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.allowedUsers.includes(userId)) {
      log.warn({ userId }, "Unauthorized access attempt");
      return;
    }
    if (ctx.chat?.type !== "private") return;

    if (!botChatIds.includes(ctx.chat.id)) {
      botChatIds.push(ctx.chat.id);
    }

    await next();
  });

  bot.command("new", async (ctx) => {
    const args = (ctx.match as string).trim();
    const { name, cwd } = parseNewArgs(args, config.defaultCwd);

    log.info({ name, cwd, user: ctx.from?.id }, "/new command");

    if (sessions.has(name)) {
      const existing = sessions.get(name)!;
      const urlPart = existing.url ? `\n${existing.url}` : "";
      return ctx.reply(
        `Session <b>${name}</b> already running (PID: ${existing.pid})${urlPart}`,
        { parse_mode: "HTML", link_preview_options: NO_PREVIEW },
      );
    }

    let session: SessionInfo;
    try {
      session = await startSession(name, cwd);
    } catch (err: any) {
      log.error({ name, cwd, error: err.message }, "Failed to start session");
      return ctx.reply(`Failed to start: ${err.message}\n\nCLAUDE_PATH: <code>${config.claudePath}</code>`, {
        parse_mode: "HTML",
        link_preview_options: NO_PREVIEW,
      });
    }

    const url = await waitForUrl(session);

    const urlLine = url ?? "no URL yet";
    const text = `<b>${name}</b>\n${urlLine}\ndir: <code>${cwd}</code>  PID: ${session.pid}`;

    const msg = await ctx.reply(text, {
      parse_mode: "HTML",
      link_preview_options: NO_PREVIEW,
    });

    session.statusMessageId = msg.message_id;
    session.statusChatId = msg.chat.id;
    session.lastSentText = text;
    startAutoUpdate(session);
  });

  bot.command("list", async (ctx) => {
    if (sessions.size === 0) return ctx.reply("No active sessions");

    const lines: string[] = [`<b>Active sessions (${sessions.size}):</b>\n`];
    let i = 1;
    for (const [, session] of sessions) {
      const urlLine = session.url ?? "no URL";
      const alive = isProcessAlive(session.pid) ? "🟢" : "🔴";
      lines.push(
        `${i}. <b>${session.name}</b> ${alive}\n   ${urlLine}\n   <code>${session.cwd}</code>\n   up ${formatUptime(session.startedAt)}`,
      );
      i++;
    }

    await ctx.reply(lines.join("\n\n"), { parse_mode: "HTML", link_preview_options: NO_PREVIEW });
  });

  bot.command("stop", async (ctx) => {
    const name = (ctx.match as string).trim();
    if (!name) return ctx.reply("Usage: /stop NAME");
    const session = sessions.get(name);
    if (!session) return ctx.reply(`Session <b>${name}</b> not found`, { parse_mode: "HTML" });
    await killSession(session);
    await ctx.reply(`Session <b>${name}</b> stopped`, { parse_mode: "HTML" });
  });

  bot.command("stopall", async (ctx) => {
    if (sessions.size === 0) return ctx.reply("No active sessions");
    const names = [...sessions.keys()];
    await Promise.all([...sessions.values()].map((s) => killSession(s)));
    await ctx.reply(`Stopped ${names.length} sessions:\n${names.map((n) => `  - ${n}`).join("\n")}`);
  });

  bot.command("status", async (ctx) => {
    const name = (ctx.match as string).trim();
    if (!name) return ctx.reply("Usage: /status NAME");
    const session = sessions.get(name);
    if (!session) return ctx.reply(`Session <b>${name}</b> not found`, { parse_mode: "HTML" });

    const text = buildStatusText(session);
    const msg = await ctx.reply(text, { parse_mode: "HTML", link_preview_options: NO_PREVIEW });

    stopAutoUpdate(session);
    session.statusMessageId = msg.message_id;
    session.statusChatId = msg.chat.id;
    session.lastSentText = text;
    startAutoUpdate(session);
  });

  return bot;
}

// --- Graceful shutdown ---

function shutdown() {
  log.info("Shutting down, killing all sessions...");
  for (const [, session] of sessions) {
    stopAutoUpdate(session);
    try { process.kill(session.pid, "SIGTERM"); } catch { /* ok */ }
  }
  setTimeout(() => {
    for (const [, session] of sessions) {
      if (isProcessAlive(session.pid)) {
        try { process.kill(session.pid, "SIGKILL"); } catch { /* ok */ }
      }
    }
    process.exit(0);
  }, 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start ---

const isDirectRun = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");

if (isDirectRun) {
  if (!config.botToken) {
    log.fatal("TELEGRAM_BOT_TOKEN is required");
    process.exit(1);
  }
  if (config.allowedUsers.length === 0) {
    log.fatal("ALLOWED_USERS is required");
    process.exit(1);
  }

  const b = createBot(config.botToken);

  b.api.setMyCommands([
    { command: "new", description: "Start session — /new [dir] [name]" },
    { command: "list", description: "List active sessions" },
    { command: "stop", description: "Stop session — /stop NAME" },
    { command: "stopall", description: "Stop all sessions" },
    { command: "status", description: "Session status — /status NAME" },
  ]).catch((err) => log.error({ error: err.message }, "Failed to set bot commands"));

  b.start({
    onStart: () => {
      log.info({
        allowedUsers: config.allowedUsers,
        defaultCwd: config.defaultCwd,
        claudePath: config.claudePath,
      }, "Bot started");
    },
  });
}
