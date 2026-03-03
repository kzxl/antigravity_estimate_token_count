import * as vscode from 'vscode';
import { SessionManager, TokenSession } from './sessionManager';
import { formatTokenCount } from './tokenizer';
import { PbWatcher } from './pbWatcher';

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
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel.panel.reveal(column);
            DashboardPanel.currentPanel.updateContent(sessionManager, pbWatcher);
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

        DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, sessionManager, pbWatcher);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sessionManager: SessionManager,
        pbWatcher?: PbWatcher,
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.updateContent(sessionManager, pbWatcher);

        // Listen for data changes
        this.disposables.push(
            sessionManager.onDidChange(() => this.updateContent(sessionManager, pbWatcher))
        );

        // Listen for PB tracking updates
        if (pbWatcher) {
            this.disposables.push(
                pbWatcher.onTrackingUpdate(() => this.updateContent(sessionManager, pbWatcher))
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

    private updateContent(sessionManager: SessionManager, pbWatcher?: PbWatcher): void {
        const sessions = sessionManager.getAllSessions();
        const currentTotals = sessionManager.getCurrentTotals();
        const allTimeTotals = sessionManager.getAllTimeTotals();
        const pbData = pbWatcher?.getTrackingData();

        this.panel.webview.html = this.getHtmlContent(sessions, currentTotals, allTimeTotals, pbData);
    }

    private getHtmlContent(
        sessions: TokenSession[],
        currentTotals: { input: number; output: number; total: number },
        allTimeTotals: { input: number; output: number; total: number },
        pbData?: { totalDeltaKB: number; totalEstimatedTokens: number; activeConversations: number; lastUpdate: number },
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

        .tab-content { display: none; }
        .tab-content.active { display: block; }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: var(--bg-primary); }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--text-secondary); }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .card, .section {
            animation: fadeIn 0.3s ease-out;
        }

        .card:nth-child(2) { animation-delay: 0.05s; }
        .card:nth-child(3) { animation-delay: 0.1s; }
        .card:nth-child(4) { animation-delay: 0.15s; }
    </style>
</head>
<body>
    <div class="header">
        <h1>⚡ AI Token Counter</h1>
        <div class="header-actions">
            <button class="btn btn-primary" onclick="exportData()">📤 Export</button>
            <button class="btn" onclick="resetSession()">🔄 Reset Session</button>
            <button class="btn btn-danger" onclick="resetAll()">🗑 Reset All</button>
        </div>
    </div>

    <div class="summary-grid">
        ${pbData ? `
        <div class="card total" style="grid-column: span 2;">
            <div class="card-label">🔤 Auto-Track (Antigravity PB)</div>
            <div class="card-value">+${pbData.totalDeltaKB.toFixed(1)} KB</div>
            <div class="card-sub">~${formatTokenCount(pbData.totalEstimatedTokens)} estimated tokens · ${pbData.activeConversations} conversation(s)</div>
        </div>
        ` : ''}
        <div class="card input">
            <div class="card-label">↑ Input (Sent Today)</div>
            <div class="card-value">${formatTokenCount(currentTotals.input)}</div>
            <div class="card-sub">${currentTotals.input.toLocaleString()} tokens</div>
        </div>
        <div class="card output">
            <div class="card-label">↓ Output (Received Today)</div>
            <div class="card-value">${formatTokenCount(currentTotals.output)}</div>
            <div class="card-sub">${currentTotals.output.toLocaleString()} tokens</div>
        </div>
        <div class="card total">
            <div class="card-label">📊 Total Today</div>
            <div class="card-value">${formatTokenCount(currentTotals.total)}</div>
            <div class="card-sub">${currentTotals.total.toLocaleString()} tokens</div>
        </div>
        <div class="card alltime">
            <div class="card-label">🏆 All Time</div>
            <div class="card-value">${formatTokenCount(allTimeTotals.total)}</div>
            <div class="card-sub">${allTimeTotals.input.toLocaleString()} ↑ / ${allTimeTotals.output.toLocaleString()} ↓</div>
        </div>
    </div>

    <div class="section">
        <h2>📈 Token Usage (Last 14 Days)</h2>
        <div class="chart-container">
            <canvas id="usageChart"></canvas>
        </div>
    </div>

    <div class="section">
        <div class="tabs">
            <div class="tab active" onclick="switchTab('entries')">📝 Today's Entries</div>
            <div class="tab" onclick="switchTab('history')">📅 Session History</div>
        </div>

        <div id="tab-entries" class="tab-content active">
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
                <tbody>
                    ${entriesHtml}
                </tbody>
            </table>
        </div>

        <div id="tab-history" class="tab-content">
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
                <tbody>
                    ${sessionRows || '<tr><td colspan="5" class="empty">No session history yet.</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script>
        const vscode = acquireVsCodeApi();

        // Tab switching
        function switchTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

            event.target.classList.add('active');
            document.getElementById('tab-' + tabName).classList.add('active');
        }

        // Actions
        function resetSession() { vscode.postMessage({ command: 'resetSession' }); }
        function resetAll() { vscode.postMessage({ command: 'resetAll' }); }
        function exportData() { vscode.postMessage({ command: 'export' }); }

        // Chart
        const ctx = document.getElementById('usageChart');
        if (ctx) {
            new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ${chartLabels},
                    datasets: [
                        {
                            label: 'Input Tokens',
                            data: ${chartInputData},
                            backgroundColor: 'rgba(88, 166, 255, 0.6)',
                            borderColor: 'rgba(88, 166, 255, 1)',
                            borderWidth: 1,
                            borderRadius: 4,
                        },
                        {
                            label: 'Output Tokens',
                            data: ${chartOutputData},
                            backgroundColor: 'rgba(63, 185, 80, 0.6)',
                            borderColor: 'rgba(63, 185, 80, 1)',
                            borderWidth: 1,
                            borderRadius: 4,
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: { color: '#8b949e', font: { size: 12 } }
                        }
                    },
                    scales: {
                        x: {
                            stacked: true,
                            ticks: { color: '#8b949e' },
                            grid: { color: 'rgba(48, 54, 61, 0.5)' }
                        },
                        y: {
                            stacked: true,
                            ticks: { color: '#8b949e' },
                            grid: { color: 'rgba(48, 54, 61, 0.5)' }
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
