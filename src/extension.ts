import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { StatusBarManager } from './statusBar';
import { DashboardPanel } from './dashboard';
import { PbWatcher } from './pbWatcher';
import { ConversionTracker } from './conversionTracker';
import { QuotaFetcher } from './quotaFetcher';
import { countTokens } from './tokenizer';

let sessionManager: SessionManager;
let statusBarManager: StatusBarManager;
let pbWatcher: PbWatcher | undefined;
let conversionTracker: ConversionTracker | undefined;
let quotaFetcher: QuotaFetcher | undefined;

export function activate(context: vscode.ExtensionContext) {
    // Initialize core services
    sessionManager = new SessionManager(context.globalState);

    // Initialize PB Watcher (auto-tracking)
    const config = vscode.workspace.getConfiguration('tokenCount');
    if (config.get<boolean>('pbWatcherEnabled', true)) {
        pbWatcher = new PbWatcher();
        pbWatcher.start();
        context.subscriptions.push(pbWatcher);

        // Auto-feed PB delta events into session entries
        pbWatcher.onDeltaDetected(async event => {
            console.log(
                `[TokenCount] PB delta: ${event.conversationId.substring(0, 8)}... ` +
                `+${event.deltaKB.toFixed(1)}KB (~${event.estimatedTokens} tokens)`
            );

            // Log to conversion tracker
            conversionTracker?.logConversion(event);

            // Split PB tokens into input/output using configurable ratio
            const pbConfig = vscode.workspace.getConfiguration('tokenCount');
            const inputRatio = pbConfig.get<number>('pbInputRatio', 0.4);
            const inputTokens = Math.round(event.estimatedTokens * inputRatio);
            const outputTokens = event.estimatedTokens - inputTokens;

            await sessionManager.addEntry(
                inputTokens, outputTokens, 'antigravity',
                `Auto: ${event.conversationId.substring(0, 8)}… +${event.deltaKB.toFixed(1)}KB`
            );
        });
    }

    // Initialize conversion tracker
    conversionTracker = new ConversionTracker();
    context.subscriptions.push(conversionTracker);

    // Initialize status bar (with optional PB watcher + quota fetcher)
    // quotaFetcher initialized below — pass after init
    statusBarManager = new StatusBarManager(sessionManager, pbWatcher, undefined);

    context.subscriptions.push(sessionManager);
    context.subscriptions.push(statusBarManager);

    // Initialize Quota Fetcher (real-time model quota from Antigravity API)
    quotaFetcher = new QuotaFetcher();
    quotaFetcher.start(120_000); // poll every 2 minutes
    quotaFetcher.onQuotaUpdate(() => {
        DashboardPanel.refresh(sessionManager, pbWatcher, conversionTracker, quotaFetcher);
    });
    context.subscriptions.push(quotaFetcher);

    // Re-create status bar now that quotaFetcher is ready
    statusBarManager.dispose();
    statusBarManager = new StatusBarManager(sessionManager, pbWatcher, quotaFetcher);
    context.subscriptions.push(statusBarManager);

    // Command: Show Dashboard
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenCount.showDashboard', () => {
            DashboardPanel.createOrShow(context.extensionUri, sessionManager, pbWatcher, conversionTracker, quotaFetcher);
        })
    );

    // Command: Count Selected Text
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenCount.countSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor found.');
                return;
            }

            const selection = editor.selection;
            const text = editor.document.getText(selection);

            if (!text || text.trim().length === 0) {
                vscode.window.showWarningMessage('No text selected. Select some text first.');
                return;
            }

            const tokens = countTokens(text);

            // Ask how to categorize
            const action = await vscode.window.showInformationMessage(
                `Selected text: ${tokens.toLocaleString()} tokens (${text.length} chars)`,
                'Track as Input ↑',
                'Track as Output ↓',
                'Just Count'
            );

            if (action === 'Track as Input ↑') {
                await sessionManager.addEntry(tokens, 0, 'selection', `Selected text (${text.length} chars)`);
                vscode.window.showInformationMessage(`Added ${tokens.toLocaleString()} input tokens.`);
            } else if (action === 'Track as Output ↓') {
                await sessionManager.addEntry(0, tokens, 'selection', `Selected text (${text.length} chars)`);
                vscode.window.showInformationMessage(`Added ${tokens.toLocaleString()} output tokens.`);
            }
        })
    );

    // Command: Add Manual Entry
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenCount.addManualEntry', async () => {
            // Select provider
            const provider = await vscode.window.showQuickPick(
                [
                    { label: '$(sparkle) Antigravity', value: 'antigravity' },
                    { label: '$(copilot) Copilot', value: 'copilot' },
                    { label: '$(edit) Manual', value: 'manual' },
                ],
                { placeHolder: 'Select AI provider' }
            );

            if (!provider) { return; }

            // Input tokens
            const inputStr = await vscode.window.showInputBox({
                prompt: 'Input tokens (sent to AI)',
                placeHolder: 'e.g. 1500',
                validateInput: (v) => {
                    if (v && isNaN(Number(v))) { return 'Please enter a valid number'; }
                    return null;
                }
            });

            if (inputStr === undefined) { return; }
            const inputTokens = Number(inputStr) || 0;

            // Output tokens
            const outputStr = await vscode.window.showInputBox({
                prompt: 'Output tokens (received from AI)',
                placeHolder: 'e.g. 2000',
                validateInput: (v) => {
                    if (v && isNaN(Number(v))) { return 'Please enter a valid number'; }
                    return null;
                }
            });

            if (outputStr === undefined) { return; }
            const outputTokens = Number(outputStr) || 0;

            if (inputTokens === 0 && outputTokens === 0) {
                vscode.window.showWarningMessage('Both input and output are 0. Nothing to track.');
                return;
            }

            // Description
            const description = await vscode.window.showInputBox({
                prompt: 'Description (optional)',
                placeHolder: 'e.g. Chat about refactoring',
            }) || `Manual entry (${provider.value})`;

            await sessionManager.addEntry(inputTokens, outputTokens, provider.value, description);

            vscode.window.showInformationMessage(
                `Added: ${inputTokens.toLocaleString()} ↑ / ${outputTokens.toLocaleString()} ↓ tokens (${provider.value})`
            );
        })
    );

    // Command: Reset Current Session
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenCount.resetSession', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Reset today\'s token count?',
                { modal: true },
                'Yes'
            );
            if (answer === 'Yes') {
                await sessionManager.resetCurrentSession();
                pbWatcher?.resetTracking();
                vscode.window.showInformationMessage('Current session has been reset.');
            }
        })
    );

    // Command: Reset All Data
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenCount.resetAll', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Reset ALL token count data? This cannot be undone.',
                { modal: true },
                'Yes, Reset All'
            );
            if (answer === 'Yes, Reset All') {
                await sessionManager.resetAll();
                pbWatcher?.resetTracking();
                vscode.window.showInformationMessage('All token data has been reset.');
            }
        })
    );

    // Command: Export Data
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenCount.exportData', async () => {
            const json = sessionManager.exportAsJson(pbWatcher?.getTrackingData());
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`token-usage-${new Date().toISOString().slice(0, 10)}.json`),
                filters: { 'JSON': ['json'] },
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
                vscode.window.showInformationMessage(`Token data exported to ${uri.fsPath}`);
            }
        })
    );

    // Command: Calibrate Rate
    context.subscriptions.push(
        vscode.commands.registerCommand('tokenCount.calibrateRate', async () => {
            let text = '';
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                text = editor.document.getText(editor.selection);
            } else {
                text = await vscode.env.clipboard.readText();
            }

            if (!text || text.trim().length === 0) {
                vscode.window.showErrorMessage('Không tìm thấy văn bản để tính toán. Vui lòng bôi đen đoạn chat hoặc copy vào Clipboard trước.');
                return;
            }

            // Chọn định dạng file để hiệu chuẩn
            const formatOption = await vscode.window.showQuickPick(
                [
                    { label: 'Protobuf (.pb)', value: 'pb', description: 'Cấu hình tokenCount.tokensPerKB (mặc định: 256)' },
                    { label: 'SQLite (.db + .db-wal)', value: 'sqlite', description: 'Cấu hình tokenCount.tokensPerKBSqlite (mặc định: 6)' }
                ],
                { placeHolder: 'Chọn định dạng file cần hiệu chuẩn' }
            );

            if (!formatOption) { return; }

            // Nhập dung lượng thực tế
            const sizeStr = await vscode.window.showInputBox({
                prompt: `Nhập dung lượng file thực tế (hoặc phần tăng thêm) bằng KB của định dạng ${formatOption.label}`,
                placeHolder: 'Ví dụ: 150 (cho 150 KB), 1024 (cho 1 MB)',
                validateInput: (v) => {
                    if (!v || isNaN(Number(v)) || Number(v) <= 0) {
                        return 'Vui lòng nhập một số dương đại diện cho dung lượng (KB)';
                    }
                    return null;
                }
            });

            if (sizeStr === undefined) { return; }
            const sizeKB = Number(sizeStr);

            // Tính toán số token và tỷ lệ mới
            const tokenCount = countTokens(text);
            const calculatedRate = Math.round((tokenCount / sizeKB) * 100) / 100;
            
            const pbConfig = vscode.workspace.getConfiguration('tokenCount');
            const settingKey = formatOption.value === 'pb' ? 'tokensPerKB' : 'tokensPerKBSqlite';
            const currentRate = pbConfig.get<number>(settingKey, formatOption.value === 'pb' ? 256 : 6);

            const confirm = await vscode.window.showInformationMessage(
                `Kết quả hiệu chuẩn:\n` +
                `- Số token thực tế: ${tokenCount.toLocaleString()} tokens (đoạn text dài ${text.length} ký tự)\n` +
                `- Dung lượng file: ${sizeKB.toLocaleString()} KB\n` +
                `- Tỷ lệ mới tính toán: ${calculatedRate} tokens/KB (Tỷ lệ hiện tại: ${currentRate} tokens/KB)\n\n` +
                `Bạn có muốn áp dụng tỷ lệ mới này vào cài đặt "${settingKey}" không?`,
                { modal: true },
                'Cập nhật'
            );

            if (confirm === 'Cập nhật') {
                await pbConfig.update(settingKey, calculatedRate, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Đã cập nhật cấu hình ${settingKey} thành ${calculatedRate} tokens/KB.`);
            }
        })
    );

    // Log activation
    const outputChannel = vscode.window.createOutputChannel('AI Token Counter');
    outputChannel.appendLine(`AI Token Counter activated at ${new Date().toISOString()}`);
    if (pbWatcher) {
        outputChannel.appendLine(`PB File Watcher enabled - monitoring Antigravity conversations`);
    }
    context.subscriptions.push(outputChannel);
}

export function deactivate() {
    // Cleanup handled by disposables
}
