#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(ROOT, "scripts");

function run(cmd, opts = {}) {
  spawnSync("bash", ["-c", cmd], {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    ...opts,
  });
}

function needEnv(name) {
  if (!process.env[name]) {
    console.error(`${name} is required. Export it and try again.`);
    process.exit(1);
  }
}

// ── Commands ──────────────────────────────────────────────────────

function setup() {
  needEnv("NVIDIA_API_KEY");
  run(`bash "${SCRIPTS}/setup.sh"`);
}

function deploy(instanceName) {
  needEnv("NVIDIA_API_KEY");
  needEnv("GITHUB_TOKEN");

  const name = instanceName || "nemoclaw";
  const gpu = process.env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";

  console.log("");
  console.log(`  Deploying NemoClaw to Brev instance: ${name}`);
  console.log("");

  // Check if brev CLI exists
  try {
    execSync("which brev", { stdio: "ignore" });
  } catch {
    console.error("brev CLI not found. Install: https://brev.nvidia.com");
    process.exit(1);
  }

  // Check if instance exists
  let exists = false;
  try {
    const out = execSync("brev ls 2>&1", { encoding: "utf-8" });
    exists = out.includes(name);
  } catch {}

  if (!exists) {
    console.log(`  Creating Brev instance '${name}' (${gpu})...`);
    run(`brev create ${name} --gpu "${gpu}"`);
  } else {
    console.log(`  Brev instance '${name}' already exists.`);
  }

  // Wait for SSH
  console.log("  Waiting for SSH...");
  run(`brev shell ${name} -- echo ready`, { stdio: "ignore" });

  // Sync repo to VM
  console.log("  Syncing NemoClaw to VM...");
  run(`brev copy ${name} "${ROOT}" --dest /home/ubuntu/nemoclaw`);

  // Run brev-setup (installs deps + runs setup.sh)
  console.log("  Running brev-setup.sh...");
  run(`brev shell ${name} -- bash -c 'cd /home/ubuntu/nemoclaw && NVIDIA_API_KEY="${process.env.NVIDIA_API_KEY}" GITHUB_TOKEN="${process.env.GITHUB_TOKEN}" bash scripts/brev-setup.sh'`);

  // Start services
  if (process.env.TELEGRAM_BOT_TOKEN) {
    console.log("  Starting services...");
    run(`brev shell ${name} -- bash -c 'cd /home/ubuntu/nemoclaw && NVIDIA_API_KEY="${process.env.NVIDIA_API_KEY}" TELEGRAM_BOT_TOKEN="${process.env.TELEGRAM_BOT_TOKEN}" bash scripts/start-services.sh'`);
  }

  console.log("");
  console.log("  Deploy complete. Connect:");
  console.log(`    brev shell ${name}`);
  console.log("");
}

function start() {
  needEnv("NVIDIA_API_KEY");
  run(`bash "${SCRIPTS}/start-services.sh"`);
}

function stop() {
  run(`bash "${SCRIPTS}/start-services.sh" --stop`);
}

function status() {
  run(`bash "${SCRIPTS}/start-services.sh" --status`);
}

function help() {
  console.log(`
  nemoclaw — NemoClaw CLI

  Usage:
    nemoclaw setup                 Set up locally (gateway, providers, sandbox)
    nemoclaw deploy [name]         Deploy to a Brev VM and start services
    nemoclaw start                 Start services (JensenClaw, Telegram, tunnel)
    nemoclaw stop                  Stop all services
    nemoclaw status                Show service status

  Environment:
    NVIDIA_API_KEY       Required for setup and deploy
    GITHUB_TOKEN         Required for deploy (needs read:packages scope)
    TELEGRAM_BOT_TOKEN   Optional — enables Telegram bridge
    NEMOCLAW_GPU         Brev GPU type (default: a2-highgpu-1g:nvidia-tesla-a100:1)

  Quick start:
    npm install -g nemoclaw
    export NVIDIA_API_KEY=nvapi-...
    nemoclaw setup

  Deploy to the world:
    export GITHUB_TOKEN=ghp_...
    nemoclaw deploy
`);
}

// ── Dispatch ──────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "setup":   setup(); break;
  case "deploy":  deploy(args[0]); break;
  case "start":   start(); break;
  case "stop":    stop(); break;
  case "status":  status(); break;
  case "--help":
  case "-h":
  case "help":
  case undefined: help(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
