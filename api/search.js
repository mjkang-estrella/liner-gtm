const PROVIDERS = [
  { id: "liner", name: "LINER", env: "LINER_API_KEY", run: searchLiner },
  { id: "exa", name: "EXA", env: "EXA_API_KEY", run: searchExa },
  { id: "perplexity", name: "PERPLEXITY", env: "PERPLEXITY_API_KEY", run: searchPerplexity },
  { id: "parallel", name: "PARALLEL", env: "PARALLEL_API_KEY", run: searchParallel },
  { id: "tavily", name: "TAVILY", env: "TAVILY_API_KEY", run: searchTavily },
  { id: "brave", name: "BRAVE", env: "BRAVE_API_KEY", run: searchBrave },
];

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const PROVIDER_TIMEOUT_MS = 20000;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = await readBody(req);
    const query = String(body.query || "").trim();
    const maxResults = clampInteger(body.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT);

    if (!query) {
      return sendJson(res, 400, { error: "Query is required" });
    }

    const startedAt = Date.now();
    const providerResults = await Promise.all(
      PROVIDERS.map((provider) => runProvider(provider, query, maxResults))
    );

    return sendJson(res, 200, {
      query,
      maxResults,
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

async function runProvider(provider, query, maxResults) {
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
    const raw = await provider.run({ apiKey, query, maxResults });
    const normalized = normalizeProvider(provider.id, raw);

    return providerEnvelope(provider, {
      status: "ok",
      latencyMs: Date.now() - startedAt,
      requestId: normalized.requestId,
      nativeCost: normalized.nativeCost,
      nativeUsage: normalized.nativeUsage,
      raw,
      results: normalized.results.slice(0, maxResults),
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
    requestId: overrides.requestId || null,
    nativeCost: overrides.nativeCost ?? null,
    nativeUsage: overrides.nativeUsage ?? null,
    raw: overrides.raw ?? null,
    results,
    error: overrides.error || null,
  };
}

async function searchLiner({ apiKey, query, maxResults }) {
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
      max_results: maxResults,
    }),
  });
}

async function searchExa({ apiKey, query, maxResults }) {
  return providerFetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: maxResults,
      contents: {
        highlights: true,
      },
    }),
  });
}

async function searchPerplexity({ apiKey, query, maxResults }) {
  return providerFetch("https://api.perplexity.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      country: "US",
      max_results: maxResults,
      search_language_filter: ["en"],
    }),
  });
}

async function searchParallel({ apiKey, query }) {
  return providerFetch("https://api.parallel.ai/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      objective: query,
      search_queries: [deriveKeywordQuery(query)],
      mode: "basic",
    }),
  });
}

async function searchTavily({ apiKey, query, maxResults }) {
  return providerFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_favicon: true,
      include_usage: true,
    }),
  });
}

async function searchBrave({ apiKey, query, maxResults }) {
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
      count: maxResults,
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
          title: item.title,
          url: item.url,
          snippet: toArray(item.excerpts).join(" "),
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

function clampInteger(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(Math.max(number, min), max);
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
