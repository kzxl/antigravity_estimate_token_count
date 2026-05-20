import * as vscode from 'vscode';
import { SessionManager, TokenSession } from './sessionManager';
import { formatTokenCount } from './tokenizer';
import { PbWatcher } from './pbWatcher';
import { ConversionTracker, ConversionLogEntry, ConversionStats } from './conversionTracker';
import { QuotaFetcher, QuotaData } from './quotaFetcher';

export class DashboardPanel {
    public static currentPanel: DashboardPanel | undefined;
    private static readonly viewType = 'tokenCountDashboard';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    public static createOrShow(
        extensionUri: vscode.Uri,
        sessionManager: SessionManager,
        pbWatcher?: PbWatcher,
        conversionTracker?: ConversionTracker,
        quotaFetcher?: QuotaFetcher,
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel.panel.reveal(column);
            DashboardPanel.currentPanel.updateContent(sessionManager, pbWatcher, conversionTracker, quotaFetcher);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            DashboardPanel.viewType,
            'AI Token Counter',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, sessionManager, pbWatcher, conversionTracker, quotaFetcher);
    }

    /** Refresh dashboard nếu đang mở (dùng khi quota update từ background) */
    public static refresh(
        sessionManager: SessionManager,
        pbWatcher?: PbWatcher,
        conversionTracker?: ConversionTracker,
        quotaFetcher?: QuotaFetcher,
    ): void {
        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel.updateContent(sessionManager, pbWatcher, conversionTracker, quotaFetcher);
        }
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sessionManager: SessionManager,
        pbWatcher?: PbWatcher,
        conversionTracker?: ConversionTracker,
        quotaFetcher?: QuotaFetcher,
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.updateContent(sessionManager, pbWatcher, conversionTracker, quotaFetcher);

        // Listen for data changes
        this.disposables.push(
            sessionManager.onDidChange(() => this.updateContent(sessionManager, pbWatcher, conversionTracker, quotaFetcher))
        );

        // Listen for PB tracking updates
        if (pbWatcher) {
            this.disposables.push(
                pbWatcher.onTrackingUpdate(() => this.updateContent(sessionManager, pbWatcher, conversionTracker, quotaFetcher))
            );
        }

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'resetSession':
                        await sessionManager.resetCurrentSession();
                        pbWatcher?.resetTracking();
                        break;
                    case 'resetAll': {
                        const confirmReset = await vscode.window.showWarningMessage(
                            'Are you sure you want to reset ALL token data?',
                            { modal: true },
                            'Yes, Reset All'
                        );
                        if (confirmReset === 'Yes, Reset All') {
                            await sessionManager.resetAll();
                            pbWatcher?.resetTracking();
                        }
                        break;
                    }
                    case 'export': {
                        const json = sessionManager.exportAsJson(pbWatcher?.getTrackingData());
                        const uri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(`token-usage-${new Date().toISOString().slice(0, 10)}.json`),
                            filters: { 'JSON': ['json'] },
                        });
                        if (uri) {
                            await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
                            vscode.window.showInformationMessage(`Token data exported to ${uri.fsPath}`);
                        }
                        break;
                    }
                }
            },
            null,
            this.disposables
        );
    }

    private async updateContent(
        sessionManager: SessionManager,
        pbWatcher?: PbWatcher,
        conversionTracker?: ConversionTracker,
        quotaFetcher?: QuotaFetcher,
    ): Promise<void> {
        const sessions = sessionManager.getAllSessions();
        const currentTotals = sessionManager.getCurrentTotals();
        const allTimeTotals = sessionManager.getAllTimeTotals();
        const pbData = pbWatcher?.getTrackingData();
        const quotaData = quotaFetcher?.getData();

        // Load conversion data asynchronously
        let conversionEntries: ConversionLogEntry[] = [];
        let conversionStats: ConversionStats | undefined;
        let todayLog: { tokens: number; events: number; deltaKB: number } | undefined;
        if (conversionTracker) {
            conversionEntries = await conversionTracker.getRecentConversions(50);
            conversionStats = await conversionTracker.getConversionStats();
            todayLog = await conversionTracker.getTodayTokensFromLog();
        }

        this.panel.webview.html = this.getHtmlContent(sessions, currentTotals, allTimeTotals, pbData, conversionEntries, conversionStats, todayLog, quotaData);
    }

    private getHtmlContent(
        sessions: TokenSession[],
        currentTotals: { input: number; output: number; total: number },
        allTimeTotals: { input: number; output: number; total: number },
        pbData?: { totalDeltaKB: number; totalEstimatedTokens: number; activeConversations: number; lastUpdate: number },
        conversionEntries: ConversionLogEntry[] = [],
        conversionStats?: ConversionStats,
        todayLog?: { tokens: number; events: number; deltaKB: number },
        quotaData?: QuotaData,
    ): string {
        // Prepare chart data (last 14 days)
        const last14Days = this.getLast14DaysData(sessions);
        const chartLabels = JSON.stringify(last14Days.map(d => d.label));
        const chartInputData = JSON.stringify(last14Days.map(d => d.input));
        const chartOutputData = JSON.stringify(last14Days.map(d => d.output));

        // Current session entries (latest first)
        const currentSession = sessions.find(s => s.date === new Date().toISOString().slice(0, 10));
        const entries = currentSession ? [...currentSession.entries].reverse() : [];

        const entriesHtml = entries.length === 0
            ? '<tr><td colspan="5" class="empty">No entries yet. Use "Count Selection" or "Add Manual Entry" to start tracking.</td></tr>'
            : entries.map(e => `
                <tr>
                    <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
                    <td><span class="badge badge-${e.provider}">${e.provider}</span></td>
                    <td class="num">${e.inputTokens.toLocaleString()}</td>
                    <td class="num">${e.outputTokens.toLocaleString()}</td>
                    <td class="desc">${this.escapeHtml(e.description)}</td>
                </tr>
            `).join('');

        // Session history
        const sessionRows = [...sessions].reverse().map(s => `
            <tr>
                <td>${s.date}</td>
                <td class="num">${s.totalInput.toLocaleString()}</td>
                <td class="num">${s.totalOutput.toLocaleString()}</td>
                <td class="num">${(s.totalInput + s.totalOutput).toLocaleString()}</td>
                <td class="num">${s.entries.length}</td>
            </tr>
        `).join('');

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Token Counter</title>
    <style>
        :root {
            --bg-primary: #0d1117;
            --bg-secondary: #161b22;
            --bg-tertiary: #21262d;
            --bg-card: rgba(22, 27, 34, 0.8);
            --border: #30363d;
            --text-primary: #e6edf3;
            --text-secondary: #8b949e;
            --accent-blue: #58a6ff;
            --accent-green: #3fb950;
            --accent-purple: #bc8cff;
            --accent-orange: #d29922;
            --accent-red: #f85149;
            --gradient-blue: linear-gradient(135deg, #1a73e8, #58a6ff);
            --gradient-green: linear-gradient(135deg, #238636, #3fb950);
            --gradient-purple: linear-gradient(135deg, #8957e5, #bc8cff);
            --shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            --glass: rgba(255, 255, 255, 0.05);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
            padding: 24px;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border);
        }

        .header h1 {
            font-size: 24px;
            font-weight: 600;
            background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .header-actions {
            display: flex;
            gap: 8px;
        }

        .btn {
            padding: 6px 14px;
            border-radius: 6px;
            border: 1px solid var(--border);
            background: var(--bg-tertiary);
            color: var(--text-primary);
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
        }

        .btn:hover { background: var(--border); }

        .btn-danger {
            border-color: var(--accent-red);
            color: var(--accent-red);
        }

        .btn-danger:hover {
            background: rgba(248, 81, 73, 0.15);
        }

        .btn-primary {
            background: var(--gradient-blue);
            border: none;
            color: white;
        }

        .btn-primary:hover { opacity: 0.9; }

        /* Summary Cards */
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .card {
            background: var(--bg-card);
            backdrop-filter: blur(10px);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            box-shadow: var(--shadow);
            position: relative;
            overflow: hidden;
        }

        .card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            border-radius: 12px 12px 0 0;
        }

        .card.input::before { background: var(--gradient-blue); }
        .card.output::before { background: var(--gradient-green); }
        .card.total::before { background: var(--gradient-purple); }
        .card.alltime::before { background: linear-gradient(135deg, var(--accent-orange), #f0883e); }
        .card.quota::before { background: linear-gradient(135deg, #00b4d8, #90e0ef); }

        .card-label {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }

        .card-value {
            font-size: 32px;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
        }

        .card.input .card-value { color: var(--accent-blue); }
        .card.output .card-value { color: var(--accent-green); }
        .card.total .card-value { color: var(--accent-purple); }
        .card.alltime .card-value { color: var(--accent-orange); }

        .card-sub {
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        /* Chart Section */
        .section {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 24px;
            box-shadow: var(--shadow);
        }

        .section h2 {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 16px;
            color: var(--text-primary);
        }

        .chart-container {
            position: relative;
            width: 100%;
            height: 250px;
        }

        /* Table */
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }

        th {
            text-align: left;
            padding: 10px 12px;
            border-bottom: 2px solid var(--border);
            color: var(--text-secondary);
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--border);
        }

        tr:hover td {
            background: var(--glass);
        }

        .num { text-align: right; font-variant-numeric: tabular-nums; }

        .desc {
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--text-secondary);
        }

        .empty {
            text-align: center;
            color: var(--text-secondary);
            padding: 24px !important;
            font-style: italic;
        }

        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 500;
        }

        .badge-manual { background: rgba(188, 140, 255, 0.2); color: var(--accent-purple); }
        .badge-selection { background: rgba(88, 166, 255, 0.2); color: var(--accent-blue); }
        .badge-copilot { background: rgba(63, 185, 80, 0.2); color: var(--accent-green); }
        .badge-antigravity { background: rgba(210, 153, 34, 0.2); color: var(--accent-orange); }

        /* Tabs */
        .tabs {
            display: flex;
            gap: 0;
            margin-bottom: 16px;
            border-bottom: 1px solid var(--border);
        }

        .tab {
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            color: var(--text-secondary);
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }

        .tab:hover { color: var(--text-primary); }

        .tab.active {
            color: var(--accent-blue);
            border-bottom-color: var(--accent-blue);
        }

            display: inline-flex;
            align-items: center;
            padding: 2px 7px;
            border-radius: 20px;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.2px;
        }
        .badge-manual    { background: var(--purple-dim); color: var(--purple); }
        .badge-selection { background: var(--blue-dim);   color: var(--blue); }
        .badge-copilot   { background: var(--green-dim);  color: var(--green); }
        .badge-antigravity { background: var(--amber-dim); color: var(--amber); }

        /* ── Conversion mini stats ── */
        .mini-stats {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 8px;
            margin-bottom: 14px;
        }
        .mini-stat {
            background: var(--bg-4);
            border-radius: var(--radius-sm);
            padding: 10px 12px;
            text-align: center;
        }
        .mini-stat-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-3);
            margin-bottom: 4px;
        }
        .mini-stat-value {
            font-size: 18px;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
        }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border-bright); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

        /* ── Animations ── */
        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(8px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .quota-card { animation: fadeUp 0.25s ease both; }
        .stats-row  { animation: fadeUp 0.3s 0.05s ease both; }
        .section    { animation: fadeUp 0.3s 0.1s ease both; }
    </style>
</head>
<body>
<div class="app">

    <!-- Topbar -->
    <div class="topbar">
        <div class="logo">
            <span class="logo-icon">⚡</span>
            AI Token Counter
        </div>
        <div class="topbar-right">
            <button class="btn btn-primary" onclick="exportData()">↑ Export</button>
            <button class="btn" onclick="resetSession()">↺ Reset Session</button>
            <button class="btn btn-danger" onclick="resetAll()">✕ Reset All</button>
        </div>
    </div>

    <div class="content">

        <!-- Quota Card -->
        ${(() => {
            const getModelColor = (label: string): string => {
                const l = label.toLowerCase();
                if (l.includes('flash') || l.includes('gemini 3.5')) { return '#34d399'; }
                if (l.includes('gemini')) { return '#4f8ef7'; }
                if (l.includes('claude sonnet')) { return '#f59e0b'; }
                if (l.includes('claude opus')) { return '#a78bfa'; }
                if (l.includes('claude')) { return '#f59e0b'; }
                if (l.includes('gpt') || l.includes('openai')) { return '#22d3ee'; }
                return '#8892a4';
            };

            if (quotaData && quotaData.models.length > 0) {
                const fetchedAgo = Math.round((Date.now() - quotaData.fetchedAt) / 1000);
                const agoStr = fetchedAgo < 60 ? `${fetchedAgo}s ago` : `${Math.round(fetchedAgo/60)}m ago`;
                const modelBars = quotaData.models.map(m => {
                    const usedPct = (1 - Math.max(0, Math.min(1, m.remainingFraction))) * 100;
                    const color = getModelColor(m.label);
                    const barColor = usedPct >= 85 ? '#f87171' : usedPct >= 60 ? '#fbbf24' : color;
                    const resetDate = new Date(m.resetTime);
                    const resetStr = resetDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                    const pctStr = usedPct < 0.1 ? '0' : usedPct.toFixed(usedPct < 1 ? 1 : 0);
                    return `
                    <div class="quota-row">
                        <div class="quota-model" title="${m.label}">${m.label}</div>
                        <div class="quota-bar-wrap">
                            <div class="quota-bar-fill" style="width:${usedPct}%;background:${barColor};"></div>
                        </div>
                        <div class="quota-pct" style="color:${barColor};">${pctStr}%<span style="color:var(--text-3);font-size:9px;font-weight:400;"> used</span></div>
                    </div>`;
                }).join('');
                return `
        <div class="quota-card">
            <div class="quota-header">
                <span class="quota-title">⚡ Quota Thực Tế — Antigravity</span>
                <span class="quota-badge">Live · ${agoStr}</span>
            </div>
            <div class="quota-grid">${modelBars}</div>
        </div>`;

            } else if (todayLog && todayLog.events > 0) {
                const tokens = todayLog.tokens;
                const LIMITS = [
                    { name: 'Gemini 2.5 Pro', limit: 1_048_576, color: '#4f8ef7' },
                    { name: 'Claude Sonnet',  limit: 200_000,   color: '#f59e0b' },
                    { name: 'GPT-4o',         limit: 128_000,   color: '#22d3ee' },
                ];
                const modelBars = LIMITS.map(m => {
                    const pct = Math.min(100, (tokens / m.limit) * 100);
                    const limitStr = m.limit >= 1_000_000 ? `${(m.limit/1_000_000).toFixed(1)}M` : `${(m.limit/1_000).toFixed(0)}K`;
                    return `
                    <div class="quota-row">
                        <div class="quota-model">${m.name}</div>
                        <div class="quota-bar-wrap">
                            <div class="quota-bar-fill" style="width:${pct}%;background:${m.color};"></div>
                        </div>
                        <div class="quota-pct" style="color:${m.color};">${pct.toFixed(pct<1?2:1)}%<span style="color:var(--text-3);font-size:9px;font-weight:400;">/${limitStr}</span></div>
                    </div>`;
                }).join('');
                return `
        <div class="quota-card">
            <div class="quota-header">
                <span class="quota-title">📡 Token Hôm Nay (ước tính)</span>
                <span class="quota-badge">${formatTokenCount(tokens)} · ${todayLog.events} events</span>
            </div>
            <div class="quota-grid">${modelBars}</div>
        </div>`;
            } else {
                return `
        <div class="quota-card" style="opacity:0.5;">
            <div class="quota-header">
                <span class="quota-title">📡 Quota</span>
            </div>
            <div class="quota-empty">Đang tải dữ liệu quota từ Antigravity API...</div>
        </div>`;
            }
        })()}

        <!-- Stats row -->
        <div class="stats-row">
            ${pbData ? `
            <div class="stat-card pb-card">
                <div class="pb-icon">🔤</div>
                <div>
                    <div class="stat-label">Auto-Track (PB phiên này)</div>
                    <div class="stat-value" style="color:var(--purple);font-size:22px;">+${pbData.totalDeltaKB.toFixed(1)} KB</div>
                    <div class="stat-sub">~${formatTokenCount(pbData.totalEstimatedTokens)} tokens · ${pbData.activeConversations} conv.</div>
                </div>
            </div>` : ''}
            <div class="stat-card blue">
                <div class="stat-label">↑ Input Today</div>
                <div class="stat-value">${formatTokenCount(currentTotals.input)}</div>
                <div class="stat-sub">${currentTotals.input.toLocaleString()} tokens</div>
            </div>
            <div class="stat-card green">
                <div class="stat-label">↓ Output Today</div>
                <div class="stat-value">${formatTokenCount(currentTotals.output)}</div>
                <div class="stat-sub">${currentTotals.output.toLocaleString()} tokens</div>
            </div>
            <div class="stat-card purple">
                <div class="stat-label">∑ Total Today</div>
                <div class="stat-value">${formatTokenCount(currentTotals.total)}</div>
                <div class="stat-sub">${currentTotals.total.toLocaleString()} tokens</div>
            </div>
            <div class="stat-card amber">
                <div class="stat-label">🏆 All Time</div>
                <div class="stat-value">${formatTokenCount(allTimeTotals.total)}</div>
                <div class="stat-sub">${allTimeTotals.input.toLocaleString()} ↑ / ${allTimeTotals.output.toLocaleString()} ↓</div>
            </div>
        </div>

        <!-- Chart -->
        <div class="section">
            <div class="section-header">
                <span class="section-title">Token Usage</span>
                <span class="section-badge">Last 14 days</span>
            </div>
            <div class="chart-wrap">
                <canvas id="usageChart"></canvas>
            </div>
        </div>

        <!-- Tabs -->
        <div class="section">
            <div class="tab-bar">
                <button class="tab active" onclick="switchTab('entries', this)">📝 Today's Entries</button>
                <button class="tab" onclick="switchTab('history', this)">📅 Session History</button>
                <button class="tab" onclick="switchTab('conversions', this)">📊 Conversion Log</button>
            </div>

            <div id="tab-entries" class="tab-pane active">
                <div class="tbl-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>Provider</th>
                                <th class="num">Input</th>
                                <th class="num">Output</th>
                                <th>Description</th>
                            </tr>
                        </thead>
                        <tbody>${entriesHtml}</tbody>
                    </table>
                </div>
            </div>

            <div id="tab-history" class="tab-pane">
                <div class="tbl-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th class="num">Input</th>
                                <th class="num">Output</th>
                                <th class="num">Total</th>
                                <th class="num">Entries</th>
                            </tr>
                        </thead>
                        <tbody>${sessionRows || '<tr><td colspan="5" class="empty">No session history yet.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>

            <div id="tab-conversions" class="tab-pane">
                ${conversionStats && conversionStats.totalEvents > 0 ? `
                <div class="mini-stats">
                    <div class="mini-stat">
                        <div class="mini-stat-label">Events</div>
                        <div class="mini-stat-value" style="color:var(--blue);">${conversionStats.totalEvents}</div>
                    </div>
                    <div class="mini-stat">
                        <div class="mini-stat-label">ΔKB</div>
                        <div class="mini-stat-value" style="color:var(--green);">${conversionStats.totalDeltaKB.toFixed(1)}</div>
                    </div>
                    <div class="mini-stat">
                        <div class="mini-stat-label">Tokens</div>
                        <div class="mini-stat-value" style="color:var(--purple);font-size:15px;">${conversionStats.totalEstimatedTokens.toLocaleString()}</div>
                    </div>
                    <div class="mini-stat">
                        <div class="mini-stat-label">Avg KB/ev</div>
                        <div class="mini-stat-value" style="color:var(--amber);">${conversionStats.avgDeltaKBPerEvent.toFixed(1)}</div>
                    </div>
                    <div class="mini-stat">
                        <div class="mini-stat-label">Conv.</div>
                        <div class="mini-stat-value">${conversionStats.uniqueConversations}</div>
                    </div>
                </div>` : ''}
                <div class="tbl-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>Conv. ID</th>
                                <th class="num">ΔKB</th>
                                <th class="num">Est. Tokens</th>
                                <th class="num">Tok/KB</th>
                                <th class="num">PB Total KB</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${conversionEntries.length === 0
                                ? '<tr><td colspan="6" class="empty">No conversion events yet.</td></tr>'
                                : [...conversionEntries].reverse().map(e => `
                                <tr>
                                    <td>${new Date(e.ts).toLocaleTimeString()}</td>
                                    <td><span class="badge badge-antigravity">${e.convId.substring(0, 8)}…</span></td>
                                    <td class="num">+${e.deltaKB.toFixed(1)}</td>
                                    <td class="num">${e.estimatedTokens.toLocaleString()}</td>
                                    <td class="num">${e.tokensPerKB}</td>
                                    <td class="num">${e.pbTotalKB.toFixed(1)}</td>
                                </tr>`).join('')
                            }
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

    </div><!-- /content -->
</div><!-- /app -->

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
    const vscode = acquireVsCodeApi();

    function switchTab(name, el) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        document.getElementById('tab-' + name).classList.add('active');
    }

    function resetSession() { vscode.postMessage({ command: 'resetSession' }); }
    function resetAll()     { vscode.postMessage({ command: 'resetAll' }); }
    function exportData()   { vscode.postMessage({ command: 'export' }); }

    // Chart
    const ctx = document.getElementById('usageChart');
    if (ctx) {
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ${chartLabels},
                datasets: [
                    {
                        label: 'Input',
                        data: ${chartInputData},
                        backgroundColor: 'rgba(79,142,247,0.5)',
                        borderColor: 'rgba(79,142,247,0.9)',
                        borderWidth: 1,
                        borderRadius: 3,
                    },
                    {
                        label: 'Output',
                        data: ${chartOutputData},
                        backgroundColor: 'rgba(52,211,153,0.5)',
                        borderColor: 'rgba(52,211,153,0.9)',
                        borderWidth: 1,
                        borderRadius: 3,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: '#8892a4', font: { size: 11 }, boxWidth: 10 } }
                },
                scales: {
                    x: {
                        stacked: true,
                        ticks: { color: '#4a5568', font: { size: 10 } },
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        border: { color: 'rgba(255,255,255,0.06)' }
                    },
                    y: {
                        stacked: true,
                        ticks: { color: '#4a5568', font: { size: 10 } },
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        border: { color: 'rgba(255,255,255,0.06)' }
                    }
                }
            }
        });
    }
</script>
</body>
</html>`;
    }

    private getLast14DaysData(sessions: TokenSession[]): Array<{ label: string; input: number; output: number }> {
        const result: Array<{ label: string; input: number; output: number }> = [];
        const today = new Date();

        for (let i = 13; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().slice(0, 10);
            const session = sessions.find(s => s.date === dateStr);

            result.push({
                label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                input: session?.totalInput || 0,
                output: session?.totalOutput || 0,
            });
        }

        return result;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    public dispose(): void {
        DashboardPanel.currentPanel = undefined;
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
