const assert = require("node:assert/strict");
const { _test } = require("./deep-research-api.js");

function collectSseEvents(input) {
  const events = [];
  const parser = _test.createSseParser((event) => events.push(event));
  parser.write(input);
  parser.end();
  return events;
}

{
  const events = collectSseEvents([
    "event: data",
    'data: {"type":"data-search-tasks","data":{"tasks":[{"id":"task_01","title":"Gather clinical evidence","status":"in_progress"}]}}',
    "",
    "event: data",
    'data: {"type":"text-delta","id":"text-1","delta":"Report body"}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"));

  assert.equal(events.length, 3);
  assert.equal(events[0].data.type, "data-search-tasks");
  assert.equal(events[1].data.delta, "Report body");
  assert.equal(events[2].done, true);
}

{
  const sources = _test.extractPerplexitySources([
    {
      type: "search_results",
      results: [
        { id: 1, title: "Source A", url: "https://example.com/a", snippet: "Evidence A" },
      ],
    },
  ]);

  assert.equal(sources.length, 1);
  assert.equal(sources[0].hostname, "example.com");
  assert.equal(sources[0].excerpt, "Evidence A");
}

{
  const result = {
    output: {
      type: "text",
      content: "# Market report\n\nBody with [1].",
      basis: [
        {
          field: "content",
          citations: [
            {
              title: "Source B",
              url: "https://example.org/b",
              excerpts: ["Evidence B"],
            },
          ],
        },
      ],
    },
  };

  assert.equal(_test.extractParallelReport(result), "# Market report\n\nBody with [1].");
  const sources = _test.extractParallelSources(result);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, "Source B");
  assert.equal(sources[0].excerpt, "Evidence B");
}

{
  const tiers = _test.normalizeTierSelection({
    perplexity: "advanced-deep-research",
    parallel: "not-real",
    liner: "deep-research-pro",
  });

  assert.deepEqual(tiers, {
    perplexity: "advanced-deep-research",
    parallel: "pro-fast",
    liner: "deep-research-pro",
  });
}

{
  assert.equal(_test.estimateFixedProviderCost("liner", "deep-research"), 0.2);
  assert.equal(_test.estimateFixedProviderCost("liner", "deep-research-pro"), 0.3);
  assert.equal(_test.estimateFixedProviderCost("parallel", "pro-fast"), 0.1);
  assert.equal(_test.estimateFixedProviderCost("parallel", "ultra"), 0.3);
  assert.equal(_test.extractPerplexityCost({ cost: { total_cost: 0.31943 } }), 0.31943);
}

console.log("deep research parser fixtures passed");
