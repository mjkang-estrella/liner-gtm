const fs = require("node:fs");
const path = require("node:path");

loadLocalEnv();

const PROVIDERS = [
  { id: "liner", name: "LINER", env: "LINER_API_KEY", run: searchLiner, defaultResults: 10, estimatedCostDollars: 0.003 },
  { id: "exa", name: "EXA", env: "EXA_API_KEY", run: searchExa, defaultResults: 10, estimatedCostDollars: 0.007 },
  { id: "perplexity", name: "PERPLEXITY", env: "PERPLEXITY_API_KEY", run: searchPerplexity, defaultResults: 10, estimatedCostDollars: 0.005 },
  { id: "parallel", name: "PARALLEL", env: "PARALLEL_API_KEY", run: searchParallel, defaultResults: 10, estimatedCostDollars: 0.005 },
  { id: "tavily", name: "TAVILY", env: "TAVILY_API_KEY", run: searchTavily, defaultResults: 5, estimatedCostDollars: 0.008 },
  { id: "brave", name: "BRAVE", env: "BRAVE_API_KEY", run: searchBrave, defaultResults: 20, estimatedCostDollars: 0.005 },
];

const PROVIDER_TIMEOUT_MS = 20000;

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const separatorIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = await readBody(req);
    const query = String(body.query || "").trim();

    if (!query) {
      return sendJson(res, 400, { error: "Query is required" });
    }

    const startedAt = Date.now();
    const providerResults = await Promise.all(
      PROVIDERS.map((provider) => runProvider(provider, query))
    );

    return sendJson(res, 200, {
      query,
      resultMode: "provider-defaults",
      completedAt: new Date().toISOString(),
      totalLatencyMs: Date.now() - startedAt,
      providers: providerResults,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: "Search request failed",
      message: getSafeErrorMessage(error),
    });
  }
};

async function runProvider(provider, query) {
  const apiKey = process.env[provider.env];

  if (!apiKey) {
    return providerEnvelope(provider, {
      status: "skipped",
      error: {
        message: `Missing ${provider.env}`,
        envVar: provider.env,
      },
    });
  }

  const startedAt = Date.now();

  try {
    const raw = await provider.run({ apiKey, query, defaultResults: provider.defaultResults });
    const normalized = normalizeProvider(provider.id, raw);
    const nativeCost = normalized.nativeCost ?? estimateProviderCost(provider, normalized);

    return providerEnvelope(provider, {
      status: "ok",
      latencyMs: Date.now() - startedAt,
      requestId: normalized.requestId,
      nativeCost,
      nativeUsage: normalized.nativeUsage,
      raw,
      results: normalized.results,
    });
  } catch (error) {
    return providerEnvelope(provider, {
      status: "error",
      latencyMs: Date.now() - startedAt,
      error: {
        message: getSafeErrorMessage(error),
        httpStatus: error.status || null,
      },
      raw: error.raw || null,
    });
  }
}

function providerEnvelope(provider, overrides = {}) {
  const results = Array.isArray(overrides.results) ? overrides.results : [];

  return {
    id: provider.id,
    name: provider.name,
    status: overrides.status || "idle",
    latencyMs: overrides.latencyMs ?? null,
    resultCount: results.length,
    defaultResults: provider.defaultResults,
    requestId: overrides.requestId || null,
    nativeCost: overrides.nativeCost ?? null,
    nativeUsage: overrides.nativeUsage ?? null,
    raw: overrides.raw ?? null,
    results,
    error: overrides.error || null,
  };
}

async function searchLiner({ apiKey, query, defaultResults }) {
  return providerFetch("https://platform.liner.com/api/v1/search/web", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      country_code: "us",
      lang: "en",
      max_results: defaultResults,
    }),
  });
}

async function searchExa({ apiKey, query, defaultResults }) {
  return providerFetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: defaultResults,
      contents: {
        highlights: true,
      },
    }),
  });
}

async function searchPerplexity({ apiKey, query, defaultResults }) {
  return providerFetch("https://api.perplexity.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      country: "US",
      max_results: defaultResults,
      search_language_filter: ["en"],
    }),
  });
}

async function searchParallel({ apiKey, query, defaultResults }) {
  return providerFetch("https://api.parallel.ai/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      objective: `Find web search API products, documentation, pricing, and benchmark resources for AI agents and LLM applications. User query: ${query}.`,
      search_queries: deriveParallelQueries(query),
      advanced_settings: {
        max_results: defaultResults,
      },
    }),
  });
}

async function searchTavily({ apiKey, query, defaultResults }) {
  return providerFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: defaultResults,
      include_answer: false,
      include_raw_content: false,
      include_favicon: true,
      include_usage: true,
    }),
  });
}

async function searchBrave({ apiKey, query, defaultResults }) {
  return providerFetch("https://api.search.brave.com/res/v1/web/search", {
    method: "POST",
    headers: {
      accept: "application/json",
      "Accept-Encoding": "gzip",
      "Content-Type": "application/json",
      "x-subscription-token": apiKey,
    },
    body: JSON.stringify({
      q: query,
      country: "US",
      search_lang: "en",
      count: defaultResults,
      result_filter: ["web"],
      text_decorations: false,
    }),
  });
}

async function providerFetch(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = parseJson(text);

    if (!response.ok) {
      const error = new Error(extractProviderError(data, response.statusText));
      error.status = response.status;
      error.raw = data;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Provider timed out after ${PROVIDER_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeProvider(providerId, raw) {
  switch (providerId) {
    case "liner":
      return {
        requestId: raw.request_id || raw.requestId || null,
        results: toArray(raw.results).map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.description,
          publishedDate: item.date,
          updatedDate: null,
          score: null,
          favicon: item.favicon_url,
        })),
      };
    case "exa":
      return {
        requestId: raw.requestId || null,
        nativeCost: raw.costDollars?.total ?? null,
        results: toArray(raw.results).map((item) => ({
          title: item.title,
          url: item.url,
          snippet: firstText(item.highlights) || item.summary || item.text,
          publishedDate: item.publishedDate,
          updatedDate: null,
          score: firstNumber(item.highlightScores),
          favicon: item.favicon,
        })),
      };
    case "perplexity":
      return {
        requestId: raw.id || null,
        nativeUsage: raw.server_time ? { server_time: raw.server_time } : null,
        results: toArray(raw.results).map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          publishedDate: item.date,
          updatedDate: item.last_updated,
          score: null,
          favicon: null,
        })),
      };
    case "parallel":
      return {
        requestId: raw.search_id || null,
        nativeUsage: raw.usage || null,
        results: toArray(raw.results).map((item) => ({
          title: cleanTitle(item.title),
          url: item.url,
          snippet: cleanParallelSnippet(item),
          publishedDate: item.publish_date,
          updatedDate: null,
          score: null,
          favicon: null,
        })),
      };
    case "tavily":
      return {
        requestId: raw.request_id || null,
        nativeUsage: {
          response_time: raw.response_time,
          usage: raw.usage,
        },
        results: toArray(raw.results).map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.content,
          publishedDate: item.published_date || item.date || null,
          updatedDate: null,
          score: typeof item.score === "number" ? item.score : null,
          favicon: item.favicon,
        })),
      };
    case "brave":
      return {
        requestId: raw.query?.original || null,
        nativeUsage: raw.mixed ? { mixed: raw.mixed } : null,
        results: toArray(raw.web?.results).map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.description,
          publishedDate: item.age,
          updatedDate: null,
          score: null,
          favicon: item.profile?.img || item.meta_url?.favicon || null,
        })),
      };
    default:
      return { results: [] };
  }
}

function estimateProviderCost(provider, normalized) {
  if (typeof normalized.nativeCost === "number") return normalized.nativeCost;

  if (provider.id === "tavily") {
    const credits = normalized.nativeUsage?.usage?.credits;
    if (typeof credits === "number") return credits * 0.008;
  }

  if (provider.id === "parallel") {
    const searchUsage = toArray(normalized.nativeUsage).find((item) => item?.name === "sku_search");
    if (typeof searchUsage?.count === "number") return searchUsage.count * provider.estimatedCostDollars;
  }

  return provider.estimatedCostDollars ?? null;
}

function deriveKeywordQuery(query) {
  return query
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => word.length > 2)
    .slice(0, 6)
    .join(" ") || query.slice(0, 80);
}

function deriveParallelQueries(query) {
  const normalized = deriveKeywordQuery(query);
  const agentQuery = normalized.includes("agent") ? normalized : `${normalized} ai agents`;
  const queries = [
    "web search api ai agents",
    "llm search api documentation",
    "search api pricing benchmark",
    agentQuery,
  ];

  return [...new Set(queries.map((item) => item.trim()).filter(Boolean))].slice(0, 3);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") return Promise.resolve(parseJson(req.body));

  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      resolve(parseJson(data || "{}"));
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function extractProviderError(data, fallback) {
  return (
    data?.error?.message ||
    data?.error ||
    data?.message ||
    data?.detail ||
    fallback ||
    "Provider request failed"
  );
}

function getSafeErrorMessage(error) {
  return String(error?.message || "Unknown error").slice(0, 300);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstText(value) {
  return toArray(value).find((item) => typeof item === "string" && item.trim());
}

function firstNumber(value) {
  return toArray(value).find((item) => typeof item === "number") ?? null;
}

function cleanParallelSnippet(item) {
  const text = toArray(item.excerpts)
    .join("\n\n")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";

  const title = cleanTitle(item.title);
  const noisyPatterns = [
    /^product pricing resources docs\b/i,
    /^login sign up\b/i,
    /^webinars blog certification/i,
    /^section title:/i,
    /^content:/i,
  ];

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40)
    .filter((sentence) => !noisyPatterns.some((pattern) => pattern.test(sentence)))
    .filter((sentence) => !title || sentence.toLowerCase() !== title.toLowerCase());

  return (sentences[0] || text).slice(0, 420);
}

function cleanTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();

  const metadataTitle = title.match(/(?:^|\s)title:\s*(.+?)(?:\s+image:|\s+description:|$)/i);
  if (metadataTitle?.[1]) return metadataTitle[1].trim();

  if (title.length <= 180) return title;

  return `${title.slice(0, 177)}...`;
}
