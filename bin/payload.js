/* ANTIGRAVITY METRICS PATCH */
try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const CONFIG_FILE = path.join(os.homedir(), '.antigravity-metrics.json');
    const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

    let currentWatchedPath = null;
    let currentWatcher = null;

    function estimateTokensFast(text) {
        if (!text || typeof text !== 'string') return 0;
        const nonAsciiMatches = text.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC\u08A0-\u08FF]/g);
        const nonAsciiCount = nonAsciiMatches ? nonAsciiMatches.length : 0;
        const latinChars = text.length - nonAsciiCount;
        const symbols = (text.match(/[{}\[\]()<>=+\-*/:;,"'`\\_]/g) || []).length;
        return Math.max(1, Math.ceil(latinChars / 3.65) + Math.ceil(nonAsciiCount / 1.75) + Math.ceil(symbols * 0.12));
    }

    function findTranscriptForChat(query) {
        try {
            if (!fs.existsSync(BRAIN_DIR)) return null;

            // Direct ID match
            if (query && query.id) {
                const direct = path.join(BRAIN_DIR, query.id, '.system_generated', 'logs', 'transcript.jsonl');
                if (fs.existsSync(direct)) return direct;
            }

            const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
            const convDirs = [];
            for (const e of entries) {
                if (!e.isDirectory() || e.name.startsWith('.')) continue;
                const fullPath = path.join(BRAIN_DIR, e.name);
                let mtimeMs = 0;
                try {
                    mtimeMs = fs.statSync(fullPath).mtimeMs;
                } catch (_) {}
                convDirs.push({ name: e.name, fullPath, mtimeMs });
            }

            // Sort by modification time descending
            convDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

            // If title or firstPrompt provided, search recent transcripts (skip generic titles)
            if (query && (query.title || query.firstPrompt)) {
                const target = (query.firstPrompt || query.title || '').trim().toLowerCase();
                if (target.length > 3 && target !== 'active conversation' && target !== 'new conversation') {
                    for (const d of convDirs.slice(0, 25)) {
                        const tPath = path.join(d.fullPath, '.system_generated', 'logs', 'transcript.jsonl');
                        if (!fs.existsSync(tPath)) continue;
                        try {
                            const fd = fs.openSync(tPath, 'r');
                            const buf = Buffer.alloc(4096);
                            const bytes = fs.readSync(fd, buf, 0, 4096, 0);
                            fs.closeSync(fd);
                            const snippet = buf.toString('utf8', 0, bytes).toLowerCase();
                            if (snippet.includes(target.slice(0, 30))) {
                                return tPath;
                            }
                        } catch (_) {}
                    }
                }
            }

            // Fallback to most recently updated transcript
            for (const d of convDirs) {
                const tPath = path.join(d.fullPath, '.system_generated', 'logs', 'transcript.jsonl');
                if (fs.existsSync(tPath)) return tPath;
            }
        } catch (_) {}
        return null;
    }

    function parseTranscript(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null;
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            if (lines.length === 0) return null;

            const convId = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
            let totalTokens = 3500;
            let totalTools = 0;
            let totalSteps = lines.length;
            let rounds = [];
            let currentRound = null;

            for (const line of lines) {
                try {
                    const step = JSON.parse(line);
                    if (step.type === 'USER_INPUT') {
                        if (currentRound) rounds.push(currentRound);
                        currentRound = {
                            userStartTime: step.created_at ? new Date(step.created_at).getTime() : Date.now(),
                            lastStepTime: step.created_at ? new Date(step.created_at).getTime() : Date.now(),
                            inputTokens: estimateTokensFast(step.content || ''),
                            outputTokens: 0,
                            thinkingTokens: 0,
                            toolCount: 0,
                            tools: [],
                            isDone: step.status === 'DONE'
                        };
                    } else if (currentRound) {
                        const stepTime = step.created_at ? new Date(step.created_at).getTime() : Date.now();
                        currentRound.lastStepTime = stepTime;

                        if (step.thinking) {
                            currentRound.thinkingTokens += estimateTokensFast(step.thinking);
                        }
                        if (step.content) {
                            currentRound.outputTokens += estimateTokensFast(step.content);
                        }
                        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
                            currentRound.toolCount += step.tool_calls.length;
                            totalTools += step.tool_calls.length;
                            for (const tc of step.tool_calls) {
                                if (tc.name) currentRound.tools.push(tc.name);
                            }
                        }
                        if (step.status === 'RUNNING') {
                            currentRound.isDone = false;
                        }
                    }
                } catch (_) {}
            }
            if (currentRound) rounds.push(currentRound);

            for (const r of rounds) {
                totalTokens += (r.inputTokens + r.outputTokens + r.thinkingTokens);
            }

            const latest = rounds[rounds.length - 1] || {
                userStartTime: Date.now(),
                lastStepTime: Date.now(),
                inputTokens: 0,
                outputTokens: 0,
                thinkingTokens: 0,
                toolCount: 0,
                tools: []
            };

            const durationMs = Math.max(0, latest.lastStepTime - latest.userStartTime);
            const lastStep = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
            const isAgentRunning = lastStep ? lastStep.status === 'RUNNING' : false;

            return {
                conversationId: convId,
                isAgentRunning,
                sessionStats: {
                    totalTokens,
                    totalRounds: Math.max(1, rounds.length),
                    totalSteps,
                    totalTools
                },
                rounds: rounds.map(r => ({
                    inputTokens: r.inputTokens,
                    outputTokens: r.outputTokens,
                    thinkingTokens: r.thinkingTokens,
                    durationMs: Math.max(0, r.lastStepTime - r.userStartTime),
                    toolCount: r.toolCount
                })),
                latestRoundStats: {
                    durationMs,
                    inputTokens: latest.inputTokens,
                    outputTokens: latest.outputTokens,
                    thinkingTokens: latest.thinkingTokens,
                    totalRoundTokens: latest.inputTokens + latest.outputTokens + latest.thinkingTokens,
                    toolCount: latest.toolCount,
                    toolsList: latest.tools
                }
            };
        } catch (_) {
            return null;
        }
    }

    let watchDebounceTimer = null;
    function watchTranscript(tPath) {
        if (!tPath || currentWatchedPath === tPath) return;
        if (currentWatcher) {
            try { currentWatcher.close(); } catch (_) {}
            currentWatcher = null;
        }
        currentWatchedPath = tPath;
        try {
            currentWatcher = fs.watch(tPath, () => {
                if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
                watchDebounceTimer = setTimeout(() => {
                    const metrics = parseTranscript(tPath);
                    if (metrics) {
                        win.webContents.executeJavaScript(
                            `window.__ANTIGRAVITY_METRICS_UPDATE__ && window.__ANTIGRAVITY_METRICS_UPDATE__(${JSON.stringify(metrics)});`
                        ).catch(() => {});
                    }
                }, 300);
            });
        } catch (_) {}
    }

    const pushMetricsToWindow = (query) => {
        try {
            const transcriptPath = findTranscriptForChat(query);
            if (transcriptPath) {
                watchTranscript(transcriptPath);
                const metrics = parseTranscript(transcriptPath);
                if (metrics) {
                    win.webContents.executeJavaScript(
                        `window.__ANTIGRAVITY_METRICS_UPDATE__ && window.__ANTIGRAVITY_METRICS_UPDATE__(${JSON.stringify(metrics)});`
                    ).catch(() => {});
                }
            }
        } catch (_) {}
    };

    win.webContents.on('console-message', (event, ...args) => {
        let message = '';
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
            message = args[0].message;
        } else {
            message = args[1];
        }

        if (typeof message === 'string') {
            if (message.startsWith('SAVE_METRICS_CONFIG|')) {
                try {
                    const data = message.substring(20);
                    let merged = JSON.parse(data);
                    if (fs.existsSync(CONFIG_FILE)) {
                        try {
                            const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                            merged = { ...existing, ...merged };
                        } catch (_) {}
                    }
                    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
                } catch (_) {}
            } else if (message.startsWith('REQUEST_TRANSCRIPT_METRICS|')) {
                try {
                    const raw = message.substring(27);
                    const query = raw ? JSON.parse(raw) : null;
                    pushMetricsToWindow(query);
                } catch (_) {
                    pushMetricsToWindow();
                }
            }
        }
    });

    win.webContents.on('dom-ready', () => {
        const currentURL = win.webContents.getURL();
        if (!currentURL || !/^https?:\/\/127\.0\.0\.1:\d+/i.test(currentURL)) {
            return;
        }

        let userConfig = {};
        if (fs.existsSync(CONFIG_FILE)) {
            try {
                userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            } catch (_) {}
        }

        const clientScriptPath = path.join(__dirname, 'antigravity-metrics-client.js');
        let clientCode = '';
        if (fs.existsSync(clientScriptPath)) {
            clientCode = fs.readFileSync(clientScriptPath, 'utf8');
        }

        if (clientCode) {
            win.webContents.executeJavaScript(`
                const __METRICS_CONFIG__ = ${JSON.stringify(userConfig)};
                ${clientCode}
            `).catch(() => {});
        }

        pushMetricsToWindow();
    });
} catch (_) {}

void win.loadURL(url);
/* END ANTIGRAVITY METRICS PATCH */
