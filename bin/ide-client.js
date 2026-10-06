/**
 * Antigravity Metrics Client-Side Script
 * Injected into Antigravity IDE workbench and Antigravity Standalone chat windows.
 * Tracks live context window tokens, per-chat usage, message telemetry, and tool activity.
 */
(function() {
    try {
        if (window.__antigravity_metrics_injected) return;
        window.__antigravity_metrics_injected = true;

        const defaultMetricsConfig = {
            modelLimit: 256000,
            modelName: 'Gemini 3.8 Flash (Antigravity 256k)',
            warnThreshold: 75,
            costPerMIn: 0.075,
            costPerMOut: 0.30
        };

        let userConfig = { ...defaultMetricsConfig };
        try {
            const rawConfig = typeof __METRICS_CONFIG__ !== 'undefined' ? __METRICS_CONFIG__ : null;
            if (rawConfig) Object.assign(userConfig, rawConfig);
        } catch (_) {}

        // State Store
        const state = {
            config: userConfig,
            currentChatTitle: 'New Conversation',
            currentChatId: '',
            currentChatKey: '',
            hasTranscriptData: false,
            isGenerating: false,
            msgStartTime: 0,
            lastMsgDurationMs: 0,
            // Wall-clock duration of the last turn this client watched run,
            // plus the conversation it belongs to. Used only as a fallback for
            // the newest turn when the transcript's second-granular timestamps
            // cannot resolve a duration (see resolveTurnDuration).
            lastMeasuredDurationMs: 0,
            lastMeasuredChatKey: '',
            latestLiveTokens: 0,
            latestRoundStats: {
                durationMs: 0,
                inputTokens: 0,
                outputTokens: 0,
                thinkingTokens: 0,
                totalRoundTokens: 0,
                toolCount: 0,
                toolsList: []
            },
            sessionStats: {
                totalTokens: 0,
                totalRounds: 0,
                totalSteps: 0,
                totalTools: 0
            },
            rounds: [],
            chatMetricsCache: {}
        };

        // Multi-lingual token estimator (Calibrated for Gemini / SentencePiece & BPE)
        function estimateTokens(text) {
            if (!text || typeof text !== 'string') return 0;
            const nonAsciiMatches = text.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC\u08A0-\u08FF]/g);
            const nonAsciiCount = nonAsciiMatches ? nonAsciiMatches.length : 0;
            const latinChars = text.length - nonAsciiCount;
            const symbols = (text.match(/[{}\[\]()<>=+\-*/:;,"'`\\_]/g) || []).length;
            const latinTokens = Math.ceil(latinChars / 3.65);
            const nonAsciiTokens = Math.ceil(nonAsciiCount / 1.75);
            const symbolTokens = Math.ceil(symbols * 0.12);
            return Math.max(1, latinTokens + nonAsciiTokens + symbolTokens);
        }

        function formatTokens(count) {
            if (!count || count < 0) return '0';
            if (count >= 1000000) return (count / 1000000).toFixed(2) + 'M';
            if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
            return count.toLocaleString();
        }

        function formatDuration(ms) {
            if (!ms || ms <= 0) return '0.0s';
            const s = ms / 1000;
            if (s < 60) return s.toFixed(1) + 's';
            const mins = Math.floor(s / 60);
            const secs = Math.floor(s % 60);
            return `${mins}m ${secs}s`;
        }

        // Cognitive context degradation & dumb zone model
        function getContextZone(tokens, limit) {
            tokens = Math.max(0, tokens || 0);
            limit = Math.max(1, limit || 256000);

            let warnTokens;
            let dumbZoneTokens;

            if (limit <= 128000) {
                // e.g. GPT-4o 128k
                warnTokens = 50000;
                dumbZoneTokens = 85000;
            } else if (limit <= 200000) {
                // e.g. Claude 3.7 Sonnet 200k
                warnTokens = 80000;
                dumbZoneTokens = 135000;
            } else if (limit <= 260000) {
                // e.g. Gemini 3.8 Flash in Antigravity (256k checkpointer limit)
                warnTokens = 100000;
                dumbZoneTokens = 165000;
            } else if (limit <= 500000) {
                // 500k custom limit
                warnTokens = 120000;
                dumbZoneTokens = 180000;
            } else {
                // 1M / 2M (Gemini 3.8 Flash / Pro full windows)
                // In massive windows, models enter mediocre reasoning after ~130k-150k,
                // and dumb zone after ~190k-200k, regardless of 1M advertised capacity.
                warnTokens = 130000;
                dumbZoneTokens = 190000;
            }

            if (tokens >= dumbZoneTokens || (limit > 0 && tokens >= limit * 0.85)) {
                return {
                    zone: 'dumb',
                    label: 'Dumb Zone',
                    badge: '🔴 Dumb Zone',
                    color: '#ef4444',
                    bg: 'rgba(239, 68, 68, 0.18)',
                    description: 'Context rot risk — compaction or fresh session recommended'
                };
            } else if (tokens >= warnTokens || (limit > 0 && tokens >= limit * 0.50)) {
                return {
                    zone: 'mediocre',
                    label: 'Mediocre Zone',
                    badge: '🟡 Attention Degradation',
                    color: '#f59e0b',
                    bg: 'rgba(245, 158, 11, 0.18)',
                    description: 'Attention degradation — subtle instructions may be missed'
                };
            } else {
                return {
                    zone: 'smart',
                    label: 'Smart Zone',
                    badge: '🟢 Smart Zone (Optimal)',
                    color: '#10b981',
                    bg: 'rgba(16, 185, 129, 0.18)',
                    description: 'Optimal reasoning and instruction recall'
                };
            }
        }

        // Save Config to main process
        function saveConfig() {
            try {
                console.log('SAVE_METRICS_CONFIG|' + JSON.stringify(state.config));
            } catch (e) {
                console.error('[Antigravity Metrics] Save config error:', e);
            }
        }

        // Request updated metrics from main process transcript monitor
        function requestTranscriptUpdate(chatQuery) {
            try {
                const active = detectActiveChat();
                let href = '';
                try { href = window.location.href || ''; } catch (_) {}
                const payload = chatQuery || {
                    id: state.currentChatId || active.id || '',
                    title: state.currentChatTitle || active.title || '',
                    firstPrompt: active.firstPrompt || '',
                    key: active.key || '',
                    url: href,
                    isNewConversation: active.isNewConversation || false
                };
                if (!payload.url) payload.url = href;
                console.log('REQUEST_TRANSCRIPT_METRICS|' + JSON.stringify(payload));
            } catch (_) {}
        }

        function isUuid(s) {
            return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
        }

        // External update handler called by main process bridge
        window.__ANTIGRAVITY_METRICS_UPDATE__ = function(data) {
            if (!data) return;

            if (data.notFound) {
                state.hasTranscriptData = false;
                // Keep the id: a "not found" for a known conversation only
                // means its transcript is not on disk yet (brand-new chat),
                // not that we forgot which conversation is open.
                scanDomMetrics();
                return;
            }

            const activeChat = detectActiveChat();
            // Only drop if user is in an unstarted new conversation with 0 messages and data has no rounds
            if (activeChat.isNewConversation && (!data.rounds || data.rounds.length === 0) && !state.isGenerating) {
                return;
            }

            // Reject only on POSITIVE mismatch: both sides name a concrete,
            // different conversation id. When our side has no id (e.g. IDE
            // webview without /c/ in the URL) we cannot verify, so we accept
            // and adopt the transcript's id instead of freezing the pill.
            if (isUuid(data.conversationId) && isUuid(activeChat.id) && activeChat.id !== data.conversationId) {
                return;
            }

            if (data.conversationId) {
                state.currentChatId = data.conversationId;
                // Adopt the authoritative key when we know the id. Legacy
                // placeholder keys ('default-chat', 'active-dom-chat') from
                // older versions, and any non-id key while the id is known,
                // are upgraded so future switches hit the cache.
                if (!state.currentChatKey || state.currentChatKey === 'default-chat' || state.currentChatKey === 'active-dom-chat' || (isUuid(activeChat.id) && state.currentChatKey !== 'id:' + activeChat.id)) {
                    state.currentChatKey = 'id:' + data.conversationId;
                }
            }

            if (data.title && (state.currentChatTitle === 'Active Conversation' || state.currentChatTitle === 'New Conversation' || !state.currentChatTitle)) {
                state.currentChatTitle = data.title;
            }

            if (data.sessionStats) {
                state.sessionStats = { ...state.sessionStats, ...data.sessionStats };
                state.hasTranscriptData = true;
            }
            if (data.latestRoundStats) {
                state.latestRoundStats = { ...state.latestRoundStats, ...data.latestRoundStats };
            }
            if (Array.isArray(data.rounds)) {
                state.rounds = data.rounds;
            }

            const cacheEntry = {
                sessionStats: { ...state.sessionStats },
                latestRoundStats: { ...state.latestRoundStats },
                rounds: Array.isArray(state.rounds) ? [...state.rounds] : [],
                hasTranscriptData: true,
                title: state.currentChatTitle,
                id: state.currentChatId,
                firstPrompt: data.firstPrompt || activeChat.firstPrompt || ''
            };

            if (state.currentChatKey) {
                state.chatMetricsCache[state.currentChatKey] = cacheEntry;
            }
            if (data.conversationId) {
                state.chatMetricsCache['id:' + data.conversationId] = cacheEntry;
            }

            updateUI();
            syncTurnTelemetry();
        };

        // DOM Element helper
        function el(tag, styles, children, attrs) {
            const element = document.createElement(tag);
            if (styles) element.style.cssText = styles;
            if (attrs) Object.assign(element, attrs);
            if (children) {
                if (typeof children === 'string') {
                    element.textContent = children;
                } else if (Array.isArray(children)) {
                    for (const child of children) {
                        if (child) element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
                    }
                } else {
                    element.appendChild(children);
                }
            }
            return element;
        }

        // Inject Stylesheet
        let style = document.getElementById('antigravity-metrics-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'antigravity-metrics-style';
            style.textContent = `
                /* Prevent horizontal window scrollbar if elements touch window bounds */
                body {
                    overflow-x: hidden !important;
                }

                @keyframes agm-pulse-dot {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.4; transform: scale(0.85); }
                }
                .agm-pulsing-dot {
                    display: inline-block;
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background-color: #10b981;
                    box-shadow: 0 0 8px #10b981;
                    animation: agm-pulse-dot 1.2s infinite ease-in-out;
                }
                .agm-pulsing-dot-amber {
                    display: inline-block;
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background-color: #f59e0b;
                    box-shadow: 0 0 8px #f59e0b;
                    animation: agm-pulse-dot 1.0s infinite ease-in-out;
                }

                /* Dedicated Topbar Button (Twin of Install IDE & RTL buttons) */
                .agm-topbar-btn {
                    display: inline-flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                    font-size: 12.5px !important;
                    font-weight: 500 !important;
                    line-height: 1 !important;
                    height: 28px !important;
                    padding: 0 9px !important;
                    border-radius: 6px !important;
                    border: 1px solid var(--border, rgba(255, 255, 255, 0.12)) !important;
                    background-color: transparent !important;
                    color: var(--secondary-foreground, #f4f4f5) !important;
                    cursor: pointer !important;
                    user-select: none !important;
                    white-space: nowrap !important;
                    transition: all 0.15s ease !important;
                    app-region: no-drag !important;
                    -webkit-app-region: no-drag !important;
                    gap: 5px !important;
                    outline: none !important;
                }
                .agm-topbar-btn:hover {
                    background-color: var(--secondary, rgba(255, 255, 255, 0.08)) !important;
                    color: var(--foreground, #ffffff) !important;
                    border-color: var(--border, rgba(255, 255, 255, 0.22)) !important;
                }
                .agm-topbar-btn.active {
                    background-color: var(--secondary, rgba(255, 255, 255, 0.12)) !important;
                    border-color: var(--color-primary, #3b82f6) !important;
                }

                /* Context Progress Gauge */
                .agm-progress-bg {
                    width: 100%;
                    height: 6px;
                    border-radius: 3px;
                    background: var(--muted, rgba(255, 255, 255, 0.1));
                    overflow: hidden;
                    position: relative;
                }
                .agm-progress-fill {
                    height: 100%;
                    border-radius: 3px;
                    transition: width 0.3s ease, background-color 0.3s ease;
                }
                .agm-card {
                    background: var(--muted, rgba(255, 255, 255, 0.04));
                    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
                    border-radius: 8px;
                    padding: 8px 10px;
                }
                /* Per-turn telemetry, mounted inside the native message
                   toolbar so it reads as part of Antigravity's own row. */
                .agm-turn-dur {
                    display: flex !important;
                    align-items: center !important;
                    flex-shrink: 0 !important;
                    height: 20px !important;
                    font-size: 11px !important;
                    line-height: 1 !important;
                    font-weight: 400 !important;
                    letter-spacing: 0.1px !important;
                    white-space: nowrap !important;
                    color: var(--muted-foreground, #a1a1aa) !important;
                    opacity: 0.7;
                    font-variant-numeric: tabular-nums;
                    user-select: none;
                    pointer-events: none;
                }
                .agm-select {
                    background: var(--vscode-input-background, var(--muted, #27272a));
                    color: var(--vscode-input-foreground, var(--foreground, #f4f4f5));
                    border: 1px solid var(--vscode-input-border, var(--border, rgba(255,255,255,0.15)));
                    border-radius: 4px;
                    padding: 4px 6px;
                    font-size: 11px;
                    outline: none;
                    cursor: pointer;
                }
            `;
            document.head.appendChild(style);
        }

        function getReactFiber(node) {
            if (!node) return null;
            for (const key in node) {
                if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
                    return node[key];
                }
            }
            return null;
        }

        function findConversationIdInUrl(href) {
            try {
                if (!href || typeof href !== 'string') return '';
                const m = href.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
                    || href.match(/[?&](?:conversationId|conversation_id|chatId|cascadeId)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
                    || href.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                return m ? m[1] : '';
            } catch (_) {
                return '';
            }
        }

        function findActiveConversationId() {
            try {
                // 1. URL is ground truth in the Standalone App:
                // the active conversation lives at /c/<uuid> and SPA
                // navigations update it synchronously.
                const urlId = findConversationIdInUrl(window.location.href);
                if (urlId) return urlId;

                // 2. Explicitly selected sidebar row. Antigravity marks the
                // open conversation with data-selected="true" on
                // [data-testid="conversation-row-sidebar"] carrying
                // data-cascade-id. NOTE: never return the first
                // [data-cascade-id] in DOM order — the list holds many rows
                // and the first one is usually NOT the active conversation.
                const selectedRow = document.querySelector(
                    '[data-testid="conversation-row-sidebar"][data-selected="true"]'
                );
                if (selectedRow) {
                    const cid = selectedRow.getAttribute('data-cascade-id')
                        || selectedRow.getAttribute('data-conversation-id');
                    if (cid && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(cid)) {
                        return cid.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)[0];
                    }
                    const rowLink = selectedRow.querySelector('a[href*="/c/"]');
                    if (rowLink) {
                        const linkId = findConversationIdInUrl(rowLink.getAttribute('href') || rowLink.href || '');
                        if (linkId) return linkId;
                    }
                }

                // 3. Links pointing at the active conversation (scoped to the
                // selected row or breadcrumb — not the whole document, which
                // contains one link per conversation in the list).
                const crumbLink = document.querySelector('[data-testid="breadcrumb-segment"] a[href*="/c/"]');
                if (crumbLink) {
                    const linkId = findConversationIdInUrl(crumbLink.getAttribute('href') || crumbLink.href || '');
                    if (linkId) return linkId;
                }
            } catch (_) {}
            return null;
        }

        function extractFirstPromptFromDom() {
            try {
                const userSteps = document.querySelectorAll(
                    '[data-testid="user-input-step"], [aria-label="User message"], [data-role="user"], [data-testid="chat-user-message"], [data-testid="chat-message"][data-role="user"]'
                );
                let firstEl = userSteps.length > 0 ? userSteps[0] : null;
                if (!firstEl) {
                    const allBubbles = document.querySelectorAll('[data-testid="chat-message"], [class*="message-bubble"], .leading-relaxed');
                    for (const b of allBubbles) {
                        if (b.matches('[data-role="user"], [aria-label*="user"]') || b.closest('[data-role="user"], [aria-label*="user"]')) {
                            firstEl = b;
                            break;
                        }
                    }
                }
                if (firstEl) {
                    let raw = firstEl.textContent || '';
                    const reqMatch = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                    if (reqMatch) raw = reqMatch[1];
                    raw = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                    if (raw.length > 0) {
                        return raw;
                    }
                }
            } catch (_) {}
            return '';
        }

        // Active Chat Identification
        // Priority: URL /c/<uuid> > selected sidebar row > breadcrumb >
        // document.title > first user message. The URL and the selected row
        // are explicit framework markers; everything below is a fallback for
        // surfaces (e.g. IDE webviews) where the URL carries no conversation.
        function detectActiveChat() {
            let title = '';
            let id = '';

            // 1. Conversation UUID from URL or selected sidebar row.
            id = findActiveConversationId() || '';

            // 2. Extract first user prompt as chat fingerprint (verification
            // + cache key fallback, never the primary identity).
            const firstPrompt = extractFirstPromptFromDom();

            // 3. Title from breadcrumb segments (last = conversation).
            // Verified live: span[data-testid="breadcrumb-segment"] holds the
            // conversation title shown next to the workspace name.
            try {
                const segments = [...document.querySelectorAll('[data-testid="breadcrumb-segment"]')]
                    .map(s => (s.textContent || '').trim())
                    .filter(Boolean);
                if (segments.length > 0) {
                    const last = segments[segments.length - 1];
                    if (last.length > 1) title = last;
                }
            } catch (_) {}

            // 4. Title from selected sidebar row (authoritative list label).
            if (!title) {
                try {
                    const selRow = document.querySelector(
                        '[data-testid="conversation-row-sidebar"][data-selected="true"]'
                    );
                    const labelEl = selRow?.querySelector('span.truncate') || selRow;
                    let text = (labelEl?.textContent || '').replace(/\s*\d+[mhd]\s*$/, '').trim();
                    if (text && text.length > 1 && !/^(conversations|chats)$/i.test(text)) {
                        title = text;
                    }
                } catch (_) {}
            }

            // 5. Title from document.title ("<Conversation> - ... - Antigravity").
            if (!title) {
                try {
                    const docTitle = (document.title || '').split(' - ')[0].trim();
                    if (docTitle && docTitle.length > 1 && !/^(antigravity|new tab)$/i.test(docTitle)) {
                        title = docTitle;
                    }
                } catch (_) {}
            }

            // 6. Active editor tab (IDE surfaces).
            if (!title) {
                const activeTab = document.querySelector('.tab.active .label-name, [role="tab"][aria-selected="true"]');
                if (activeTab) {
                    const t = activeTab.textContent?.trim() || '';
                    if (t && t.length > 1 && !t.includes('.')) {
                        title = t;
                    }
                }
            }

            // 7. Header title element (IDE agent panel).
            if (!title) {
                const headerEl =
                    document.querySelector('[data-testid="conversation-title"]') ||
                    document.querySelector('[data-testid="chat-header"] h1, [data-testid="chat-header"] h2') ||
                    document.querySelector('header h1, header h2');
                if (headerEl) {
                    const text = headerEl.textContent?.trim() || '';
                    if (text && text.length > 1) title = text;
                }
            }

            // 7. Check for messages presence in DOM
            const messageElements = document.querySelectorAll(
                '[aria-label="User message"], [aria-label="Agent response"], [data-testid="chat-message"], [data-testid="user-input-step"], [data-role="user"], [data-testid="conversation-view"] .leading-relaxed, .prose, .markdown-body, [class*="message-bubble"]'
            );
            const hasMessages = messageElements.length > 0;

            // 8. Derive title from firstPrompt if title is not explicit
            if (!title && firstPrompt) {
                title = firstPrompt.length > 36 ? firstPrompt.slice(0, 36) + '...' : firstPrompt;
            }

            // 9. Check if this is explicitly a new unstarted conversation
            const isExplicitNewConvo = (title === 'New Conversation' || title === 'New Chat') ||
                (!hasMessages && !id && !firstPrompt);

            if (!title) {
                title = isExplicitNewConvo ? 'New Conversation' : (hasMessages ? 'Active Conversation' : 'New Conversation');
            }

            // Stable per-conversation key. id:<uuid> is authoritative; the
            // title/prompt fallbacks only fire on surfaces without URL ids.
            // There is deliberately NO generic constant fallback: a constant
            // key never changes, so switching conversations would never
            // trigger a refresh and the pill would freeze on stale numbers.
            let key = '';
            if (id) {
                key = 'id:' + id;
            } else if (firstPrompt) {
                key = 'prompt:' + firstPrompt.slice(0, 50).toLowerCase().trim();
            } else if (title && title !== 'Active Conversation' && title !== 'New Conversation') {
                key = 'title:' + title.toLowerCase().trim();
            } else if (isExplicitNewConvo) {
                key = 'new-chat';
            } else {
                try {
                    key = 'url:' + (window.location.href || document.title || 'unknown');
                } catch (_) {
                    key = 'url:unknown';
                }
            }

            return {
                title,
                id,
                firstPrompt,
                key,
                isNewConversation: isExplicitNewConvo && !hasMessages,
                hasMessages
            };
        }

        // Analyze DOM metrics specifically for the active chat
        function scanDomMetrics() {
            try {
                // Check if active chat changed
                const activeChat = detectActiveChat();
                const chatKeyChanged = activeChat.key && activeChat.key !== state.currentChatKey;

                if (chatKeyChanged) {
                    state.currentChatKey = activeChat.key;
                    // The measured stopwatch belongs to the conversation we are
                    // leaving; keeping it would let its duration leak onto this
                    // one's newest turn.
                    state.lastMeasuredDurationMs = 0;
                    state.lastMeasuredChatKey = '';
                    if (activeChat.title && activeChat.title !== 'Active Conversation') {
                        state.currentChatTitle = activeChat.title;
                    }
                    if (activeChat.id) {
                        state.currentChatId = activeChat.id;
                    } else if (activeChat.isNewConversation) {
                        state.currentChatId = '';
                    }

                    // Prefer the id-keyed cache entry: the key may be a
                    // title/prompt fallback while the id is known.
                    const cached = state.chatMetricsCache[activeChat.key]
                        || (activeChat.id && state.chatMetricsCache['id:' + activeChat.id]);

                    if (activeChat.isNewConversation) {
                        state.sessionStats = {
                            totalTokens: 0,
                            totalRounds: 0,
                            totalSteps: 0,
                            totalTools: 0
                        };
                        state.latestRoundStats = {
                            durationMs: 0,
                            inputTokens: 0,
                            outputTokens: 0,
                            thinkingTokens: 0,
                            totalRoundTokens: 0,
                            toolCount: 0,
                            toolsList: []
                        };
                        state.rounds = [];
                        state.hasTranscriptData = true;
                        state.currentChatTitle = 'New Conversation';
                        state.currentChatId = '';
                    } else if (cached) {
                        state.sessionStats = { ...cached.sessionStats };
                        if (cached.latestRoundStats) state.latestRoundStats = { ...cached.latestRoundStats };
                        if (Array.isArray(cached.rounds)) state.rounds = cached.rounds;
                        state.hasTranscriptData = cached.hasTranscriptData || false;
                        if (cached.title) state.currentChatTitle = cached.title;
                        if (cached.id) state.currentChatId = cached.id;
                        requestTranscriptUpdate(activeChat);
                        updateUI();
                    } else {
                        // Unknown conversation: reset synchronously so the
                        // pill never shows the previous chat's numbers while
                        // the transcript lookup is in flight. The DOM scrape
                        // below fills a rough estimate; the transcript
                        // update overwrites it with ground truth.
                        state.sessionStats = {
                            totalTokens: 0,
                            totalRounds: 0,
                            totalSteps: 0,
                            totalTools: 0
                        };
                        state.latestRoundStats = {
                            durationMs: 0,
                            inputTokens: 0,
                            outputTokens: 0,
                            thinkingTokens: 0,
                            totalRoundTokens: 0,
                            toolCount: 0,
                            toolsList: []
                        };
                        state.rounds = [];
                        state.hasTranscriptData = false;
                        updateUI();
                        requestTranscriptUpdate(activeChat);
                    }
                }

                if (activeChat.isNewConversation && !state.isGenerating) {
                    state.sessionStats.totalTokens = 0;
                    state.sessionStats.totalRounds = 0;
                    state.latestRoundStats = {
                        durationMs: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        thinkingTokens: 0,
                        totalRoundTokens: 0,
                        toolCount: 0,
                        toolsList: []
                    };
                    state.hasTranscriptData = true;
                } else if (!state.hasTranscriptData) {
                    // Only scrape DOM if we don't have transcript data yet and chat is not empty
                    const messageElements = document.querySelectorAll(
                        '[aria-label="User message"], [aria-label="Agent response"], [data-testid="chat-message"], [data-testid="user-input-step"], [data-testid="conversation-view"] .leading-relaxed, .prose, .markdown-body'
                    );

                    let aggregatedTokens = 0;
                    let userTurns = 0;

                    messageElements.forEach((el) => {
                        if (el.matches('.prose, .markdown-body') && el.closest('[data-testid="chat-message"], [data-testid="user-input-step"]')) {
                            return;
                        }
                        const text = el.textContent || '';
                        aggregatedTokens += estimateTokens(text);
                        if (el.matches('[data-testid="user-input-step"], [aria-label="User message"]') || el.querySelector('[data-testid="user-input-step"]')) {
                            userTurns++;
                        }
                    });

                    if (userTurns > 0 || messageElements.length > 0) {
                        aggregatedTokens += 3500;
                    }

                    state.sessionStats.totalTokens = aggregatedTokens;
                    state.sessionStats.totalRounds = userTurns;

                    if (state.currentChatKey) {
                        state.chatMetricsCache[state.currentChatKey] = {
                            sessionStats: { ...state.sessionStats },
                            latestRoundStats: { ...state.latestRoundStats },
                            hasTranscriptData: false,
                            title: state.currentChatTitle,
                            id: state.currentChatId
                        };
                    }

                    // Throttled re-request: an unwatched conversation (no
                    // transcript on disk yet) gets no fs.watch pushes, so
                    // poll the main process at most every 5s until ground
                    // truth arrives (e.g. first turn of a new chat finishes).
                    try {
                        const now = Date.now();
                        if (!state.lastTranscriptRequest || now - state.lastTranscriptRequest > 5000) {
                            state.lastTranscriptRequest = now;
                            requestTranscriptUpdate(activeChat);
                        }
                    } catch (_) {}
                }

                // Detect generation status strictly via generation-specific indicators
                const isGenerating = Boolean(
                    document.querySelector('[data-testid="stop-generation"]') ||
                    document.querySelector('button[aria-label*="Stop"]') ||
                    document.querySelector('button[title*="Stop"]') ||
                    document.querySelector('.streaming-cursor') ||
                    document.querySelector('.typing-cursor') ||
                    document.querySelector('[data-testid="agent-status-running"]')
                );

                if (isGenerating && !state.isGenerating) {
                    state.isGenerating = true;
                    state.msgStartTime = Date.now();
                    startLiveTimer();
                } else if (!isGenerating && state.isGenerating) {
                    state.isGenerating = false;
                    state.lastMsgDurationMs = Date.now() - state.msgStartTime;
                    state.latestRoundStats.durationMs = state.lastMsgDurationMs;
                    // Remember it against this conversation so the newest turn
                    // still gets a real duration when the transcript's
                    // second-granular timestamps cannot resolve one.
                    state.lastMeasuredDurationMs = state.lastMsgDurationMs;
                    state.lastMeasuredChatKey = state.currentChatKey;
                    stopLiveTimer();
                    requestTranscriptUpdate(activeChat);
                }

                updateUI();
            } catch (err) {
                console.error('[Antigravity Metrics] DOM scan error:', err);
            }
        }

        let liveTimerInterval = null;
        function startLiveTimer() {
            if (liveTimerInterval) return;
            liveTimerInterval = setInterval(() => {
                if (!state.isGenerating) {
                    stopLiveTimer();
                    return;
                }

                // Update live output tokens from streaming assistant reply
                const assistantReplies = document.querySelectorAll(
                    '[aria-label="Agent response"], [data-testid="conversation-view"] .leading-relaxed.select-text, [data-testid="chat-message"]:not([data-testid="user-input-step"])'
                );
                const replyList = assistantReplies.length > 0
                    ? Array.from(assistantReplies)
                    : Array.from(document.querySelectorAll('.prose, [data-testid="conversation-view"] .leading-relaxed')).filter(el => !el.closest('[data-testid="chat-message"], [data-testid="user-input-step"], [aria-label="User message"]'));

                if (replyList.length > 0) {
                    const latestReply = replyList[replyList.length - 1];
                    state.latestLiveTokens = estimateTokens(latestReply.textContent || '');
                    state.latestRoundStats.outputTokens = state.latestLiveTokens;
                    state.latestRoundStats.totalRoundTokens = (state.latestRoundStats.inputTokens || 0) + state.latestLiveTokens + (state.latestRoundStats.thinkingTokens || 0);
                }

                updateButtonText();
            }, 250);
        }

        function stopLiveTimer() {
            if (liveTimerInterval) {
                clearInterval(liveTimerInterval);
                liveTimerInterval = null;
            }
            state.latestLiveTokens = 0;
            updateButtonText();
        }

        // ---------------------------------------------------------------------
        // Per-turn duration, mounted inside Antigravity's own message toolbar.
        //
        // [data-testid="cascade-system-message-toolbar"] is the row holding the
        // copy / good / bad buttons. Verified against the served bundle: it is
        // rendered by the turn container as Usb({steps, showThumbsUpDown,
        // isLatest}) and gated on the turn being IDLE, so there is exactly one
        // toolbar per finished turn and none for the turn currently generating.
        //
        // The duration text goes in the row's left slot, where the native hover
        // timestamp already lives, so it reads as part of the row rather than as
        // a widget dropped into the chat.
        //
        // Duration is the ONLY metric shown. The transcript's step timestamps
        // are second-granular, and a turn's steps frequently share one second
        // (verified on real transcripts: a 3-step turn whose steps all carry the
        // same created_at), which makes the per-round delta collapse to 0. That
        // also poisons anything derived from it — turn tokens and speed were
        // dropped for that reason rather than shown as noise or "—".
        //
        // So the duration is either real or absent: when the transcript cannot
        // tell us, we fall back to the stopwatch this client kept while the turn
        // was actually running, and if even that is unavailable (app restarted
        // since) we render nothing at all rather than a misleading "0.0s".
        // ---------------------------------------------------------------------

        function resolveTurnDuration(round, isLastRound) {
            const fromTranscript = Math.max(0, (round && round.durationMs) || 0);
            if (fromTranscript > 0) return fromTranscript;
            // Only the newest turn can be one we watched run, and only while we
            // are still in the conversation it happened in.
            if (isLastRound && state.lastMeasuredChatKey && state.lastMeasuredChatKey === state.currentChatKey) {
                return Math.max(0, state.lastMeasuredDurationMs || 0);
            }
            return 0;
        }

        let turnTelemetrySignature = '';
        function syncTurnTelemetry() {
            let bars = [];
            try {
                bars = Array.from(document.querySelectorAll('[data-testid="cascade-system-message-toolbar"]'));
            } catch (_) {
                return;
            }

            const rounds = (state.hasTranscriptData && Array.isArray(state.rounds)) ? state.rounds : [];

            // One toolbar per finished turn, so index i is turn i. The only turn
            // that can lack a toolbar is the one generating right now, and that
            // is always the last one — so head alignment stays correct while a
            // turn runs. When the transcript knows FEWER turns than the DOM shows
            // (leading history cleared) align from the tail instead, keeping the
            // newest rows on real numbers rather than guessing.
            const offset = rounds.length >= bars.length ? 0 : rounds.length - bars.length;

            // React owns these rows and drops foreign children when it re-renders
            // (e.g. after Copy is pressed), so the count of rows still carrying
            // our node is part of the signature: losing one invalidates it and
            // forces a re-insert instead of a no-op.
            let mounted = 0;
            for (let i = 0; i < bars.length; i++) {
                if (bars[i].querySelector('.agm-turn-dur')) mounted++;
            }

            const signature = [bars.length, rounds.length, offset, mounted,
                state.lastMeasuredDurationMs, state.lastMeasuredChatKey].join('|') + '|' + rounds
                .map(r => r.durationMs || 0)
                .join(',');
            if (signature === turnTelemetrySignature) return;
            turnTelemetrySignature = signature;

            bars.forEach((bar, i) => {
                const roundIndex = i + offset;
                const round = rounds[roundIndex];
                // Guard the index: with no rounds at all (conversation switch,
                // transcript not found) roundIndex is negative and would still
                // compare equal to rounds.length - 1, wrongly making some row
                // "the last turn" and letting the stopwatch backfill it.
                const isLastRound = roundIndex >= 0 && roundIndex === rounds.length - 1;
                const durMs = resolveTurnDuration(round, isLastRound);
                const existing = bar.querySelector('.agm-turn-dur');

                // Unknown duration -> show nothing. A row that quietly reads
                // "0.0s" is worse than no row at all.
                if (durMs <= 0) {
                    if (existing) existing.remove();
                    return;
                }

                const durText = formatDuration(durMs);
                if (existing) {
                    if (existing.textContent !== durText) existing.textContent = durText;
                    return;
                }

                const durEl = el('span', null, durText, { className: 'agm-turn-dur' });
                const row = bar.firstElementChild;
                if (row) {
                    row.insertBefore(durEl, row.firstElementChild);
                } else {
                    bar.insertBefore(durEl, bar.firstChild);
                }
            });
        }

        // Find the native actions container in Antigravity header (Supports Standalone App & Antigravity IDE)
        // The topbar actions cluster holds More actions + Open IDE + RTL.
        // Verified live: [data-testid="titlebar-more-actions"] and
        // [data-testid="open-editor-empty"] share the same parent DIV, and the
        // RTL patch appends #rtl-topbar-wrapper to that same parent.
        // NEVER use the New Conversation button: it lives in the sidebar
        // section header and previously mis-mounted the pill down there.
        function getHeaderActionsContainer() {
            const moreActions = document.querySelector('[data-testid="titlebar-more-actions"]')?.parentElement;
            if (moreActions) return moreActions;
            const openEditor = document.querySelector('[data-testid="open-editor-empty"]')?.parentElement
                || document.querySelector('[data-testid="install-editor"]')?.parentElement;
            if (openEditor) return openEditor;
            const rtlParent = document.getElementById('rtl-topbar-wrapper')?.parentElement;
            if (rtlParent) return rtlParent;
            return (
                document.querySelector('button[aria-label="More actions"]')?.parentElement ||
                document.querySelector('button[aria-label="Close panel"]')?.parentElement ||
                document.querySelector('.composite.title .title-actions') ||
                document.querySelector('.pane-header .actions') ||
                document.querySelector('[data-testid="chat-header"] > div:last-child') ||
                document.querySelector('header > div:last-child') ||
                document.querySelector('.part.titlebar .titlebar-right') ||
                null
            );
        }

        // Dedicated Topbar Button (Supports Standalone App & IDE Agent panel header)
        function ensureTopbarButton() {
            let btn = document.getElementById('agm-topbar-btn');
            if (!btn) {
                btn = el('button', null, null, {
                    id: 'agm-topbar-btn',
                    type: 'button',
                    className: 'agm-topbar-btn',
                    title: 'Antigravity Metrics (⌥M / Alt+M)'
                });

                const svgNS = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(svgNS, 'svg');
                svg.setAttribute('width', '13');
                svg.setAttribute('height', '13');
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('stroke-linecap', 'round');
                svg.setAttribute('stroke-linejoin', 'round');
                svg.setAttribute('class', 'shrink-0 opacity-80');
                svg.style.marginRight = '2px';

                for (const d of ['M3 3v18h18', 'M18 17V9', 'M13 17V5', 'M8 17v-3']) {
                    const path = document.createElementNS(svgNS, 'path');
                    path.setAttribute('d', d);
                    svg.appendChild(path);
                }

                const pctSpan = el('span', 'font-weight:600;color:#10b981;', '0.0%', { id: 'agm-topbar-pct' });
                const tokensSpan = el('span', 'opacity:0.65;font-size:11px;', '(0k)', { id: 'agm-topbar-tokens' });

                btn.appendChild(svg);
                btn.appendChild(pctSpan);
                btn.appendChild(tokensSpan);

                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleDashboard();
                });
            }

            // Mount button in topbar actions cluster, next to Open IDE / RTL.
            // Self-healing: if a previous version mounted the pill in the
            // sidebar, this moves it back to the header on the next scan.
            const actionsCluster = getHeaderActionsContainer();
            if (actionsCluster && btn.parentElement !== actionsCluster) {
                const rtlWrapper = document.getElementById('rtl-topbar-wrapper');

                if (rtlWrapper && rtlWrapper.parentElement === actionsCluster) {
                    actionsCluster.insertBefore(btn, rtlWrapper);
                } else {
                    actionsCluster.appendChild(btn);
                }
                btn.style.position = '';
                btn.style.top = '';
                btn.style.right = '';
                btn.style.zIndex = '';
            } else if (!actionsCluster && btn.parentElement && btn.parentElement !== document.body) {
                // Stuck in a wrong container (e.g. sidebar from an older
                // version) with no valid cluster found yet: detach so the
                // next scan can re-mount it correctly instead of showing
                // stale numbers in the wrong place.
                btn.remove();
            }
            // NOTE: no fixed-position body fallback. A floating pill overlaps
            // content and hides the misplacement instead of fixing it; when
            // the cluster is not mounted yet we simply wait for the next scan.

            return btn;
        }

        function updateButtonText() {
            const pctEl = document.getElementById('agm-topbar-pct');
            const tokensEl = document.getElementById('agm-topbar-tokens');

            let totalTokens = state.sessionStats.totalTokens || 0;
            if (state.isGenerating && state.latestLiveTokens > 0) {
                totalTokens += state.latestLiveTokens;
            }
            const limit = state.config.modelLimit || 256000;
            const pct = Math.min(100, ((totalTokens / limit) * 100)).toFixed(1);
            const pctStr = `${pct}%`;
            const zoneInfo = getContextZone(totalTokens, limit);

            if (pctEl && pctEl.textContent !== pctStr) {
                pctEl.textContent = pctStr;
            }
            if (pctEl) {
                pctEl.style.color = zoneInfo.color;
            }
            const tokensStr = `(${formatTokens(totalTokens)})`;
            if (tokensEl && tokensEl.textContent !== tokensStr) {
                tokensEl.textContent = tokensStr;
            }

            // Statusbar button in IDE
            const statusbarBtn = document.getElementById('antigravity-metrics-statusbar-btn');
            if (statusbarBtn) {
                const sbText = `📊 ${pct}% (${formatTokens(totalTokens)})`;
                if (statusbarBtn.textContent !== sbText) {
                    statusbarBtn.textContent = sbText;
                }
                statusbarBtn.style.color = zoneInfo.color;
            }
        }

        // Flyout Dashboard Panel
        function ensureDashboard() {
            let panel = document.getElementById('antigravity-metrics-panel');
            if (panel) return panel;

            panel = el('div', `
                display: none;
                position: fixed;
                z-index: 1000000;
                top: 44px;
                right: 16px;
                width: 330px;
                background: var(--popover, var(--card, #18181b));
                color: var(--popover-foreground, var(--foreground, #f4f4f5));
                border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
                border-radius: 12px;
                box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.25);
                font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px;
                padding: 16px;
                direction: ltr;
                box-sizing: border-box;
                user-select: none;
                backdrop-filter: blur(14px);
            `, null, { id: 'antigravity-metrics-panel' });

            // 1. Header
            const titleBlock = el('div', null, [
                el('div', 'font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;', [
                    el('span', null, '📊 Antigravity Metrics'),
                    el('span', 'font-size:10px;padding:1px 5px;border-radius:4px;background:#10b98120;color:#10b981;font-weight:600;', '● LIVE', { id: 'agm-dash-status-badge' })
                ]),
                el('div', 'font-size:10.5px;color:var(--muted-foreground, #94a3b8);margin-top:2px;', 'Real-time tokens, context & per-chat telemetry')
            ]);
            const closeBtn = el('button', 'background:none;border:none;color:inherit;cursor:pointer;font-size:15px;line-height:1;opacity:0.6;padding:4px;', '✕', { title: 'Close (Esc)' });
            const header = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border, rgba(255,255,255,0.1));', [titleBlock, closeBtn]);
            panel.appendChild(header);

            // 2. Active Chat Identification Card (Fixes Issue 2 & Issue 5)
            const activeChatCard = el('div', 'margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;', [
                el('div', 'display:flex;flex-direction:column;gap:2px;overflow:hidden;max-width:230px;', [
                    el('div', 'display:flex;align-items:center;gap:6px;overflow:hidden;', [
                        el('span', 'opacity:0.75;', '💬'),
                        el('span', 'font-weight:600;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', 'New Conversation', { id: 'agm-dash-chat-title' })
                    ]),
                    el('div', 'font-size:9.5px;color:var(--muted-foreground, #a1a1aa);padding-left:18px;', 'Empty session • 0 rounds', { id: 'agm-dash-chat-subtitle' })
                ]),
                el('span', 'font-size:10px;color:var(--muted-foreground,#a1a1aa);align-self:flex-start;margin-top:2px;', 'Chat Scope')
            ], { className: 'agm-card' });
            panel.appendChild(activeChatCard);

            // 3. Context Window Card
            const progressFill = el('div', 'width:0%;background-color:#10b981;', null, { id: 'agm-progress-fill', className: 'agm-progress-fill' });
            const progressBar = el('div', null, [progressFill], { className: 'agm-progress-bg' });

            const contextCard = el('div', null, [
                el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;', [
                    el('div', 'display:flex;align-items:center;gap:6px;', [
                        el('span', 'font-weight:600;font-size:11.5px;', 'Context Window'),
                        el('span', 'font-size:9.5px;padding:1px 5px;border-radius:4px;font-weight:600;background:#10b98120;color:#10b981;', '🟢 Smart Zone', { id: 'agm-dash-zone-badge' })
                    ]),
                    el('span', 'font-weight:600;font-size:11.5px;color:#10b981;', '0.0%', { id: 'agm-dash-pct' })
                ]),
                progressBar,
                el('div', 'display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted-foreground, #94a3b8);margin-top:6px;', [
                    el('span', null, '0 used', { id: 'agm-dash-used' }),
                    el('span', null, '256k limit', { id: 'agm-dash-limit' })
                ]),
                el('div', 'font-size:10.5px;color:#10b981;margin-top:4px;', '~256.0k tokens remaining', { id: 'agm-dash-remaining' })
            ], { className: 'agm-card' });
            panel.appendChild(contextCard);

            // 4. Model Selection & Settings
            const selectModel = el('select', 'width:100%;', [
                el('option', null, 'Gemini 3.8 Flash - Antigravity (256,000 tokens)', { value: '256000' }),
                el('option', null, 'Gemini 3.8 Flash / Pro (1,000,000 tokens)', { value: '1000000' }),
                el('option', null, 'Gemini Pro Extended (2,000,000 tokens)', { value: '2000000' }),
                el('option', null, 'Claude 3.7 Sonnet (200,000 tokens)', { value: '200000' }),
                el('option', null, 'GPT-4o / o1 (128,000 tokens)', { value: '128000' }),
                el('option', null, 'Custom limit (500,000 tokens)', { value: '500000' })
            ], { className: 'agm-select', id: 'agm-dash-model-select' });

            const settingsCard = el('div', 'margin-top:10px;', [
                el('div', 'font-weight:600;font-size:11.5px;margin-bottom:6px;', 'Model Context Limit'),
                selectModel
            ], { className: 'agm-card' });
            panel.appendChild(settingsCard);

            // 5. Footer with Shortcut info
            const footer = el('div', 'margin-top:12px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--muted-foreground,#94a3b8);', [
                el('span', null, 'Shortcut: ⌥M / Alt+M'),
                el('span', 'color:#38bdf8;cursor:pointer;', 'Refresh Data', { id: 'agm-refresh-btn' })
            ]);
            panel.appendChild(footer);

            document.body.appendChild(panel);

            // Bind Events
            closeBtn.addEventListener('click', () => { closeDashboard(); });
            selectModel.value = String(state.config.modelLimit || 256000);
            selectModel.addEventListener('change', (e) => {
                state.config.modelLimit = parseInt(e.target.value, 10) || 256000;
                saveConfig();
                updateUI();
            });
            panel.querySelector('#agm-refresh-btn').addEventListener('click', () => {
                state.hasTranscriptData = false;
                scanDomMetrics();
                requestTranscriptUpdate();
                updateUI();
            });

            return panel;
        }

        function positionDashboard() {
            const btn = document.getElementById('agm-topbar-btn') || document.getElementById('antigravity-metrics-statusbar-btn');
            const panel = document.getElementById('antigravity-metrics-panel');
            if (!panel) return;
            if (btn) {
                const rect = btn.getBoundingClientRect();
                if (rect.top > window.innerHeight / 2) {
                    panel.style.top = 'auto';
                    panel.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
                } else {
                    panel.style.bottom = 'auto';
                    panel.style.top = (rect.bottom + 6) + 'px';
                }
                const rightPos = Math.max(16, window.innerWidth - rect.right);
                panel.style.right = rightPos + 'px';
            } else {
                panel.style.top = '44px';
                panel.style.bottom = 'auto';
                panel.style.right = '16px';
            }
        }

        function openDashboard() {
            const panel = ensureDashboard();
            const btn = document.getElementById('agm-topbar-btn');
            positionDashboard();
            updateUI();
            panel.style.display = 'block';
            if (btn) btn.classList.add('active');
        }

        function closeDashboard() {
            const panel = document.getElementById('antigravity-metrics-panel');
            const btn = document.getElementById('agm-topbar-btn');
            if (panel) panel.style.display = 'none';
            if (btn) btn.classList.remove('active');
        }

        function toggleDashboard() {
            const panel = ensureDashboard();
            if (panel.style.display === 'block') {
                closeDashboard();
            } else {
                openDashboard();
            }
        }

        function updateUI() {
            updateButtonText();
            const panel = document.getElementById('antigravity-metrics-panel');
            if (!panel || panel.style.display === 'none') return;

            let totalTokens = state.sessionStats.totalTokens || 0;
            if (state.isGenerating && state.latestLiveTokens > 0) {
                totalTokens += state.latestLiveTokens;
            }
            const limit = state.config.modelLimit || 256000;
            const pct = Math.min(100, (totalTokens / limit) * 100);
            const remaining = Math.max(0, limit - totalTokens);
            const zoneInfo = getContextZone(totalTokens, limit);

            const fill = document.getElementById('agm-progress-fill');
            const pctEl = document.getElementById('agm-dash-pct');
            const zoneBadgeEl = document.getElementById('agm-dash-zone-badge');
            const usedEl = document.getElementById('agm-dash-used');
            const limitEl = document.getElementById('agm-dash-limit');
            const remEl = document.getElementById('agm-dash-remaining');
            const chatTitleEl = document.getElementById('agm-dash-chat-title');
            const chatSubtitleEl = document.getElementById('agm-dash-chat-subtitle');
            const statusBadge = document.getElementById('agm-dash-status-badge');

            const currentTitle = state.currentChatTitle || 'New Conversation';
            if (chatTitleEl && chatTitleEl.textContent !== currentTitle) {
                chatTitleEl.textContent = currentTitle;
                chatTitleEl.title = currentTitle;
            }

            if (chatSubtitleEl) {
                let subText = '';
                if (state.currentChatId) {
                    const shortId = state.currentChatId.slice(0, 8);
                    const roundsCount = state.sessionStats.totalRounds || 0;
                    subText = `ID: ${shortId} • ${roundsCount} ${roundsCount === 1 ? 'round' : 'rounds'}`;
                } else if (state.sessionStats.totalRounds === 0) {
                    subText = 'Empty session • 0 rounds';
                } else {
                    subText = `${state.sessionStats.totalRounds} ${state.sessionStats.totalRounds === 1 ? 'round' : 'rounds'}`;
                }
                if (chatSubtitleEl.textContent !== subText) {
                    chatSubtitleEl.textContent = subText;
                }
            }

            if (statusBadge) {
                const statusText = state.isGenerating ? '● GENERATING' : '● IDLE';
                if (statusBadge.textContent !== statusText) {
                    statusBadge.textContent = statusText;
                    statusBadge.style.color = state.isGenerating ? '#f59e0b' : '#10b981';
                    statusBadge.style.backgroundColor = state.isGenerating ? '#f59e0b20' : '#10b98120';
                }
            }

            const pctStr = pct.toFixed(1) + '%';
            if (fill) {
                if (fill.style.width !== pctStr) fill.style.width = pctStr;
                fill.style.backgroundColor = zoneInfo.color;
            }
            if (pctEl && pctEl.textContent !== pctStr) {
                pctEl.textContent = pctStr;
            }
            if (pctEl) {
                pctEl.style.color = zoneInfo.color;
            }
            if (zoneBadgeEl) {
                if (zoneBadgeEl.textContent !== zoneInfo.badge) {
                    zoneBadgeEl.textContent = zoneInfo.badge;
                }
                zoneBadgeEl.style.color = zoneInfo.color;
                zoneBadgeEl.style.backgroundColor = zoneInfo.bg;
            }

            const usedStr = formatTokens(totalTokens) + ' used';
            if (usedEl && usedEl.textContent !== usedStr) usedEl.textContent = usedStr;

            const limitStr = formatTokens(limit) + ' limit';
            if (limitEl && limitEl.textContent !== limitStr) limitEl.textContent = limitStr;

            let remStr = `~${formatTokens(remaining)} tokens remaining`;
            if (zoneInfo.zone === 'dumb') {
                remStr += ' (compaction recommended)';
            }
            if (remEl && remEl.textContent !== remStr) {
                remEl.textContent = remStr;
            }
            if (remEl) {
                remEl.style.color = zoneInfo.color;
            }

            // Per-turn telemetry lives inline on every message toolbar now
            // (see syncTurnTelemetry), so the dashboard no longer renders a
            // "Latest Turn Telemetry" card.
        }

        function getStatusBarTarget() {
            return (
                document.querySelector('.part.statusbar .right-items') ||
                document.querySelector('.part.statusbar .items-container.right-items') ||
                document.querySelector('[id="workbench.parts.statusbar"] .right-items') ||
                document.querySelector('.part.statusbar') ||
                document.querySelector('[id="workbench.parts.statusbar"]') ||
                null
            );
        }

        // Status bar integration for IDE
        function tryInsertStatusBarItem() {
            const statusBar = getStatusBarTarget();
            if (!statusBar) return;

            let item = document.getElementById('antigravity-metrics-statusbar-btn');
            if (!item) {
                item = el('a', `
                    cursor: pointer !important;
                    padding: 0 8px !important;
                    display: inline-flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    font-size: 11px !important;
                    height: 100% !important;
                    line-height: 22px !important;
                    user-select: none !important;
                    text-decoration: none !important;
                    white-space: nowrap !important;
                    color: #10b981 !important;
                    opacity: 0.95;
                    box-sizing: border-box !important;
                `, [
                    el('span', null, '📊 0.0% (0k)')
                ], {
                    id: 'antigravity-metrics-statusbar-btn',
                    className: 'statusbar-item right',
                    href: '#',
                    title: 'Antigravity Metrics (Alt+M / ⌥M)'
                });

                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleDashboard();
                });

                item.addEventListener('mouseenter', () => {
                    item.style.backgroundColor = 'var(--vscode-statusBarItem-hoverBackground, rgba(255,255,255,0.12))';
                });
                item.addEventListener('mouseleave', () => {
                    item.style.backgroundColor = 'transparent';
                });
            }

            if (item.parentElement !== statusBar) {
                const rtlBtn = document.getElementById('antigravity-rtl-statusbar-btn');
                if (rtlBtn && rtlBtn.parentElement === statusBar) {
                    statusBar.insertBefore(item, rtlBtn);
                } else {
                    statusBar.prepend(item);
                }
            }
        }

        // Global Keyboard Shortcut: Alt+M or Option+M
        document.addEventListener('keydown', (e) => {
            if (e.altKey && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M')) {
                e.preventDefault();
                toggleDashboard();
            } else if (e.key === 'Escape') {
                closeDashboard();
            }
        });

        // Close dashboard on outside click
        document.addEventListener('click', (e) => {
            const panel = document.getElementById('antigravity-metrics-panel');
            const btn = document.getElementById('agm-topbar-btn');
            if (panel && panel.style.display === 'block') {
                if (!panel.contains(e.target) && !btn?.contains(e.target)) {
                    closeDashboard();
                }
            }
        });

        // Clean up legacy elements from older versions (sidebar pill era,
        // standalone per-message badge era) if present
        function cleanLegacyPill() {
            const oldPill = document.getElementById('antigravity-metrics-pill');
            if (oldPill) oldPill.remove();
            // The old badges were appended INSIDE the message body and carried
            // guessed numbers. Superseded by .agm-turn-dur, which lives
            // in the native toolbar — strip any left by a previous version so an
            // upgrade never shows both.
            try {
                document.querySelectorAll('.agm-msg-badge, .agm-turn-chip').forEach(b => b.remove());
            } catch (_) {}
        }

        let updateDebounceTimer = null;
        let isInternalMutation = false;

        function scheduleScan() {
            if (updateDebounceTimer) return;
            updateDebounceTimer = setTimeout(() => {
                updateDebounceTimer = null;
                runScanAndSync();
            }, 300);
        }

        function runScanAndSync() {
            isInternalMutation = true;
            try {
                cleanLegacyPill();
                ensureTopbarButton();
                tryInsertStatusBarItem();
                scanDomMetrics();
                syncTurnTelemetry();
            } catch (err) {
                console.error('[Antigravity Metrics] runScanAndSync error:', err);
            } finally {
                setTimeout(() => { isInternalMutation = false; }, 50);
            }
        }

        // Loop and Mutation Observer
        function init() {
            runScanAndSync();
            ensureDashboard();
            requestTranscriptUpdate();
            updateUI();

            // Instant conversation-switch detection: Antigravity is an SPA —
            // opening another chat rewrites the URL (/c/<uuid>) via
            // history.pushState without a reload and sometimes with barely
            // any DOM churn, so the MutationObserver + poll below can lag by
            // seconds. Hooking navigation fires a scan immediately.
            try {
                let lastHref = window.location.href;
                const onUrlChange = () => {
                    const now = window.location.href;
                    if (now !== lastHref) {
                        lastHref = now;
                        runScanAndSync();
                        requestTranscriptUpdate();
                    }
                };
                const origPush = history.pushState;
                history.pushState = function(...args) {
                    const r = origPush.apply(this, args);
                    onUrlChange();
                    return r;
                };
                const origReplace = history.replaceState;
                history.replaceState = function(...args) {
                    const r = origReplace.apply(this, args);
                    onUrlChange();
                    return r;
                };
                window.addEventListener('popstate', onUrlChange);
                window.addEventListener('hashchange', onUrlChange);
                setInterval(() => {
                    try {
                        if (window.location.href !== lastHref) {
                            lastHref = window.location.href;
                            runScanAndSync();
                            requestTranscriptUpdate();
                        }
                    } catch (_) {}
                }, 750);
            } catch (_) {}

            const observer = new MutationObserver((mutations) => {
                if (isInternalMutation) return;

                // Check if any mutation is external (not our own widgets)
                const isOurNode = (node) => {
                    if (!node) return false;
                    if (node.id && (node.id.startsWith('agm-') || node.id.startsWith('antigravity-metrics-'))) return true;
                    // The per-turn telemetry has no id (it must not disturb the
                    // native row's child list identity), so match on its classes.
                    return typeof node.className === 'string' && node.className.indexOf('agm-turn-') !== -1;
                };
                const hasExternal = mutations.some(m => {
                    if (m.target && m.target.closest && m.target.closest('#agm-topbar-btn, #antigravity-metrics-panel, #antigravity-metrics-statusbar-btn, .agm-turn-dur')) {
                        return false;
                    }
                    for (let i = 0; i < m.addedNodes.length; i++) {
                        if (isOurNode(m.addedNodes[i])) continue;
                        return true;
                    }
                    for (let i = 0; i < m.removedNodes.length; i++) {
                        if (isOurNode(m.removedNodes[i])) continue;
                        return true;
                    }
                    return false;
                });

                if (hasExternal) {
                    scheduleScan();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setInterval(scheduleScan, 2000);
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    } catch (e) {
        console.error('[Antigravity Metrics] Initialisation error:', e);
    }
})();
