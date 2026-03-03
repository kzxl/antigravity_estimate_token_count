import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { formatTokenCount } from './tokenizer';
import { PbWatcher, PbTrackingData } from './pbWatcher';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];
    private latestPbData: PbTrackingData | undefined;

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly pbWatcher: PbWatcher | undefined,
    ) {
        const config = vscode.workspace.getConfiguration('tokenCount');
        const alignment = config.get<string>('statusBarAlignment', 'right') === 'left'
            ? vscode.StatusBarAlignment.Left
            : vscode.StatusBarAlignment.Right;

        this.statusBarItem = vscode.window.createStatusBarItem(alignment, 100);
        this.statusBarItem.command = 'tokenCount.showDashboard';
        this.statusBarItem.tooltip = 'Click to open Token Counter Dashboard';

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

        // Build status bar text
        const parts: string[] = [];

        // PB auto-tracking part
        if (pbData && pbData.totalDeltaKB > 0) {
            const deltaKBStr = pbData.totalDeltaKB.toFixed(1);
            const tokensStr = formatTokenCount(pbData.totalEstimatedTokens);
            parts.push(`ΔKB: +${deltaKBStr}KB (~${tokensStr} tokens)`);
        }

        // Manual tracking part
        if (manualTotals.total > 0) {
            const inputStr = formatTokenCount(manualTotals.input);
            const outputStr = formatTokenCount(manualTotals.output);
            parts.push(`Manual: ${inputStr} ↑ / ${outputStr} ↓`);
        }

        // Default when nothing tracked yet
        if (parts.length === 0) {
            this.statusBarItem.text = `$(pulse) Token Counter`;
        } else {
            this.statusBarItem.text = `$(pulse) ${parts.join(' | ')}`;
        }

        // Build tooltip
        const config = vscode.workspace.getConfiguration('tokenCount');
        const tokensPerKB = config.get<number>('tokensPerKB', 200);

        let tooltipLines = [`**AI Token Counter**\n`];

        if (pbData && pbData.totalDeltaKB > 0) {
            tooltipLines.push(`**🔤 Auto-Track (PB File)**\n`);
            tooltipLines.push(`| Metric | Value |`);
            tooltipLines.push(`|---|---|`);
            tooltipLines.push(`| ΔKB (session) | **+${pbData.totalDeltaKB.toFixed(1)} KB** |`);
            tooltipLines.push(`| ~Estimated Tokens | **${pbData.totalEstimatedTokens.toLocaleString()}** |`);
            tooltipLines.push(`| Active Conversations | ${pbData.activeConversations} |`);
            tooltipLines.push(`| Ratio | ${tokensPerKB} tokens/KB |`);
            tooltipLines.push(``);
        }

        if (manualTotals.total > 0) {
            tooltipLines.push(`**✏️ Manual Tracking**\n`);
            tooltipLines.push(`| | Tokens |`);
            tooltipLines.push(`|---|---|`);
            tooltipLines.push(`| ↑ Input | **${manualTotals.input.toLocaleString()}** |`);
            tooltipLines.push(`| ↓ Output | **${manualTotals.output.toLocaleString()}** |`);
            tooltipLines.push(`| Total | **${manualTotals.total.toLocaleString()}** |`);
            tooltipLines.push(``);
        }

        tooltipLines.push(`_Click to open Dashboard_`);

        this.statusBarItem.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
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
