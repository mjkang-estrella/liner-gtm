const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const handler = require("./deep-research-api.js");

const DEFAULT_QUERY = `Assume I am the CEO of liner.com and anchor the following results based on our company's product.

Research the current market for AI web search API products, including Web Search API, AI Search, and Deep research.

I want:
1. A market map by customer segment and use case
2. Key differentiators by product
3. Pricing and packaging comparison
4. Developer experience comparison
5. ICP for each company
6. Which product is best positioned for agentic AI applications and why

Do not just summarize company websites. Find real customer examples, docs, changelogs, announcements, GitHub discussions, and developer complaints where possible.`;

const DEFAULT_TIERS = {
  perplexity: "deep-research",
  parallel: "pro-fast",
  liner: "deep-research",
};

async function main() {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/deep-research`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: DEFAULT_QUERY,
        tiers: DEFAULT_TIERS,
      }),
    });

    if (!response.ok) {
      throw new Error(`Snapshot request failed with HTTP ${response.status}`);
    }

    const snapshot = await collectSnapshot(response);
    const outputPath = path.join(__dirname, "deep-research-default-results.json");
    await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`Saved ${outputPath}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function collectSnapshot(response) {
  const decoder = new TextDecoder();
  const providers = new Map();
  let run = null;
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) applyEvent(JSON.parse(line));
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) applyEvent(JSON.parse(buffer));

  return {
    query: DEFAULT_QUERY,
    tiers: DEFAULT_TIERS,
    resultMode: "deep-research-defaults",
    completedAt: run?.completedAt || new Date().toISOString(),
    totalLatencyMs: run?.totalLatencyMs ?? null,
    providers: Array.from(providers.values()),
  };

  function applyEvent(event) {
    if (event.type === "run-start") {
      for (const provider of event.providers || []) providers.set(provider.id, provider);
      return;
    }

    if (event.type === "provider-update") {
      providers.set(event.provider.id, event.provider);
      return;
    }

    if (event.type === "run-complete") {
      run = event;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
