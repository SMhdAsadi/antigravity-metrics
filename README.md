# Antigravity Metrics & Telemetry Patcher

<div align="center">

**Real-time token usage, context limits, live execution stopwatch, and per-round telemetry for Antigravity & Antigravity IDE.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-green.svg)](https://antigravity.google)
[![Compatible](https://img.shields.io/badge/Compatible%20with-antigravity--rtl-orange.svg)](https://github.com/mmnaderi/antigravity-rtl)

```
[ 🟢 14.8s (Running)  |  📊 4.8% (48.2k)  |  Round #5 ]
```

[Features](#features) · [UI Overview](#ui-overview) · [Install](#install) · [CLI Options](#cli-options) · [Uninstall](#uninstall) · [How It Works](#how-it-works) · [فارسی](#فارسی)

</div>

---

Inspired by the brilliant patching mechanism of [**antigravity-rtl**](https://github.com/mmnaderi/antigravity-rtl), **Antigravity Metrics** injects a native telemetry and analytics HUD directly into your **Antigravity** chat sessions (both the **Standalone Desktop App** and **Antigravity IDE**).

It gives you full visibility into context consumption, agent processing speed, per-round cost and tokens, and real-time execution duration—without leaving your workflow.

---

## Features

- ⏱️ **Live Agent Execution Timer**:
  - Live stopwatch counting up in real-time (`⚡ 14.2s (Running)`) while the agent is thinking and running tools.
  - Automatically freezes when done (`✓ Completed in 28.4s`).
  - Stage duration breakdown: Thinking time, Tool execution time, and Response generation time.

- 📊 **Context Window Health & Remaining Limit**:
  - Real-time percentage indicator with color-coded gauge (Green `<60%`, Amber `60%-80%`, Crimson `>80%`).
  - Exact token count (e.g. `48,250 / 1,000,000 tokens`).
  - Tokens remaining before model compaction or truncation (e.g. `~951,750 tokens left`).
  - Presets for **Gemini 1.5/2.0 Flash (1M)**, **Gemini Pro (2M)**, **Claude 3.7 Sonnet (200k)**, **GPT-4o (128k)**, or custom limits.

- 🪙 **Per-Round Token Usage Breakdown**:
  - Net tokens consumed in the current turn: Prompt input, Thinking/reasoning tokens, and Model output.
  - Attached subtle footer pill on each assistant response:
    `⏱️ 14.2s · 🪙 5.4k tok · 🛠️ 3 tools · ⚡ 78 tok/s`

- 🛠️ **Tool Activity & Step Intelligence**:
  - Real-time tool call count per round and across the entire session.
  - Inspect which tools were executed (`run_command`, `view_file`, `write_to_file`, etc.).

- ⚡ **Generation Velocity & Cost Estimator**:
  - Real-time throughput indicator (`~78 tokens/sec`).
  - Approximate session cost based on active model rates.

- 🤝 **100% Compatible with `antigravity-rtl`**:
  - Can be installed before, after, or alongside `antigravity-rtl` with **zero conflicts**.
  - Respects native Antigravity theme tokens (dark & light modes).

---

## UI Overview

### 1. Header HUD Pill
Placed right in your chat header next to title actions:
```
┌──────────────────────────────────────────────────────────┐
│  [ ⚡ 14.2s  |  📊 4.8%  (48.2k)  |  Round #5 ]   ⚙️  ✕   │
└──────────────────────────────────────────────────────────┘
```
Clicking the pill toggles the **Flyout Dashboard** (`⌥M` / `Alt+M`).

### 2. Flyout Analytics Dashboard
```
╭──────────────────────────────────────────────────╮
│ 📊 Antigravity Metrics                   ● LIVE  │
│ Real-time tokens, context & execution telemetry  │
├──────────────────────────────────────────────────┤
│ Context Window:                          4.8%    │
│ [████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] │
│ 48.2k used                       1.0M limit      │
│ ~951,750 tokens remaining                        │
├──────────────────────────────────────────────────┤
│ Latest Round Activity                  Round #5  │
│ ┌──────────────────────┬───────────────────────┐ │
│ │ ⏱️ Duration: 14.2s   │ 🪙 Round: +5.4k tok   │ │
│ ├──────────────────────┼───────────────────────┤ │
│ │ 🛠️ Tools: 3 calls    │ ⚡ Speed: 78 tok/s    │ │
│ └──────────────────────┴───────────────────────┘ │
├──────────────────────────────────────────────────┤
│ Model Preset: [ Gemini Flash (1,000,000)   ▼ ]   │
│ [x] Show message token badges                    │
├──────────────────────────────────────────────────┤
│ Shortcut: ⌥M / Alt+M             [Refresh Data] │
╰──────────────────────────────────────────────────╯
```

### 3. Per-Message Assistant Badge
Subtle metadata attached to each assistant response:
```
  ╭────────────────────────────────────────────────╮
  │ Agent response markdown text...                │
  ╰────────────────────────────────────────────────╯
  [ 🪙 3.4k tok · ⏱️ 12.8s · 🛠️ 2 tools · ⚡ 82 tok/s ]
```

---

## Install

Requires Node.js **20+**. Close Antigravity before patching.

### Run via npx:
```bash
npx antigravity-metrics
```

### macOS
```bash
npx antigravity-metrics
```
*(If you see "Permission Denied", make sure your Terminal has "App Management" enabled in System Settings → Privacy & Security → App Management, or run with `sudo`)*.

### Linux
```bash
sudo npx antigravity-metrics
```

### Windows (PowerShell Run as Administrator)
```powershell
npx antigravity-metrics
```

---

## CLI Options

| Flag | Description |
| :--- | :--- |
| `npx antigravity-metrics` | Auto-detects installed apps and patches them |
| `npx antigravity-metrics --ide` | Patches only Antigravity IDE (VS Code edition) |
| `npx antigravity-metrics --app` | Patches only Antigravity Standalone App |
| `npx antigravity-metrics --restore` | Safely restores original backups |
| `npx antigravity-metrics -r --ide` | Restores only Antigravity IDE |
| `npx antigravity-metrics -r --app` | Restores only Antigravity Standalone App |
| `npx antigravity-metrics --path <dir>` | Specify a custom installation path |

---

## Uninstall

To cleanly revert the patch and restore original files:
```bash
npx antigravity-metrics --restore
```

---

## How It Works

1. **Dual Extraction Architecture**:
   - **Antigravity Standalone App**: Unpacks `app.asar`, injects the metrics telemetry hook into `dist/utils.js`, and repacks cleanly using `@electron/asar`.
   - **Antigravity IDE**: Injects an isolated hook into `resources/app/out/main.js` targeting the workbench window.
2. **Hybrid Telemetry Engine**:
   - **Main Process Bridge**: Reads and watches `~/.gemini/antigravity/brain/<conv-id>/.system_generated/logs/transcript.jsonl` in real-time, providing ground-truth step timestamps, tool call execution records, and thinking token calculations.
   - **DOM & Observer Engine**: Observes message nodes and active streaming state at 60fps via `MutationObserver` and high-resolution timers (`performance.now()`), serving as a fast, zero-delay real-time fallback.
3. **Persistent Settings**:
   - Preferences and model limits are stored in `~/.antigravity-metrics.json`.

---

<div dir="rtl">

## فارسی

### پچ اطلاعات و مانیتورینگ زنده برای Antigravity

این پچ یک ابزار کاربردی برای نمایش آمار لحظه‌ای مکالمات و عملکرد ایجنت در **Antigravity (نسخه دسکتاپ)** و **Antigravity IDE (نسخه VS Code)** است:

#### قابلیت‌ها
- **کرنومتر زنده عملکرد ایجنت:** نمایش مدت زمان دقیق کارکرد ایجنت به صورت ثانیه‌شمار زنده (`⏱️ 14.2s`) و تفکیک زمان تفکر (Thinking) و اجرای ابزارها (Tools).
- **درصد و ظرفیت کانتکست (Token Usage):** نمایش درصد پر شدن پنجره زمینه (Context Window)، توکن‌های مصرف‌شده و ظرفیت باقیمانده به همراه نوار پیشرفت رنگی.
- **مصرف توکن در هر مرحله:** نمایش حجم توکن مصرفی ورودی، خروجی و پردازش هر پرامپت.
- **تعداد ابزارهای فراخوانی‌شده:** نمایش تعداد و نوع ابزارهای ترمینال یا فایل اجراشده در هر نوبت.
- **تخمین سرعت و هزینه:** نمایش سرعت تولید توکن بر ثانیه و برآورد هزینه بر اساس مدل انتخابی.
- **سازگاری کامل با پچ antigravity-rtl:** بدون تداخل با پچ راست‌چین فارسی، به صورت همزمان یا مجزا قابل نصب است.

#### نحوه نصب
```bash
npx antigravity-metrics
```

#### بازگردانی به نسخه اصلی (Uninstall)
```bash
npx antigravity-metrics --restore
```

</div>

---

## License

MIT
