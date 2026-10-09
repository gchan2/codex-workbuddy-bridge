#!/usr/bin/env node
// gen_catalog.mjs - build a Codex model_catalog_json for an OpenAI-compatible gateway.
//
// Codex warns "Model metadata for <slug> not found" when its model_catalog_json has no
// entry for the model you use. This script clones a built-in Codex catalog entry (taken
// from 'codex debug models' run in a throwaway CODEX_HOME, so no OpenAI prompt text is
// shipped in this repo) and rewrites the per-model fields from the gateway's /v1/models.
//
// usage:
//   node gen_catalog.mjs --base-url http://gw/v1 --api-key KEY --out ~/.codex/catalog.json

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function argValue(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined ? fallback : v;
}

const baseUrl = String(argValue("base-url", process.env.WORKBUDDY_BASE_URL || "")).replace(/[/]+$/, "");
const apiKey = argValue("api-key", process.env.WORKBUDDY_API_KEY || "");
const outFile = argValue("out", "");
const templateSlug = argValue("template-slug", "gpt-5.5");

if (!baseUrl || !outFile) {
  console.error("usage: gen_catalog.mjs --base-url URL [--api-key KEY] --out FILE [--template-slug SLUG]");
  process.exit(2);
}

async function fetchGatewayModels() {
  const headers = {};
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  const res = await fetch(baseUrl + "/models", { headers });
  if (!res.ok) throw new Error("GET " + baseUrl + "/models -> HTTP " + res.status + " " + res.statusText);
  const body = await res.json();
  const list = body.data || body.models || [];
  if (!Array.isArray(list) || list.length === 0) throw new Error("gateway returned no models");
  return list;
}

// Pull the built-in catalog out of the codex binary using an empty CODEX_HOME, so the
// user's own model_catalog_json cannot interfere.
function readBuiltinTemplate(slug) {
  const home = mkdtempSync(join(tmpdir(), "codex-catalog-"));
  try {
    const raw = execFileSync("codex", ["debug", "models"], {
      env: Object.assign({}, process.env, { CODEX_HOME: home }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const models = JSON.parse(raw).models;
    if (!Array.isArray(models) || models.length === 0) throw new Error("'codex debug models' returned nothing");
    return models.find((m) => m.slug === slug) || models[0];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function buildEntry(template, model, index) {
  const entry = structuredClone(template);
  entry.slug = model.id;
  entry.display_name = model.name || model.id;
  if (model.description) entry.description = model.description;
  const ctx = Number(model.context_length) || entry.context_window;
  entry.context_window = ctx;
  entry.max_context_window = Number(model.max_allowed_size) || ctx;
  entry.input_modalities = model.supports_images ? ["text", "image"] : ["text"];
  entry.supported_in_api = true;
  entry.visibility = "list";
  entry.priority = 1000 - index;
  // These only make sense for the OpenAI model the template was cloned from.
  delete entry.upgrade;
  delete entry.availability_nux;
  delete entry.additional_speed_tiers;
  delete entry.service_tiers;

  const efforts = Array.isArray(model.reasoning_supported_efforts) ? model.reasoning_supported_efforts : [];
  if (efforts.length > 0 && Array.isArray(entry.supported_reasoning_levels)) {
    const known = new Map(entry.supported_reasoning_levels.map((l) => [l.effort, l]));
    const levels = efforts.map((e) => known.get(e) || { effort: e, description: e });
    entry.supported_reasoning_levels = levels;
    const wanted = model.reasoning_default_effort;
    entry.default_reasoning_level =
      wanted && efforts.includes(wanted) ? wanted : levels[Math.min(1, levels.length - 1)].effort;
  }
  return entry;
}

const models = await fetchGatewayModels();
const template = readBuiltinTemplate(templateSlug);
const catalog = { models: models.map((m, i) => buildEntry(template, m, i)) };
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(catalog, null, 2), { mode: 0o644 });
console.log(
  "wrote " + catalog.models.length + " model entries to " + outFile +
  " (template: " + template.slug + ")"
);
