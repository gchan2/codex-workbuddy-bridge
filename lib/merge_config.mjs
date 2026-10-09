#!/usr/bin/env node
// merge_config.mjs - point an existing Codex config.toml at the workbuddy bridge.
//
// Text-level merge. It rewrites only:
//   * the managed top-level keys listed in MANAGED_KEYS
//   * the [model_providers.<provider>] table
// Everything else (mcp_servers, plugins, marketplaces, projects, tui, other providers)
// is preserved byte for byte, and all remaining top-level keys stay above the first
// table header. A timestamped backup of the original file is written next to it.
//
// usage:
//   node merge_config.mjs --config ~/.codex/config.toml --base-url http://127.0.0.1:8799/v1 \
//        --key KEY [--model cn:deepseek-v4.1-flash] [--catalog FILE] [--dry-run]

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BS = String.fromCharCode(92);

function argValue(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}
function hasFlag(name) {
  return process.argv.includes("--" + name);
}
function tomlString(value) {
  const s = String(value).split(BS).join(BS + BS).split('"').join(BS + '"');
  return '"' + s + '"';
}
function keyName(line) {
  const t = line.trim();
  if (!t || t.startsWith("#")) return "";
  const eq = t.indexOf("=");
  if (eq <= 0) return "";
  return t.slice(0, eq).trim();
}
function trimBlank(lines) {
  const out = lines.slice();
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

const configPath = argValue("config", "");
const providerName = argValue("provider", "workbuddy");
const baseUrl = argValue("base-url", "http://127.0.0.1:8799/v1");
const apiKey = argValue("key", "");
const model = argValue("model", "");
const catalog = argValue("catalog", "");
const effort = argValue("reasoning-effort", "high");
const dryRun = hasFlag("dry-run");

if (!configPath) {
  console.error("usage: merge_config.mjs --config FILE --base-url URL --key KEY [--model M] [--catalog F] [--dry-run]");
  process.exit(2);
}

const MANAGED_KEYS = [
  "model_provider",
  "model",
  "model_reasoning_effort",
  "model_catalog_json",
  "preferred_auth_method",
  "forced_login_method",
  "disable_response_storage", // dropped: ignored by codex >= 0.150
];
const providerHeader = "[model_providers." + providerName + "]";

const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const rawLines = original.split(LF).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));

// Region 1: everything before the first table header = top-level keys.
let firstHeader = rawLines.findIndex((l) => l.trim().startsWith("["));
if (firstHeader < 0) firstHeader = rawLines.length;
const removed = [];
const topKeys = [];
for (const line of rawLines.slice(0, firstHeader)) {
  if (MANAGED_KEYS.includes(keyName(line))) {
    removed.push(line);
    continue;
  }
  topKeys.push(line);
}

// Region 2: the tables. Drop the previous provider table, keep the rest.
const tables = [];
let inOurTable = false;
for (const line of rawLines.slice(firstHeader)) {
  const t = line.trim();
  if (t.startsWith("[")) {
    inOurTable = t === providerHeader;
    if (inOurTable) {
      removed.push(line);
      continue;
    }
    tables.push(line);
    continue;
  }
  if (inOurTable) {
    removed.push(line);
    continue;
  }
  tables.push(line);
}

const managed = ["model_provider = " + tomlString(providerName)];
if (model) managed.push("model = " + tomlString(model));
managed.push("model_reasoning_effort = " + tomlString(effort));
if (catalog) managed.push("model_catalog_json = " + tomlString(catalog));
// NOTE: preferred_auth_method is intentionally not written - codex >= 0.162
// reports it as an unrecognized setting ("Codex is ignoring 1 unrecognized
// configuration setting ... preferred_auth_method is ignored") and exits with a
// warning. forced_login_method is still honoured.
managed.push('forced_login_method = "api"');

const provider = [
  providerHeader,
  'name = "workbuddy (gateway via local Responses/chat bridge)"',
  'wire_api = "responses"',
  "base_url = " + tomlString(baseUrl),
  "experimental_bearer_token = " + tomlString(apiKey),
];

const parts = [managed.join(LF)];
const rest = trimBlank(topKeys);
if (rest.length > 0) parts.push(rest.join(LF));
parts.push(provider.join(LF));
const body = trimBlank(tables);
if (body.length > 0) parts.push(body.join(LF));
const out = parts.join(LF + LF) + LF;

if (dryRun) {
  process.stdout.write(out);
  process.exit(0);
}

mkdirSync(dirname(configPath), { recursive: true });
if (existsSync(configPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = configPath + ".bak-" + stamp;
  copyFileSync(configPath, backup);
  console.log("backup: " + backup);
}
writeFileSync(configPath, out, { mode: 0o600 });
try {
  chmodSync(configPath, 0o600);
} catch (e) {
  /* best effort */
}
console.log("updated " + configPath + " (rewrote " + removed.length + " old line(s), kept " + body.length + " table line(s))");
