# Antigravity Metrics & Telemetry Patcher

<div align="center">

**Real-time token usage, context limits, live execution stopwatch, and per-round telemetry for Antigravity & Antigravity IDE.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-green.svg)](https://antigravity.google)
[![Compatible](https://img.shields.io/badge/Compatible%20with-antigravity--rtl-orange.svg)](https://github.com/mmnaderi/antigravity-rtl)

```
[ 📊 4.8% (48.2k) ]
```

[Features](#features) · [UI Overview](#ui-overview) · [Install](#install) · [CLI Options](#cli-options) · [Uninstall](#uninstall) · [How It Works](#how-it-works) · [فارسی](#فارسی)

</div>

---

Inspired by the brilliant patching mechanism of [**antigravity-rtl**](https://github.com/mmnaderi/antigravity-rtl), **Antigravity Metrics** injects a native telemetry and analytics HUD directly into your **Antigravity** chat sessions (both the **Standalone Desktop App** and **Antigravity IDE**).

It gives you full visibility into context consumption, per-chat token tracking, per-message execution duration, and real-time telemetry—without leaving your workflow.

---

## Features

- 📊 **Context Window Health & Per-Chat Usage**:
  - Dynamically updates as you switch conversations in Antigravity without stale state resets.
  - **Dumb Zone & Cognitive Degradation Awareness**: Color coding dynamically follows LLM attention horizons (🟢 Smart Zone / Optimal, 🟡 Mediocre / Attention Degradation, 🔴 Dumb Zone / Context Rot risk) instead of naive percentage scaling.
  - Calibrated default for **Gemini 3.8 Flash (Antigravity 256k checkpointer limit)**, with options for **Gemini Pro Extended (2M)**, **Claude 3.7 Sonnet (200k)**, **GPT-4o (128k)**, and custom limits.
  - Exact token count and compaction recommendations when approaching the Dumb Zone.

- ⏱️ **Per-Turn Duration** (inline, on every message):
  - Each finished turn gets its wall-clock duration printed at the left of that turn's own action row — the same row that holds copy / good / bad.
  - Numbers come from the transcript, so every turn keeps its own history instead of only the latest one.
  - Nothing is rendered while a turn is generating — the native toolbar doesn't exist yet, so the UI stays untouched until the turn lands.
  - **Honest, never invented:** the transcript's step timestamps are second-granular and a turn's steps often share a single second, which collapses the delta to `0`. When that happens the newest turn falls back to the stopwatch this patch kept while it was actually running; if even that is unavailable (the app restarted since) the duration is simply **omitted** rather than shown as a misleading `0.0s`.
  - Turn token counts and speed were removed: both derive from the same unreliable delta, so they were reported as noise or `—` instead of a number.

- 🛠️ **Dedicated Topbar Header Button**:
  - Unified button placed seamlessly at the top header alongside native actions (`Open IDE`, `Update Available`, `RTL`).
  - Displays token consumption percentage and count: `[ 📊 4.8% (48.2k) ]`.
  - Zero scrollbar interference or window layout breakage.
  - Clicking toggles the **Flyout Dashboard** (`⌥M` / `Alt+M`).

---

## UI Overview

### 1. Header Button
Placed cleanly in your chat header next to title actions:
```
┌──────────────────────────────────────────────────────────┐
│                             [ 📊 4.8% (48.2k) ]   ⚙️  ✕   │
└──────────────────────────────────────────────────────────┘
```
Clicking the button toggles the **Flyout Dashboard** (`⌥M` / `Alt+M`).

### 2. Flyout Analytics Dashboard
```
╭──────────────────────────────────────────────────╮
│ 📊 Antigravity Metrics                          ● IDLE │
│ Real-time tokens, context & per-chat telemetry        │
├──────────────────────────────────────────────────┤
│ 💬 Android Wireless Connection Scrip…    Chat       │
│    ID: 74967d6d • 6 rounds                         Scope │
├──────────────────────────────────────────────────┤
│ Context Window   🟢 Smart Zone (Optimal)      25.8% │
│ [████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]   │
│ 65.9k used                       256.0k limit      │
│ ~190.1k tokens remaining                            │
├──────────────────────────────────────────────────┤
│ Model Context Limit                                │
│ [ Gemini 3.8 Flash - Antigravity (256,000 token… ▼] │
├──────────────────────────────────────────────────┤
│ Shortcut: ⌥M / Alt+M             [Refresh Data]     │
╰──────────────────────────────────────────────────╯
```

### 3. Per-Turn Duration, Inline On Every Message
Turn duration rides Antigravity's own message toolbar instead of a
dashboard card, so each turn keeps its own number where you can read it
in context:

```
                                          3m 50s          ⧉ 👍 👎
                                          ↑               └─ copy / good / bad
                                          └── this turn's wall-clock duration
```

- It is plain muted text in the row's left slot, where the native
  timestamp already appears on hover — quiet enough to ignore, legible
  enough to scan.
- A turn with an unknowable duration shows **no text at all** rather than
  `0.0s`, so the row never states something untrue.
- Nothing else is added to the row. An earlier revision also showed turn
  tokens and speed behind a ghost icon button; both were dropped because
  they are computed from the same second-granular transcript delta and
  were therefore unreliable.

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
