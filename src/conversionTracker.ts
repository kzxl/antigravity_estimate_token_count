import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { PbDeltaEvent } from './pbWatcher';

/** A single conversion log entry */
export interface ConversionLogEntry {
    ts: string;
    convId: string;
    deltaBytes: number;
    deltaKB: number;
    pbTotalKB: number;
    tokensPerKB: number;
    estimatedTokens: number;
}

/** Aggregated conversion stats */
export interface ConversionStats {
    totalEvents: number;
    totalDeltaKB: number;
    totalEstimatedTokens: number;
    avgDeltaKBPerEvent: number;
    avgTokensPerEvent: number;
    uniqueConversations: number;
}

/**
 * Tracks each PB delta event into a JSONL file for measurement and analysis.
 * Each line in the file is a JSON object representing one delta event.
 */
export class ConversionTracker implements vscode.Disposable {
    private readonly logFilePath: string;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor() {
        const config = vscode.workspace.getConfiguration('tokenCount');
        const customPath = config.get<string>('conversionLogPath', '');

        if (customPath) {
            this.logFilePath = customPath;
        } else {
            this.logFilePath = path.join(
                os.homedir(), '.gemini', 'antigravity', 'token-conversion-log.jsonl'
            );
        }
    }

    /** Log a PB delta event to the JSONL file */
    public logConversion(event: PbDeltaEvent): void {
        const config = vscode.workspace.getConfiguration('tokenCount');
        if (!config.get<boolean>('conversionLogEnabled', true)) {
            return;
        }

        const tokensPerKB = config.get<number>('tokensPerKB', 75);
        const entry: ConversionLogEntry = {
            ts: new Date(event.timestamp).toISOString(),
            convId: event.conversationId,
            deltaBytes: event.deltaBytes,
            deltaKB: event.deltaKB,
            pbTotalKB: event.totalFileKB,
            tokensPerKB,
            estimatedTokens: event.estimatedTokens,
        };

        const line = JSON.stringify(entry) + '\n';

        // Queue writes to avoid file corruption
        this.writeQueue = this.writeQueue.then(async () => {
            try {
                await fs.promises.appendFile(this.logFilePath, line, 'utf-8');
            } catch (err) {
                console.error('[ConversionTracker] Failed to write log:', err);
            }
        });
    }

    /** Read recent conversion entries (latest N) */
    public async getRecentConversions(limit: number = 50): Promise<ConversionLogEntry[]> {
        try {
            const content = await fs.promises.readFile(this.logFilePath, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.length > 0);
            const entries: ConversionLogEntry[] = [];

            // Take last N lines
            const startIdx = Math.max(0, lines.length - limit);
            for (let i = startIdx; i < lines.length; i++) {
                try {
                    entries.push(JSON.parse(lines[i]));
                } catch {
                    // Skip malformed lines
                }
            }

            return entries;
        } catch {
            return []; // File doesn't exist yet
        }
    }

    /** Get aggregated stats from all conversion entries */
    public async getConversionStats(): Promise<ConversionStats> {
        const entries = await this.getRecentConversions(100000); // Read all

        if (entries.length === 0) {
            return {
                totalEvents: 0,
                totalDeltaKB: 0,
                totalEstimatedTokens: 0,
                avgDeltaKBPerEvent: 0,
                avgTokensPerEvent: 0,
                uniqueConversations: 0,
            };
        }

        const totalDeltaKB = entries.reduce((s, e) => s + e.deltaKB, 0);
        const totalEstimatedTokens = entries.reduce((s, e) => s + e.estimatedTokens, 0);
        const uniqueConvIds = new Set(entries.map(e => e.convId));

        return {
            totalEvents: entries.length,
            totalDeltaKB: Math.round(totalDeltaKB * 10) / 10,
            totalEstimatedTokens,
            avgDeltaKBPerEvent: Math.round(totalDeltaKB / entries.length * 10) / 10,
            avgTokensPerEvent: Math.round(totalEstimatedTokens / entries.length),
            uniqueConversations: uniqueConvIds.size,
        };
    }

    public dispose(): void {
        // Ensure pending writes complete
    }
}
