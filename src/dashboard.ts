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
    private isHtmlInitialized = false;

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

        // Prepare chart data (last 14 days)
        const last14Days = this.getLast14DaysData(sessions);
        const chartLabels = last14Days.map(d => d.label);
        const chartInputData = last14Days.map(d => d.input);
        const chartOutputData = last14Days.map(d => d.output);

        // Current session entries (latest first)
        const currentSession = sessions.find(s => s.date === new Date().toISOString().slice(0, 10));
        const entries = currentSession ? [...currentSession.entries].reverse() : [];

        // Render fragments
        const quotaCardHtml = this.renderQuotaCard(quotaData, todayLog);
        const statsRowHtml = this.renderStatsRow(pbData, currentTotals, allTimeTotals);
        const entriesTbodyHtml = this.renderEntries(entries);
        const historyTbodyHtml = this.renderHistory(sessions);
        const conversionsHtml = this.renderConversions(conversionEntries, conversionStats);

        if (!this.isHtmlInitialized) {
            this.panel.webview.html = this.getHtmlContent(
                quotaCardHtml,
                statsRowHtml,
                entriesTbodyHtml,
                historyTbodyHtml,
                conversionsHtml,
                chartLabels,
                chartInputData,
                chartOutputData
            );
            this.isHtmlInitialized = true;
        } else {
            this.panel.webview.postMessage({
                command: 'update',
                quotaCardHtml,
                statsRowHtml,
                entriesTbodyHtml,
                historyTbodyHtml,
                conversionsHtml,
                chartLabels,
                chartInputData,
                chartOutputData
            });
        }
    }

    private getModelColor(label: string): string {
        const l = label.toLowerCase();
        if (l.includes('flash') || l.includes('gemini 3.5')) { return '#34d399'; }
        if (l.includes('gemini')) { return '#4f8ef7'; }
        if (l.includes('claude sonnet') || l.includes('claude 3.5')) { return '#f59e0b'; }
        if (l.includes('claude opus')) { return '#a78bfa'; }
        if (l.includes('claude')) { return '#f59e0b'; }
        if (l.includes('gpt') || l.includes('openai')) { return '#22d3ee'; }
        return '#8892a4';
    }

    private renderQuotaCard(quotaData?: QuotaData, todayLog?: { tokens: number; events: number; deltaKB: number }): string {
        if (quotaData && quotaData.models.length > 0) {
            const fetchedAgo = Math.round((Date.now() - quotaData.fetchedAt) / 1000);
            const agoStr = fetchedAgo < 60 ? `${fetchedAgo}s ago` : `${Math.round(fetchedAgo/60)}m ago`;
            const modelBars = quotaData.models.map(m => {
                const usedPct = (1 - Math.max(0, Math.min(1, m.remainingFraction))) * 100;
                const color = this.getModelColor(m.label);
                const barColor = usedPct >= 85 ? '#f87171' : usedPct >= 60 ? '#fbbf24' : color;
                const resetDate = new Date(m.resetTime);
                const resetStr = resetDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                const pctStr = usedPct < 0.1 ? '0' : usedPct.toFixed(usedPct < 1 ? 1 : 0);
                const remainPct = Math.round(m.remainingFraction * 100);
                return `
                <div class="quota-row" title="${m.label} — ${pctStr}% used, ${remainPct}% remaining, reset at ${resetStr}">
                    <div class="quota-model">${m.label}</div>
                    <div class="quota-bar-wrap">
                        <div class="quota-bar-fill" style="width:${usedPct}%;background:${barColor};"></div>
                    </div>
                    <div class="quota-pct" style="color:${barColor};">${pctStr}%<span style="color:var(--text-3);font-size:9px;font-weight:400;"> used</span></div>
                </div>`;
            }).join('');
            return `
            <div class="quota-card">
                <div class="quota-header">
                    <span class="quota-title">⚡ Live Quota — Antigravity</span>
                    <span class="quota-badge">Live · ${agoStr}</span>
                </div>
                <div class="quota-grid">${modelBars}</div>
            </div>`;

        } else if (todayLog && todayLog.events > 0) {
            const tokens = todayLog.tokens;
            const LIMITS = [
                { name: 'Gemini 3.5 Flash', limit: 1_048_576, color: '#34d399' },
                { name: 'Claude 3.5 Sonnet', limit: 200_000,   color: '#f59e0b' },
                { name: 'GPT-4o',           limit: 128_000,   color: '#22d3ee' },
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
                    <span class="quota-title">📡 Today's Estimated Tokens</span>
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
                <div class="quota-empty">Loading quota data from Antigravity API...</div>
            </div>`;
        }
    }

    private renderStatsRow(
        pbData?: { totalDeltaKB: number; totalEstimatedTokens: number; activeConversations: number; lastUpdate: number },
        currentTotals?: { input: number; output: number; total: number },
        allTimeTotals?: { input: number; output: number; total: number }
    ): string {
        const pbHtml = pbData ? `
        <div class="stat-card pb-card">
            <div class="pb-icon">🔤</div>
            <div>
                <div class="stat-label">Auto-Track (This Session)</div>
                <div class="stat-value" style="color:var(--purple);font-size:22px;">+${pbData.totalDeltaKB.toFixed(1)} KB</div>
                <div class="stat-sub">~${formatTokenCount(pbData.totalEstimatedTokens)} tokens · ${pbData.activeConversations} conv.</div>
            </div>
        </div>` : '';

        const inputVal = currentTotals ? formatTokenCount(currentTotals.input) : '0';
        const inputSub = currentTotals ? currentTotals.input.toLocaleString() : '0';
        const outputVal = currentTotals ? formatTokenCount(currentTotals.output) : '0';
        const outputSub = currentTotals ? currentTotals.output.toLocaleString() : '0';
        const totalVal = currentTotals ? formatTokenCount(currentTotals.total) : '0';
        const totalSub = currentTotals ? currentTotals.total.toLocaleString() : '0';
        const allTimeVal = allTimeTotals ? formatTokenCount(allTimeTotals.total) : '0';
        const allTimeSub = allTimeTotals ? `${allTimeTotals.input.toLocaleString()} ↑ / ${allTimeTotals.output.toLocaleString()} ↓` : '0 ↑ / 0 ↓';

        return `
        ${pbHtml}
        <div class="stat-card blue">
            <div class="stat-label">↑ Input Today</div>
            <div class="stat-value">${inputVal}</div>
            <div class="stat-sub">${inputSub} tokens</div>
        </div>
        <div class="stat-card green">
            <div class="stat-label">↓ Output Today</div>
            <div class="stat-value">${outputVal}</div>
            <div class="stat-sub">${outputSub} tokens</div>
        </div>
        <div class="stat-card purple">
            <div class="stat-label">∑ Total Today</div>
            <div class="stat-value">${totalVal}</div>
            <div class="stat-sub">${totalSub} tokens</div>
        </div>
        <div class="stat-card amber">
            <div class="stat-label">🏆 All Time</div>
            <div class="stat-value">${allTimeVal}</div>
            <div class="stat-sub">${allTimeSub}</div>
        </div>`;
    }

    private renderEntries(entries: any[]): string {
        if (entries.length === 0) {
            return '<tr><td colspan="5" class="empty">No entries yet. Use "Count Selection" or "Add Manual Entry" to start tracking.</td></tr>';
        }
        return entries.map(e => `
            <tr>
                <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
                <td><span class="badge badge-${e.provider}">${e.provider}</span></td>
                <td class="num">${e.inputTokens.toLocaleString()}</td>
                <td class="num">${e.outputTokens.toLocaleString()}</td>
                <td class="desc">${this.escapeHtml(e.description)}</td>
            </tr>
        `).join('');
    }

    private renderHistory(sessions: TokenSession[]): string {
        const rows = [...sessions].reverse().map(s => `
            <tr>
                <td>${s.date}</td>
                <td class="num">${s.totalInput.toLocaleString()}</td>
                <td class="num">${s.totalOutput.toLocaleString()}</td>
                <td class="num">${(s.totalInput + s.totalOutput).toLocaleString()}</td>
                <td class="num">${s.entries.length}</td>
            </tr>
        `).join('');
        return rows || '<tr><td colspan="5" class="empty">No session history yet.</td></tr>';
    }

    private renderConversions(conversionEntries: ConversionLogEntry[] = [], conversionStats?: ConversionStats): string {
        const statsHtml = conversionStats && conversionStats.totalEvents > 0 ? `
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
        </div>` : '';

        const tableBody = conversionEntries.length === 0
            ? '<tr><td colspan="6" class="empty">No conversion events yet.</td></tr>'
            : [...conversionEntries].reverse().map(e => `
            <tr>
                <td>${new Date(e.ts).toLocaleTimeString()}</td>
                <td><span class="badge badge-antigravity">${e.convId.substring(0, 8)}…</span></td>
                <td class="num">+${e.deltaKB.toFixed(1)}</td>
                <td class="num">${e.estimatedTokens.toLocaleString()}</td>
                <td class="num">${e.tokensPerKB}</td>
                <td class="num">${e.pbTotalKB.toFixed(1)}</td>
            </tr>`).join('');

        return `
        ${statsHtml}
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
                    ${tableBody}
                </tbody>
            </table>
        </div>`;
    }

        private getHtmlContent(
        quotaCardHtml: string,
        statsRowHtml: string,
        entriesTbodyHtml: string,
        historyTbodyHtml: string,
        conversionsHtml: string,
        chartLabels: string[],
        chartInputData: number[],
        chartOutputData: number[]
    ): string {
        const chartLabelsStr = JSON.stringify(chartLabels);
        const chartInputDataStr = JSON.stringify(chartInputData);
        const chartOutputDataStr = JSON.stringify(chartOutputData);

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Token Counter</title>
    <style>
        /* ── Design System ─────────────────────────────────────────── */
        :root {
            --bg-1:   #0d1117;
            --bg-2:   #161b22;
            --bg-3:   #1c2128;
            --bg-4:   #21262d;
            --border: #30363d;
            --border-bright: #444c56;

            --text-1: #e6edf3;
            --text-2: #adbac7;
            --text-3: #768390;

            --blue:   #58a6ff;
            --green:  #3fb950;
            --purple: #bc8cff;
            --amber:  #e3b341;
            --red:    #f85149;

            --blue-dim:   rgba(88, 166, 255, 0.15);
            --green-dim:  rgba(63, 185, 80, 0.15);
            --purple-dim: rgba(188, 140, 255, 0.15);
            --amber-dim:  rgba(227, 179, 65, 0.15);
            --red-dim:    rgba(248, 81, 73, 0.15);

            --radius:    10px;
            --radius-sm: 6px;
            --shadow:    0 4px 24px rgba(0,0,0,0.4);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--bg-1);
            color: var(--text-1);
            font-size: 13px;
            line-height: 1.5;
        }

        /* ── Layout ── */
        .app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 20px;
            background: var(--bg-2);
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
        }

        .logo {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
            font-size: 14px;
            color: var(--text-1);
        }

        .logo-icon { font-size: 18px; }

        .topbar-right { display: flex; gap: 6px; align-items: center; }

        .content {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
            display: flex;
            flex-direction: column;
            gap: 14px;
        }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border-bright); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

        /* ── Buttons ── */
        .btn {
            padding: 5px 12px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border-bright);
            background: var(--bg-4);
            color: var(--text-2);
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.15s;
            white-space: nowrap;
        }
        .btn:hover { background: var(--bg-3); color: var(--text-1); border-color: var(--text-3); }
        .btn-primary { background: var(--blue); border-color: var(--blue); color: #fff; }
        .btn-primary:hover { opacity: 0.85; }
        .btn-danger { border-color: var(--red); color: var(--red); }
        .btn-danger:hover { background: var(--red-dim); }

        /* ── Quota Card ── */
        .quota-card {
            background: var(--bg-2);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 14px 16px;
            animation: fadeUp 0.25s ease both;
        }

        .quota-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
        }

        .quota-title {
            font-weight: 600;
            font-size: 13px;
            color: var(--text-1);
        }

        .quota-badge {
            font-size: 10px;
            color: var(--text-3);
            background: var(--bg-4);
            padding: 2px 8px;
            border-radius: 20px;
            border: 1px solid var(--border);
        }

        .quota-grid { display: flex; flex-direction: column; gap: 8px; }

        .quota-row {
            display: grid;
            grid-template-columns: 180px 1fr 64px;
            align-items: center;
            gap: 10px;
        }

        .quota-model {
            font-size: 12px;
            color: var(--text-2);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .quota-bar-wrap {
            height: 6px;
            background: var(--bg-4);
            border-radius: 3px;
            overflow: hidden;
            border: 1px solid var(--border);
        }

        .quota-bar-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.4s ease;
        }

        .quota-pct {
            font-size: 11px;
            font-weight: 700;
            text-align: right;
            font-variant-numeric: tabular-nums;
        }

        .quota-pct span { font-weight: 400; }

        .quota-empty {
            color: var(--text-3);
            font-size: 12px;
            text-align: center;
            padding: 8px 0;
        }

        /* ── Stats Row ── */
        .stats-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
            gap: 10px;
            animation: fadeUp 0.3s 0.05s ease both;
        }

        .stat-card {
            background: var(--bg-2);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 14px 16px;
            position: relative;
            overflow: hidden;
        }

        .stat-card::after {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 2px;
        }

        .stat-card.blue::after   { background: linear-gradient(90deg, #1a73e8, var(--blue)); }
        .stat-card.green::after  { background: linear-gradient(90deg, #1a8f43, var(--green)); }
        .stat-card.purple::after { background: linear-gradient(90deg, #7a4bb5, var(--purple)); }
        .stat-card.amber::after  { background: linear-gradient(90deg, #b07c17, var(--amber)); }
        .stat-card.pb-card::after { background: linear-gradient(90deg, #7a4bb5, var(--purple)); }

        .stat-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-3);
            margin-bottom: 6px;
        }

        .stat-value {
            font-size: 24px;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
            line-height: 1.1;
        }

        .stat-card.blue   .stat-value { color: var(--blue); }
        .stat-card.green  .stat-value { color: var(--green); }
        .stat-card.purple .stat-value { color: var(--purple); }
        .stat-card.amber  .stat-value { color: var(--amber); }

        .stat-sub {
            font-size: 10px;
            color: var(--text-3);
            margin-top: 4px;
            font-variant-numeric: tabular-nums;
        }

        .pb-icon { font-size: 22px; margin-bottom: 6px; }

        /* ── Section ── */
        .section {
            background: var(--bg-2);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 14px 16px;
            animation: fadeUp 0.3s 0.1s ease both;
        }

        .section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
        }

        .section-title {
            font-weight: 600;
            font-size: 13px;
            color: var(--text-1);
        }

        .section-badge {
            font-size: 10px;
            color: var(--text-3);
            background: var(--bg-4);
            padding: 2px 8px;
            border-radius: 20px;
            border: 1px solid var(--border);
        }

        /* ── Chart ── */
        .chart-wrap { position: relative; height: 200px; }

        /* ── Tabs ── */
        .tab-bar {
            display: flex;
            border-bottom: 1px solid var(--border);
            margin-bottom: 12px;
        }

        .tab {
            padding: 7px 14px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            color: var(--text-3);
            border: none;
            background: none;
            border-bottom: 2px solid transparent;
            transition: all 0.15s;
            margin-bottom: -1px;
        }

        .tab:hover { color: var(--text-2); }
        .tab.active { color: var(--blue); border-bottom-color: var(--blue); }

        .tab-pane { display: none; }
        .tab-pane.active { display: block; }

        /* ── Table ── */
        .tbl-wrap { overflow-x: auto; }

        table { width: 100%; border-collapse: collapse; }

        th {
            text-align: left;
            padding: 8px 10px;
            border-bottom: 1px solid var(--border);
            color: var(--text-3);
            font-weight: 600;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            white-space: nowrap;
        }

        td {
            padding: 7px 10px;
            border-bottom: 1px solid var(--border);
            color: var(--text-2);
        }

        tr:last-child td { border-bottom: none; }
        tr:hover td { background: rgba(255,255,255,0.025); }

        .num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-1); }

        .desc {
            max-width: 280px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--text-3);
        }

        .empty {
            text-align: center;
            color: var(--text-3);
            padding: 20px !important;
            font-style: italic;
        }

        /* ── Badge ── */
        .badge {
            display: inline-flex;
            align-items: center;
            padding: 2px 7px;
            border-radius: 20px;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.2px;
        }
        .badge-manual      { background: var(--purple-dim); color: var(--purple); }
        .badge-selection   { background: var(--blue-dim);   color: var(--blue); }
        .badge-copilot     { background: var(--green-dim);  color: var(--green); }
        .badge-antigravity { background: var(--amber-dim);  color: var(--amber); }

        /* ── Mini Stats (Conversion tab) ── */
        .mini-stats {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 8px;
            margin-bottom: 12px;
        }

        .mini-stat {
            background: var(--bg-4);
            border: 1px solid var(--border);
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
            color: var(--text-1);
        }

        /* ── Animations ── */
        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
        }
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

        <!-- Quota Card Container -->
        <div id="quota-card-container">
            ${quotaCardHtml}
        </div>

        <!-- Stats Row Container -->
        <div id="stats-row-container" class="stats-row">
            ${statsRowHtml}
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
                        <tbody id="entries-tbody">
                            ${entriesTbodyHtml}
                        </tbody>
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
                        <tbody id="history-tbody">
                            ${historyTbodyHtml}
                        </tbody>
                    </table>
                </div>
            </div>

            <div id="tab-conversions" class="tab-pane">
                <div id="conversions-container">
                    ${conversionsHtml}
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
        window.usageChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ${chartLabelsStr},
                datasets: [
                    {
                        label: 'Input',
                        data: ${chartInputDataStr},
                        backgroundColor: 'rgba(79,142,247,0.45)',
                        borderColor: 'rgba(79,142,247,0.85)',
                        borderWidth: 1,
                        borderRadius: 3,
                    },
                    {
                        label: 'Output',
                        data: ${chartOutputDataStr},
                        backgroundColor: 'rgba(52,211,153,0.45)',
                        borderColor: 'rgba(52,211,153,0.85)',
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
                    legend: { labels: { color: '#768390', font: { size: 11 }, boxWidth: 10 } }
                },
                scales: {
                    x: {
                        stacked: true,
                        ticks: { color: '#4a5568', font: { size: 10 } },
                        grid: { color: 'rgba(255,255,255,0.03)' },
                        border: { color: 'rgba(255,255,255,0.06)' }
                    },
                    y: {
                        stacked: true,
                        ticks: { color: '#4a5568', font: { size: 10 } },
                        grid: { color: 'rgba(255,255,255,0.03)' },
                        border: { color: 'rgba(255,255,255,0.06)' }
                    }
                }
            }
        });
    }

    // Handle incoming messages from the extension (Dynamic Updates)
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'update') {
            if (message.quotaCardHtml !== undefined) {
                const el = document.getElementById('quota-card-container');
                if (el) el.innerHTML = message.quotaCardHtml;
            }
            if (message.statsRowHtml !== undefined) {
                const el = document.getElementById('stats-row-container');
                if (el) el.innerHTML = message.statsRowHtml;
            }
            if (message.entriesTbodyHtml !== undefined) {
                const el = document.getElementById('entries-tbody');
                if (el) el.innerHTML = message.entriesTbodyHtml;
            }
            if (message.historyTbodyHtml !== undefined) {
                const el = document.getElementById('history-tbody');
                if (el) el.innerHTML = message.historyTbodyHtml;
            }
            if (message.conversionsHtml !== undefined) {
                const el = document.getElementById('conversions-container');
                if (el) el.innerHTML = message.conversionsHtml;
            }

            // Update Chart.js data smoothly
            if (window.usageChart && message.chartLabels && message.chartInputData && message.chartOutputData) {
                window.usageChart.data.labels = message.chartLabels;
                window.usageChart.data.datasets[0].data = message.chartInputData;
                window.usageChart.data.datasets[1].data = message.chartOutputData;
                window.usageChart.update();
            }
        }
    });
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
