const fs = require("node:fs");
const path = require("node:path");

loadLocalEnv();

const PROVIDER_TIMEOUT_MS = 45 * 60 * 1000;
const PARALLEL_POLL_TIMEOUT_SECONDS = 25;

const PROVIDERS = [
  {
    id: "perplexity",
    name: "PERPLEXITY",
    env: "PERPLEXITY_API_KEY",
    tiers: ["deep-research", "advanced-deep-research"],
    defaultTier: "deep-research",
    run: runPerplexity,
  },
  {
    id: "parallel",
    name: "PARALLEL",
    env: "PARALLEL_API_KEY",
    tiers: ["pro-fast", "ultra-fast", "pro", "ultra"],
    defaultTier: "pro-fast",
    run: runParallel,
  },
  {
    id: "liner",
    name: "LINER",
    env: "LINER_API_KEY",
    tiers: ["deep-research", "deep-research-pro"],
    defaultTier: "deep-research",
    run: runLiner,
  },
];

const FIXED_COST_BY_PROVIDER_TIER = {
  liner: {
    "deep-research": 0.2,
    "deep-research-pro": 0.3,
  },
  parallel: {
    "pro-fast": 0.1,
    "ultra-fast": 0.3,
    pro: 0.1,
    ultra: 0.3,
  },
};

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

async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: "Invalid JSON body", message: getSafeErrorMessage(error) });
  }

  const query = String(body.query || "").trim();
  if (!query) {
    return sendJson(res, 400, { error: "Query is required" });
  }

  const tiers = normalizeTierSelection(body.tiers || {});
  const startedAt = Date.now();

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const emit = (event) => {
    res.write(`${JSON.stringify(event)}\n`);
  };

  emit({
    type: "run-start",
    query,
    tiers,
    startedAt: new Date(startedAt).toISOString(),
    providers: PROVIDERS.map((provider) => createProviderEnvelope(provider, tiers[provider.id], "idle")),
  });

  await Promise.all(PROVIDERS.map((provider) => runProvider(provider, query, tiers[provider.id], emit)));

  emit({
    type: "run-complete",
    query,
    tiers,
    completedAt: new Date().toISOString(),
    totalLatencyMs: Date.now() - startedAt,
  });
  res.end();
}

async function runProvider(provider, query, tier, emit) {
  const apiKey = process.env[provider.env];
  const startedAt = Date.now();
  const envelope = createProviderEnvelope(provider, tier, "loading");

  const update = (changes = {}) => {
    Object.assign(envelope, changes, {
      latencyMs: Date.now() - startedAt,
      outputLength: envelope.reportText.length,
      sourceCount: envelope.sources.length,
      taskCount: envelope.tasks.length,
    });
    emit({ type: "provider-update", provider: envelope });
  };

  update();

  if (!apiKey) {
    update({
      status: "skipped",
      error: {
        message: `Missing ${provider.env}`,
        envVar: provider.env,
      },
    });
    return;
  }

  try {
    await provider.run({ apiKey, query, tier, envelope, update });
    update({ status: "ok" });
  } catch (error) {
    update({
      status: "error",
      error: {
        message: getSafeErrorMessage(error),
        httpStatus: error.status || null,
      },
      raw: envelope.raw || error.raw || null,
    });
  }
}

function createProviderEnvelope(provider, tier, status) {
  return {
    id: provider.id,
    name: provider.name,
    status,
    tier,
    latencyMs: null,
    requestId: null,
      runId: null,
      reportText: "",
      reasoningText: "",
      tasks: [],
    taskCount: 0,
    sources: [],
    sourceCount: 0,
      outputLength: 0,
      cost: estimateFixedProviderCost(provider.id, tier),
      costSource: estimateFixedProviderCost(provider.id, tier) == null ? null : "estimated-fixed-tier",
      nativeCost: estimateFixedProviderCost(provider.id, tier),
      nativeUsage: null,
      raw: null,
      error: null,
  };
}

async function runLiner({ apiKey, query, tier, envelope, update }) {
  const raw = { events: [] };
  envelope.raw = raw;

  const response = await providerFetch(`https://platform.liner.com/api/v1/${tier}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: query }],
      lang: "en",
      request_id: `dr_${Date.now()}`,
    }),
  });

  let streamError = null;
  const parser = createSseParser((event) => {
    if (event.done) return;

    const payload = event.data;
    raw.events.push({ event: event.event, data: payload });

    if (!payload || typeof payload !== "object") return;

    if (payload.type === "start") {
      envelope.requestId = payload.message_metadata?.request_id || payload.message_id || envelope.requestId;
    }

    if (payload.type === "data-search-tasks") {
      envelope.tasks = mergeTasks(envelope.tasks, toArray(payload.data?.tasks).map(normalizeTask));
    }

    if (payload.type === "data-search-references") {
      envelope.sources = mergeSources(
        envelope.sources,
        toArray(payload.data?.references).map((item, index) => normalizeSource(item, index + 1, "reference"))
      );
    }

    if (payload.type === "data-search-chunks") {
      envelope.sources = mergeSources(
        envelope.sources,
        toArray(payload.data?.referenceChunks).map((item) => normalizeSource({
          title: item.source_title,
          url: item.source_url,
          description: item.content,
          num: item.num,
        }, item.num, "chunk"))
      );
    }

    if (payload.type === "reasoning-delta") {
      envelope.reasoningText += payload.delta || "";
    }

    if (payload.type === "text-delta") {
      envelope.reportText += payload.delta || "";
    }

    if (payload.type === "data-metadata") {
      envelope.nativeUsage = payload.data || payload;
    }

    if (payload.type === "data-error") {
      streamError = new Error(payload.error?.message || payload.message || "Liner stream error");
    }

    update();
  });

  await readResponseStream(response, parser.write);
  parser.end();

  if (streamError) throw streamError;
}

async function runPerplexity({ apiKey, query, tier, envelope, update }) {
  const raw = { events: [] };
  envelope.raw = raw;

  const response = await providerFetch("https://api.perplexity.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: query,
      preset: tier,
      stream: true,
    }),
  });

  const parser = createSseParser((event) => {
    if (event.done) return;

    const payload = event.data;
    const type = payload?.type || event.event || "";
    raw.events.push({ event: event.event, data: payload });

    if (payload?.id && !envelope.requestId) {
      envelope.requestId = payload.id;
    }

    if (type === "response.output_text.delta" || type === "output_text.delta") {
      envelope.reportText += payload.delta || "";
    }

    if (type === "response.reasoning.delta" || type === "reasoning.delta") {
      envelope.reasoningText += payload.delta || "";
    }

    if (type === "response.reasoning.search_results" || type === "reasoning.search_results") {
      envelope.sources = mergeSources(
        envelope.sources,
        toArray(payload.results).map((item, index) => normalizeSource(item, item.id || index + 1, "search_result"))
      );
    }

    if (type === "response.completed" || type === "response.done") {
      envelope.nativeUsage = payload.response?.usage || payload.usage || envelope.nativeUsage;
      envelope.requestId = payload.response?.id || payload.id || envelope.requestId;
      envelope.reportText ||= payload.response?.output_text || payload.output_text || "";
      const nativeCost = extractPerplexityCost(envelope.nativeUsage);
      if (typeof nativeCost === "number") {
        envelope.cost = nativeCost;
        envelope.nativeCost = nativeCost;
        envelope.costSource = "native-usage";
      }
      const output = toArray(payload.response?.output || payload.output);
      envelope.sources = mergeSources(envelope.sources, extractPerplexitySources(output));
    }

    if (payload?.usage) {
      envelope.nativeUsage = payload.usage;
      const nativeCost = extractPerplexityCost(payload.usage);
      if (typeof nativeCost === "number") {
        envelope.cost = nativeCost;
        envelope.nativeCost = nativeCost;
        envelope.costSource = "native-usage";
      }
    }

    update();
  });

  await readResponseStream(response, parser.write);
  parser.end();
}

async function runParallel({ apiKey, query, tier, envelope, update }) {
  const raw = { events: [], create: null, result: null };
  envelope.raw = raw;

  const createResponse = await providerFetch("https://api.parallel.ai/v1/tasks/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "parallel-beta": "events-sse-2025-07-24",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      input: query,
      processor: tier,
      enable_events: true,
      task_spec: {
        output_schema: {
          type: "text",
          description: "Return a markdown research report with inline citations and enough structure to compare against other deep research providers.",
        },
      },
    }),
  });

  const created = await responseJson(createResponse);
  raw.create = created;
  envelope.runId = created.run_id || created.run?.run_id || null;
  envelope.requestId = envelope.runId;
  envelope.tasks = mergeTasks(envelope.tasks, [normalizeTask({
    id: "create",
    title: `Created ${tier} task run`,
    status: created.status || created.run?.status || "running",
  })]);
  update();

  if (!envelope.runId) {
    throw new Error("Parallel did not return a run_id");
  }

  await streamParallelEvents({ apiKey, runId: envelope.runId, raw, envelope, update });

  const result = await retrieveParallelResultWithPolling({ apiKey, runId: envelope.runId, envelope, update });
  raw.result = result;

  envelope.reportText = extractParallelReport(result) || envelope.reportText;
  envelope.sources = mergeSources(envelope.sources, extractParallelSources(result));
  envelope.nativeUsage = result.usage || result.run?.usage || null;
  envelope.tasks = mergeTasks(envelope.tasks, [normalizeTask({
    id: "completed",
    title: "Retrieved final task result",
    status: result.run?.status || "completed",
  })]);
  update();
}

async function retrieveParallelResultWithPolling({ apiKey, runId, envelope, update }) {
  const deadline = Date.now() + PROVIDER_TIMEOUT_MS;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    envelope.tasks = mergeTasks(envelope.tasks, [normalizeTask({
      id: "polling-result",
      title: `Polling final task result, attempt ${attempt}`,
      status: "running",
    })]);
    update();

    try {
      const resultResponse = await providerFetch(
        `https://api.parallel.ai/v1/tasks/runs/${encodeURIComponent(runId)}/result?timeout=${PARALLEL_POLL_TIMEOUT_SECONDS}`,
        {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
          },
        },
        (PARALLEL_POLL_TIMEOUT_SECONDS + 5) * 1000
      );
      return responseJson(resultResponse);
    } catch (error) {
      if (error.status !== 408) throw error;
    }
  }

  throw new Error(`Parallel task did not complete within ${PROVIDER_TIMEOUT_MS}ms`);
}

async function streamParallelEvents({ apiKey, runId, raw, envelope, update }) {
  try {
    const response = await providerFetch(`https://api.parallel.ai/v1beta/tasks/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
      },
    }, 10000);

    const parser = createSseParser((event) => {
      if (event.done) return;

      const payload = event.data;
      const type = payload?.type || event.event || "task_run.event";
      raw.events.push({ event: event.event, data: payload });

      envelope.tasks = mergeTasks(envelope.tasks, [normalizeTask({
        id: payload?.event_id || payload?.id || type,
        title: summarizeParallelEvent(payload, type),
        status: payload?.status || payload?.task_run?.status || payload?.run?.status || "running",
      })]);

      if (payload?.task_run?.run_id) envelope.runId = payload.task_run.run_id;
      if (payload?.task_run?.status === "completed" || payload?.run?.status === "completed") {
        envelope.tasks = mergeTasks(envelope.tasks, [normalizeTask({
          id: "events-completed",
          title: "Parallel event stream completed",
          status: "completed",
        })]);
      }

      const eventResult = payload?.task_run?.output || payload?.output;
      if (eventResult) {
        envelope.reportText = extractParallelReport({ output: eventResult }) || envelope.reportText;
        envelope.sources = mergeSources(envelope.sources, extractParallelSources({ output: eventResult }));
      }

      update();
    });

    await readResponseStream(response, parser.write);
    parser.end();
  } catch (error) {
    envelope.tasks = mergeTasks(envelope.tasks, [normalizeTask({
      id: "events-unavailable",
      title: `Event stream unavailable, using result polling (${getSafeErrorMessage(error)})`,
      status: "running",
    })]);
    update();
  }
}

function createSseParser(onEvent) {
  let buffer = "";

  const flushBlock = (block) => {
    const lines = block.split(/\r?\n/);
    const dataLines = [];
    let event = "";

    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    if (dataLines.length === 0) return;

    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") {
      onEvent({ event, done: true });
      return;
    }

    onEvent({
      event,
      done: false,
      data: parseJson(dataText),
      raw: dataText,
    });
  };

  return {
    write(chunk) {
      buffer += chunk;
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      for (const part of parts) flushBlock(part);
    },
    end() {
      if (buffer.trim()) flushBlock(buffer);
      buffer = "";
    },
  };
}

async function providerFetch(url, options, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      const data = parseJson(text);
      const error = new Error(extractProviderError(data, response.statusText));
      error.status = response.status;
      error.raw = data;
      throw error;
    }

    return response;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Provider timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseStream(response, onText) {
  if (!response.body) {
    onText(await response.text());
    return;
  }

  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    onText(decoder.decode(chunk, { stream: true }));
  }
  const tail = decoder.decode();
  if (tail) onText(tail);
}

async function responseJson(response) {
  return parseJson(await response.text());
}

function normalizeTierSelection(selection) {
  const tiers = {};

  for (const provider of PROVIDERS) {
    const selected = String(selection[provider.id] || provider.defaultTier);
    tiers[provider.id] = provider.tiers.includes(selected) ? selected : provider.defaultTier;
  }

  return tiers;
}

function mergeTasks(existing, incoming) {
  const byId = new Map(toArray(existing).map((item) => [item.id || item.title, item]));
  for (const item of toArray(incoming)) {
    if (!item?.title) continue;
    byId.set(item.id || item.title, { ...(byId.get(item.id || item.title) || {}), ...item });
  }
  return Array.from(byId.values()).slice(-24);
}

function mergeSources(existing, incoming) {
  const byKey = new Map(toArray(existing).map((item) => [item.url || item.id || item.title, item]));
  for (const item of toArray(incoming)) {
    if (!item?.url && !item?.title && !item?.excerpt) continue;
    byKey.set(item.url || item.id || item.title, { ...(byKey.get(item.url || item.id || item.title) || {}), ...item });
  }
  return Array.from(byKey.values()).slice(0, 250);
}

function normalizeTask(item) {
  return {
    id: String(item.id || item.task_id || item.title || "").slice(0, 120),
    title: String(item.title || item.name || item.message || item.status || "Research step").slice(0, 260),
    status: String(item.status || "running"),
  };
}

function normalizeSource(item, id, kind) {
  return {
    id: String(item.id || item.num || id || ""),
    kind,
    title: cleanText(item.title || item.source_title || item.hostname || "Untitled source", 220),
    url: item.url || item.source_url || "",
    hostname: item.hostname || safeHostname(item.url || item.source_url),
    date: item.date || item.published_date || null,
    excerpt: cleanText(item.description || item.snippet || item.content || item.excerpt || firstText(item.excerpts), 900),
    favicon: item.favicon_url || item.favicon || null,
  };
}

function extractPerplexitySources(output) {
  const sources = [];
  for (const item of toArray(output)) {
    if (item?.type !== "search_results") continue;
    sources.push(...toArray(item.results).map((result, index) => normalizeSource(result, result.id || index + 1, "search_result")));
  }
  return sources;
}

function estimateFixedProviderCost(providerId, tier) {
  return FIXED_COST_BY_PROVIDER_TIER[providerId]?.[tier] ?? null;
}

function extractPerplexityCost(usage) {
  const value = usage?.cost?.total_cost ?? usage?.cost?.totalCost ?? usage?.total_cost;
  return typeof value === "number" ? value : null;
}

function extractParallelReport(result) {
  const output = result?.output || result?.task_run?.output || result;
  if (typeof output?.content === "string") return output.content;
  if (typeof output?.text === "string") return output.text;
  if (typeof output === "string") return output;
  if (output?.content && typeof output.content === "object") {
    return JSON.stringify(output.content, null, 2);
  }
  return "";
}

function extractParallelSources(result) {
  const output = result?.output || result?.task_run?.output || result;
  const basis = toArray(output?.basis);
  const citations = [
    ...basis.flatMap((item) => toArray(item.citations)),
    ...toArray(output?.citations),
  ];

  return citations.map((citation, index) => normalizeSource({
    title: citation.title || citation.source_title || citation.url,
    url: citation.url,
    description: firstText(citation.excerpts) || citation.excerpt || citation.reasoning,
  }, index + 1, "basis"));
}

function summarizeParallelEvent(payload, type) {
  if (payload?.message) return cleanText(payload.message, 220);
  if (payload?.task?.title) return cleanText(payload.task.title, 220);
  if (payload?.data?.message) return cleanText(payload.data.message, 220);
  if (payload?.task_run?.status) return `Task run ${payload.task_run.status}`;
  return String(type || "Parallel progress");
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
  return String(error?.message || "Unknown error").slice(0, 500);
}

function cleanText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function safeHostname(value) {
  try {
    return value ? new URL(value).hostname : "";
  } catch {
    return "";
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstText(value) {
  return toArray(value).find((item) => typeof item === "string" && item.trim()) || "";
}

module.exports = handler;
module.exports._test = {
  createSseParser,
  extractParallelReport,
  extractParallelSources,
  extractPerplexitySources,
  mergeSources,
  mergeTasks,
  normalizeSource,
  normalizeTask,
  normalizeTierSelection,
  estimateFixedProviderCost,
  extractPerplexityCost,
};
