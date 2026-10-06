/**
 * Antigravity Metrics Main-Process Injection Hook for Antigravity IDE
 * Injected at the top of resources/app/out/main.js
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(os.homedir(), '.antigravity-metrics.json');
const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

function estimateTokensFast(text) {
    if (!text || typeof text !== 'string') return 0;
    const nonAsciiMatches = text.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC\u08A0-\u08FF]/g);
    const nonAsciiCount = nonAsciiMatches ? nonAsciiMatches.length : 0;
    const latinChars = text.length - nonAsciiCount;
    const symbols = (text.match(/[{}\[\]()<>=+\-*/:;,"'`\\_]/g) || []).length;
    return Math.max(1, Math.ceil(latinChars / 3.65) + Math.ceil(nonAsciiCount / 1.75) + Math.ceil(symbols * 0.12));
}

function findLatestTranscriptPath() {
    try {
        if (!fs.existsSync(BRAIN_DIR)) return null;
        const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
        const convDirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => path.join(BRAIN_DIR, e.name))
            .sort((a, b) => {
                try {
                    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
                } catch (_) { return 0; }
            });

        for (const dir of convDirs) {
            const transcript = path.join(dir, '.system_generated', 'logs', 'transcript.jsonl');
            if (fs.existsSync(transcript)) return transcript;
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

        let totalTokens = 3500; // Base system prompt estimation
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
            isAgentRunning,
            sessionStats: {
                totalTokens,
                totalRounds: Math.max(1, rounds.length),
                totalSteps,
                totalTools
            },
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

    const pushMetricsToWindow = () => {
        try {
            const transcriptPath = watchedTranscriptPath || findLatestTranscriptPath();
            if (transcriptPath) {
                const metrics = parseTranscript(transcriptPath);
                if (metrics) {
                    win.webContents.executeJavaScript(
                        `window.__ANTIGRAVITY_METRICS_UPDATE__ && window.__ANTIGRAVITY_METRICS_UPDATE__(${JSON.stringify(metrics)});`
                    ).catch(() => {});
                }
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
                pushMetricsToWindow();
            }
        }
    });

    const injectScript = async () => {
        try {
            const url = win.webContents.getURL() || '';
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
                clientCode = `const __METRICS_CONFIG__ = ${JSON.stringify(metricsConfig)};\n` + clientCode;
                await win.webContents.executeJavaScript(clientCode);
            }

            // Start watching transcript
            const transcriptPath = findLatestTranscriptPath();
            if (transcriptPath && !watcher) {
                watchedTranscriptPath = transcriptPath;
                try {
                    watcher = fs.watch(transcriptPath, () => {
                        pushMetricsToWindow();
                    });
                } catch (_) {}
            }
            pushMetricsToWindow();
        } catch (_) {}
    };

    win.webContents.on('dom-ready', () => injectScript());
});
