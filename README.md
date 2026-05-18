# API Result Comparison

A Vercel-ready benchmark UI for comparing web search API results across Liner, Exa, Perplexity, Parallel, Tavily, and Brave. It also includes a separate deep research comparison page for Perplexity, Parallel, and Liner.

The app keeps API keys server-side, calls providers through `/api/search`, normalizes provider-specific responses into one UI model, and shows raw JSON in an in-page modal for inspection.

## Project Structure

```text
api/search.js                  Web search API route wrapper
api/deep-research.js           Deep research API route wrapper
benchmark/search-api.js         Provider calls, normalization, cost estimates
benchmark/deep-research-api.js  Deep research provider calls, streaming, normalization
benchmark/index.html            Static page structure
benchmark/research.html         Deep research page structure
benchmark/styles.css            UI styles
benchmark/app.js                Browser UI logic
benchmark/research-app.js       Deep research browser UI logic
benchmark/deep-research-api.test.js  Parser fixture checks
benchmark/default-results.json  Default landing snapshot
vercel.json                     Root rewrite to benchmark/index.html
```

## Environment

Create `benchmark/.env` with the provider keys you want to test:

```bash
LINER_API_KEY=
EXA_API_KEY=
PERPLEXITY_API_KEY=
PARALLEL_API_KEY=
TAVILY_API_KEY=
BRAVE_API_KEY=
```

Missing keys do not block the benchmark. Providers without keys return a skipped state.

## Run Locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000` when using `vercel dev`.

The current Codex local preview may also be served at `http://localhost:8000` by a lightweight local server.

The deep research comparison page is available at `/benchmark/research.html`. It streams normalized updates from `/api/deep-research` and keeps provider-specific raw output available in each card's JSON modal.
Deep research cards include a `CST` metric. Perplexity uses native usage cost when returned by the API; Parallel and Liner use their published fixed per-request tier pricing estimates.

## Check

```bash
npm run check
```

This validates the Vercel API wrapper, provider API module, and browser UI script with `node --check`.

## Default Results

The landing page loads `benchmark/default-results.json` and does not automatically re-run a search on page load.

To refresh the snapshot, run a local script that calls `benchmark/search-api.js` with:

```js
{ query: "Search API for AI Agents" }
```

Do not commit `benchmark/.env` or print secret values while regenerating the snapshot.

To refresh the deep research landing snapshot, run:

```bash
npm run snapshot:deep-research
```

This writes `benchmark/deep-research-default-results.json` using the default CEO-of-Liner market research prompt.

## Provider Defaults

The benchmark uses provider-native default result counts rather than a shared UI limit:

- Liner: 10
- Exa: 10
- Perplexity: 10
- Parallel: 10 requested via advanced settings
- Tavily: 5
- Brave: 20

Costs are shown per run. When a provider does not return native billing data, the UI falls back to pricing estimates encoded in `benchmark/search-api.js`.
