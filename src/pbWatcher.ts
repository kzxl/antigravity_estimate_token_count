import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Delta event emitted when a .pb file changes */
export interface PbDeltaEvent {
    conversationId: string;
    deltaBytes: number;
    deltaKB: number;
    estimatedTokens: number;
    totalFileKB: number;
    timestamp: number;
}

/** Aggregated PB tracking data for the session */
export interface PbTrackingData {
    totalDeltaKB: number;
    totalEstimatedTokens: number;
    activeConversations: number;
    lastUpdate: number;
}

/**
 * Safely get file size without locking.
 * Uses fs.open with read-only + shared mode to avoid conflicts on Windows.
 */
async function safeGetFileSize(filePath: string): Promise<number | null> {
    try {
        // Use fs.promises.stat which is non-blocking and doesn't lock file
        const stats = await fs.promises.stat(filePath);
        return stats.size;
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        // EBUSY = file locked, EACCES = access denied, EPERM = permission error
        if (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
            return null; // Skip this file, try next poll
        }
        return null;
    }
}

/**
 * Watches Antigravity .pb conversation files for size changes.
 * Estimates token usage from delta file size.
 * Uses async I/O to avoid file locking issues on Windows.
 */
export class PbWatcher implements vscode.Disposable {
    private readonly conversationsDir: string;
    private fileSizes: Map<string, number> = new Map();
    private pollingTimer: NodeJS.Timeout | undefined;
    private disposed = false;
    private isChecking = false; // Prevent overlapping checks

    // Accumulated tracking data for current session
    private totalDeltaBytes = 0;
    private activeConversationIds = new Set<string>();
    private lastUpdateTime = 0;

    private readonly onDeltaDetectedEmitter = new vscode.EventEmitter<PbDeltaEvent>();
    public readonly onDeltaDetected = this.onDeltaDetectedEmitter.event;

    private readonly onTrackingUpdateEmitter = new vscode.EventEmitter<PbTrackingData>();
    public readonly onTrackingUpdate = this.onTrackingUpdateEmitter.event;

    constructor() {
        // Antigravity stores conversations at ~/.gemini/antigravity/conversations/
        this.conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
    }

    /** Start watching for .pb file changes */
    public async start(): Promise<void> {
        try {
            await fs.promises.access(this.conversationsDir, fs.constants.R_OK);
        } catch {
            console.warn(`[PbWatcher] Conversations directory not found or not readable: ${this.conversationsDir}`);
            return;
        }

        // Initial snapshot of all file sizes
        await this.snapshotAllFiles();

        // Start polling
        const config = vscode.workspace.getConfiguration('tokenCount');
        const intervalMs = config.get<number>('pbPollingIntervalMs', 5000);
        this.pollingTimer = setInterval(() => this.checkForChanges(), intervalMs);

        console.log(`[PbWatcher] Started monitoring ${this.conversationsDir} (interval: ${intervalMs}ms)`);
    }

    /** Take a snapshot of all .pb file sizes (async, non-blocking) */
    private async snapshotAllFiles(): Promise<void> {
        try {
            const files = await fs.promises.readdir(this.conversationsDir);
            for (const file of files) {
                if (file.endsWith('.pb')) {
                    const fullPath = path.join(this.conversationsDir, file);
                    const size = await safeGetFileSize(fullPath);
                    if (size !== null) {
                        this.fileSizes.set(file, size);
                    }
                }
            }
            console.log(`[PbWatcher] Initial snapshot: ${this.fileSizes.size} conversation files`);
        } catch (err) {
            console.error(`[PbWatcher] Error reading conversations directory:`, err);
        }
    }

    /** Check all .pb files for size changes (async, non-blocking) */
    private async checkForChanges(): Promise<void> {
        if (this.disposed || this.isChecking) { return; }
        this.isChecking = true;

        try {
            const files = await fs.promises.readdir(this.conversationsDir);
            const config = vscode.workspace.getConfiguration('tokenCount');
            const tokensPerKB = config.get<number>('tokensPerKB', 256);

            for (const file of files) {
                if (!file.endsWith('.pb')) { continue; }

                const fullPath = path.join(this.conversationsDir, file);
                const currentSize = await safeGetFileSize(fullPath);

                if (currentSize === null) {
                    continue; // File locked or inaccessible, skip silently
                }

                const previousSize = this.fileSizes.get(file) ?? 0;
                const deltaBytes = currentSize - previousSize;

                // Only emit if there's a meaningful change (> 100 bytes to avoid noise)
                if (deltaBytes > 100) {
                    const deltaKB = deltaBytes / 1024;
                    const estimatedTokens = Math.round(deltaKB * tokensPerKB);
                    const conversationId = file.replace('.pb', '');

                    this.totalDeltaBytes += deltaBytes;
                    this.activeConversationIds.add(conversationId);
                    this.lastUpdateTime = Date.now();

                    const event: PbDeltaEvent = {
                        conversationId,
                        deltaBytes,
                        deltaKB: Math.round(deltaKB * 10) / 10,
                        estimatedTokens,
                        totalFileKB: Math.round((currentSize / 1024) * 10) / 10,
                        timestamp: Date.now(),
                    };

                    this.onDeltaDetectedEmitter.fire(event);
                    this.emitTrackingUpdate(tokensPerKB);
                }

                // Always update the known size (if we could read it)
                this.fileSizes.set(file, currentSize);
            }
        } catch {
            // Directory might not exist or be inaccessible - silently ignore
        } finally {
            this.isChecking = false;
        }
    }

    /** Emit aggregated tracking update */
    private emitTrackingUpdate(tokensPerKB: number): void {
        const totalDeltaKB = Math.round((this.totalDeltaBytes / 1024) * 10) / 10;
        const data: PbTrackingData = {
            totalDeltaKB,
            totalEstimatedTokens: Math.round(totalDeltaKB * tokensPerKB),
            activeConversations: this.activeConversationIds.size,
            lastUpdate: this.lastUpdateTime,
        };
        this.onTrackingUpdateEmitter.fire(data);
    }

    /** Get current tracking data */
    public getTrackingData(): PbTrackingData {
        const config = vscode.workspace.getConfiguration('tokenCount');
        const tokensPerKB = config.get<number>('tokensPerKB', 256);
        const totalDeltaKB = Math.round((this.totalDeltaBytes / 1024) * 10) / 10;

        return {
            totalDeltaKB,
            totalEstimatedTokens: Math.round(totalDeltaKB * tokensPerKB),
            activeConversations: this.activeConversationIds.size,
            lastUpdate: this.lastUpdateTime,
        };
    }

    /** Reset session tracking data */
    public async resetTracking(): Promise<void> {
        this.totalDeltaBytes = 0;
        this.activeConversationIds.clear();
        this.lastUpdateTime = 0;

        // Re-snapshot to reset baselines
        await this.snapshotAllFiles();

        const config = vscode.workspace.getConfiguration('tokenCount');
        const tokensPerKB = config.get<number>('tokensPerKB', 256);
        this.emitTrackingUpdate(tokensPerKB);
    }

    public dispose(): void {
        this.disposed = true;
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
        this.onDeltaDetectedEmitter.dispose();
        this.onTrackingUpdateEmitter.dispose();
    }
}
