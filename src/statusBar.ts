import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { formatTokenCount } from './tokenizer';
import { PbWatcher, PbTrackingData } from './pbWatcher';
import { QuotaFetcher, QuotaData } from './quotaFetcher';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];
    private latestPbData: PbTrackingData | undefined;
    private latestQuota: QuotaData | undefined;

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly pbWatcher: PbWatcher | undefined,
        private readonly quotaFetcher: QuotaFetcher | undefined,
    ) {
        const config = vscode.workspace.getConfiguration('tokenCount');
        const alignment = config.get<string>('statusBarAlignment', 'right') === 'left'
            ? vscode.StatusBarAlignment.Left
            : vscode.StatusBarAlignment.Right;

        this.statusBarItem = vscode.window.createStatusBarItem(alignment, 100);
        this.statusBarItem.command = 'tokenCount.showDashboard';

        // Listen for manual data changes
        this.disposables.push(
            sessionManager.onDidChange(() => this.update())
        );

        // Listen for PB tracking updates
        if (pbWatcher) {
            this.disposables.push(
                pbWatcher.onTrackingUpdate(data => {
                    this.latestPbData = data;
                    this.update();
                })
            );
        }

        // Listen for quota updates
        if (quotaFetcher) {
            this.disposables.push(
                quotaFetcher.onQuotaUpdate(data => {
                    this.latestQuota = data;
                    this.update();
                })
            );
        }

        // Listen for config changes
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('tokenCount.showInStatusBar')) {
                    this.updateVisibility();
                }
            })
        );

        this.update();
        this.updateVisibility();
    }

    private update(): void {
        const manualTotals = this.sessionManager.getCurrentTotals();
        const pbData = this.latestPbData ?? this.pbWatcher?.getTrackingData();
        const quota = this.latestQuota ?? this.quotaFetcher?.getData();

        // ── Determine status bar background color via color customization ─
        // (not possible via API directly, use tooltip color hints instead)

        // ── Status bar text ──────────────────────────────────────────────
        const parts: string[] = [];

        // Quota: show tất cả model theo format compact
        if (quota && quota.models.length > 0) {
            const modelParts = quota.models.map(m => {
                const usedPct = Math.round((1 - Math.max(0, Math.min(1, m.remainingFraction))) * 100);
                return `${this.shortModelName(m.label)} ${usedPct}%`;
            });

            // Icon theo model nào dùng nhiều nhất
            const maxUsedPct = Math.max(...quota.models.map(m =>
                Math.round((1 - Math.max(0, Math.min(1, m.remainingFraction))) * 100)
            ));
            const icon = maxUsedPct >= 85 ? '$(error)' : maxUsedPct >= 60 ? '$(warning)' : '$(check)';
            parts.push(`${icon} ${modelParts.join(' · ')}`);
        }

        // PB delta
        if (pbData && pbData.totalDeltaKB > 0) {
            parts.push(`$(database) +${pbData.totalDeltaKB.toFixed(1)}KB`);
        }

        // Manual tokens today
        if (manualTotals.total > 0) {
            parts.push(`$(pulse) ${formatTokenCount(manualTotals.total)}`);
        }

        if (parts.length === 0) {
            this.statusBarItem.text = `$(pulse) Token Counter`;
        } else {
            // Khi có quota (đã có icon riêng), không cần $(pulse) prefix
            const hasQuota = quota && quota.models.length > 0;
            this.statusBarItem.text = hasQuota ? parts.join('  ') : `$(pulse) ${parts.join('  ')}`;
        }

        // ── Tooltip (Markdown) ──────────────────────────────────────────
        const md = new vscode.MarkdownString('', true);
        md.isTrusted = true;
        md.supportThemeIcons = true;

        md.appendMarkdown(`### ⚡ AI Token Counter\n\n`);

        // Quota table
        if (quota && quota.models.length > 0) {
            const fetchedAgo = Math.round((Date.now() - quota.fetchedAt) / 1000);
            const agoStr = fetchedAgo < 60 ? `${fetchedAgo}s ago` : `${Math.round(fetchedAgo / 60)}m ago`;

            md.appendMarkdown(`**📡 Quota — Antigravity** _(${agoStr})_\n\n`);
            md.appendMarkdown(`| Model | Used | Remaining |\n`);
            md.appendMarkdown(`|---|---:|---:|\n`);
            for (const m of quota.models) {
                const usedPct = Math.round((1 - Math.max(0, Math.min(1, m.remainingFraction))) * 100);
                const remainPct = Math.round(m.remainingFraction * 100);
                const icon = usedPct >= 85 ? '🔴' : usedPct >= 60 ? '🟡' : '🟢';
                const resetTime = new Date(m.resetTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                md.appendMarkdown(`| ${icon} ${this.shortModelName(m.label)} | **${usedPct}%** | ${remainPct}% _(reset ${resetTime})_ |\n`);
            }
            md.appendMarkdown(`\n`);
        }

        // PB tracker
        if (pbData && pbData.totalDeltaKB > 0) {
            const config = vscode.workspace.getConfiguration('tokenCount');
            const tokensPerKB = config.get<number>('tokensPerKB', 256);
            md.appendMarkdown(`**🔤 Auto-Track (PB)**\n\n`);
            md.appendMarkdown(`| | |\n|---|---|\n`);
            md.appendMarkdown(`| ΔKB | **+${pbData.totalDeltaKB.toFixed(1)} KB** |\n`);
            md.appendMarkdown(`| ~Tokens | **${pbData.totalEstimatedTokens.toLocaleString()}** |\n`);
            md.appendMarkdown(`| Conversations | ${pbData.activeConversations} |\n`);
            md.appendMarkdown(`| Ratio | ${tokensPerKB} tok/KB |\n\n`);
        }

        // Manual tracking
        if (manualTotals.total > 0) {
            md.appendMarkdown(`**✏️ Manual — Today**\n\n`);
            md.appendMarkdown(`| | |\n|---|---|\n`);
            md.appendMarkdown(`| ↑ Input | **${manualTotals.input.toLocaleString()}** |\n`);
            md.appendMarkdown(`| ↓ Output | **${manualTotals.output.toLocaleString()}** |\n`);
            md.appendMarkdown(`| Total | **${manualTotals.total.toLocaleString()}** |\n\n`);
        }

        md.appendMarkdown(`_Click to open Dashboard_`);
        this.statusBarItem.tooltip = md;
    }

    /** Rút gọn tên model cho status bar */
    private shortModelName(label: string): string {
        const l = label.toLowerCase();
        if (l.includes('gemini 3.5') && l.includes('flash') && l.includes('high'))   { return 'G3.5 Flash↑'; }
        if (l.includes('gemini 3.5') && l.includes('flash') && l.includes('medium')) { return 'G3.5 Flash'; }
        if (l.includes('gemini 3.1') && l.includes('high'))  { return 'G3.1 Pro↑'; }
        if (l.includes('gemini 3.1') && l.includes('low'))   { return 'G3.1 Pro↓'; }
        if (l.includes('gemini 2.5') && l.includes('pro'))   { return 'G2.5 Pro'; }
        if (l.includes('gemini 2.5') && l.includes('flash')) { return 'G2.5 Flash'; }
        if (l.includes('gemini'))  { return 'Gemini'; }
        if (l.includes('claude sonnet') && l.includes('think')) { return 'C.Sonnet🧠'; }
        if (l.includes('claude opus')   && l.includes('think')) { return 'C.Opus🧠'; }
        if (l.includes('claude sonnet')) { return 'Sonnet'; }
        if (l.includes('claude opus'))   { return 'Opus'; }
        if (l.includes('gpt-oss') && l.includes('120b')) { return 'GPT-120B'; }
        if (l.includes('gpt'))  { return 'GPT'; }
        // Fallback: lấy 12 ký tự đầu
        return label.substring(0, 12);
    }

    private updateVisibility(): void {
        const config = vscode.workspace.getConfiguration('tokenCount');
        if (config.get<boolean>('showInStatusBar', true)) {
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    public dispose(): void {
        this.statusBarItem.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
