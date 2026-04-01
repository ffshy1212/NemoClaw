#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram → NemoClaw bridge.
 *
 * Messages from Telegram are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Telegram.
 *
 * For photos, the image is saved to /sandbox/data/image/diet/[date]/[time].png
 * and the path is passed to the agent. The agent uses the diet-analyze-image
 * skill to run `claude -p` for vision analysis.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   NVIDIA_API_KEY      — for inference
 *   SANDBOX_NAME        — sandbox name (default: nemoclaw)
 *   ALLOWED_CHAT_IDS    — comma-separated Telegram chat IDs to accept (optional, accepts all if unset)
 */

const https = require("https");
const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

// ── Logger ────────────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(tag, msg) { console.log(`${ts()} [${tag}] ${msg}`); }
function logErr(tag, msg) { console.error(`${ts()} [${tag}] ERROR ${msg}`); }

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "my-assistant";

try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { logErr("init", e.message); process.exit(1); }
const ALLOWED_CHATS = process.env.ALLOWED_CHAT_IDS
  ? process.env.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim())
  : null;

if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

let offset = 0;
const activeSessions = new Map(); // chatId → message history

// ── Telegram API helpers ──────────────────────────────────────────

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      /** @type {any} */({
        hostname: "api.telegram.org",
        path: `/bot${TOKEN}/${method}`,
        method: "POST",
        family: 4, // force IPv4: DNS returns IPv6 but no route exists on this network
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }),
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: buf }); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(chatId, text, replyTo) {
  // Telegram max message length is 4096
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    log("send", `chat=${chatId} len=${chunk.length} text=${chunk.slice(0, 80)}... replyTo=${replyTo}`);
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyTo,
      parse_mode: "Markdown",
    }).catch(() =>
      // Retry without markdown if it fails (unbalanced formatting)
      tgApi("sendMessage", { chat_id: chatId, text: chunk, reply_to_message_id: replyTo }),
    );
  }
}

async function sendTyping(chatId) {
  await tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => { });
}

// ── File download & transfer ──────────────────────────────────────

async function downloadTelegramFile(fileId) {
  log("download", `getFile file_id=${fileId}`);
  const fileInfo = await tgApi("getFile", { file_id: fileId });
  if (!fileInfo.ok) throw new Error(`getFile failed: ${JSON.stringify(fileInfo)}`);

  const filePath = fileInfo.result.file_path;
  const ext = filePath.includes(".") ? filePath.split(".").pop() : "bin";
  const tmpDir = require("fs").mkdtempSync("/tmp/nemoclaw-tg-dl-");
  const tmpPath = `${tmpDir}/attachment.${ext}`;

  await new Promise((resolve, reject) => {
    const file = require("fs").createWriteStream(tmpPath);
    https.get(
      { hostname: "api.telegram.org", path: `/file/bot${TOKEN}/${filePath}`, family: 4 },
      (res) => {
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          const size = require("fs").statSync(tmpPath).size;
          log("download", `saved ${filePath} → ${tmpPath} (${size} bytes)`);
          resolve();
        });
        file.on("error", reject);
      },
    ).on("error", reject);
  });

  return { tmpPath, tmpDir, ext };
}

async function transferToSandbox(localPath, remotePath) {
  log("transfer", `${localPath} → sandbox:${remotePath}`);
  const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });
  const confDir = require("fs").mkdtempSync("/tmp/nemoclaw-tg-ssh-transfer-");
  const confPath = `${confDir}/config`;
  require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });

  const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
  try {
    // Pipe file via SSH stdin + cat — sandbox has no scp/sftp-server
    execFileSync("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, `mkdir -p ${shellQuote(remoteDir)}`]);
    log("transfer", `mkdir -p ${remoteDir}`);
    const fileData = require("fs").readFileSync(localPath);
    execFileSync(
      "ssh",
      ["-T", "-F", confPath, `openshell-${SANDBOX}`, `cat > ${shellQuote(remotePath)}`],
      { input: fileData },
    );
    log("transfer", `done (${fileData.length} bytes)`);
  } finally {
    try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch { /* ignored */ }
  }
  return remotePath;
}

function cleanupLocalFile(tmpPath, tmpDir) {
  try { require("fs").unlinkSync(tmpPath); } catch { /* ignored */ }
  try { require("fs").rmdirSync(tmpDir); } catch { /* ignored */ }
}

async function handleMediaAttachment(msg, chatId) {
  let fileId, fileExt;
  if (msg.photo) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
    fileExt = "jpg";
  } else if (msg.video) {
    fileId = msg.video.file_id;
    fileExt = msg.video.mime_type?.split("/")[1] || "mp4";
  } else {
    fileId = msg.document.file_id;
    fileExt = (msg.document.file_name || "file").split(".").pop();
  }

  const mediaFileType = msg.photo ? "photo" : msg.video ? "video" : "doc";
  const mediaType = msg.photo ? "photo" : msg.video ? "video" : "document";
  log("media", `chat=${chatId} type=${mediaFileType} file_id=${fileId}`);

  const { tmpPath, tmpDir, ext } = await downloadTelegramFile(fileId);
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const time = now.toISOString().slice(11, 19).replace(/:/g, "-"); // HH-MM-SS (UTC)
  const remotePath = msg.photo
    ? `/sandbox/data/image/diet/${date}/${time}.png`
    : `/tmp/tg-${mediaType}-${Date.now()}.${ext || fileExt}`;

  const sandboxFilePath = await transferToSandbox(tmpPath, remotePath);
  cleanupLocalFile(tmpPath, tmpDir);
  log("transfer", `chat=${chatId} sandbox path=${sandboxFilePath}`);
  return sandboxFilePath;
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId, filePath = null) {
  log("agent", `session=${sessionId} filePath=${filePath || "none"} msg=${message.slice(0, 80)}...`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });

    // Write temp ssh config with unpredictable name
    const confDir = require("fs").mkdtempSync("/tmp/nemoclaw-tg-ssh-");
    const confPath = `${confDir}/config`;
    require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const fullMessage = filePath ? `${message}\n\n[附件路徑: ${filePath}]`.trim() : message;
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(fullMessage)} --session-id ${shellQuote("tg-" + safeSessionId)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      const elapsed = Date.now() - t0;
      log("agent", `exit code=${code} elapsed=${elapsed}ms`);
      try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch { /* ignored */ }

      // Extract the actual agent response — skip setup lines and tool call XML
      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          !l.trim().startsWith("<function") &&
          !l.trim().startsWith("<tool_call") &&
          !l.trim().startsWith("<parameter") &&
          !l.trim().startsWith("<method") &&
          !l.trim().startsWith("</parameter") &&
          !l.trim().startsWith("</function") &&
          !l.trim().startsWith("</tool_call") &&
          !l.trim().startsWith("</method>") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => {
      logErr("agent", `spawn error: ${err.message}`);
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Sandbox health check ──────────────────────────────────────────

function isSandboxAlive() {
  try {
    execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

let sandboxFailCount = 0;
setInterval(() => {
  if (!isSandboxAlive()) {
    sandboxFailCount++;
    logErr("health", `sandbox "${SANDBOX}" unreachable (${sandboxFailCount}/3)`);
    if (sandboxFailCount >= 3) {
      logErr("health", "sandbox gone after 3 consecutive failures — exiting");
      process.exit(0);
    }
  } else {
    if (sandboxFailCount > 0) log("health", `sandbox "${SANDBOX}" recovered`);
    sandboxFailCount = 0;
  }
}, 30_000);

// ── Message handler ───────────────────────────────────────────────

function msgText(msg) { return msg.text || msg.caption || ""; }
function mediaTypeOf(msg) {
  if (msg.photo) return "photo";
  if (msg.video) return "video";
  if (msg.document) return "document";
  return "text";
}
function msgHasMedia(msg) { return !!(msg.photo || msg.video || msg.document); }

/** Returns true if the message was a handled command (/start, /reset). */
async function handleCommand(msg, chatId) {
  if (msg.text === "/start") {
    await sendMessage(
      chatId,
      "🦀 *NemoClaw* — powered by Nemotron 3 Super 120B\n\n" +
      "Send me a message and I'll run it through the OpenClaw agent " +
      "inside an OpenShell sandbox.\n\n" +
      "If the agent needs external access, the TUI will prompt for approval.",
      msg.message_id,
    );
    return true;
  }
  if (msg.text === "/reset") {
    activeSessions.delete(chatId);
    await sendMessage(chatId, "Session reset.", msg.message_id);
    return true;
  }
  return false;
}

async function runAgentWithTyping(userText, chatId, sandboxFilePath, messageId) {
  await sendTyping(chatId);
  const typingInterval = setInterval(() => sendTyping(chatId), 4000);
  try {
    const response = await runAgentInSandbox(userText, chatId, sandboxFilePath);
    clearInterval(typingInterval);
    log("reply", `chat=${chatId} len=${response.length} preview=${response.slice(0, 80)}...`);
    await sendMessage(chatId, response, messageId);
  } catch (err) {
    clearInterval(typingInterval);
    logErr("reply", `chat=${chatId} ${err.message}`);
    await sendMessage(chatId, `Error: ${err.message}`, messageId);
  }
}

async function handleMessage(msg) {
  if (!msg?.text && !msgHasMedia(msg)) return;

  const chatId = String(msg.chat.id);

  if (ALLOWED_CHATS && !ALLOWED_CHATS.includes(chatId)) {
    log("access", `chat=${chatId} blocked (not in allowlist)`);
    return;
  }

  log("msg", `chat=${chatId} user=${msg.from?.first_name || "someone"} type=${mediaTypeOf(msg)} text=${msgText(msg).slice(0, 60)}`);

  if (await handleCommand(msg, chatId)) return;

  let sandboxFilePath = null;
  if (msgHasMedia(msg)) {
    try {
      sandboxFilePath = await handleMediaAttachment(msg, chatId);
    } catch (err) {
      logErr("media", `chat=${chatId} download/transfer failed: ${err.message}`);
      await sendMessage(chatId, `無法處理媒體檔案: ${err.message}`, msg.message_id);
      return;
    }
  }

  await runAgentWithTyping(msgText(msg), chatId, sandboxFilePath, msg.message_id);
}

// ── Poll loop ─────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await tgApi("getUpdates", { offset, timeout: 30 });
    if (res.ok && res.result?.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        await handleMessage(update.message);
      }
    }
  } catch (err) {
    logErr("poll", err.message);
  }

  setTimeout(poll, 100);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const me = await tgApi("getMe", {});
  if (!me.ok) {
    console.error("Failed to connect to Telegram:", JSON.stringify(me));
    process.exit(1);
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Telegram Bridge                          │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      @${(me.result.username + "                    ").slice(0, 37)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
  log("init", `sandbox=${SANDBOX} allowlist=${ALLOWED_CHATS ? ALLOWED_CHATS.join(",") : "all"}`);

  poll();
}

main();
