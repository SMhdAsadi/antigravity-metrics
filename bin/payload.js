/* ANTIGRAVITY METRICS PATCH */
try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const child_process = require('child_process');
    const CONFIG_FILE = path.join(os.homedir(), '.antigravity-metrics.json');
    const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    const DB_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');

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

    function extractFirstPrompt(content) {
        if (!content || typeof content !== 'string') return '';
        let text = content;
        const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
        if (reqMatch) text = reqMatch[1];
        text = text.replace(/<[^>]+>/g, '').trim();
        text = text.replace(/\s+/g, ' ').trim();
        return text;
    }

    function findConversationIdByTitle(title) {
        if (!title || typeof title !== 'string') return null;
        const clean = title.trim();
        if (!clean || clean.length < 2 || clean === 'Active Conversation' || clean === 'New Conversation') return null;

        try {
            if (!fs.existsSync(DB_PATH)) return null;
            const sqliteBin = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3';
            const escaped = clean.replace(/'/g, "''");
            const sql = `SELECT conversation_id FROM conversation_summaries WHERE title = '${escaped}' OR title LIKE '${escaped}%' OR title LIKE '%${escaped}%' ORDER BY last_modified_time DESC LIMIT 1;`;
            const out = child_process.execFileSync(sqliteBin, [DB_PATH, sql], {
                encoding: 'utf8',
                timeout: 500,
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (out && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(out)) {
                return out;
            }
        } catch (_) {}
        return null;
    }

    function findMostRecentConversationId() {
        try {
            if (!fs.existsSync(DB_PATH)) return null;
            const sqliteBin = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3';
            const sql = `SELECT conversation_id FROM conversation_summaries ORDER BY last_user_input_time DESC, last_modified_time DESC LIMIT 1;`;
            const out = child_process.execFileSync(sqliteBin, [DB_PATH, sql], {
                encoding: 'utf8',
                timeout: 500,
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (out && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(out)) {
                return out;
            }
        } catch (_) {}
        return null;
    }

    function getConversationMetadata(convId) {
        if (!convId) return null;
        try {
            if (!fs.existsSync(DB_PATH)) return null;
            const sqliteBin = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3';
            const escapedId = convId.replace(/'/g, "''");
            const sql = `SELECT title, last_user_input_time FROM conversation_summaries WHERE conversation_id = '${escapedId}' LIMIT 1;`;
            const out = child_process.execFileSync(sqliteBin, [DB_PATH, sql], {
                encoding: 'utf8',
                timeout: 500,
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (out) {
                const parts = out.split('|');
                return {
                    title: parts[0] || '',
                    lastUserInputTime: parts[1] || ''
                };
            }
        } catch (_) {}
        return null;
    }

    function findTranscriptForChat(query) {
        try {
            if (!fs.existsSync(BRAIN_DIR)) return null;

            // If explicitly a new empty conversation, never attach old transcripts
            if (query && (query.isNewConversation || query.title === 'New Conversation')) {
                return null;
            }

            // 1. Direct ID match
            if (query && query.id && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(query.id)) {
                const direct = path.join(BRAIN_DIR, query.id, '.system_generated', 'logs', 'transcript.jsonl');
                if (fs.existsSync(direct)) return direct;
            }

            // 2. Query title via SQLite conversation_summaries.db
            if (query && query.title) {
                const resolvedId = findConversationIdByTitle(query.title);
                if (resolvedId) {
                    const direct = path.join(BRAIN_DIR, resolvedId, '.system_generated', 'logs', 'transcript.jsonl');
                    if (fs.existsSync(direct)) return direct;
                }
            }

            // 3. Fallback: most recently active conversation from SQLite
            const mostRecentId = findMostRecentConversationId();
            if (mostRecentId) {
                const direct = path.join(BRAIN_DIR, mostRecentId, '.system_generated', 'logs', 'transcript.jsonl');
                if (fs.existsSync(direct)) return direct;
            }

            // 4. Disk fallback: scan directory mtime
            const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
            const convDirs = [];
            for (const e of entries) {
                if (!e.isDirectory() || e.name.startsWith('.')) continue;
                const fullPath = path.join(BRAIN_DIR, e.name);
                const tPath = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
                if (!fs.existsSync(tPath)) continue;
                let mtimeMs = 0;
                try {
                    mtimeMs = fs.statSync(tPath).mtimeMs;
                } catch (_) {}
                convDirs.push({ id: e.name, fullPath, tPath, mtimeMs });
            }
            convDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

            if (convDirs.length > 0) {
                return convDirs[0].tPath;
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
            let totalTokens = 0;
            let totalTools = 0;
            let totalSteps = lines.length;
            let rounds = [];
            let currentRound = null;
            let firstPrompt = '';

            for (const line of lines) {
                try {
                    const step = JSON.parse(line);
                    if (step.type === 'USER_INPUT') {
                        if (currentRound) rounds.push(currentRound);
                        if (!firstPrompt && step.content) {
                            firstPrompt = extractFirstPrompt(step.content);
                        }
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

            // Add base system overhead only when conversation actually has rounds
            if (rounds.length > 0) {
                totalTokens += 3500;
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

            const meta = getConversationMetadata(convId);
            const derivedTitle = (meta && meta.title)
                ? meta.title
                : (firstPrompt
                    ? (firstPrompt.length > 36 ? firstPrompt.slice(0, 36) + '...' : firstPrompt)
                    : 'Active Conversation');

            return {
                conversationId: convId,
                title: derivedTitle,
                firstPrompt,
                isAgentRunning,
                sessionStats: {
                    totalTokens,
                    totalRounds: Math.max(0, rounds.length),
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

    try {
        win.on('closed', () => {
            if (currentWatcher) {
                try { currentWatcher.close(); } catch (_) {}
                currentWatcher = null;
            }
        });
    } catch (_) {}

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
