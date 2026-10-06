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
            showMsgBadges: true,
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
                const payload = chatQuery || {
                    id: state.currentChatId,
                    title: state.currentChatTitle
                };
                console.log('REQUEST_TRANSCRIPT_METRICS|' + JSON.stringify(payload));
            } catch (_) {}
        }

        // External update handler called by main process bridge
        window.__ANTIGRAVITY_METRICS_UPDATE__ = function(data) {
            if (!data) return;

            // If we are currently in an empty new session with 0 messages, do not adopt an old transcript!
            const activeChat = detectActiveChat();
            if (activeChat.isEmpty && !state.isGenerating) {
                return;
            }

            // If update contains a conversationId and we know our currentChatId, verify match
            if (data.conversationId) {
                if (!state.currentChatId) {
                    state.currentChatId = data.conversationId;
                } else if (state.currentChatId !== data.conversationId) {
                    return;
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

            if (state.currentChatKey) {
                state.chatMetricsCache[state.currentChatKey] = {
                    sessionStats: { ...state.sessionStats },
                    latestRoundStats: { ...state.latestRoundStats },
                    hasTranscriptData: true,
                    title: state.currentChatTitle,
                    id: state.currentChatId
                };
            }

            updateUI();
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

                /* Message Badge attached to each assistant reply */
                .agm-msg-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 6px;
                    padding: 2px 7px;
                    border-radius: 4px;
                    font-size: 10.5px;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                    background: var(--muted, rgba(255, 255, 255, 0.04));
                    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
                    color: var(--muted-foreground, #a1a1aa);
                    user-select: none;
                    width: fit-content;
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

        // Active Chat Identification
        function detectActiveChat() {
            let title = '';
            let id = '';

            // 1. Detect from URL (if available)
            try {
                const href = window.location.href;
                const match = href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                if (match) id = match[0];
            } catch (_) {}

            // 2. Detect from active sidebar item (scoped strictly to navigation / sidebar containers)
            try {
                const sidebarContainers = document.querySelectorAll(
                    'nav, aside, [role="navigation"], [data-testid*="sidebar"], [data-testid*="conversation-list"], [class*="sidebar"]'
                );

                for (const nav of sidebarContainers) {
                    const activeItem = nav.querySelector(
                        '[aria-selected="true"], [data-state="active"], [data-state="selected"], [data-active="true"], .active'
                    );
                    if (activeItem) {
                        const dataId = activeItem.getAttribute('data-conversation-id') ||
                                       activeItem.getAttribute('data-id') ||
                                       activeItem.getAttribute('data-chat-id') ||
                                       activeItem.getAttribute('data-session-id');
                        if (dataId) id = dataId;

                        const link = activeItem.matches('a') ? activeItem : activeItem.querySelector('a');
                        if (link && link.href) {
                            const linkMatch = link.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                            if (linkMatch && !id) id = linkMatch[0];
                        }

                        const titleEl = activeItem.querySelector('.title, [class*="title"], h3, h4, span') || activeItem;
                        let text = titleEl.textContent || '';
                        text = text.replace(/\s*\d+[mhd]\s*$/, '').trim();
                        if (text && text.length > 1 && text.toLowerCase() !== 'conversations' && text.toLowerCase() !== 'chats') {
                            title = text;
                        }
                        break;
                    }
                }
            } catch (_) {}

            // 3. Detect from breadcrumb or header title
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

            // 4. Fallback to first user input in the chat view (index 0, never a random turn)
            const userSteps = document.querySelectorAll(
                '[data-testid="user-input-step"], [data-testid="chat-user-message"], [data-role="user"]'
            );
            const hasMessages = userSteps.length > 0 || Boolean(document.querySelector('[data-testid="chat-message"], .prose, .markdown-body'));

            if (!title && userSteps.length > 0) {
                let raw = userSteps[0].textContent?.trim() || '';
                const reqMatch = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                if (reqMatch) raw = reqMatch[1];
                raw = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                if (raw) {
                    title = raw.slice(0, 36) + (raw.length > 36 ? '...' : '');
                }
            }

            if (!title) {
                title = hasMessages ? 'Active Conversation' : 'New Conversation';
            }

            const key = id || (title !== 'New Conversation' && title !== 'Active Conversation' ? title : '');
            return { title, id, key: key || 'default-chat', isEmpty: !hasMessages && userSteps.length === 0 };
        }

        // Analyze DOM metrics specifically for the active chat
        function scanDomMetrics() {
            try {
                // Check if active chat changed
                const activeChat = detectActiveChat();
                const chatKeyChanged = activeChat.key && activeChat.key !== state.currentChatKey;

                if (chatKeyChanged) {
                    state.currentChatKey = activeChat.key;
                    if (activeChat.title && activeChat.title !== 'Active Conversation') {
                        state.currentChatTitle = activeChat.title;
                    }
                    if (activeChat.id) {
                        state.currentChatId = activeChat.id;
                    }

                    if (activeChat.isEmpty) {
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
                        state.hasTranscriptData = true;
                        state.currentChatTitle = 'New Conversation';
                    } else if (state.chatMetricsCache[activeChat.key]) {
                        const cached = state.chatMetricsCache[activeChat.key];
                        state.sessionStats = { ...cached.sessionStats };
                        if (cached.latestRoundStats) state.latestRoundStats = { ...cached.latestRoundStats };
                        state.hasTranscriptData = cached.hasTranscriptData || false;
                        if (cached.title) state.currentChatTitle = cached.title;
                        if (cached.id) state.currentChatId = cached.id;
                        requestTranscriptUpdate(activeChat);
                    } else {
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
                        state.hasTranscriptData = false;
                        requestTranscriptUpdate(activeChat);
                    }
                }

                if (activeChat.isEmpty && !state.isGenerating) {
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
                        '[data-testid="chat-message"], [data-testid="user-input-step"], [data-testid="conversation-view"] .prose, .prose, .markdown-body'
                    );

                    let aggregatedTokens = 0;
                    let userTurns = 0;

                    messageElements.forEach((el) => {
                        if (el.matches('.prose, .markdown-body') && el.closest('[data-testid="chat-message"], [data-testid="user-input-step"]')) {
                            return;
                        }
                        const text = el.textContent || '';
                        aggregatedTokens += estimateTokens(text);
                        if (el.matches('[data-testid="user-input-step"]') || el.querySelector('[data-testid="user-input-step"]')) {
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
                }

                // Detect generation status strictly via generation-specific indicators
                // (Fix Issue 1: NEVER trigger on generic loading spinners or animation classes)
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
                    stopLiveTimer();
                }

                attachMessageBadges();
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
                const elapsed = Math.max(0, Date.now() - state.msgStartTime);
                const durText = '⚡ ' + formatDuration(elapsed);

                const badges = document.querySelectorAll('.agm-msg-badge');
                if (badges.length > 0) {
                    const latestBadge = badges[badges.length - 1];
                    const durSpan = latestBadge.querySelector('.agm-badge-dur');
                    if (durSpan && durSpan.textContent !== durText) {
                        durSpan.textContent = durText;
                    }
                }

                const roundDurEl = document.getElementById('agm-dash-round-duration');
                if (roundDurEl) {
                    const formatted = formatDuration(elapsed);
                    if (roundDurEl.textContent !== formatted) {
                        roundDurEl.textContent = formatted;
                    }
                }
            }, 250);
        }

        function stopLiveTimer() {
            if (liveTimerInterval) {
                clearInterval(liveTimerInterval);
                liveTimerInterval = null;
            }
        }

        // Attach per-message metrics badge to assistant replies
        function attachMessageBadges() {
            if (!state.config.showMsgBadges) return;
            const assistantReplies = document.querySelectorAll(
                '[data-testid="chat-message"]:not([data-testid="user-input-step"])'
            );

            const replyList = assistantReplies.length > 0
                ? Array.from(assistantReplies)
                : Array.from(document.querySelectorAll('.prose')).filter(el => !el.closest('[data-testid="chat-message"]'));

            const total = replyList.length;
            replyList.forEach((replyEl, idx) => {
                let badge = replyEl.querySelector(':scope > .agm-msg-badge') || replyEl.querySelector('.agm-msg-badge');
                const isLatest = idx === total - 1;
                const tokens = estimateTokens(replyEl.textContent || '');
                if (tokens < 10) return;

                // Determine duration for this message
                let durationText = '';
                if (isLatest && state.isGenerating) {
                    const elapsed = Math.max(0, Date.now() - state.msgStartTime);
                    durationText = '⚡ ' + formatDuration(elapsed);
                } else if (isLatest && state.lastMsgDurationMs > 0) {
                    durationText = '⏱️ ' + formatDuration(state.lastMsgDurationMs);
                } else if (state.rounds && state.rounds[idx] && state.rounds[idx].durationMs > 0) {
                    durationText = '⏱️ ' + formatDuration(state.rounds[idx].durationMs);
                } else if (state.latestRoundStats.durationMs > 0 && isLatest) {
                    durationText = '⏱️ ' + formatDuration(state.latestRoundStats.durationMs);
                }

                if (badge) {
                    // Update existing badge only if changed
                    const durSpan = badge.querySelector('.agm-badge-dur');
                    if (durSpan) {
                        if (durSpan.textContent !== durationText) {
                            durSpan.textContent = durationText;
                        }
                    } else if (durationText) {
                        const dot = el('span', 'opacity:0.35;', '·');
                        const newDur = el('span', 'opacity:0.85;', durationText, { className: 'agm-badge-dur' });
                        badge.appendChild(dot);
                        badge.appendChild(newDur);
                    }
                    return;
                }

                const children = [
                    el('span', 'opacity:0.85;', '🪙 ' + formatTokens(tokens) + ' tok')
                ];

                if (durationText) {
                    children.push(el('span', 'opacity:0.35;', '·'));
                    children.push(el('span', 'opacity:0.85;', durationText, { className: 'agm-badge-dur' }));
                }

                badge = el('div', null, children, { className: 'agm-msg-badge' });
                replyEl.appendChild(badge);
            });
        }

        // Find the native actions container in Antigravity header
        function getHeaderActionsContainer() {
            return (
                document.querySelector('[data-testid="install-editor"]')?.parentElement ||
                document.querySelector('[data-testid="titlebar-more-actions"]')?.parentElement ||
                document.getElementById('rtl-topbar-wrapper')?.parentElement ||
                document.querySelector('[data-testid="chat-header"] > div:last-child') ||
                document.querySelector('header > div:last-child') ||
                document.querySelector('.part.titlebar .titlebar-right') ||
                null
            );
        }

        // Dedicated Topbar Button (Fixes Issue 4 & Issue 6)
        function ensureTopbarButton() {
            let btn = document.getElementById('agm-topbar-btn');
            if (!btn) {
                const chartSvg = `
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 opacity-80" style="margin-right:2px;">
                        <path d="M3 3v18h18"></path>
                        <path d="M18 17V9"></path>
                        <path d="M13 17V5"></path>
                        <path d="M8 17v-3"></path>
                    </svg>
                `;

                btn = el('button', null, null, {
                    id: 'agm-topbar-btn',
                    type: 'button',
                    className: 'agm-topbar-btn',
                    title: 'Antigravity Metrics (⌥M / Alt+M)'
                });

                btn.innerHTML = `
                    ${chartSvg}
                    <span id="agm-topbar-pct" style="font-weight:600;color:#10b981;">0.0%</span>
                    <span id="agm-topbar-tokens" style="opacity:0.65;font-size:11px;">(0k)</span>
                `;

                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleDashboard();
                });
            }

            // Mount button in topbar actions cluster
            const actionsCluster = getHeaderActionsContainer();
            if (actionsCluster && btn.parentElement !== actionsCluster) {
                const rtlWrapper = document.getElementById('rtl-topbar-wrapper');
                const installBtn = document.querySelector('[data-testid="install-editor"]');

                if (rtlWrapper && rtlWrapper.parentElement === actionsCluster) {
                    actionsCluster.insertBefore(btn, rtlWrapper);
                } else if (installBtn && installBtn.parentElement === actionsCluster) {
                    actionsCluster.insertBefore(btn, installBtn);
                } else {
                    actionsCluster.appendChild(btn);
                }
                btn.style.position = '';
                btn.style.top = '';
                btn.style.right = '';
                btn.style.zIndex = '';
            } else if (!actionsCluster && !btn.parentElement) {
                // If in IDE and statusbar exists, avoid floating button over code
                const isIde = Boolean(document.querySelector('.part.statusbar'));
                if (!isIde) {
                    btn.style.cssText += 'position:fixed;top:8px;right:24px;z-index:9999;';
                    document.body.appendChild(btn);
                }
            }

            return btn;
        }

        function updateButtonText() {
            const pctEl = document.getElementById('agm-topbar-pct');
            const tokensEl = document.getElementById('agm-topbar-tokens');

            const totalTokens = state.sessionStats.totalTokens || 0;
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

            // 4. Latest Round Stats Card
            const roundCard = el('div', 'margin-top:10px;', [
                el('div', 'font-weight:600;font-size:11.5px;margin-bottom:6px;display:flex;justify-content:space-between;', [
                    el('span', null, 'Latest Turn Telemetry'),
                    el('span', 'color:#38bdf8;', 'Round #' + state.sessionStats.totalRounds, { id: 'agm-dash-round-num' })
                ]),
                el('div', 'display:grid;grid-template-columns: 1fr 1fr;gap:6px;', [
                    el('div', 'background:var(--popover, #18181b);padding:6px;border-radius:6px;border:1px solid var(--border, rgba(255,255,255,0.06));', [
                        el('div', 'font-size:10px;color:var(--muted-foreground,#a1a1aa);', '⏱️ Msg Duration'),
                        el('div', 'font-weight:600;font-size:12px;margin-top:2px;', '0.0s', { id: 'agm-dash-round-duration' })
                    ]),
                    el('div', 'background:var(--popover, #18181b);padding:6px;border-radius:6px;border:1px solid var(--border, rgba(255,255,255,0.06));', [
                        el('div', 'font-size:10px;color:var(--muted-foreground,#a1a1aa);', '🪙 Turn Tokens'),
                        el('div', 'font-weight:600;font-size:12px;margin-top:2px;', '+0 tok', { id: 'agm-dash-round-tokens' })
                    ]),
                    el('div', 'background:var(--popover, #18181b);padding:6px;border-radius:6px;border:1px solid var(--border, rgba(255,255,255,0.06));', [
                        el('div', 'font-size:10px;color:var(--muted-foreground,#a1a1aa);', '🛠️ Tool Calls'),
                        el('div', 'font-weight:600;font-size:12px;margin-top:2px;', '0 tools', { id: 'agm-dash-round-tools' })
                    ]),
                    el('div', 'background:var(--popover, #18181b);padding:6px;border-radius:6px;border:1px solid var(--border, rgba(255,255,255,0.06));', [
                        el('div', 'font-size:10px;color:var(--muted-foreground,#a1a1aa);', '⚡ Speed'),
                        el('div', 'font-weight:600;font-size:12px;margin-top:2px;', '~72 tok/s', { id: 'agm-dash-speed' })
                    ])
                ])
            ], { className: 'agm-card' });
            panel.appendChild(roundCard);

            // 5. Model Selection & Settings
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
                selectModel,
                el('div', 'display:flex;justify-content:space-between;align-items:center;margin-top:8px;', [
                    el('span', 'font-size:11px;', 'Show message token badges'),
                    el('input', null, null, {
                        type: 'checkbox',
                        id: 'agm-toggle-badges',
                        checked: state.config.showMsgBadges !== false
                    })
                ])
            ], { className: 'agm-card' });
            panel.appendChild(settingsCard);

            // 6. Footer with Shortcut info
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
            const badgeCheckbox = panel.querySelector('#agm-toggle-badges');
            badgeCheckbox.addEventListener('change', (e) => {
                state.config.showMsgBadges = e.target.checked;
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

            const totalTokens = state.sessionStats.totalTokens || 0;
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

            const roundNumEl = document.getElementById('agm-dash-round-num');
            const roundDurEl = document.getElementById('agm-dash-round-duration');
            const roundTokEl = document.getElementById('agm-dash-round-tokens');
            const roundToolsEl = document.getElementById('agm-dash-round-tools');

            const roundNumStr = 'Round #' + (state.sessionStats.totalRounds || 0);
            if (roundNumEl && roundNumEl.textContent !== roundNumStr) roundNumEl.textContent = roundNumStr;

            let displayDur = 0;
            if (state.isGenerating) {
                displayDur = Math.max(0, Date.now() - state.msgStartTime);
            } else if (state.lastMsgDurationMs > 0) {
                displayDur = state.lastMsgDurationMs;
            } else {
                displayDur = state.latestRoundStats.durationMs || 0;
            }

            const durStr = formatDuration(displayDur);
            if (roundDurEl && roundDurEl.textContent !== durStr) roundDurEl.textContent = durStr;

            const tokStr = '+' + formatTokens(state.latestRoundStats.totalRoundTokens || 0) + ' tok';
            if (roundTokEl && roundTokEl.textContent !== tokStr) roundTokEl.textContent = tokStr;

            const toolsStr = (state.latestRoundStats.toolCount || 0) + ' tools';
            if (roundToolsEl && roundToolsEl.textContent !== toolsStr) roundToolsEl.textContent = toolsStr;
        }

        // Status bar integration for IDE
        function tryInsertStatusBarItem() {
            const statusBar = document.querySelector('.part.statusbar .right-items') ||
                              document.querySelector('.part.statusbar .items-container.right-items') ||
                              document.querySelector('[id="workbench.parts.statusbar"] .right-items');
            if (!statusBar || document.getElementById('antigravity-metrics-statusbar-btn')) return;

            const item = el('a', `
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

            statusBar.insertBefore(item, statusBar.firstChild);
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

        // Clean up legacy element if present
        function cleanLegacyPill() {
            const oldPill = document.getElementById('antigravity-metrics-pill');
            if (oldPill) oldPill.remove();
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

            const observer = new MutationObserver((mutations) => {
                if (isInternalMutation) return;

                // Check if any mutation is external (not our own widgets)
                const hasExternal = mutations.some(m => {
                    if (m.target && m.target.closest && m.target.closest('#agm-topbar-btn, #antigravity-metrics-panel, #antigravity-metrics-statusbar-btn, .agm-msg-badge')) {
                        return false;
                    }
                    for (let i = 0; i < m.addedNodes.length; i++) {
                        const node = m.addedNodes[i];
                        if (node.id && (node.id.startsWith('agm-') || node.id.startsWith('antigravity-metrics-'))) continue;
                        if (node.classList && node.classList.contains('agm-msg-badge')) continue;
                        return true;
                    }
                    for (let i = 0; i < m.removedNodes.length; i++) {
                        const node = m.removedNodes[i];
                        if (node.id && (node.id.startsWith('agm-') || node.id.startsWith('antigravity-metrics-'))) continue;
                        if (node.classList && node.classList.contains('agm-msg-badge')) continue;
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
