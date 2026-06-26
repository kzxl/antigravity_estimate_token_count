# AI Token Counter

A VS Code extension that **automatically estimates token usage** from [Google Antigravity](https://antigravity.google) by monitoring conversation files (supporting both legacy Protobuf `.pb` and new SQLite `.db` + `.db-wal` formats). Also supports manual token counting via regex tokenizer.

> **Conversion rates**: 
> - Protobuf (`.pb`): `1 KB = 256 tokens`
> - SQLite (`.db` + `.db-wal`): `1 KB = 6 tokens`

## ✨ Features

### 🔍 Auto-Tracking (File Watcher)
- Monitors conversations in `~/.gemini/antigravity-ide/conversations/` (supporting `.pb` and `.db` + `.db-wal` formats)
- Combines `.db` and `.db-wal` sizes dynamically to ensure real-time tracking of active chat sessions
- Estimates token usage from file size delta (`ΔKB × tokensPerKB` or `ΔKB × tokensPerKBSqlite`)
- Non-blocking async I/O — won't interfere with Antigravity
- Configurable polling interval and tokens/KB calibration rates

### ✏️ Manual Tracking
- **Select text** → count tokens using GPT cl100k_base regex tokenizer (~90-95% accuracy)
- **Manual entry** — log token usage from any AI provider (Antigravity, Copilot, etc.)

###  Dashboard & Status Bar
- **Status bar**: `ΔKB: +42KB (~8.4K tokens) | Manual: 1.2K ↑ / 0.8K ↓`
- **Dashboard**: WebView panel with Chart.js charts, session history, and detailed entries
- **Export**: JSON export of all tracking data

## 📦 Installation

```bash
# From VSIX file
code --install-extension ai-token-counter-1.2.4.vsix
```

Or in VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`

## 🔧 Commands

| Command | Description | Shortcut |
|---------|------------|----------|
| `Token Count: Show Dashboard` | Open the dashboard panel | — |
| `Token Count: Count Selected Text` | Count tokens in selected text | `Ctrl+Shift+T` |
| `Token Count: Add Manual Entry` | Manually log token usage | — |
| `Token Count: Reset Current Session` | Reset today's data | — |
| `Token Count: Reset All Data` | Clear all stored data | — |
| `Token Count: Export Data (JSON)` | Export data to JSON file | — |

## ⚙️ Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tokenCount.pbWatcherEnabled` | `true` | Enable auto-tracking via conversation file watcher |
| `tokenCount.tokensPerKB` | `256` | Tokens per KB for Protobuf `.pb` files (1T≈4B → 1024/4=256) |
| `tokenCount.tokensPerKBSqlite` | `6` | Tokens per KB for SQLite `.db` + `.db-wal` files (calibrated from page writes and WAL log replication) |
| `tokenCount.pbPollingIntervalMs` | `5000` | Polling interval in ms (1000-60000) |
| `tokenCount.showInStatusBar` | `true` | Show/hide status bar item |
| `tokenCount.statusBarAlignment` | `right` | Status bar position (left/right) |
| `tokenCount.autoNewSessionDaily` | `true` | Auto-create new session daily |
| `tokenCount.dailyTokenLimit` | `1000000` | Daily token limit used for displaying the estimated token usage progress bar on the dashboard |

## 🔍 How Auto-Tracking Works

```
Antigravity writes to ~/.gemini/antigravity-ide/conversations/{id}.pb or {id}.db (+ {id}.db-wal)
    ↓
Watcher polls every 5 seconds (async, non-blocking)
    ↓
Detects file type & combines SQLite sizes (.db + .db-wal)
    ↓
Calculates size delta (ΔKB) → estimates tokens:
  - For Protobuf: ΔKB × tokensPerKB (default: 256)
  - For SQLite:   ΔKB × tokensPerKBSqlite (default: 6)
    ↓
Updates status bar + dashboard
```

> **Note**: Token count is an **estimate**. The conversation files are encrypted or structured in SQLite DB, so we track file size delta rather than parsing content. Adjustable in settings.

### 🧪 Conversion Rate Methodology

- **Protobuf (.pb)**: The default rate `256 tokens/KB` represents raw payload density where 1 token ≈ 4 bytes.
- **SQLite (.db + .db-wal)**: The calibrated rate `6 tokens/KB` accounts for SQLite page overhead (4KB pages), WAL log duplication (intermediate agent steps write draft content repeatedly to `.db-wal`), and SQLite structural metadata.

**Experimental results** (measured with real project files and token counts):

| Content Type / Format | Sample Size | Measured Rate | Deviation |
|---|---|---|---|
| Compressed YAML/keywords | 13.4 KB | 256 tokens/KB | baseline |
| Mixed code + markdown | 23.6 KB | 248 tokens/KB | -3% |
| Pure English text | 8.2 KB | 250 tokens/KB | -2% |
| Vietnamese + emoji | 5.1 KB | 293 tokens/KB | +14% |
| Protobuf binary (.pb) | varies | ~200 tokens/KB | -22% |
| SQLite database (.db + .db-wal) | 5.9 MB | ~6.46 tokens/KB | -97.5% (due to WAL) |

> ⚠️ **Disclaimer**: Do nội dung và định dạng lưu trữ khác nhau, các giá trị chỉ mang tính **tương đối** (±15-25%). Người dùng có thể tinh chỉnh `tokenCount.tokensPerKB` và `tokenCount.tokensPerKBSqlite` trong Settings để phù hợp với workload cụ thể.

### 📊 Quick Reference

| Size | Tokens |
|---|---|
| 1 KB | ~256 |
| 10 KB | ~2,560 |
| 100 KB | ~25,600 |
| 1 MB | ~262,144 |

## 🛠️ Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Package VSIX
npm run package
```

## 📄 License

MIT
