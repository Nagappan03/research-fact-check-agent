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
2. Add your API key: create a `.env` file in the project root (gitignored) and set `ANTHROPIC_API_KEY`:
   ```
   ANTHROPIC_API_KEY=your-api-key-here
   ```
   Keys come from the [Anthropic Console](https://console.anthropic.com/settings/keys).
3. Make sure web search is enabled for your organization in the Console settings. Without that, the request fails with an error about the tool.
4. Run it:
   ```bash
   node research.js "Your topic here"
   ```

Each run prints the searches Claude decides to make as it goes, so you can watch the agent work.

Optional: to email a brief to yourself locally (the same thing the GitHub Actions workflow does, see [Cloud deployment](#cloud-deployment)), also set `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`, then run:
```bash
node send-brief-email.js "Your topic here"
```
It reads `output/<slug>.md` for that topic, so run `research.js` for it first.

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
research.js             the whole agent: loop, JSON parsing, markdown rendering
send-brief-email.js     emails a generated brief to yourself (used by the workflow)
notify-empty-queue.js   emails a "topic queue is empty" notice when topics.json runs dry
pick-next-topic.js      picks the next un-researched topic for the scheduled run (see Cloud deployment)
lib/slug.js             shared slugify(), used by the scripts above
topics.json             this agent's own topic queue (see Keeping the topic queue filled)
.trigger/topic.txt      written+pushed to fire a run via the push trigger (see Cloud deployment)
.env                     your local secrets: ANTHROPIC_API_KEY, GMAIL_USER, GMAIL_APP_PASSWORD (gitignored)
output/                  generated briefs (gitignored)
cost-log.csv             per-run usage and cost (gitignored locally; committed by the workflow, see Cost tracking)
.github/workflows/research.yml   the GitHub Actions workflow (see Cloud deployment)
```

## Configuration

Everything lives at the top of `research.js`:

- `MODEL` is `claude-sonnet-5`.
- `WEB_SEARCH_TOOL` uses `web_search_20260209`, with `max_uses: 3` to cap searches (and cost) per run - the system prompt also asks Claude to spend them deliberately.
- `MAX_TURNS` caps the loop so it cannot run forever.
- `INPUT_PRICE_PER_MTOK`, `OUTPUT_PRICE_PER_MTOK` and `WEB_SEARCH_PRICE_PER_1000` drive the cost tracking below. Update them if rates change.

## Cost tracking

After every run the script prints the input tokens, output tokens, number of web searches and the total cost in USD. It also appends the run to `cost-log.csv` (created on first run) and prints your cumulative spend across all runs, which you can compare against your remaining API credits. The same numbers are also written into a "Cost" section at the bottom of the generated `.md` brief, so they travel with it - including into the email the GitHub Actions workflow sends (see [Cloud deployment](#cloud-deployment)).

The cost is `input tokens x $2/M + output tokens x $10/M + searches x $10/1000`, summed over every turn of the loop. The constants are at the top of `research.js`.

- The run is logged as soon as the agent loop ends, before the JSON is parsed. If parsing fails, the API calls were still billed and still appear in the log.
- If the loop itself fails partway (say, a rate limit on turn 3), the turns that completed are logged too.
- This is an estimate from the usage numbers the API returns. Your Anthropic Console is the source of truth for billing.

`cost-log.csv` is gitignored for local runs, so your own runs stay local. The GitHub Actions workflow is the exception: its runner is thrown away after every run, so it force-adds and commits `cost-log.csv` back to the repo (as `github-actions[bot]`) after each run, which is what lets cumulative spend actually accumulate across workflow runs instead of resetting to zero each time. That also means the file is visible directly on GitHub once the workflow has run at least once.

## Cloud deployment

A GitHub Actions workflow ([.github/workflows/research.yml](.github/workflows/research.yml)) runs this unattended - checks out the repo, installs dependencies, runs `research.js`, commits `cost-log.csv`, and emails the brief - with no terminal and, for the main path, no human involved at all.

### Set up the three repo secrets

In the repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Add all three:

| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key, same as in `.env` |
| `GMAIL_USER` | The Gmail address to send from and to (you email yourself) |
| `GMAIL_APP_PASSWORD` | A Gmail [App Password](https://myaccount.google.com/apppasswords) for that address - not your regular Gmail password. Requires 2-Step Verification to be enabled on the account. |

### Three ways to trigger a run

| Trigger | When it's used | How the topic is chosen |
|---|---|---|
| `schedule` (cron) | The real automation - fires unattended, weekdays at 9 PM IST, no one involved | `pick-next-topic.js` reads `topics.json` (this agent's topic queue) and `cost-log.csv` (what's already researched), and picks the first one not yet done, matching by slug |
| `workflow_dispatch` | Researching something out of order, or re-running a topic, from the Actions tab | Typed into the **topic** input field |
| `push` to `.trigger/topic.txt` | A scripted/manual fallback - write a topic into that file and push it | The file's content |

If `topics.json` is ever fully researched, the scheduled run sends a "topic queue is empty" email instead of silently doing nothing - see [Keeping the topic queue filled](#keeping-the-topic-queue-filled).

Whichever way it's triggered, the run then does the same thing: `research.js` writes `output/<slug>.md`, `cost-log.csv` gets committed back, and `send-brief-email.js` emails that file with subject `Research Brief: <topic>` (exact match - other tooling searches Gmail for it). If any step fails - a bad API key, no matching output file, an SMTP error - the workflow run shows red instead of silently succeeding.

### Keeping the topic queue filled

`topics.json` is this agent's own ordered queue - just the topics it's responsible for researching (starting from #10 in the blog's pipeline; #1-9 predate this agent and were drafted without it). There's no automated step that invents new topics: deciding them is a deliberate conversation, written into the blog's own `content-creation.md` pipeline first. Whenever a new batch is decided there, append the same titles to `topics.json` here too, commit, and the next scheduled run picks up from where it left off.

If that maintenance step gets missed, you'll know: once only one topic is left, that day's brief email carries a low-queue warning, and once the queue is fully empty, a dedicated email says so - so running dry is visible, not a silent skip.

### Why three triggers instead of just a timer calling workflow_dispatch

The obvious design - a scheduled job that calls the `workflow_dispatch` REST API on a timer - doesn't work from any Claude-hosted session: the GitHub credential those sessions get lacks the `actions:write` permission, confirmed by testing it directly (a `403 Resource not accessible by integration`, unchanged even when a manually-supplied Authorization header is sent - the session's proxy overrides it regardless). A plain `git push`, on the other hand, isn't gated by that permission, which is why the `push`-to-`.trigger/topic.txt` path exists and works. `schedule` sidesteps the whole problem by not needing any external caller at all - GitHub fires it on its own.

## Planned for v2

A multi-agent version (orchestrator, searcher, synthesizer). The v1 loop is the building block each of those agents will reuse.
