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
    private conversationTypes: Map<string, 'protobuf' | 'sqlite'> = new Map();
    private pollingTimer: NodeJS.Timeout | undefined;
    private disposed = false;
    private isChecking = false; // Prevent overlapping checks

    // Accumulated tracking data for current session
    private totalDeltaBytes = 0;
    private totalEstimatedTokens = 0;
    private activeConversationIds = new Set<string>();
    private lastUpdateTime = 0;

    private readonly onDeltaDetectedEmitter = new vscode.EventEmitter<PbDeltaEvent>();
    public readonly onDeltaDetected = this.onDeltaDetectedEmitter.event;

    private readonly onTrackingUpdateEmitter = new vscode.EventEmitter<PbTrackingData>();
    public readonly onTrackingUpdate = this.onTrackingUpdateEmitter.event;

    constructor() {
        // Antigravity stores conversations at ~/.gemini/antigravity-ide/conversations/
        this.conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'conversations');
    }

    /** Start watching for conversation file changes */
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

    /** Take a snapshot of all conversation file sizes (async, non-blocking) */
    private async snapshotAllFiles(): Promise<void> {
        try {
            const files = await fs.promises.readdir(this.conversationsDir);
            this.conversationTypes.clear();
            this.fileSizes.clear();

            for (const file of files) {
                let id = '';
                let type: 'protobuf' | 'sqlite' | null = null;

                if (file.endsWith('.pb')) {
                    id = file.replace('.pb', '');
                    type = 'protobuf';
                } else if (file.endsWith('.db')) {
                    id = file.replace('.db', '');
                    type = 'sqlite';
                }

                if (type && id) {
                    this.conversationTypes.set(id, type);
                    const size = await this.getConversationSize(id, type);
                    if (size !== null) {
                        this.fileSizes.set(id, size);
                    }
                }
            }
            console.log(`[PbWatcher] Initial snapshot: ${this.fileSizes.size} active conversation files`);
        } catch (err) {
            console.error(`[PbWatcher] Error reading conversations directory:`, err);
        }
    }

    /** Get total size of a conversation based on its type */
    private async getConversationSize(id: string, type: 'protobuf' | 'sqlite'): Promise<number | null> {
        if (type === 'protobuf') {
            const filePath = path.join(this.conversationsDir, `${id}.pb`);
            return await safeGetFileSize(filePath);
        } else {
            const dbPath = path.join(this.conversationsDir, `${id}.db`);
            const walPath = path.join(this.conversationsDir, `${id}.db-wal`);

            const dbSize = await safeGetFileSize(dbPath);
            if (dbSize === null) {
                return null;
            }

            let walSize = 0;
            try {
                const size = await safeGetFileSize(walPath);
                if (size !== null) {
                    walSize = size;
                }
            } catch {
                // Ignore WAL read errors
            }

            return dbSize + walSize;
        }
    }

    /** Check all files for size changes (async, non-blocking) */
    private async checkForChanges(): Promise<void> {
        if (this.disposed || this.isChecking) { return; }
        this.isChecking = true;

        try {
            const files = await fs.promises.readdir(this.conversationsDir);
            const config = vscode.workspace.getConfiguration('tokenCount');
            const tokensPerKB = config.get<number>('tokensPerKB', 256);
            const tokensPerKBSqlite = config.get<number>('tokensPerKBSqlite', 6);

            // Update conversation types map from current files list
            const currentIds = new Set<string>();
            for (const file of files) {
                let id = '';
                let type: 'protobuf' | 'sqlite' | null = null;

                if (file.endsWith('.pb')) {
                    id = file.replace('.pb', '');
                    type = 'protobuf';
                } else if (file.endsWith('.db')) {
                    id = file.replace('.db', '');
                    type = 'sqlite';
                }

                if (type && id) {
                    this.conversationTypes.set(id, type);
                    currentIds.add(id);
                }
            }

            // Cleanup deleted conversations
            for (const id of Array.from(this.conversationTypes.keys())) {
                if (!currentIds.has(id)) {
                    this.fileSizes.delete(id);
                    this.conversationTypes.delete(id);
                }
            }

            for (const [id, type] of this.conversationTypes.entries()) {
                const currentSize = await this.getConversationSize(id, type);
                if (currentSize === null) {
                    continue; // File locked or inaccessible, skip silently
                }

                const previousSize = this.fileSizes.get(id) ?? 0;
                
                // If previousSize is 0, it means it's a newly detected conversation file.
                // We set the baseline and skip delta detection to avoid giant initial spikes.
                if (previousSize === 0) {
                    this.fileSizes.set(id, currentSize);
                    continue;
                }

                const deltaBytes = currentSize - previousSize;

                // Only emit if there's a meaningful change (> 100 bytes to avoid noise)
                if (deltaBytes > 100) {
                    const deltaKB = deltaBytes / 1024;
                    const rate = type === 'sqlite' ? tokensPerKBSqlite : tokensPerKB;
                    const estimatedTokens = Math.round(deltaKB * rate);

                    this.totalDeltaBytes += deltaBytes;
                    this.totalEstimatedTokens += estimatedTokens;
                    this.activeConversationIds.add(id);
                    this.lastUpdateTime = Date.now();

                    const event: PbDeltaEvent = {
                        conversationId: id,
                        deltaBytes,
                        deltaKB: Math.round(deltaKB * 10) / 10,
                        estimatedTokens,
                        totalFileKB: Math.round((currentSize / 1024) * 10) / 10,
                        timestamp: Date.now(),
                    };

                    this.onDeltaDetectedEmitter.fire(event);
                    this.emitTrackingUpdate();
                }

                // Always update the known size
                this.fileSizes.set(id, currentSize);
            }
        } catch {
            // Directory might not exist or be inaccessible - silently ignore
        } finally {
            this.isChecking = false;
        }
    }

    /** Emit aggregated tracking update */
    private emitTrackingUpdate(): void {
        const totalDeltaKB = Math.round((this.totalDeltaBytes / 1024) * 10) / 10;
        const data: PbTrackingData = {
            totalDeltaKB,
            totalEstimatedTokens: this.totalEstimatedTokens,
            activeConversations: this.activeConversationIds.size,
            lastUpdate: this.lastUpdateTime,
        };
        this.onTrackingUpdateEmitter.fire(data);
    }

    /** Get current tracking data */
    public getTrackingData(): PbTrackingData {
        const totalDeltaKB = Math.round((this.totalDeltaBytes / 1024) * 10) / 10;

        return {
            totalDeltaKB,
            totalEstimatedTokens: this.totalEstimatedTokens,
            activeConversations: this.activeConversationIds.size,
            lastUpdate: this.lastUpdateTime,
        };
    }

    /** Reset session tracking data */
    public async resetTracking(): Promise<void> {
        this.totalDeltaBytes = 0;
        this.totalEstimatedTokens = 0;
        this.activeConversationIds.clear();
        this.lastUpdateTime = 0;

        // Re-snapshot to reset baselines
        await this.snapshotAllFiles();
        this.emitTrackingUpdate();
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
