# Antigravity Estimate Token Count

A VS Code extension that **automatically estimates token usage** from [Google Antigravity](https://antigravity.google) by monitoring `.pb` conversation files. Also supports manual token counting via regex tokenizer.

## ✨ Features

### � Auto-Tracking (PB File Watcher)
- Monitors `.pb` files in `~/.gemini/antigravity/conversations/` for size changes
- Estimates token usage from file size delta (`ΔKB × tokensPerKB`)
- Non-blocking async I/O — won't interfere with Antigravity
- Configurable polling interval and tokens/KB ratio

### ✏️ Manual Tracking
- **Select text** → count tokens using GPT cl100k_base regex tokenizer (~90-95% accuracy)
- **Manual entry** — log token usage from any AI provider (Antigravity, Copilot, etc.)

### � Dashboard & Status Bar
- **Status bar**: `ΔKB: +42KB (~8.4K tokens) | Manual: 1.2K ↑ / 0.8K ↓`
- **Dashboard**: WebView panel with Chart.js charts, session history, and detailed entries
- **Export**: JSON export of all tracking data

## 📦 Installation

```bash
# From VSIX file
code --install-extension ai-token-counter-1.0.0.vsix
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
| `tokenCount.pbWatcherEnabled` | `true` | Enable auto-tracking via PB file watcher |
| `tokenCount.tokensPerKB` | `200` | Estimated tokens per KB of file size change |
| `tokenCount.pbPollingIntervalMs` | `5000` | Polling interval in ms (1000-60000) |
| `tokenCount.showInStatusBar` | `true` | Show/hide status bar item |
| `tokenCount.statusBarAlignment` | `right` | Status bar position (left/right) |
| `tokenCount.autoNewSessionDaily` | `true` | Auto-create new session daily |

## 🔍 How Auto-Tracking Works

```
Antigravity writes to ~/.gemini/antigravity/conversations/{id}.pb
    ↓
PbWatcher polls every 5 seconds (async, non-blocking)
    ↓
Detects file size change → calculates ΔKB
    ↓
Estimates tokens = ΔKB × tokensPerKB (default: 200)
    ↓
Updates status bar + dashboard
```

> **Note**: Token count is an **estimate** (~±30% accuracy). The `.pb` files are encrypted (AES-GCM), so we track file size delta rather than parsing content. The ratio `tokensPerKB` can be adjusted in settings.

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
