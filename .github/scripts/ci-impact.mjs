#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultConfigPath = ".github/ci-impact.json";

function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matches(path, pattern) {
  return globToRegExp(pattern).test(path);
}

export function validateConfig(config) {
  if (config?.schemaVersion !== 1) throw new Error("CI impact config must use schemaVersion 1.");
  if (!Array.isArray(config.jobs) || config.jobs.length === 0) throw new Error("CI impact config needs jobs.");
  if (config.jobs.some((job) => typeof job !== "string" || !/^[a-z][a-z0-9-]*$/.test(job) || ["impact", "security", "required"].includes(job))) throw new Error("Invalid CI impact job.");
  if (new Set(config.jobs).size !== config.jobs.length) throw new Error("CI impact jobs must be unique.");
  if (!Array.isArray(config.fullRunPatterns)) throw new Error("CI impact config needs fullRunPatterns.");
  if (!Array.isArray(config.rules) || config.rules.length === 0) throw new Error("CI impact config needs rules.");
  const patternsValid = (patterns) => patterns.every((pattern) => typeof pattern === "string" && pattern.length > 0);
  if (!patternsValid(config.fullRunPatterns)) throw new Error("Invalid full-run patterns.");
  const jobSet = new Set(config.jobs);
  const ruleIds = new Set();
  for (const rule of config.rules) {
    if (!rule.id || !Array.isArray(rule.patterns) || rule.patterns.length === 0 || !Array.isArray(rule.jobs)) {
      throw new Error("Every CI impact rule needs id, patterns and jobs.");
    }
    if (ruleIds.has(rule.id) || !patternsValid(rule.patterns)) throw new Error("Invalid or duplicate CI impact rule.");
    ruleIds.add(rule.id);
    for (const job of rule.jobs) {
      if (!jobSet.has(job)) throw new Error(`Unknown CI impact job ${job} in rule ${rule.id}.`);
    }
  }
}

function fullSelection(config, reason, changedPaths = []) {
  return {
    schemaVersion: 1,
    full: true,
    reason,
    changedPaths,
    unmatchedPaths: [],
    matchedRules: [],
    jobs: Object.fromEntries(config.jobs.map((job) => [job, true])),
  };
}

export function selectImpact({ config, eventName, changedPaths }) {
  validateConfig(config);
  const normalizedPaths = [...new Set(changedPaths.map((path) => path.replaceAll("\\", "/")).filter(Boolean))].sort();
  if (eventName !== "pull_request") return fullSelection(config, `event:${eventName || "unknown"}`, normalizedPaths);
  if (normalizedPaths.length === 0) return fullSelection(config, "empty-diff", normalizedPaths);

  const fullPath = normalizedPaths.find((path) => config.fullRunPatterns.some((pattern) => matches(path, pattern)));
  if (fullPath) return fullSelection(config, `full-run-path:${fullPath}`, normalizedPaths);

  const selectedJobs = new Set();
  const matchedRules = new Set();
  const unmatchedPaths = [];
  for (const path of normalizedPaths) {
    const pathRules = config.rules.filter((rule) => rule.patterns.some((pattern) => matches(path, pattern)));
    if (pathRules.length === 0) {
      unmatchedPaths.push(path);
      continue;
    }
    for (const rule of pathRules) {
      matchedRules.add(rule.id);
      for (const job of rule.jobs) selectedJobs.add(job);
    }
  }
  if (unmatchedPaths.length > 0) {
    const plan = fullSelection(config, "unmatched-path", normalizedPaths);
    plan.unmatchedPaths = unmatchedPaths;
    return plan;
  }

  return {
    schemaVersion: 1,
    full: false,
    reason: "matched-impact-rules",
    changedPaths: normalizedPaths,
    unmatchedPaths,
    matchedRules: [...matchedRules].sort(),
    jobs: Object.fromEntries(config.jobs.map((job) => [job, selectedJobs.has(job)])),
  };
}

function readChangedPaths(base, head) {
  if (!base || !head) throw new Error("Pull request impact selection needs base and head SHAs.");
  const result = spawnSync("git", ["diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", "-z", `${base}...${head}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git diff failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

function appendFile(path, content) {
  if (!path) return;
  fs.appendFileSync(path, content, "utf8");
}

export function renderSummary(plan) {
  const selected = Object.entries(plan.jobs).filter(([, enabled]) => enabled).map(([job]) => job);
  const skipped = Object.entries(plan.jobs).filter(([, enabled]) => !enabled).map(([job]) => job);
  return [
    "## CI impact selection",
    "",
    `- Mode: ${plan.full ? "full" : "selective"}`,
    `- Reason: \`${plan.reason}\``,
    `- Changed paths: ${plan.changedPaths.length}`,
    `- Matched rules: ${plan.matchedRules.length ? plan.matchedRules.map((rule) => `\`${rule}\``).join(", ") : "none"}`,
    `- Run: ${selected.length ? selected.map((job) => `\`${job}\``).join(", ") : "security + selector only"}`,
    `- Skip: ${skipped.length ? skipped.map((job) => `\`${job}\``).join(", ") : "none"}`,
    plan.unmatchedPaths.length ? `- Unmatched paths (forced full): ${plan.unmatchedPaths.map((path) => `\`${path}\``).join(", ")}` : "",
    "",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export function verifyRequired(config, results) {
  validateConfig(config);
  const expected = ["impact", "security", ...config.jobs];
  if (!results || Object.keys(results).length !== expected.length ||
      expected.some((name) => !Object.hasOwn(results, name))) throw new Error("Required CI job set mismatch.");
  if (results.impact?.result !== "success" || results.security?.result !== "success") {
    throw new Error("Impact analysis and security must succeed.");
  }
  const outputs = results.impact.outputs;
  if (!outputs || !["true", "false"].includes(outputs.full)) throw new Error("Missing or invalid impact outputs.");
  for (const job of config.jobs) {
    const enabled = outputs[job.replaceAll("-", "_")];
    if (!["true", "false"].includes(enabled) || (outputs.full === "true" && enabled !== "true")) {
      throw new Error(`Invalid impact selection for ${job}.`);
    }
    const expectedResult = enabled === "true" ? "success" : "skipped";
    if (results[job]?.result !== expectedResult) throw new Error(`Required CI expected ${job}: ${expectedResult}.`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const configPath = options.config || defaultConfigPath;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (options["check-required"] === "true") {
    verifyRequired(config, JSON.parse(process.env.JOB_RESULTS || "null"));
    console.log("Verified selected Cloud CI results.");
    return;
  }
  let plan;
  try {
    const changedPaths = options.event === "pull_request" ? readChangedPaths(options.base, options.head) : [];
    plan = selectImpact({ config, eventName: options.event, changedPaths });
  } catch (error) {
    validateConfig(config);
    plan = fullSelection(config, `selector-error:${error.message}`);
  }

  if (options.plan) fs.writeFileSync(options.plan, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  if (options.output) {
    appendFile(options.output, `full=${plan.full}\n`);
    for (const [job, enabled] of Object.entries(plan.jobs)) {
      appendFile(options.output, `${job.replaceAll("-", "_")}=${enabled}\n`);
    }
  }
  appendFile(options.summary, `${renderSummary(plan)}\n`);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
