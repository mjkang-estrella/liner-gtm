const providers = [
    { id: 'perplexity', name: 'PERPLEXITY', tierSelectId: 'perplexityTier' },
    { id: 'parallel', name: 'PARALLEL', tierSelectId: 'parallelTier' },
    { id: 'liner', name: 'LINER', tierSelectId: 'linerTier' },
];

const fixedCostByProviderTier = {
    liner: {
        'deep-research': 0.2,
        'deep-research-pro': 0.3,
    },
    parallel: {
        'pro-fast': 0.1,
        'ultra-fast': 0.3,
        pro: 0.1,
        ultra: 0.3,
    },
};

function createProviderState(provider, status = 'idle', error = null) {
    const tier = getTierValue(provider);
    return {
        ...provider,
        status,
        tier,
        latencyMs: null,
        requestId: null,
        runId: null,
        reportText: '',
        reasoningText: '',
        tasks: [],
        taskCount: 0,
        sources: [],
        sourceCount: 0,
        outputLength: 0,
        cost: estimateFixedCost(provider.id, tier),
        costSource: estimateFixedCost(provider.id, tier) == null ? null : 'estimated-fixed-tier',
        nativeCost: estimateFixedCost(provider.id, tier),
        nativeUsage: null,
        raw: null,
        error,
    };
}

const state = {
    isSearching: false,
    providers: providers.map((provider) => createProviderState(provider)),
    lastRun: null,
    error: null,
    modalTrigger: null,
};

const queryInput = document.querySelector('#queryInput');
const searchButton = document.querySelector('#searchButton');
const buttonStatus = document.querySelector('#buttonStatus');
const resultsArea = document.querySelector('#resultsArea');
const jsonModal = document.querySelector('#jsonModal');
const jsonModalTitle = document.querySelector('#jsonModalTitle');
const jsonModalBody = document.querySelector('#jsonModalBody');
const researchInputRow = document.querySelector('#researchInputRow');
const inputExpandBackdrop = document.querySelector('#inputExpandBackdrop');
const tierControls = providers.map((provider) => document.querySelector(`#${provider.tierSelectId}`));

window.addEventListener('DOMContentLoaded', () => {
    queryInput.focus();
    queryInput.setSelectionRange(queryInput.value.length, queryInput.value.length);
    render();
    loadDefaultSnapshot();
});

searchButton.addEventListener('click', runResearch);

queryInput.addEventListener('focus', expandInputComposer);
queryInput.addEventListener('click', expandInputComposer);

inputExpandBackdrop.addEventListener('click', collapseInputComposer);

tierControls.forEach((control) => {
    control.addEventListener('change', () => {
        state.providers = state.providers.map((provider) => ({
            ...provider,
            tier: getTierValue(provider),
        }));
        render();
    });
});

resultsArea.addEventListener('click', (event) => {
    const rawButton = event.target.closest('[data-action="open-json"]');
    if (rawButton) {
        openJsonModal(rawButton.dataset.providerId);
        return;
    }

    const toggle = event.target.closest('[data-action="toggle-panel"]');
    if (!toggle) return;

    const panel = toggle.closest('.research-panel');
    const content = panel?.querySelector('.research-panel-content');
    if (!panel || !content) return;

    const isOpen = panel.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    content.hidden = !isOpen;
});

jsonModal.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="close-json"]')) {
        closeJsonModal();
    }
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && researchInputRow.classList.contains('is-expanded')) {
        collapseInputComposer();
        return;
    }

    if (event.key === 'Escape' && !jsonModal.hidden) {
        closeJsonModal();
        return;
    }

    if (event.key === 'Tab' && !jsonModal.hidden) {
        keepFocusInModal(event);
    }
});

queryInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        runResearch();
    }
});

function expandInputComposer() {
    if (researchInputRow.classList.contains('is-expanded')) return;

    researchInputRow.classList.add('is-expanded');
    inputExpandBackdrop.hidden = false;
}

function collapseInputComposer() {
    researchInputRow.classList.remove('is-expanded');
    inputExpandBackdrop.hidden = true;
    queryInput.blur();
}

async function runResearch() {
    const query = queryInput.value.trim();
    if (!query || state.isSearching) return;

    state.isSearching = true;
    state.error = null;
    state.lastRun = null;
    state.providers = providers.map((provider) => createProviderState(provider, 'loading'));
    render();

    try {
        const response = await fetch('/api/deep-research', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query,
                tiers: getTierSelection(),
            }),
        });

        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || payload.message || 'Deep research failed');
        }

        await readNdjson(response, handleStreamEvent);
    } catch (error) {
        state.error = error.message || 'Deep research failed';
        state.providers = providers.map((provider) => (
            createProviderState(provider, 'error', { message: state.error })
        ));
    } finally {
        state.isSearching = false;
        render();
    }
}

async function loadDefaultSnapshot() {
    try {
        const response = await fetch('/benchmark/deep-research-default-results.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('Default snapshot unavailable');

        const payload = await response.json();
        if (payload.query) {
            queryInput.value = payload.query;
        }
        if (payload.tiers) {
            setTierSelection(payload.tiers);
        }
        state.providers = toProviderSnapshot(payload.providers || state.providers);
        state.lastRun = payload;
        render();
    } catch {
        render();
    }
}

async function readNdjson(response, onEvent) {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.trim()) onEvent(JSON.parse(line));
        }
    }

    buffer += decoder.decode();
    if (buffer.trim()) onEvent(JSON.parse(buffer));
}

function handleStreamEvent(event) {
    if (event.type === 'run-start') {
        state.lastRun = event;
        state.providers = toProviderSnapshot(event.providers || state.providers);
        render();
        return;
    }

    if (event.type === 'provider-update') {
        state.providers = state.providers.map((provider) => (
            provider.id === event.provider.id ? normalizeProviderCost(event.provider) : provider
        ));
        render();
        return;
    }

    if (event.type === 'run-complete') {
        state.lastRun = {
            ...(state.lastRun || {}),
            ...event,
            providers: state.providers,
        };
        render();
    }
}

function render() {
    searchButton.disabled = state.isSearching;
    buttonStatus.textContent = state.isSearching ? 'RUNNING' : 'EXECUTE';
    resultsArea.innerHTML = state.providers.map(renderProviderCard).join('');
}

function renderProviderCard(provider) {
    const cost = getProviderCost(provider);
    return `
        <article class="provider-card research-provider-card" data-provider-id="${escapeAttribute(provider.id)}">
            <div class="card-header">
                <div>
                    <div class="provider-name mono">${escapeHtml(provider.name)}</div>
                    <div class="provider-tier mono">${escapeHtml(provider.tier || '-')}</div>
                </div>
                <div class="metrics">
                    <div class="metric-item"><span class="metric-label">STS:</span> ${escapeHtml(getStatusLabel(provider))}</div>
                    <div class="metric-item"><span class="metric-label">LAT:</span> ${formatLatency(provider.latencyMs)}</div>
                    <div class="metric-item"><span class="metric-label">SRC:</span> ${formatNumber(provider.sourceCount)}</div>
                    <div class="metric-item"><span class="metric-label">TSK:</span> ${formatNumber(provider.taskCount)}</div>
                    <div class="metric-item"><span class="metric-label">OUT:</span> ${formatNumber(provider.outputLength)}</div>
                    <div class="metric-item"><span class="metric-label">CST:</span> ${formatCost(cost.value)}</div>
                </div>
            </div>
            <div class="card-body research-card-body">
                ${renderProviderBody(provider)}
            </div>
            <div class="card-footer">
                ${renderRawButton(provider)}
            </div>
        </article>
    `;
}

function renderProviderBody(provider) {
    if (provider.status === 'loading' && !provider.reportText && provider.tasks.length === 0 && provider.sources.length === 0) {
        return renderSkeleton();
    }

    if (provider.status === 'idle') {
        return '<div class="state-message">Awaiting deep research execution.</div>';
    }

    if (provider.status === 'skipped') {
        return `<div class="state-message status-skipped"><strong>Skipped</strong><br>${escapeHtml(provider.error?.message || 'Missing API key')}</div>`;
    }

    if (provider.status === 'error') {
        const status = provider.error?.httpStatus ? `HTTP ${provider.error.httpStatus}` : 'REQUEST ERROR';
        return `<div class="state-message status-error"><strong>${escapeHtml(status)}</strong><br>${escapeHtml(provider.error?.message || 'Provider failed')}</div>${renderPartialProviderData(provider)}`;
    }

    return renderPartialProviderData(provider) || '<div class="state-message">Waiting for provider output.</div>';
}

function renderPartialProviderData(provider) {
    return [
        renderReport(provider),
        renderPanel('Reasoning', provider.reasoningText ? `<p class="research-text">${renderMarkdown(provider.reasoningText)}</p>` : '', provider.reasoningText.length),
        renderPanel('Tasks', renderTasks(provider.tasks), provider.tasks.length),
        renderPanel('Sources', renderSources(provider.sources), provider.sources.length),
    ].filter(Boolean).join('');
}

function renderReport(provider) {
    if (!provider.reportText) {
        if (provider.status === 'loading') {
            return '<div class="state-message">Collecting research signals...</div>';
        }
        return '';
    }

    return `
        <section class="research-report">
            <div class="research-section-label mono">Report Preview</div>
            <div class="research-markdown">${renderMarkdown(truncate(provider.reportText, 12000))}</div>
        </section>
    `;
}

function renderPanel(title, content, count) {
    if (!content) return '';

    const id = title.toLowerCase();
    return `
        <section class="research-panel ${id === 'sources' ? 'is-open' : ''}">
            <button class="research-panel-toggle" type="button" data-action="toggle-panel" aria-expanded="${id === 'sources' ? 'true' : 'false'}">
                <span>${escapeHtml(title)}</span>
                <span>${formatNumber(count)}</span>
            </button>
            <div class="research-panel-content" ${id === 'sources' ? '' : 'hidden'}>
                ${content}
            </div>
        </section>
    `;
}

function renderTasks(tasks) {
    if (!tasks.length) return '';

    return `
        <ol class="task-list">
            ${tasks.map((task) => `
                <li>
                    <span class="task-status mono">${escapeHtml(task.status || 'running')}</span>
                    <span>${escapeHtml(task.title || 'Research step')}</span>
                </li>
            `).join('')}
        </ol>
    `;
}

function renderSources(sources) {
    if (!sources.length) return '';

    return `
        <div class="source-list">
            ${sources.map((source, index) => `
                <article class="source-card">
                    <div class="source-index mono">${escapeHtml(source.id || index + 1)}</div>
                    <div>
                        <a href="${escapeAttribute(source.url || '#')}" target="_blank" rel="noreferrer">${escapeHtml(source.title || `Source ${index + 1}`)}</a>
                        <div class="source-meta mono">${escapeHtml([source.kind, source.hostname, source.date].filter(Boolean).join(' / ') || 'source')}</div>
                        ${source.excerpt ? `<p>${escapeHtml(truncate(source.excerpt, 420))}</p>` : ''}
                    </div>
                </article>
            `).join('')}
        </div>
    `;
}

function renderSkeleton() {
    return Array.from({ length: 5 }, () => `
        <div class="result-snippet" aria-hidden="true">
            <div class="skeleton-line medium"></div>
            <div class="skeleton-line"></div>
            <div class="skeleton-line short"></div>
        </div>
    `).join('');
}

function renderRawButton(provider) {
    return `
        <button class="raw-button" type="button" data-action="open-json" data-provider-id="${escapeAttribute(provider.id)}">VIEW RAW JSON</button>
    `;
}

function openJsonModal(providerId) {
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) return;

    const cost = getProviderCost(provider);
    state.modalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const payload = {
        provider: provider.name,
        status: getStatusLabel(provider),
        tier: provider.tier,
        latencyMs: provider.latencyMs,
        requestId: provider.requestId,
        runId: provider.runId,
        sourceCount: provider.sourceCount,
        taskCount: provider.taskCount,
        outputLength: provider.outputLength,
        cost: cost.value,
        costSource: cost.source,
        nativeCost: provider.nativeCost,
        nativeUsage: provider.nativeUsage,
        error: provider.error,
        normalized: provider,
        raw: provider.raw || provider.error || { status: provider.status },
    };

    jsonModalTitle.textContent = `${provider.name} RAW JSON`;
    jsonModalBody.textContent = JSON.stringify(payload, null, 2);
    jsonModal.hidden = false;
    document.querySelector('.app-container')?.setAttribute('inert', '');
    jsonModal.querySelector('[data-action="close-json"]').focus();
}

function closeJsonModal() {
    jsonModal.hidden = true;
    jsonModalBody.textContent = '';
    document.querySelector('.app-container')?.removeAttribute('inert');
    if (state.modalTrigger?.isConnected) {
        state.modalTrigger.focus();
    }
    state.modalTrigger = null;
}

function keepFocusInModal(event) {
    const focusable = Array.from(jsonModal.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )).filter((element) => element.offsetParent !== null);

    if (focusable.length === 0) {
        event.preventDefault();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function getTierSelection() {
    return Object.fromEntries(providers.map((provider) => [provider.id, getTierValue(provider)]));
}

function setTierSelection(tiers) {
    for (const provider of providers) {
        const control = document.querySelector(`#${provider.tierSelectId}`);
        if (control && tiers[provider.id]) {
            control.value = tiers[provider.id];
        }
    }
}

function getTierValue(provider) {
    return document.querySelector(`#${provider.tierSelectId}`)?.value || '';
}

function toProviderSnapshot(snapshotProviders) {
    return providers.map((provider) => ({
        ...createProviderState(provider),
        ...normalizeProviderCost(snapshotProviders.find((item) => item.id === provider.id) || {}),
    }));
}

function normalizeProviderCost(provider) {
    const cost = getProviderCost(provider);
    return {
        ...provider,
        cost: cost.value,
        costSource: cost.source,
        nativeCost: typeof provider.nativeCost === 'number' ? provider.nativeCost : cost.value,
    };
}

function getProviderCost(provider) {
    if (typeof provider.cost === 'number') {
        return { value: provider.cost, source: provider.costSource || 'provider-envelope' };
    }

    if (typeof provider.nativeCost === 'number') {
        return { value: provider.nativeCost, source: provider.costSource || 'native-cost' };
    }

    const nativeUsageCost = extractNativeUsageCost(provider.nativeUsage);
    if (typeof nativeUsageCost === 'number') {
        return { value: nativeUsageCost, source: 'native-usage' };
    }

    const estimatedCost = estimateFixedCost(provider.id, provider.tier);
    if (typeof estimatedCost === 'number') {
        return { value: estimatedCost, source: 'estimated-fixed-tier' };
    }

    return { value: null, source: null };
}

function estimateFixedCost(providerId, tier) {
    return fixedCostByProviderTier[providerId]?.[tier] ?? null;
}

function extractNativeUsageCost(nativeUsage) {
    const value = nativeUsage?.cost?.total_cost ?? nativeUsage?.cost?.totalCost ?? nativeUsage?.total_cost;
    return typeof value === 'number' ? value : null;
}

function getStatusLabel(provider) {
    switch (provider.status) {
        case 'loading':
            return provider.reportText || provider.tasks.length || provider.sources.length ? 'Streaming' : 'Loading';
        case 'ok':
            return 'OK';
        case 'skipped':
            return 'Skipped';
        case 'error':
            return 'Error';
        default:
            return 'Idle';
    }
}

function formatLatency(value) {
    return typeof value === 'number' ? `${value}ms` : '-';
}

function formatNumber(value) {
    return typeof value === 'number' ? String(value) : '-';
}

function formatCost(value) {
    if (typeof value !== 'number') return '-';
    if (value === 0) return '$0';
    return `$${value.toFixed(value < 0.01 ? 3 : 2)}`;
}

function truncate(value, maxLength) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
}

function renderMarkdown(value) {
    const lines = String(value || '').split(/\r?\n/);
    const html = [];
    let paragraph = [];
    let listItems = [];
    let orderedItems = [];
    let tableRows = [];
    let codeLines = [];
    let inCode = false;

    const flushParagraph = () => {
        if (!paragraph.length) return;
        html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
        paragraph = [];
    };
    const flushList = () => {
        if (listItems.length) {
            html.push(`<ul>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`);
            listItems = [];
        }
        if (orderedItems.length) {
            html.push(`<ol>${orderedItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ol>`);
            orderedItems = [];
        }
    };
    const flushTable = () => {
        if (!tableRows.length) return;
        html.push(renderMarkdownTable(tableRows));
        tableRows = [];
    };
    const flushCode = () => {
        if (!codeLines.length) return;
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
    };
    const flushAll = () => {
        flushParagraph();
        flushList();
        flushTable();
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (line.startsWith('```')) {
            if (inCode) {
                inCode = false;
                flushCode();
            } else {
                flushAll();
                inCode = true;
            }
            continue;
        }

        if (inCode) {
            codeLines.push(rawLine);
            continue;
        }

        if (!line) {
            flushAll();
            continue;
        }

        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        if (heading) {
            flushAll();
            const level = Math.min(heading[1].length + 2, 4);
            html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
            continue;
        }

        if (/^\|.+\|$/.test(line)) {
            flushParagraph();
            flushList();
            tableRows.push(line);
            continue;
        }

        const unordered = line.match(/^[-*]\s+(.+)$/);
        if (unordered) {
            flushParagraph();
            flushTable();
            listItems.push(unordered[1]);
            continue;
        }

        const ordered = line.match(/^\d+\.\s+(.+)$/);
        if (ordered) {
            flushParagraph();
            flushTable();
            orderedItems.push(ordered[1]);
            continue;
        }

        flushList();
        flushTable();
        paragraph.push(line);
    }

    if (inCode) flushCode();
    flushAll();
    return html.join('');
}

function renderInlineMarkdown(value) {
    return escapeHtml(value)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderMarkdownTable(rows) {
    const parsedRows = rows
        .map((row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
        .filter((row) => row.some(Boolean));

    if (parsedRows.length < 2 || !isDividerRow(parsedRows[1])) {
        return `<pre class="research-table">${escapeHtml(rows.join('\n'))}</pre>`;
    }

    const headers = parsedRows[0];
    const bodyRows = parsedRows.slice(2).filter((row) => !isDividerRow(row));

    return `
        <div class="research-table-scroll">
            <table class="research-table">
                <thead>
                    <tr>${headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr>
                </thead>
                <tbody>
                    ${bodyRows.map((row) => `
                        <tr>
                            ${headers.map((_, index) => `<td>${renderInlineMarkdown(row[index] || '')}</td>`).join('')}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function isDividerRow(row) {
    return row.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
}
