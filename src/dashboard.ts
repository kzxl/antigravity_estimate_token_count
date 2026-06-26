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
        if (l.includes('flash') || l.includes('gemini 3.5')) { return 'linear-gradient(90deg, #10b981, #059669)'; } // Green/Emerald
        if (l.includes('gemini')) { return 'linear-gradient(90deg, #3b82f6, #1d4ed8)'; } // Blue
        if (l.includes('claude sonnet') || l.includes('claude 3.5')) { return 'linear-gradient(90deg, #f59e0b, #d97706)'; } // Amber/Orange
        if (l.includes('claude opus')) { return 'linear-gradient(90deg, #a855f7, #7e22ce)'; } // Purple
        if (l.includes('claude')) { return 'linear-gradient(90deg, #f59e0b, #d97706)'; }
        if (l.includes('gpt') || l.includes('openai')) { return 'linear-gradient(90deg, #06b6d4, #0891b2)'; } // Cyan
        return 'linear-gradient(90deg, #6b7280, #4b5563)'; // Grey
    }

    private renderQuotaCard(quotaData?: QuotaData, todayLog?: { tokens: number; events: number; deltaKB: number }): string {
        if (quotaData && quotaData.models.length > 0) {
            const fetchedAgo = Math.round((Date.now() - quotaData.fetchedAt) / 1000);
            const agoStr = fetchedAgo < 60 ? `${fetchedAgo}s ago` : `${Math.round(fetchedAgo/60)}m ago`;
            const modelBars = quotaData.models.map(m => {
                const usedPct = (1 - Math.max(0, Math.min(1, m.remainingFraction))) * 100;
                const gradient = this.getModelColor(m.label);
                const isWarning = usedPct >= 85;
                const isMild = usedPct >= 60 && usedPct < 85;
                const barColor = isWarning ? 'linear-gradient(90deg, #ef4444, #b91c1c)' : isMild ? 'linear-gradient(90deg, #f59e0b, #b45309)' : gradient;
                const textColor = isWarning ? '#ef4444' : isMild ? '#fbbf24' : '#58a6ff';
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
                    <div class="quota-pct" style="color:${textColor};">${pctStr}%<span style="color:var(--text-3);font-size:9px;font-weight:400;"> used</span></div>
                </div>`;
            }).join('');
            return `
            <div class="quota-card">
                <div class="quota-header">
                    <span class="quota-title">
                        <svg class="header-icon animate-pulse" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        Live Quota — Antigravity
                    </span>
                    <span class="quota-badge">Live · ${agoStr}</span>
                </div>
                <div class="quota-grid">${modelBars}</div>
            </div>`;

        } else if (todayLog && todayLog.events > 0) {
            const tokens = todayLog.tokens;
            const config = vscode.workspace.getConfiguration('tokenCount');
            const dailyLimit = config.get<number>('dailyTokenLimit', 1000000);
            
            const pct = Math.min(100, (tokens / dailyLimit) * 100);
            const limitStr = formatTokenCount(dailyLimit);
            const barColor = pct >= 90 ? 'linear-gradient(90deg, #ef4444, #b91c1c)' : pct >= 70 ? 'linear-gradient(90deg, #f59e0b, #d97706)' : 'linear-gradient(90deg, #10b981, #059669)';
            const textColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#fbbf24' : '#adbac7';

            const modelBars = `
            <div class="quota-row">
                <div class="quota-model">Today's Usage</div>
                <div class="quota-bar-wrap">
                    <div class="quota-bar-fill" style="width:${pct}%;background:${barColor};"></div>
                </div>
                <div class="quota-pct" style="color:${textColor};">${pct.toFixed(pct < 1 ? 2 : 1)}%<span style="color:var(--text-3);font-size:9px;font-weight:400;">/${limitStr}</span></div>
            </div>`;

            return `
            <div class="quota-card">
                <div class="quota-header">
                    <span class="quota-title">
                        <svg class="header-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.58 16.14a7 7 0 0 1 6.84 0M12 20h.01"/></svg>
                        Today's Estimated Tokens
                    </span>
                    <span class="quota-badge">${formatTokenCount(tokens)} · ${todayLog.events} events</span>
                </div>
                <div class="quota-grid">${modelBars}</div>
            </div>`;
        } else {
            return `
            <div class="quota-card" style="opacity:0.6;">
                <div class="quota-header">
                    <span class="quota-title">
                        <svg class="header-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.58 16.14a7 7 0 0 1 6.84 0M12 20h.01"/></svg>
                        Quota
                    </span>
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
            <div class="stat-icon-wrap" style="background: var(--purple-dim); color: var(--purple);">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            </div>
            <div class="stat-content">
                <div class="stat-label">Auto-Track (This Session)</div>
                <div class="stat-value" style="color: var(--purple);">+${pbData.totalDeltaKB.toFixed(1)} KB</div>
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
            <div class="stat-icon-wrap" style="background: var(--blue-dim); color: var(--blue);">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
            </div>
            <div class="stat-content">
                <div class="stat-label">Input Today</div>
                <div class="stat-value">${inputVal}</div>
                <div class="stat-sub">${inputSub} tokens</div>
            </div>
        </div>
        <div class="stat-card green">
            <div class="stat-icon-wrap" style="background: var(--green-dim); color: var(--green);">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>
            </div>
            <div class="stat-content">
                <div class="stat-label">Output Today</div>
                <div class="stat-value">${outputVal}</div>
                <div class="stat-sub">${outputSub} tokens</div>
            </div>
        </div>
        <div class="stat-card purple">
            <div class="stat-icon-wrap" style="background: var(--purple-dim); color: var(--purple);">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"/></svg>
            </div>
            <div class="stat-content">
                <div class="stat-label">Total Today</div>
                <div class="stat-value">${totalVal}</div>
                <div class="stat-sub">${totalSub} tokens</div>
            </div>
        </div>
        <div class="stat-card amber">
            <div class="stat-icon-wrap" style="background: var(--amber-dim); color: var(--amber);">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.45 1-1 1H4v2h16v-2h-5c-.55 0-1-.45-1-1v-2.34M12 2a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4z"/></svg>
            </div>
            <div class="stat-content">
                <div class="stat-label">All Time</div>
                <div class="stat-value">${allTimeVal}</div>
                <div class="stat-sub">${allTimeSub}</div>
            </div>
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
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        /* ── Modern Premium Theme ─────────────────────────────────── */
        :root {
            --bg-base:    #07090e;
            --bg-panel:   rgba(18, 22, 33, 0.7);
            --bg-element: rgba(30, 37, 54, 0.5);
            --border-low: rgba(255, 255, 255, 0.04);
            --border-mid: rgba(255, 255, 255, 0.08);
            --border-glow: rgba(56, 139, 253, 0.15);

            --text-1: #f0f3f6;
            --text-2: #adbac7;
            --text-3: #768390;

            --blue:   #3b82f6;
            --green:  #10b981;
            --purple: #a855f7;
            --amber:  #f59e0b;
            --red:    #ef4444;

            --blue-dim:   rgba(59, 130, 246, 0.1);
            --green-dim:  rgba(16, 185, 129, 0.1);
            --purple-dim: rgba(168, 85, 247, 0.1);
            --amber-dim:  rgba(245, 158, 11, 0.1);
            --red-dim:    rgba(239, 68, 68, 0.1);

            --radius-lg: 12px;
            --radius-md: 8px;
            --radius-sm: 4px;
            --shadow:    0 8px 32px 0 rgba(0, 0, 0, 0.37);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--bg-base);
            color: var(--text-1);
            font-size: 13px;
            line-height: 1.6;
            overflow: hidden;
        }

        /* ── Glowing Background Spots ── */
        .bg-glow {
            position: fixed;
            width: 500px;
            height: 500px;
            border-radius: 50%;
            filter: blur(140px);
            opacity: 0.08;
            z-index: -1;
            pointer-events: none;
        }
        .bg-glow-1 {
            top: -150px;
            left: -100px;
            background: radial-gradient(circle, var(--blue) 0%, transparent 70%);
        }
        .bg-glow-2 {
            bottom: -150px;
            right: -100px;
            background: radial-gradient(circle, var(--purple) 0%, transparent 70%);
        }

        /* ── Layout ── */
        .app {
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
            position: relative;
        }

        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 24px;
            background: rgba(13, 17, 24, 0.85);
            backdrop-filter: blur(12px);
            border-bottom: 1px solid var(--border-low);
            z-index: 10;
        }

        .logo {
            display: flex;
            align-items: center;
            gap: 10px;
            font-weight: 700;
            font-size: 15px;
            letter-spacing: -0.2px;
            color: #fff;
            text-shadow: 0 0 10px rgba(59, 130, 246, 0.3);
        }

        .logo svg {
            color: var(--blue);
            filter: drop-shadow(0 0 4px var(--blue));
        }

        .topbar-right { display: flex; gap: 8px; align-items: center; }

        .content {
            flex: 1;
            overflow-y: auto;
            padding: 24px;
            display: flex;
            flex-direction: column;
            gap: 20px;
            z-index: 5;
        }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.2); }

        /* ── Buttons ── */
        .btn {
            padding: 6px 14px;
            border-radius: var(--radius-md);
            border: 1px solid var(--border-mid);
            background: var(--bg-element);
            color: var(--text-2);
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            white-space: nowrap;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .btn:hover {
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            border-color: rgba(255, 255, 255, 0.25);
            transform: translateY(-1px);
        }
        .btn-primary {
            background: linear-gradient(135deg, var(--blue) 0%, #2563eb 100%);
            border: none;
            color: #fff;
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
        }
        .btn-primary:hover {
            box-shadow: 0 6px 16px rgba(59, 130, 246, 0.35);
            transform: translateY(-1px);
            opacity: 0.95;
        }
        .btn-danger {
            border-color: rgba(239, 68, 68, 0.3);
            color: var(--red);
        }
        .btn-danger:hover {
            background: var(--red-dim);
            border-color: var(--red);
        }

        /* ── Cards & Panels (Glassmorphism) ── */
        .quota-card, .stat-card, .section {
            background: var(--bg-panel);
            border: 1px solid var(--border-low);
            border-radius: var(--radius-lg);
            padding: 20px;
            box-shadow: var(--shadow);
            backdrop-filter: blur(16px);
            transition: border-color 0.25s, box-shadow 0.25s;
        }
        
        .quota-card:hover, .section:hover {
            border-color: var(--border-glow);
        }

        /* ── Quota Card ── */
        .quota-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
        }

        .quota-title {
            font-weight: 700;
            font-size: 14px;
            color: #fff;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .header-icon {
            color: var(--blue);
            flex-shrink: 0;
        }

        .quota-badge {
            font-size: 11px;
            color: var(--text-2);
            background: var(--bg-element);
            padding: 3px 10px;
            border-radius: 20px;
            border: 1px solid var(--border-low);
            font-weight: 500;
        }

        .quota-grid { display: flex; flex-direction: column; gap: 10px; }

        .quota-row {
            display: grid;
            grid-template-columns: 180px 1fr 70px;
            align-items: center;
            gap: 14px;
            padding: 4px 0;
        }

        .quota-model {
            font-size: 12px;
            color: var(--text-2);
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .quota-bar-wrap {
            height: 8px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 10px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.02);
            box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
        }

        .quota-bar-fill {
            height: 100%;
            border-radius: 10px;
            transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .quota-pct {
            font-size: 12px;
            font-weight: 700;
            text-align: right;
            font-variant-numeric: tabular-nums;
        }

        .quota-pct span { font-weight: 500; }

        .quota-empty {
            color: var(--text-3);
            font-size: 12px;
            text-align: center;
            padding: 12px 0;
            font-style: italic;
        }

        /* ── Stats Grid & Cards ── */
        .stats-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 12px;
        }

        .stat-card {
            display: flex;
            gap: 14px;
            align-items: flex-start;
            transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.25s, box-shadow 0.25s;
        }

        .stat-card:hover {
            transform: translateY(-3px);
            border-color: rgba(255, 255, 255, 0.12);
            box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
        }

        .stat-card.blue:hover   { border-color: rgba(59, 130, 246, 0.35); box-shadow: 0 8px 24px rgba(59, 130, 246, 0.1); }
        .stat-card.green:hover  { border-color: rgba(16, 185, 129, 0.35); box-shadow: 0 8px 24px rgba(16, 185, 129, 0.1); }
        .stat-card.purple:hover { border-color: rgba(168, 85, 247, 0.35); box-shadow: 0 8px 24px rgba(168, 85, 247, 0.1); }
        .stat-card.amber:hover  { border-color: rgba(245, 158, 11, 0.35);  box-shadow: 0 8px 24px rgba(245, 158, 11, 0.1); }
        .stat-card.pb-card:hover { border-color: rgba(168, 85, 247, 0.35); box-shadow: 0 8px 24px rgba(168, 85, 247, 0.1); }

        .stat-icon-wrap {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 40px;
            height: 40px;
            border-radius: var(--radius-md);
            flex-shrink: 0;
            border: 1px solid rgba(255, 255, 255, 0.03);
        }

        .stat-content { flex: 1; }

        .stat-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-3);
            margin-bottom: 4px;
            font-weight: 700;
        }

        .stat-value {
            font-size: 20px;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
            line-height: 1.2;
            margin-bottom: 2px;
        }

        .stat-card.blue   .stat-value { color: var(--blue); }
        .stat-card.green  .stat-value { color: var(--green); }
        .stat-card.purple .stat-value { color: var(--purple); }
        .stat-card.amber  .stat-value { color: var(--amber); }
        .stat-card.pb-card .stat-value { color: var(--purple); }

        .stat-sub {
            font-size: 11px;
            color: var(--text-3);
            font-variant-numeric: tabular-nums;
        }

        /* ── Section Header ── */
        .section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
        }

        .section-title {
            font-weight: 700;
            font-size: 14px;
            color: #fff;
        }

        .section-badge {
            font-size: 11px;
            color: var(--text-3);
            background: var(--bg-element);
            padding: 3px 10px;
            border-radius: 20px;
            border: 1px solid var(--border-low);
            font-weight: 500;
        }

        /* ── Chart ── */
        .chart-wrap { position: relative; height: 200px; }

        /* ── Tabs ── */
        .tab-bar {
            display: flex;
            border-bottom: 1px solid var(--border-low);
            margin-bottom: 16px;
            gap: 4px;
        }

        .tab {
            padding: 8px 16px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-3);
            border: none;
            background: none;
            border-bottom: 2px solid transparent;
            transition: all 0.2s ease;
            margin-bottom: -1px;
            border-radius: var(--radius-md) var(--radius-md) 0 0;
        }

        .tab:hover {
            color: var(--text-2);
            background: rgba(255, 255, 255, 0.02);
        }

        .tab.active {
            color: var(--blue);
            border-bottom-color: var(--blue);
            background: rgba(59, 130, 246, 0.05);
        }

        .tab-pane { display: none; }
        .tab-pane.active { display: block; }

        /* ── Tables ── */
        .tbl-wrap { overflow-x: auto; }

        table { width: 100%; border-collapse: collapse; }

        th {
            text-align: left;
            padding: 10px 12px;
            border-bottom: 1px solid var(--border-mid);
            color: var(--text-3);
            font-weight: 700;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            white-space: nowrap;
        }

        td {
            padding: 10px 12px;
            border-bottom: 1px solid var(--border-low);
            color: var(--text-2);
            font-size: 12px;
        }

        tr:last-child td { border-bottom: none; }
        tr:hover td { background: rgba(255, 255, 255, 0.015); }

        .num {
            text-align: right;
            font-variant-numeric: tabular-nums;
            color: var(--text-1);
            font-weight: 600;
        }

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
            padding: 24px !important;
            font-style: italic;
        }

        /* ── Badges ── */
        .badge {
            display: inline-flex;
            align-items: center;
            padding: 3px 9px;
            border-radius: 20px;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.2px;
            border: 1px solid transparent;
        }
        .badge-manual      { background: var(--purple-dim); border-color: rgba(168, 85, 247, 0.2); color: #c084fc; }
        .badge-selection   { background: var(--blue-dim);   border-color: rgba(59, 130, 246, 0.2); color: #60a5fa; }
        .badge-copilot     { background: var(--green-dim);  border-color: rgba(16, 185, 129, 0.2); color: #34d399; }
        .badge-antigravity { background: var(--amber-dim);  border-color: rgba(245, 158, 11, 0.2); color: #fbbf24; }

        /* ── Mini Stats ── */
        .mini-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
            gap: 10px;
            margin-bottom: 16px;
        }

        .mini-stat {
            background: var(--bg-element);
            border: 1px solid var(--border-low);
            border-radius: var(--radius-md);
            padding: 10px 14px;
            text-align: center;
            transition: transform 0.2s;
        }
        
        .mini-stat:hover {
            transform: translateY(-1px);
            border-color: rgba(255, 255, 255, 0.1);
        }

        .mini-stat-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-3);
            margin-bottom: 4px;
            font-weight: 700;
        }

        .mini-stat-value {
            font-size: 16px;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
            color: #fff;
        }

        /* ── Animations ── */
        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(8px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        
        .animate-pulse {
            animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: .4; }
        }
    </style>
</head>
<body>
<div class="app">

    <!-- Glowing Background Spots -->
    <div class="bg-glow bg-glow-1"></div>
    <div class="bg-glow bg-glow-2"></div>

    <!-- Topbar -->
    <div class="topbar">
        <div class="logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
            AI Token Counter
        </div>
        <div class="topbar-right">
            <button class="btn btn-primary" onclick="exportData()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                Export
            </button>
            <button class="btn" onclick="resetSession()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                Reset Session
            </button>
            <button class="btn btn-danger" onclick="resetAll()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                Reset All
            </button>
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
                        backgroundColor: 'rgba(59, 130, 246, 0.4)',
                        borderColor: 'rgba(59, 130, 246, 0.8)',
                        borderWidth: 1.5,
                        borderRadius: 4,
                    },
                    {
                        label: 'Output',
                        data: ${chartOutputDataStr},
                        backgroundColor: 'rgba(16, 185, 129, 0.4)',
                        borderColor: 'rgba(16, 185, 129, 0.8)',
                        borderWidth: 1.5,
                        borderRadius: 4,
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: '#adbac7', font: { family: 'Plus Jakarta Sans', size: 11, weight: '600' }, boxWidth: 10 } }
                },
                scales: {
                    x: {
                        stacked: true,
                        ticks: { color: '#768390', font: { family: 'Plus Jakarta Sans', size: 10 } },
                        grid: { color: 'rgba(255, 255, 255, 0.02)' },
                        border: { color: 'rgba(255, 255, 255, 0.04)' }
                    },
                    y: {
                        stacked: true,
                        ticks: { color: '#768390', font: { family: 'Plus Jakarta Sans', size: 10 } },
                        grid: { color: 'rgba(255, 255, 255, 0.02)' },
                        border: { color: 'rgba(255, 255, 255, 0.04)' }
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
