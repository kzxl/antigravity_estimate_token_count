import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

export interface ModelQuota {
    label: string;
    remainingFraction: number;  // 0.0 - 1.0 (1 = 100% còn lại)
    resetTime: string;          // ISO string
}

export interface QuotaData {
    models: ModelQuota[];
    fetchedAt: number;
}

export class QuotaFetcher implements vscode.Disposable {
    private port: number = 0;
    private csrfToken: string = '';
    private pollingTimer: NodeJS.Timeout | undefined;
    private lastData: QuotaData | undefined;

    private readonly onQuotaUpdateEmitter = new vscode.EventEmitter<QuotaData>();
    public readonly onQuotaUpdate = this.onQuotaUpdateEmitter.event;

    /** Tìm port và CSRF token từ process language server của Antigravity */
    private async detectProcessInfo(): Promise<{ port: number; token: string } | null> {
        try {
            const { stdout } = await execAsync(
                `powershell -NoProfile -Command "` +
                `Get-CimInstance Win32_Process -Filter \\"name='language_server_windows_x64.exe'\\" ` +
                `| Select-Object ProcessId,CommandLine | ConvertTo-Json"`
            );

            let data = JSON.parse(stdout.trim());
            if (!Array.isArray(data)) { data = [data]; }

            for (const item of data) {
                const cmd: string = item.CommandLine || '';
                // Chỉ lấy process không có --enable_lsp (main auth process)
                if (cmd.includes('--enable_lsp')) { continue; }
                if (!cmd.toLowerCase().includes('antigravity')) { continue; }

                // Lấy extension_server_port
                const portMatch = cmd.match(/--extension_server_port\s+(\d+)/);
                // Lấy extension_server_csrf_token
                const tokenMatch = cmd.match(/--extension_server_csrf_token\s+([\w-]+)/);

                if (portMatch && tokenMatch) {
                    return {
                        port: parseInt(portMatch[1]),
                        token: tokenMatch[1],
                    };
                }
            }
        } catch (err) {
            console.error('[QuotaFetcher] Failed to detect process info:', err);
        }
        return null;
    }

    /** Tìm connect_port (HTTPS) từ PID — là port khác với extension_server_port */
    private async detectConnectPort(pid: number): Promise<number | null> {
        try {
            const { stdout } = await execAsync(
                `powershell -NoProfile -Command "` +
                `Get-NetTCPConnection -OwningProcess ${pid} -State Listen ` +
                `| Select-Object -ExpandProperty LocalPort"`
            );
            const ports = stdout.trim().split('\n')
                .map(p => parseInt(p.trim()))
                .filter(p => !isNaN(p) && p > 1024);
            return ports[0] ?? null;
        } catch {
            return null;
        }
    }

    /** Gọi API GetUserStatus, extract quota của từng model */
    private async fetchFromApi(port: number, token: string): Promise<QuotaData | null> {
        return new Promise((resolve) => {
            const body = '{}';
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port,
                path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': token,
                },
                rejectUnauthorized: false,
                timeout: 5000,
            };

            const req = https.request(options, res => {
                let raw = '';
                res.on('data', chunk => (raw += chunk));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(raw);
                        const modelConfigs: any[] =
                            json?.userStatus?.planStatus?.modelConfigs ?? [];

                        const models: ModelQuota[] = modelConfigs
                            .filter(m => m.quotaInfo?.remainingFraction !== undefined)
                            .map(m => ({
                                label: m.label as string,
                                remainingFraction: m.quotaInfo.remainingFraction as number,
                                resetTime: m.quotaInfo.resetTime as string,
                            }));

                        resolve({ models, fetchedAt: Date.now() });
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    }

    /** Thực hiện fetch đầy đủ: detect process → find port → call API */
    public async refresh(): Promise<QuotaData | null> {
        // Nếu chưa có port, tự detect
        if (!this.port || !this.csrfToken) {
            const info = await this.detectProcessInfo();
            if (!info) { return null; }

            // Lấy PID của process để tìm connect port
            const { stdout } = await execAsync(
                `powershell -NoProfile -Command "` +
                `Get-CimInstance Win32_Process -Filter \\"name='language_server_windows_x64.exe'\\" ` +
                `| Where-Object {$_.CommandLine -notlike '*--enable_lsp*'} ` +
                `| Select-Object -ExpandProperty ProcessId"`
            ).catch(() => ({ stdout: '' }));

            const pid = parseInt(stdout.trim());
            if (!pid) { return null; }

            const connectPort = await this.detectConnectPort(pid);
            if (!connectPort) { return null; }

            this.port = connectPort;
            this.csrfToken = info.token;
            console.log(`[QuotaFetcher] Detected port=${this.port}, token=${this.csrfToken.substring(0, 8)}...`);
        }

        const data = await this.fetchFromApi(this.port, this.csrfToken);
        if (data) {
            this.lastData = data;
            this.onQuotaUpdateEmitter.fire(data);
        } else {
            // Reset để retry detect
            this.port = 0;
            this.csrfToken = '';
        }
        return data;
    }

    /** Bắt đầu polling quota theo interval (ms) */
    public start(intervalMs: number = 60_000): void {
        this.refresh(); // fetch ngay lập tức
        this.pollingTimer = setInterval(() => this.refresh(), intervalMs);
        console.log(`[QuotaFetcher] Started polling every ${intervalMs}ms`);
    }

    public getData(): QuotaData | undefined {
        return this.lastData;
    }

    public dispose(): void {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
        this.onQuotaUpdateEmitter.dispose();
    }
}
