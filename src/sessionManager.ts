import * as vscode from 'vscode';

/** A single token usage entry */
export interface TokenEntry {
    id: string;
    timestamp: number;
    inputTokens: number;
    outputTokens: number;
    provider: string;    // 'copilot' | 'antigravity' | 'manual' | 'selection'
    description: string;
}

/** A tracking session (usually one per day) */
export interface TokenSession {
    id: string;
    date: string;        // YYYY-MM-DD
    entries: TokenEntry[];
    totalInput: number;
    totalOutput: number;
}

/** All persisted data */
interface PersistedData {
    sessions: TokenSession[];
    currentSessionId: string | null;
}

const STORAGE_KEY = 'tokenCount.data';

export class SessionManager {
    private sessions: TokenSession[] = [];
    private currentSessionId: string | null = null;
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.onDidChangeEmitter.event;

    constructor(private readonly globalState: vscode.Memento) {
        this.load();
    }

    /** Load persisted data from globalState */
    private load(): void {
        const data = this.globalState.get<PersistedData>(STORAGE_KEY);
        if (data) {
            this.sessions = data.sessions;
            this.currentSessionId = data.currentSessionId;
        }
        // Ensure we have a session for today
        this.ensureTodaySession();
    }

    /** Save data to globalState */
    private async save(): Promise<void> {
        const data: PersistedData = {
            sessions: this.sessions,
            currentSessionId: this.currentSessionId,
        };
        await this.globalState.update(STORAGE_KEY, data);
    }

    /** Get today's date string */
    private getTodayString(): string {
        const now = new Date();
        return now.toISOString().slice(0, 10); // YYYY-MM-DD
    }

    /** Generate a unique ID */
    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    /** Ensure a session exists for today */
    private ensureTodaySession(): void {
        const today = this.getTodayString();
        const existing = this.sessions.find(s => s.date === today);
        if (!existing) {
            const session: TokenSession = {
                id: this.generateId(),
                date: today,
                entries: [],
                totalInput: 0,
                totalOutput: 0,
            };
            this.sessions.push(session);
            this.currentSessionId = session.id;
        } else {
            this.currentSessionId = existing.id;
        }
    }

    /** Get the current session */
    public getCurrentSession(): TokenSession | undefined {
        const config = vscode.workspace.getConfiguration('tokenCount');
        if (config.get<boolean>('autoNewSessionDaily', true)) {
            this.ensureTodaySession();
        }
        return this.sessions.find(s => s.id === this.currentSessionId);
    }

    /** Get all sessions */
    public getAllSessions(): TokenSession[] {
        return [...this.sessions];
    }

    /** Add a token entry to the current session */
    public async addEntry(
        inputTokens: number,
        outputTokens: number,
        provider: string,
        description: string
    ): Promise<void> {
        const session = this.getCurrentSession();
        if (!session) {
            return;
        }

        const entry: TokenEntry = {
            id: this.generateId(),
            timestamp: Date.now(),
            inputTokens,
            outputTokens,
            provider,
            description,
        };

        session.entries.push(entry);
        session.totalInput += inputTokens;
        session.totalOutput += outputTokens;

        await this.save();
        this.onDidChangeEmitter.fire();
    }

    /** Get totals for the current session */
    public getCurrentTotals(): { input: number; output: number; total: number } {
        const session = this.getCurrentSession();
        if (!session) {
            return { input: 0, output: 0, total: 0 };
        }
        return {
            input: session.totalInput,
            output: session.totalOutput,
            total: session.totalInput + session.totalOutput,
        };
    }

    /** Get all-time totals */
    public getAllTimeTotals(): { input: number; output: number; total: number } {
        let input = 0;
        let output = 0;
        for (const session of this.sessions) {
            input += session.totalInput;
            output += session.totalOutput;
        }
        return { input, output, total: input + output };
    }

    /** Reset the current session */
    public async resetCurrentSession(): Promise<void> {
        const session = this.getCurrentSession();
        if (session) {
            session.entries = [];
            session.totalInput = 0;
            session.totalOutput = 0;
            await this.save();
            this.onDidChangeEmitter.fire();
        }
    }

    /** Reset all data */
    public async resetAll(): Promise<void> {
        this.sessions = [];
        this.currentSessionId = null;
        this.ensureTodaySession();
        await this.save();
        this.onDidChangeEmitter.fire();
    }

    /** Export all data as JSON string */
    public exportAsJson(pbTrackingData?: { totalDeltaKB: number; totalEstimatedTokens: number; activeConversations: number }): string {
        const data: Record<string, unknown> = {
            exportDate: new Date().toISOString(),
            sessions: this.sessions,
            allTimeTotals: this.getAllTimeTotals(),
        };
        if (pbTrackingData) {
            data.pbAutoTracking = pbTrackingData;
        }
        return JSON.stringify(data, null, 2);
    }

    public dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}
