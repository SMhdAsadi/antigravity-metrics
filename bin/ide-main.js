/**
 * Antigravity Metrics Main-Process Injection Hook for Antigravity IDE
 * Injected at the top of resources/app/out/main.js
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import child_process from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(os.homedir(), '.antigravity-metrics.json');
const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const DB_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
const LOG_FILE = path.join(os.tmpdir(), 'antigravity-metrics.log');

function log(...args) {
    try {
        const line = `[${new Date().toISOString()}] ` + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
        fs.appendFileSync(LOG_FILE, line);
    } catch (_) {}
}

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
        if (query && (query.isNewConversation || query.title === 'New Conversation' || query.key === 'new-chat')) {
            return null;
        }

        // 1. Direct ID match
        if (query && query.id && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(query.id)) {
            const direct = path.join(BRAIN_DIR, query.id, '.system_generated', 'logs', 'transcript.jsonl');
            if (fs.existsSync(direct)) return direct;
        }

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

        const cleanPrompt = (query && query.firstPrompt ? query.firstPrompt : '').trim().toLowerCase();
        const cleanTitle = (query && query.title && query.title !== 'Active Conversation' && query.title !== 'New Conversation' ? query.title : '').trim().toLowerCase();

        // 2. Direct firstPrompt match in transcript file content (checks top 60 recent conversations)
        if (cleanPrompt && cleanPrompt.length >= 4) {
            const target = cleanPrompt.replace(/[^\w\s\u0600-\u06FF]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 35);
            if (target.length >= 4) {
                for (const d of convDirs.slice(0, 60)) {
                    try {
                        const fd = fs.openSync(d.tPath, 'r');
                        const buf = Buffer.alloc(8192);
                        const bytes = fs.readSync(fd, buf, 0, 8192, 0);
                        fs.closeSync(fd);
                        const snippet = buf.toString('utf8', 0, bytes).toLowerCase();
                        if (snippet.includes(target)) {
                            return d.tPath;
                        }
                    } catch (_) {}
                }
            }
        }

        // 3. SQLite title match
        if (cleanTitle && cleanTitle.length >= 2) {
            const resolvedId = findConversationIdByTitle(cleanTitle);
            if (resolvedId) {
                const direct = path.join(BRAIN_DIR, resolvedId, '.system_generated', 'logs', 'transcript.jsonl');
                if (fs.existsSync(direct)) return direct;
            }
        }

        // 4. SQLite prompt match
        if (cleanPrompt && cleanPrompt.length >= 4) {
            const target = cleanPrompt.slice(0, 30);
            const resolvedId = findConversationIdByTitle(target);
            if (resolvedId) {
                const direct = path.join(BRAIN_DIR, resolvedId, '.system_generated', 'logs', 'transcript.jsonl');
                if (fs.existsSync(direct)) return direct;
            }
        }

        // 5. Active generation / newly created session fallback:
        // ONLY if the newest conversation folder was modified within the last 25 seconds
        if (convDirs.length > 0) {
            const mostRecent = convDirs[0];
            const ageMs = Date.now() - mostRecent.mtimeMs;
            if (ageMs < 25000) {
                if (cleanPrompt) {
                    try {
                        const fd = fs.openSync(mostRecent.tPath, 'r');
                        const buf = Buffer.alloc(8192);
                        const bytes = fs.readSync(fd, buf, 0, 8192, 0);
                        fs.closeSync(fd);
                        const snippet = buf.toString('utf8', 0, bytes).toLowerCase();
                        const target = cleanPrompt.replace(/[^\w\s\u0600-\u06FF]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
                        if (snippet.includes(target)) {
                            return mostRecent.tPath;
                        }
                    } catch (_) {}
                } else if (!cleanTitle) {
                    return mostRecent.tPath;
                }
            }
        }

        // NEVER return an unrelated transcript
        return null;
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

app.on('browser-window-created', (_event, win) => {
    let watchedTranscriptPath = null;
    let watcher = null;

    win.on('closed', () => {
        if (watcher) {
            try { watcher.close(); } catch (_) {}
            watcher = null;
        }
    });

    let watchDebounceTimer = null;
    const pushMetricsToWindow = (query) => {
        try {
            const transcriptPath = findTranscriptForChat(query);
            if (transcriptPath) {
                if (watchedTranscriptPath !== transcriptPath) {
                    if (watcher) {
                        try { watcher.close(); } catch (_) {}
                        watcher = null;
                    }
                    watchedTranscriptPath = transcriptPath;
                    try {
                        const setupWatcher = () => {
                            return fs.watch(transcriptPath, (eventType) => {
                                if (eventType === 'rename') {
                                    setTimeout(() => {
                                        if (watchedTranscriptPath === transcriptPath && fs.existsSync(transcriptPath)) {
                                            try {
                                                if (watcher) watcher.close();
                                                watcher = setupWatcher();
                                            } catch (_) {}
                                        }
                                    }, 250);
                                }
                                if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
                                watchDebounceTimer = setTimeout(() => {
                                    const updated = parseTranscript(transcriptPath);
                                    if (updated) {
                                        win.webContents.executeJavaScript(
                                            `window.__ANTIGRAVITY_METRICS_UPDATE__ && window.__ANTIGRAVITY_METRICS_UPDATE__(${JSON.stringify(updated)});`
                                        ).catch(() => {});
                                    }
                                }, 300);
                            });
                        };
                        watcher = setupWatcher();
                    } catch (_) {}
                }

                const metrics = parseTranscript(transcriptPath);
                if (metrics) {
                    win.webContents.executeJavaScript(
                        `window.__ANTIGRAVITY_METRICS_UPDATE__ && window.__ANTIGRAVITY_METRICS_UPDATE__(${JSON.stringify(metrics)});`
                    ).catch(() => {});
                }
            } else {
                if (watchedTranscriptPath && (!query || !query.isNewConversation)) {
                    if (watcher) {
                        try { watcher.close(); } catch (_) {}
                        watcher = null;
                    }
                    watchedTranscriptPath = null;
                }
                win.webContents.executeJavaScript(
                    `window.__ANTIGRAVITY_METRICS_UPDATE__ && window.__ANTIGRAVITY_METRICS_UPDATE__({ notFound: true, query: ${JSON.stringify(query || {})} });`
                ).catch(() => {});
            }
        } catch (_) {}
    };

    win.webContents.on('console-message', (_e, ...args) => {
        let msg = '';
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
            msg = args[0].message;
        } else {
            msg = args[1];
        }

        if (typeof msg === 'string') {
            if (msg.startsWith('SAVE_METRICS_CONFIG|')) {
                try {
                    const newConfig = JSON.parse(msg.substring(20));
                    let merged = newConfig;
                    if (fs.existsSync(CONFIG_FILE)) {
                        try {
                            const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                            merged = { ...existing, ...newConfig };
                        } catch (_) {}
                    }
                    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
                } catch (_) {}
            } else if (msg.startsWith('REQUEST_TRANSCRIPT_METRICS|')) {
                try {
                    const raw = msg.substring(27);
                    const query = raw ? JSON.parse(raw) : null;
                    pushMetricsToWindow(query);
                } catch (_) {
                    pushMetricsToWindow();
                }
            }
        }
    });

    const injectScript = async (sourceEvent = 'dom-ready') => {
        try {
            const url = win.webContents.getURL() || '';
            log(`[${sourceEvent}] Window URL:`, url);
            if (!url.includes('workbench') && !url.includes('jetski') && !url.endsWith('.html') && url !== '') {
                return;
            }

            let metricsConfig = {};
            if (fs.existsSync(CONFIG_FILE)) {
                try {
                    metricsConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                } catch (_) {}
            }

            const clientPath = path.join(__dirname, 'antigravity-metrics-client.js');
            if (fs.existsSync(clientPath)) {
                let clientCode = fs.readFileSync(clientPath, 'utf8');
                clientCode = `var __METRICS_CONFIG__ = ${JSON.stringify(metricsConfig)};\n` + clientCode;
                await win.webContents.executeJavaScript(clientCode);
                log(`[${sourceEvent}] Successfully injected antigravity-metrics-client.js into:`, url);
            }

            pushMetricsToWindow();
        } catch (err) {
            log(`[${sourceEvent}] Injection error:`, err.message);
        }
    };

    win.webContents.on('dom-ready', () => injectScript('dom-ready'));
});
