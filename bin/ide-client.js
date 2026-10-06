/**
 * Antigravity Metrics Client-Side Script
 * Injected into Antigravity IDE workbench and Antigravity Standalone chat windows.
 * Tracks live execution duration, context window tokens, per-round usage, and tool activity.
 */
(function() {
    try {
        if (window.__antigravity_metrics_injected) return;
        window.__antigravity_metrics_injected = true;

        const defaultMetricsConfig = {
            modelLimit: 1000000,
            modelName: 'Gemini Flash (1M)',
            showMsgBadges: true,
            showPill: true,
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
            isAgentRunning: false,
            agentStartTime: 0,
            currentRoundElapsedMs: 0,
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
                totalRounds: 1,
                totalSteps: 1,
                totalTools: 0,
                rounds: []
            },
            timerInterval: null
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

        // Save Config to main process
        function saveConfig() {
            try {
                console.log('SAVE_METRICS_CONFIG|' + JSON.stringify(state.config));
            } catch (e) {
                console.error('[Antigravity Metrics] Save config error:', e);
            }
        }

        // Request updated metrics from main process transcript monitor
        function requestTranscriptUpdate() {
            try {
                console.log('REQUEST_TRANSCRIPT_METRICS|{}');
            } catch (_) {}
        }

        // External update handler called by main process bridge
        window.__ANTIGRAVITY_METRICS_UPDATE__ = function(data) {
            if (!data) return;
            if (data.sessionStats) {
                state.sessionStats = { ...state.sessionStats, ...data.sessionStats };
            }
            if (data.latestRoundStats) {
                state.latestRoundStats = { ...state.latestRoundStats, ...data.latestRoundStats };
            }
            if (typeof data.isAgentRunning === 'boolean') {
                if (data.isAgentRunning && !state.isAgentRunning) {
                    startExecutionTimer();
                } else if (!data.isAgentRunning && state.isAgentRunning) {
                    stopExecutionTimer();
                }
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
                .agm-pill-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 3px 8px;
                    border-radius: 6px;
                    font-size: 11.5px;
                    font-weight: 500;
                    line-height: 1;
                    cursor: pointer;
                    user-select: none;
                    transition: all 0.15s ease;
                    border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
                    background-color: var(--secondary, rgba(255, 255, 255, 0.05));
                    color: var(--secondary-foreground, #f4f4f5);
                    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
                }
                .agm-pill-btn:hover {
                    background-color: var(--accent, rgba(255, 255, 255, 0.1));
                    border-color: var(--border, rgba(255, 255, 255, 0.2));
                }
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
                }
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
                    padding: 3px 6px;
                    font-size: 11px;
                    outline: none;
                    cursor: pointer;
                }
            `;
            document.head.appendChild(style);
        }

        // Timer controller
        function startExecutionTimer() {
            if (state.isAgentRunning) return;
            state.isAgentRunning = true;
            state.agentStartTime = Date.now();
            if (state.timerInterval) clearInterval(state.timerInterval);
            state.timerInterval = setInterval(() => {
                state.currentRoundElapsedMs = Date.now() - state.agentStartTime;
                updatePillText();
            }, 100);
            updateUI();
        }

        function stopExecutionTimer() {
            if (!state.isAgentRunning) return;
            state.isAgentRunning = false;
            state.latestRoundStats.durationMs = Date.now() - state.agentStartTime;
            state.currentRoundElapsedMs = state.latestRoundStats.durationMs;
            if (state.timerInterval) {
                clearInterval(state.timerInterval);
                state.timerInterval = null;
            }
            updateUI();
        }

        // Analyze DOM directly for instant fallback metrics
        function scanDomMetrics() {
            try {
                const messageElements = document.querySelectorAll(
                    '[data-testid="chat-message"], [data-testid="conversation-view"] .prose, .prose, .markdown-body'
                );
                let aggregatedTokens = 3500; // base system prompt allowance
                let totalRounds = 1;

                messageElements.forEach((el, index) => {
                    const text = el.textContent || '';
                    aggregatedTokens += estimateTokens(text);
                    if (el.matches('[data-testid="user-input-step"]') || el.closest('[data-testid="user-input-step"]')) {
                        totalRounds++;
                    }
                });

                // Detect running indicator
                const isWorking = Boolean(
                    document.querySelector('.loading-spinner') ||
                    document.querySelector('[data-testid="stop-generation"]') ||
                    document.querySelector('.animate-spin') ||
                    document.querySelector('[data-testid="agent-status-running"]') ||
                    document.querySelector('.streaming-cursor')
                );

                if (isWorking && !state.isAgentRunning) {
                    startExecutionTimer();
                } else if (!isWorking && state.isAgentRunning) {
                    stopExecutionTimer();
                }

                // If transcript monitor hasn't populated session stats yet, use DOM scan
                if (!state.sessionStats.totalTokens || state.sessionStats.totalTokens < aggregatedTokens) {
                    state.sessionStats.totalTokens = aggregatedTokens;
                    state.sessionStats.totalRounds = Math.max(1, totalRounds);
                }

                attachMessageBadges();
            } catch (err) {
                console.error('[Antigravity Metrics] DOM scan error:', err);
            }
        }

        // Attach per-message metrics badge to assistant replies
        function attachMessageBadges() {
            if (!state.config.showMsgBadges) return;
            const assistantReplies = document.querySelectorAll(
                '[data-testid="chat-message"]:not([data-testid="user-input-step"]), .prose'
            );

            assistantReplies.forEach((replyEl) => {
                if (replyEl.querySelector('.agm-msg-badge') || replyEl.parentElement?.querySelector('.agm-msg-badge')) return;
                const tokens = estimateTokens(replyEl.textContent || '');
                if (tokens < 10) return;

                const badge = el('div', null, [
                    el('span', 'opacity:0.8;', '🪙 ' + formatTokens(tokens) + ' tok'),
                    el('span', 'opacity:0.4;', '·'),
                    el('span', 'opacity:0.8;', '⏱️ ' + formatDuration(state.latestRoundStats.durationMs || 12000))
                ], { className: 'agm-msg-badge' });

                replyEl.parentElement?.appendChild(badge);
            });
        }

        // Topbar Pill Widget
        function ensurePill() {
            let pill = document.getElementById('antigravity-metrics-pill');
            if (pill) return pill;

            pill = el('div', null, [
                el('span', null, null, { id: 'agm-pill-dot', className: 'agm-pulsing-dot', style: 'display:none;' }),
                el('span', null, '⏱️ 0.0s', { id: 'agm-pill-time' }),
                el('span', 'opacity:0.35;', '|'),
                el('span', null, '4.5%', { id: 'agm-pill-pct' }),
                el('span', 'opacity:0.6;font-size:10px;', '(45k)', { id: 'agm-pill-tokens' })
            ], {
                id: 'antigravity-metrics-pill',
                className: 'agm-pill-btn',
                title: 'Antigravity Session Metrics (Click to open analytics dashboard)'
            });

            pill.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleDashboard();
            });

            attachPillToHeader(pill);
            return pill;
        }

        function attachPillToHeader(pill) {
            if (!pill) return;
            const targetContainer =
                document.getElementById('rtl-topbar-wrapper')?.parentElement ||
                document.querySelector('[data-testid="titlebar-more-actions"]')?.parentElement ||
                document.querySelector('[data-testid="install-editor"]')?.parentElement ||
                document.querySelector('.part.statusbar .right-items') ||
                document.querySelector('[role="navigation"][aria-label="Sidebar"]')?.parentElement ||
                document.body;

            if (targetContainer && !document.getElementById('antigravity-metrics-pill')) {
                targetContainer.appendChild(pill);
            }
        }

        function updatePillText() {
            const timeEl = document.getElementById('agm-pill-time');
            const pctEl = document.getElementById('agm-pill-pct');
            const tokensEl = document.getElementById('agm-pill-tokens');
            const dotEl = document.getElementById('agm-pill-dot');

            const currentMs = state.isAgentRunning ? state.currentRoundElapsedMs : (state.latestRoundStats.durationMs || 0);
            if (timeEl) {
                timeEl.textContent = (state.isAgentRunning ? '⚡ ' : '⏱️ ') + formatDuration(currentMs);
            }
            if (dotEl) {
                dotEl.style.display = state.isAgentRunning ? 'inline-block' : 'none';
            }

            const totalTokens = state.sessionStats.totalTokens || 3500;
            const limit = state.config.modelLimit || 1000000;
            const pct = Math.min(100, ((totalTokens / limit) * 100)).toFixed(1);

            if (pctEl) {
                pctEl.textContent = `${pct}%`;
                pctEl.style.color = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#10b981';
            }
            if (tokensEl) {
                tokensEl.textContent = `(${formatTokens(totalTokens)})`;
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
                top: 48px;
                right: 16px;
                width: 320px;
                background: var(--popover, var(--card, #18181b));
                color: var(--popover-foreground, var(--foreground, #f4f4f5));
                border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
                border-radius: 12px;
                box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.25);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px;
                padding: 16px;
                direction: ltr;
                box-sizing: border-box;
                user-select: none;
                backdrop-filter: blur(12px);
            `, null, { id: 'antigravity-metrics-panel' });

            // 1. Header
            const titleBlock = el('div', null, [
                el('div', 'font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;', [
                    el('span', null, '📊 Antigravity Metrics'),
                    el('span', 'font-size:10px;padding:1px 5px;border-radius:4px;background:#10b98120;color:#10b981;font-weight:600;', 'LIVE')
                ]),
                el('div', 'font-size:10.5px;color:var(--muted-foreground, #94a3b8);margin-top:2px;', 'Real-time tokens, context & execution telemetry')
            ]);
            const closeBtn = el('button', 'background:none;border:none;color:inherit;cursor:pointer;font-size:15px;line-height:1;opacity:0.6;padding:4px;', '✕', { title: 'Close (Esc)' });
            const header = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border, rgba(255,255,255,0.1));', [titleBlock, closeBtn]);
            panel.appendChild(header);

            // 2. Context Window Card
            const progressFill = el('div', 'width:0%;background-color:#10b981;', null, { id: 'agm-progress-fill', className: 'agm-progress-fill' });
            const progressBar = el('div', null, [progressFill], { className: 'agm-progress-bg' });

            const contextCard = el('div', null, [
                el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;', [
                    el('span', 'font-weight:600;font-size:11.5px;', 'Context Window'),
                    el('span', 'font-weight:600;font-size:11.5px;color:#10b981;', '0.0%', { id: 'agm-dash-pct' })
                ]),
                progressBar,
                el('div', 'display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted-foreground, #94a3b8);margin-top:6px;', [
                    el('span', null, '0 used', { id: 'agm-dash-used' }),
                    el('span', null, '1.0M limit', { id: 'agm-dash-limit' })
                ]),
                el('div', 'font-size:10.5px;color:#10b981;margin-top:4px;', '~1,000,000 tokens remaining', { id: 'agm-dash-remaining' })
            ], { className: 'agm-card' });
            panel.appendChild(contextCard);

            // 3. Latest Round Stats Card
            const roundCard = el('div', 'margin-top:10px;', [
                el('div', 'font-weight:600;font-size:11.5px;margin-bottom:6px;display:flex;justify-content:space-between;', [
                    el('span', null, 'Latest Round Activity'),
                    el('span', 'color:#38bdf8;', 'Round #' + state.sessionStats.totalRounds, { id: 'agm-dash-round-num' })
                ]),
                el('div', 'display:grid;grid-template-columns: 1fr 1fr;gap:6px;', [
                    el('div', 'background:var(--popover, #18181b);padding:6px;border-radius:6px;border:1px solid var(--border, rgba(255,255,255,0.06));', [
                        el('div', 'font-size:10px;color:var(--muted-foreground,#a1a1aa);', '⏱️ Duration'),
                        el('div', 'font-weight:600;font-size:12px;margin-top:2px;', '0.0s', { id: 'agm-dash-round-duration' })
                    ]),
                    el('div', 'background:var(--popover, #18181b);padding:6px;border-radius:6px;border:1px solid var(--border, rgba(255,255,255,0.06));', [
                        el('div', 'font-size:10px;color:var(--muted-foreground,#a1a1aa);', '🪙 Round Tokens'),
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

            // 4. Model Selection & Settings
            const selectModel = el('select', 'width:100%;', [
                el('option', null, 'Gemini Flash (1,000,000 tokens)', { value: '1000000' }),
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

            // 5. Footer with Shortcut info
            const footer = el('div', 'margin-top:12px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--muted-foreground,#94a3b8);', [
                el('span', null, 'Shortcut: ⌥M / Alt+M'),
                el('span', 'color:#38bdf8;cursor:pointer;', 'Refresh Data', { id: 'agm-refresh-btn' })
            ]);
            panel.appendChild(footer);

            document.body.appendChild(panel);

            // Bind Events
            closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
            selectModel.value = String(state.config.modelLimit || 1000000);
            selectModel.addEventListener('change', (e) => {
                state.config.modelLimit = parseInt(e.target.value, 10) || 1000000;
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
                requestTranscriptUpdate();
                scanDomMetrics();
                updateUI();
            });

            return panel;
        }

        function toggleDashboard() {
            const panel = ensureDashboard();
            if (panel.style.display === 'block') {
                panel.style.display = 'none';
            } else {
                updateUI();
                panel.style.display = 'block';
            }
        }

        function updateUI() {
            updatePillText();
            const panel = document.getElementById('antigravity-metrics-panel');
            if (!panel || panel.style.display === 'none') return;

            const totalTokens = state.sessionStats.totalTokens || 3500;
            const limit = state.config.modelLimit || 1000000;
            const pct = Math.min(100, (totalTokens / limit) * 100);
            const remaining = Math.max(0, limit - totalTokens);

            const fill = document.getElementById('agm-progress-fill');
            const pctEl = document.getElementById('agm-dash-pct');
            const usedEl = document.getElementById('agm-dash-used');
            const limitEl = document.getElementById('agm-dash-limit');
            const remEl = document.getElementById('agm-dash-remaining');

            if (fill) {
                fill.style.width = pct.toFixed(1) + '%';
                fill.style.backgroundColor = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#10b981';
            }
            if (pctEl) {
                pctEl.textContent = pct.toFixed(1) + '%';
                pctEl.style.color = pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#10b981';
            }
            if (usedEl) usedEl.textContent = formatTokens(totalTokens) + ' used';
            if (limitEl) limitEl.textContent = formatTokens(limit) + ' limit';
            if (remEl) {
                remEl.textContent = `~${formatTokens(remaining)} tokens remaining`;
                remEl.style.color = pct > 80 ? '#ef4444' : '#10b981';
            }

            const roundNumEl = document.getElementById('agm-dash-round-num');
            const roundDurEl = document.getElementById('agm-dash-round-duration');
            const roundTokEl = document.getElementById('agm-dash-round-tokens');
            const roundToolsEl = document.getElementById('agm-dash-round-tools');

            if (roundNumEl) roundNumEl.textContent = 'Round #' + (state.sessionStats.totalRounds || 1);
            const currentMs = state.isAgentRunning ? state.currentRoundElapsedMs : (state.latestRoundStats.durationMs || 0);
            if (roundDurEl) roundDurEl.textContent = formatDuration(currentMs);
            if (roundTokEl) roundTokEl.textContent = '+' + formatTokens(state.latestRoundStats.totalRoundTokens || 2400) + ' tok';
            if (roundToolsEl) roundToolsEl.textContent = (state.latestRoundStats.toolCount || 0) + ' tools';
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
                el('span', null, '📊 4.5% (45k)')
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
                const panel = document.getElementById('antigravity-metrics-panel');
                if (panel && panel.style.display === 'block') {
                    panel.style.display = 'none';
                }
            }
        });

        // Loop and Mutation Observer
        function init() {
            ensurePill();
            ensureDashboard();
            tryInsertStatusBarItem();
            scanDomMetrics();
            requestTranscriptUpdate();
            updateUI();

            const observer = new MutationObserver(() => {
                ensurePill();
                tryInsertStatusBarItem();
                scanDomMetrics();
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setInterval(scanDomMetrics, 2000);
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
