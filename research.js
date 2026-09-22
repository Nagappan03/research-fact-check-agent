#!/usr/bin/env node
/**
 * Content Research & Fact-Check Agent (v1: single agent)
 *
 * Usage:  node research.js "Vector Databases & Embeddings"
 *
 * What it does:
 *   1. Asks Claude to research a topic, with Anthropic's web search tool enabled.
 *   2. Runs the agent loop until Claude gives a final answer (see runAgentLoop).
 *   3. Parses Claude's answer as JSON: { topic, keyFacts, realWorldExamples, sources }
 *   4. Writes output/<topic-slug>.md (a readable brief) and output/<topic-slug>.json
 */

import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slugify } from "./lib/slug.js";

dotenv.config({ quiet: true }); // loads ANTHROPIC_API_KEY from .env into process.env

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 16000;

// Pricing in USD for Claude Sonnet 5. Update these if Anthropic's rates change.
const INPUT_PRICE_PER_MTOK = 2; // per million input tokens
const OUTPUT_PRICE_PER_MTOK = 10; // per million output tokens
const WEB_SEARCH_PRICE_PER_1000 = 10; // per 1,000 web searches

// Safety cap on the agent loop, so a misbehaving run can't spin forever.
const MAX_TURNS = 8;

// Files are written relative to this script, not to your shell's cwd.
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const COST_LOG_PATH = path.join(ROOT_DIR, "cost-log.csv");

/**
 * The tool we hand to Claude. Note there is no `input_schema` and no function
 * of ours behind it: web search is a *server tool*. Anthropic runs the search
 * on its own infrastructure. We only tell Claude that it is allowed to use it.
 */
const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 3, // upper bound on searches per request, to keep cost predictable
};

/**
 * The system prompt tells Claude its job and the exact output format.
 * We ask for JSON only, so the reply can be parsed with JSON.parse.
 */
function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a meticulous research assistant preparing a fact-checked brief for a technical blog writer.
  Today's date is ${today}.

  Use the web_search tool to research the topic. Do not rely on memory for anything time-sensitive.

  Search economy:
  - Use as few searches as possible — ideally 2-3 for the whole task.
  - Start with one broad, well-chosen query before narrowing further.
  - Only run another search if the previous one genuinely failed to answer 
    what you needed. Do not run parallel or exploratory searches "just in case."
  - You have a hard cap of a few searches per run — spend them deliberately.

  Find:
  - 2-3 current, real-world examples or use cases (real products, companies or projects)
  - Recent developments and version numbers worth mentioning, with the date or version
  - 2-3 credible source URLs (official docs, engineering blogs, reputable publications)

  Rules:
  - Only state facts you found in search results. If you are unsure, leave it out.
  - Prefer primary sources (official docs, release notes) over aggregator or SEO sites.
  - Every source you list must be a page you actually retrieved via search.

  Your final message must be ONLY a JSON object, with no prose and no markdown fences, in this shape:
  {
    "topic": string,
    "keyFacts": string[],
    "realWorldExamples": string[],
    "sources": [{ "title": string, "url": string }]
  }
  Write each keyFacts / realWorldExamples entry as one self-contained sentence.`;
}

// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------

/**
 * Runs the research conversation and returns Claude's final text, a log of
 * what it searched for, and the total usage (tokens and searches) across
 * every turn, which main() turns into a dollar cost.
 *
 * HOW THE TOOL-USE LOOP WORKS
 * ---------------------------
 * The Messages API is stateless: every request carries the whole conversation
 * so far. An "agent" is just a loop around that call:
 *
 *   1. We send `messages` + `tools`.
 *   2. Claude decides, on its own, whether it needs a tool. If it does, its
 *      reply contains a tool-call block instead of (or before) the final answer.
 *   3. The tool runs and its result goes back to Claude.
 *   4. Claude reads the result and either calls another tool or gives its
 *      final answer. Repeat until it is done.
 *
 * There are two kinds of tools, and they differ in who does step 3:
 *
 *   - CLIENT tools (functions you write). Claude replies with
 *     stop_reason "tool_use" and a `tool_use` block. YOUR code runs the
 *     function, appends a `tool_result` message, and calls the API again.
 *     That round trip is the classic loop.
 *
 *   - SERVER tools (web search is one). Anthropic runs step 3 itself, *inside*
 *     a single API response. One response can contain several search rounds:
 *
 *         server_tool_use        <- Claude decided to search, with a query
 *         web_search_tool_result <- the results Anthropic fetched for it
 *         text                   <- Claude's reasoning about the results
 *         server_tool_use        <- it searches again
 *         ...
 *
 *     So we never write a tool_result for web search. We only *observe* the
 *     blocks, which is what the logging below does.
 *
 * So why do we still need a loop? Because a server-side turn can be paused.
 * If Claude's turn runs long, the API stops with stop_reason "pause_turn".
 * That means "not finished; send this back and I'll continue". We append the
 * assistant's partial turn to `messages` and call again. That is the loop.
 */
async function runAgentLoop(client, topic) {
  const messages = [
    { role: "user", content: `Research this topic for a blog post: ${topic}` },
  ];
  const searchQueries = []; // every query Claude decided to run
  const retrievedUrls = new Set(); // every URL that search actually returned

  // Running usage totals. Each response reports only ITS OWN usage, and on a
  // pause_turn resume the whole conversation is re-sent (and re-billed as
  // input), so the true cost is the sum across all turns.
  const usage = { totalInputTokens: 0, totalOutputTokens: 0, totalSearches: 0 };

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      console.log(`\n[turn ${turn}] calling Claude...`);

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(),
        tools: [WEB_SEARCH_TOOL], // this is how Claude learns it CAN search
        messages,
      });

      // Add this turn's usage to the running totals.
      usage.totalInputTokens += response.usage.input_tokens;
      usage.totalOutputTokens += response.usage.output_tokens;
      usage.totalSearches += response.usage.server_tool_use?.web_search_requests ?? 0;

      // response.content is a list of blocks. Look at what Claude did this turn.
      for (const block of response.content) {
        if (block.type === "server_tool_use" && block.name === "web_search") {
          // Claude decided to search. block.input.query is what it searched for.
          searchQueries.push(block.input.query);
          console.log(`  🔎 searched: ${block.input.query}`);
        } else if (block.type === "web_search_tool_result") {
          // On success, content is an array of results. On failure it is a single
          // error object (server tool errors come back as HTTP 200, not exceptions).
          if (Array.isArray(block.content)) {
            for (const result of block.content) retrievedUrls.add(result.url);
            console.log(`     -> ${block.content.length} results`);
          } else {
            console.log(`     -> search error: ${block.content.error_code}`);
          }
        }
      }

      // Now decide what to do based on WHY Claude stopped.
      switch (response.stop_reason) {
        case "end_turn": {
          // Claude is done. Its final answer is in the text blocks. With search
          // citations the text is split across many blocks, so join them all.
          const text = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          return { text, searchQueries, retrievedUrls, ...usage };
        }

        case "pause_turn":
          // Turn paused mid-way. Append Claude's partial turn as-is and call
          // again with no new user message; Claude picks up where it stopped.
          messages.push({ role: "assistant", content: response.content });
          break;

        case "max_tokens":
          throw new Error("Response was cut off (max_tokens). Raise MAX_TOKENS and retry.");

        case "refusal":
          throw new Error("Claude declined this request (stop_reason: refusal).");

        default:
          // "tool_use" would land here. It means Claude called a CLIENT tool, and
          // we have none in v1, so this is unexpected.
          throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
      }
    }

    throw new Error(`Agent did not finish within ${MAX_TURNS} turns.`);
  } catch (err) {
    // If the loop fails partway, the earlier turns were still billed. Attach
    // the totals so main() can still log what was spent, then rethrow.
    err.usage = usage;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Turning Claude's reply into data, and data into a markdown brief
// ---------------------------------------------------------------------------

/**
 * Parses Claude's reply as JSON. We asked for bare JSON, but models sometimes
 * add a code fence or a sentence around it, so we cut from the first "{" to
 * the last "}" before parsing.
 */
function parseBrief(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`No JSON object found in Claude's reply:\n${text}`);
  }
  const brief = JSON.parse(text.slice(start, end + 1));

  // Light shape check so a malformed reply fails loudly here, not in the renderer.
  const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const sourcesOk =
    Array.isArray(brief.sources) &&
    brief.sources.every((s) => typeof s?.title === "string" && typeof s?.url === "string");
  if (typeof brief.topic !== "string" || !isStringArray(brief.keyFacts) ||
    !isStringArray(brief.realWorldExamples) || !sourcesOk) {
    throw new Error(`Reply was JSON but not the expected shape:\n${JSON.stringify(brief, null, 2)}`);
  }
  return brief;
}

/**
 * Renders the brief as markdown. The fact-check touch: each source is marked
 * according to whether its URL really appeared in a search result. A URL that
 * never showed up may have been recalled from memory, so verify it by hand.
 */
function renderMarkdown(brief, { searchQueries, retrievedUrls }, costReport) {
  const bullets = (items) => items.map((i) => `- ${i}`).join("\n") || "_None found._";
  const sources = brief.sources
    .map((s) => {
      const seen = retrievedUrls.has(s.url) ? "✅ found in search results" : "⚠️ not in search results, verify manually";
      return `- [${s.title}](${s.url}) (${seen})`;
    })
    .join("\n");

  return `# Research Brief: ${brief.topic}

_Generated ${new Date().toISOString().slice(0, 10)} by ${MODEL} with web search. Verify before publishing._

## Key Facts

${bullets(brief.keyFacts)}

## Real-World Examples

${bullets(brief.realWorldExamples)}

## Sources

${sources || "_None found._"}

## Research Log

Searches Claude ran:

${bullets(searchQueries.map((q) => `\`${q}\``))}

## Cost

${renderCostSection(costReport)}
`;
}

/**
 * Renders the same numbers printCostReport() prints to the console, as a
 * markdown block, so the emailed brief carries cost alongside the content.
 */
function renderCostSection({ usage, cost, cumulativeCost }) {
  return `- Input tokens: ${usage.totalInputTokens.toLocaleString()}
- Output tokens: ${usage.totalOutputTokens.toLocaleString()}
- Web searches: ${usage.totalSearches}
- Cost of this run: ${formatUsd(cost)}
- Cumulative spend across all runs: ${formatUsd(cumulativeCost)}`;
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

const COST_LOG_HEADER = "date,topic,inputTokens,outputTokens,searches,cost\n";

/** Dollar cost of one run, from the usage totals. */
function computeCost({ totalInputTokens, totalOutputTokens, totalSearches }) {
  return (
    (totalInputTokens / 1e6) * INPUT_PRICE_PER_MTOK +
    (totalOutputTokens / 1e6) * OUTPUT_PRICE_PER_MTOK +
    (totalSearches / 1000) * WEB_SEARCH_PRICE_PER_1000
  );
}

/** CSV-quote a field so topics containing commas or quotes don't break columns. */
function csvField(value) {
  return `"${String(value).replace(/\s+/g, " ").replace(/"/g, '""')}"`;
}

/**
 * Appends this run to cost-log.csv (creating it with a header if needed), then
 * re-reads the file and sums the cost column to get the all-time total.
 * Returns the report that printCostReport() displays.
 */
async function recordCost(topic, usage) {
  const cost = computeCost(usage);

  await fs.access(COST_LOG_PATH).catch(() => fs.writeFile(COST_LOG_PATH, COST_LOG_HEADER));
  const row = [
    new Date().toISOString().slice(0, 10),
    csvField(topic),
    usage.totalInputTokens,
    usage.totalOutputTokens,
    usage.totalSearches,
    cost.toFixed(6), // more precision than we display, so the running sum stays accurate
  ].join(",");
  await fs.appendFile(COST_LOG_PATH, row + "\n");

  // Cost is the last column and always a plain number, so take everything after
  // the last comma. That stays correct even if a topic contains commas.
  const log = await fs.readFile(COST_LOG_PATH, "utf8");
  const cumulativeCost = log
    .split("\n")
    .slice(1) // skip the header
    .map((line) => Number(line.slice(line.lastIndexOf(",") + 1)))
    .filter((n) => Number.isFinite(n) && n > 0)
    .reduce((sum, n) => sum + n, 0);

  return { usage, cost, cumulativeCost };
}

/** e.g. 0.0847 -> "$0.0847" */
function formatUsd(n) {
  return `$${n.toFixed(4)}`;
}

function printCostReport({ usage, cost, cumulativeCost }) {
  console.log(`
Cost of this run
  Input tokens:  ${usage.totalInputTokens.toLocaleString()}
  Output tokens: ${usage.totalOutputTokens.toLocaleString()}
  Web searches:  ${usage.totalSearches}
  Total cost:    ${formatUsd(cost)}

Cumulative spend across all runs: ${formatUsd(cumulativeCost)}  (${COST_LOG_PATH})`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  if (!topic) {
    console.error('Usage: node research.js "topic name"');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to .env in the project root.");
    process.exit(1);
  }

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  console.log(`Researching: ${topic}`);

  // The cost is logged as soon as the loop ends, before anything that could
  // still fail (JSON parsing, file writes). The API calls are billed either way.
  let costReport;
  try {
    let result;
    try {
      result = await runAgentLoop(client, topic);
    } catch (err) {
      // The loop failed partway; log whatever the completed turns cost.
      if (err.usage) costReport = await recordCost(topic, err.usage);
      throw err;
    }
    costReport = await recordCost(topic, result);

    const brief = parseBrief(result.text);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const slug = slugify(topic);
    const mdPath = path.join(OUTPUT_DIR, `${slug}.md`);
    const jsonPath = path.join(OUTPUT_DIR, `${slug}.json`);
    await fs.writeFile(mdPath, renderMarkdown(brief, result, costReport));
    await fs.writeFile(jsonPath, JSON.stringify(brief, null, 2) + "\n");

    console.log(`\nDone. Wrote:\n  ${mdPath}\n  ${jsonPath}`);
  } finally {
    // Runs on success and on failure, so you always see what the run cost.
    if (costReport) printCostReport(costReport);
  }
}

main().catch((err) => {
  // Typed SDK errors carry an HTTP status; show it so auth/rate-limit problems are obvious.
  if (err instanceof Anthropic.APIError) {
    console.error(`\nAPI error ${err.status ?? ""}: ${err.message}`);
  } else {
    console.error(`\n${err.message}`);
  }
  process.exit(1);
});
