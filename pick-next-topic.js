#!/usr/bin/env node
/**
 * Picks the next topic to research for the scheduled (cron) workflow run.
 *
 * Unlike workflow_dispatch (a human/agent types the topic in) or the
 * .trigger/topic.txt push path, a `schedule` event carries no input at all.
 * So this reads the two files already checked into the repo instead:
 *
 *   - topics.json    the ordered list of topics this agent is responsible
 *                     for researching (topics 10+ in the blog pipeline;
 *                     topics 1-9 predate this agent and were drafted
 *                     without it, so they're intentionally not listed here)
 *   - cost-log.csv    a record of every topic already researched, written
 *                     by research.js after each successful run
 *
 * It prints the first topic in topics.json whose slug isn't already in
 * cost-log.csv, and exits 1 with nothing printed if every listed topic has
 * already been researched (comparing by slug, not exact string, so minor
 * punctuation differences between how a topic is phrased in topics.json vs.
 * how it was typed in as a workflow_dispatch/push input don't cause a
 * duplicate research run).
 *
 * IMPORTANT for whoever maintains the blog pipeline: when a new topic is
 * added to the pipeline (in content-creation.md), it must also be appended
 * to topics.json here, or the scheduled run will find nothing to research
 * once it reaches the end of this list.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slugify } from "./lib/slug.js";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOPICS_PATH = path.join(ROOT_DIR, "topics.json");
const COST_LOG_PATH = path.join(ROOT_DIR, "cost-log.csv");

/** Extracts the quoted `topic` column from each cost-log.csv data row. */
function parseResearchedSlugs(csv) {
  const slugs = new Set();
  const lines = csv.split("\n").slice(1); // skip header
  const rowPattern = /^[^,]*,"((?:[^"]|"")*)",/; // date,"topic",...
  for (const line of lines) {
    const match = line.match(rowPattern);
    if (!match) continue;
    const topic = match[1].replace(/""/g, '"'); // undo CSV quote-doubling
    slugs.add(slugify(topic));
  }
  return slugs;
}

async function main() {
  const topics = JSON.parse(await fs.readFile(TOPICS_PATH, "utf8"));

  let researchedSlugs = new Set();
  try {
    researchedSlugs = parseResearchedSlugs(await fs.readFile(COST_LOG_PATH, "utf8"));
  } catch {
    // No cost-log.csv yet (e.g. very first run ever) - nothing researched so far.
  }

  const next = topics.find((topic) => !researchedSlugs.has(slugify(topic)));
  if (!next) {
    console.error("Every topic in topics.json has already been researched.");
    process.exit(1);
  }
  process.stdout.write(next);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
