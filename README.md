# Content Research & Fact-Check Agent (v1)

A small Node.js CLI that takes a technical topic and produces a research brief you can use before writing a blog post. It is a single agent: one Claude model, one tool (web search), one loop.

```bash
node research.js "Vector Databases & Embeddings"
```

This writes `output/vector-databases-embeddings.md` (the readable brief) and `output/vector-databases-embeddings.json` (the same data as `{ topic, keyFacts, realWorldExamples, sources }`).

## Setup

Requires Node.js 20 or newer.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Add your API key:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and set `ANTHROPIC_API_KEY`. Keys come from the [Anthropic Console](https://console.anthropic.com/settings/keys).
3. Make sure web search is enabled for your organization in the Console settings. Without that, the request fails with an error about the tool.
4. Run it:
   ```bash
   node research.js "Your topic here"
   ```

Each run prints the searches Claude decides to make as it goes, so you can watch the agent work.

## How the agent loop works

The full walkthrough is in the comments on `runAgentLoop` in [research.js](research.js). The short version:

1. **The API is stateless.** Every request carries the whole conversation (`messages`) plus the list of `tools` Claude may use.
2. **Claude decides whether to use a tool.** We don't write "search now" logic. We describe the tool, and Claude chooses when and what to search for, based on the topic.
3. **A tool call and its result are content blocks.** Claude's reply is a list of blocks: `server_tool_use` (the query it chose), then `web_search_tool_result` (what came back), then `text` (its reasoning or answer).
4. **Claude reads the results and continues.** It may search again with a refined query, or write the final answer. The final answer is the `text` at `stop_reason: "end_turn"`.

### Server tools vs. client tools

This is the part that is easy to miss:

| | Who runs the tool | What your code does |
|---|---|---|
| **Client tool** (a function you write) | Your code | Claude stops with `stop_reason: "tool_use"`. You run the function, append a `tool_result` message, and call the API again. |
| **Server tool** (web search) | Anthropic | Nothing. Searches happen inside a single API response, and you only read the blocks. |

Web search is a server tool, so v1 never writes a `tool_result`. The loop exists for one reason: a long server-side turn can stop with `stop_reason: "pause_turn"`, which means "not finished, send this back to continue". The code appends the partial turn to `messages` and calls again.

When you add your own tools in v2, the loop grows a `tool_use` case: run the function, append a `tool_result`, and call again.

## The fact-check step

Models can produce plausible URLs from memory. The script records every URL that web search actually returned and marks each source in the brief:

- ✅ the URL appeared in a search result
- ⚠️ it did not, so open it and check by hand

The brief also lists the searches that were run, so you can see what the research was based on. Treat the brief as a starting point and still verify the claims you publish.

## Project layout

```
research.js     the whole agent: loop, JSON parsing, markdown rendering
.env.example    template for ANTHROPIC_API_KEY
output/         generated briefs (gitignored)
cost-log.csv    per-run usage and cost (gitignored, created on first run)
```

## Configuration

Everything lives at the top of `research.js`:

- `MODEL` is `claude-sonnet-5`.
- `WEB_SEARCH_TOOL` uses `web_search_20250305`, with `max_uses: 6` to cap searches (and cost) per run. A newer variant, `web_search_20260209`, adds dynamic filtering of results. It is a drop-in swap for the `type` string if you want to try it.
- `MAX_TURNS` caps the loop so it cannot run forever.
- `INPUT_PRICE_PER_MTOK`, `OUTPUT_PRICE_PER_MTOK` and `WEB_SEARCH_PRICE_PER_1000` drive the cost tracking below. Update them if rates change.

## Cost tracking

After every run the script prints the input tokens, output tokens, number of web searches and the total cost in USD. It also appends the run to `cost-log.csv` (gitignored, created on first run) and prints your cumulative spend across all runs, which you can compare against your remaining API credits.

The cost is `input tokens x $2/M + output tokens x $10/M + searches x $10/1000`, summed over every turn of the loop. The constants are at the top of `research.js`.

- The run is logged as soon as the agent loop ends, before the JSON is parsed. If parsing fails, the API calls were still billed and still appear in the log.
- If the loop itself fails partway (say, a rate limit on turn 3), the turns that completed are logged too.
- This is an estimate from the usage numbers the API returns. Your Anthropic Console is the source of truth for billing.

## Planned for v2

A multi-agent version (orchestrator, searcher, synthesizer). The v1 loop is the building block each of those agents will reuse.
