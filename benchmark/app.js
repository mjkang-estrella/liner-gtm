const providers = [
        { id: 'liner', name: 'LINER' },
        { id: 'exa', name: 'EXA' },
        { id: 'perplexity', name: 'PERPLEXITY' },
        { id: 'parallel', name: 'PARALLEL' },
        { id: 'tavily', name: 'TAVILY' },
        { id: 'brave', name: 'BRAVE' },
    ];

    function createProviderState(provider, status = 'idle', error = null) {
        return {
            ...provider,
            status,
            latencyMs: null,
            resultCount: 0,
            defaultResults: null,
            requestId: null,
            nativeCost: null,
            nativeUsage: null,
            raw: null,
            results: [],
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

    window.addEventListener('DOMContentLoaded', () => {
        queryInput.focus();
        queryInput.setSelectionRange(queryInput.value.length, queryInput.value.length);
        render();
        loadDefaultSnapshot();
    });

    searchButton.addEventListener('click', runSearch);

    resultsArea.addEventListener('click', (event) => {
        const rawButton = event.target.closest('[data-action="open-json"]');
        if (rawButton) {
            openJsonModal(rawButton.dataset.providerId);
            return;
        }

        const button = event.target.closest('[data-action="toggle-result"]');
        if (!button) return;

        const result = button.closest('.result-snippet');
        const content = result?.querySelector('.result-content');
        if (!result || !content) return;

        const isOpen = result.classList.toggle('is-open');
        const label = button.dataset.resultLabel || 'result';
        button.setAttribute('aria-expanded', String(isOpen));
        button.setAttribute('aria-label', isOpen ? `Collapse ${label}` : `Expand ${label}`);
        content.hidden = !isOpen;
    });

    jsonModal.addEventListener('click', (event) => {
        if (event.target.closest('[data-action="close-json"]')) {
            closeJsonModal();
        }
    });

    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !jsonModal.hidden) {
            closeJsonModal();
            return;
        }

        if (event.key === 'Tab' && !jsonModal.hidden) {
            keepFocusInModal(event);
        }
    });

    queryInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            runSearch();
        }
    });

    async function runSearch() {
        const query = queryInput.value.trim();

        if (!query || state.isSearching) return;

        state.isSearching = true;
        state.error = null;
        state.lastRun = null;
        state.providers = providers.map((provider) => createProviderState(provider, 'loading'));
        render();

        try {
            const response = await fetch('/api/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query }),
            });
            const payload = await response.json();

            if (!response.ok) {
                throw new Error(payload.error || 'Search failed');
            }

            state.providers = payload.providers;
            state.lastRun = payload;
        } catch (error) {
            state.error = error.message || 'Search failed';
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
            const response = await fetch('/benchmark/default-results.json', { cache: 'no-store' });
            if (!response.ok) throw new Error('Default snapshot unavailable');

            const payload = await response.json();
            state.providers = payload.providers || state.providers;
            state.lastRun = payload;
            render();
        } catch (error) {
            state.error = 'Default snapshot not found';
            render();
        }
    }

    function render() {
        searchButton.disabled = state.isSearching;
        buttonStatus.textContent = state.isSearching ? 'RUNNING' : 'EXECUTE';
        resultsArea.innerHTML = [
            ...state.providers.map(renderProviderCard),
            renderProviderPlaceholder(),
        ].join('');
    }

    function renderProviderCard(provider) {
        return `
            <article class="provider-card" data-provider-id="${escapeAttribute(provider.id)}">
                <div class="card-header">
                    <div>
                        <div class="provider-name mono">${escapeHtml(provider.name)}</div>
                    </div>
                    <div class="metrics">
                        <div class="metric-item"><span class="metric-label">LAT:</span> ${formatLatency(provider.latencyMs)}</div>
                        <div class="metric-item"><span class="metric-label">CST:</span> ${formatCost(provider.nativeCost)}</div>
                        <div class="metric-item"><span class="metric-label">SIG:</span> ${escapeHtml(getSignals(provider))}</div>
                    </div>
                </div>
                <div class="card-body">
                    ${renderProviderBody(provider)}
                </div>
                <div class="card-footer">
                    ${renderRawButton(provider)}
                </div>
            </article>
        `;
    }

    function renderProviderBody(provider) {
        if (provider.status === 'loading') return renderSkeleton();

        if (provider.status === 'idle') {
            return '<div class="state-message">Awaiting search execution.</div>';
        }

        if (provider.status === 'skipped') {
            return `<div class="state-message"><strong>Skipped</strong><br>${escapeHtml(provider.error?.message || 'Missing API key')}</div>`;
        }

        if (provider.status === 'error') {
            const status = provider.error?.httpStatus ? `HTTP ${provider.error.httpStatus}` : 'REQUEST ERROR';
            return `<div class="state-message status-error"><strong>${escapeHtml(status)}</strong><br>${escapeHtml(provider.error?.message || 'Provider failed')}</div>`;
        }

        if (!provider.results || provider.results.length === 0) {
            return '<div class="state-message">No normalized results returned.</div>';
        }

        return provider.results.map(renderResult).join('');
    }

    function renderResult(result, index) {
        const meta = [
            result.publishedDate ? `PUB ${formatDate(result.publishedDate)}` : null,
            result.updatedDate ? `UPD ${formatDate(result.updatedDate)}` : null,
            typeof result.score === 'number' ? `SCORE ${formatScore(result.score)}` : null,
            result.favicon ? 'FAVICON' : null,
        ].filter(Boolean).join(' / ');

        return `
            <div class="result-snippet">
                <div class="result-row">
                    <button class="expand-button" type="button" data-action="toggle-result" data-result-label="result ${index + 1}" aria-expanded="false" aria-label="Expand result ${index + 1}">&gt;</button>
                    <a href="${escapeAttribute(result.url || '#')}" class="result-title" target="_blank" rel="noreferrer">${escapeHtml(result.title || `Result ${index + 1}`)}</a>
                </div>
                <div class="result-content" hidden>
                    ${meta ? `<div class="result-meta">${escapeHtml(meta)}</div>` : ''}
                    <p class="result-text">${renderMarkdownInline(truncate(result.snippet || 'No snippet supplied.', 1200))}</p>
                </div>
            </div>
        `;
    }

    function renderSkeleton() {
        return Array.from({ length: 3 }, () => `
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

    function renderProviderPlaceholder() {
        return `
            <article class="provider-placeholder" aria-label="Add additional provider for more results">
                <span>Add additional provider<br>for more results</span>
            </article>
        `;
    }

    function openJsonModal(providerId) {
        const provider = state.providers.find((item) => item.id === providerId);
        if (!provider) return;

        state.modalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const payload = {
            provider: provider.name,
            status: getStatusLabel(provider),
            latencyMs: provider.latencyMs,
            resultCount: provider.resultCount ?? provider.results?.length ?? 0,
            defaultResults: provider.defaultResults,
            requestId: provider.requestId,
            nativeCost: provider.nativeCost,
            nativeUsage: provider.nativeUsage,
            error: provider.error,
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

    function getStatusLabel(provider) {
        switch (provider.status) {
            case 'loading':
                return 'Loading';
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

    function getSignals(provider) {
        if (provider.status === 'loading') return '...';
        if (provider.status === 'skipped') return 'KEY';
        if (provider.status === 'error') return 'ERR';

        const hasDate = provider.results?.some((result) => result.publishedDate || result.updatedDate);
        const hasScore = provider.results?.some((result) => typeof result.score === 'number');
        const signals = [
            hasDate ? 'DATE' : null,
            hasScore ? 'SCORE' : null,
            provider.nativeCost != null ? 'COST' : null,
            provider.nativeUsage != null ? 'USAGE' : null,
            provider.results?.some((result) => result.snippet) ? 'TEXT' : null,
        ].filter(Boolean);

        return signals.length ? signals.join('+') : '-';
    }

    function formatLatency(value) {
        return typeof value === 'number' ? `${value}ms` : '-';
    }

    function formatCost(value) {
        if (typeof value !== 'number') return '-';
        if (value === 0) return '$0';
        return `$${value.toFixed(value < 0.01 ? 3 : 2)}`;
    }

    function formatScore(value) {
        return value.toFixed(value > 1 ? 1 : 3);
    }

    function formatDate(value) {
        return String(value).slice(0, 10);
    }

    function truncate(value, maxLength) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (text.length <= maxLength) return text;
        return `${text.slice(0, maxLength - 3)}...`;
    }

    function renderMarkdownInline(value) {
        const text = String(value || '');
        const parts = [];
        let cursor = 0;
        const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
        let match;

        while ((match = linkPattern.exec(text)) !== null) {
            parts.push(escapeHtml(text.slice(cursor, match.index)));
            parts.push(`<a href="${escapeAttribute(match[2])}" target="_blank" rel="noreferrer">${escapeHtml(match[1])}</a>`);
            cursor = match.index + match[0].length;
        }

        parts.push(escapeHtml(text.slice(cursor)));
        return parts.join('');
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
