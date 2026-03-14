import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import pool from '../config/database';
import redisClient from '../config/redis';
import pino from 'pino';
import dotenv from 'dotenv';
dotenv.config();    
const logger = pino();

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
// Minimum 3 seconds to stay well under Google's 300 req/min quota
const POLL_INTERVAL = Math.max(30000, parseInt(process.env.POLL_INTERVAL || '30000'));
const SHEET_RANGE = process.env.SHEET_RANGE || 'Sheet1!A1:H20';

// Redis keys for offline resilience
const REDIS_KEYS = {
    SHEET_SNAPSHOT: 'snapshot:sheet',           // Last known sheet state
    DB_SNAPSHOT: 'snapshot:db',                 // Last known DB state
    PENDING_TO_SHEET: 'pending:to_sheet',       // Changes waiting to go to Sheet
    PENDING_TO_DB: 'pending:to_db',             // Changes waiting to go to DB
    SHEET_ONLINE: 'status:sheet_online',        // Sheet connectivity status
    DB_ONLINE: 'status:db_online',              // DB connectivity status
};

const SNAPSHOT_TTL = 86400; // 24 hours

export class CDCMonitor {
    private lastSnapshot: Map<string, string> = new Map();
    private sheets: any;
    private isRunning = false;
    private intervalId: NodeJS.Timeout | null = null;
    private isPollInProgress = false;

    // Rate limit backoff
    private rateLimitedUntil: number = 0;
    private rateLimitBackoffMs: number = 5000; // Start with 5s backoff
    private consecutiveRateLimits: number = 0;

    // Connectivity tracking
    private sheetOnline: boolean = true;
    private dbOnline: boolean = true;
    private lastSheetError: string = '';
    private lastDbError: string = '';
    private lastChangeDetectedAt: number = 0;
    private lastSyncToDbAt: number = 0;
    private lastSyncToSheetAt: number = 0;

    private syncDebounceTimer: NodeJS.Timeout | null = null;
    private readonly SYNC_DEBOUNCE = 500;
    private dbDirtySinceLastSync = false;

    markDirty() {
        this.dbDirtySinceLastSync = true;
    }

    async initialize() {
        try {
            const jwtClient = new JWT({
                email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });

            await jwtClient.authorize();
            this.sheets = google.sheets({ version: 'v4', auth: jwtClient });
            
            // Try to load from Redis cache first (for fast startup)
            await this.loadSnapshotFromRedis();
            
            // Then try to fetch fresh data
            await this.loadInitialSnapshot();

            // Process any pending changes that were queued while offline
            await this.processPendingChangesOnStartup();

            console.log('✅ CDC Monitor initialized');
        } catch (error: any) {
            const errorMsg = error.code === 'ECONNRESET' 
                ? 'Google API connection reset during initialization'
                : `CDC Monitor initialization failed: ${error.message || error}`;
            console.error(`❌ ${errorMsg}`);
            
            // Try to recover from Redis cache
            const recovered = await this.loadSnapshotFromRedis();
            if (recovered) {
                console.log('⚠️ Running in offline mode with cached data');
                this.sheetOnline = false;
                this.lastSheetError = errorMsg;
                // Still try to process pending changes
                await this.processPendingChangesOnStartup();
            } else {
                throw error;
            }
        }
    }

    /**
     * Process pending changes that were queued while services were offline
     * Called on startup to ensure nothing is lost
     */
    private async processPendingChangesOnStartup(): Promise<void> {
        console.log('🔍 Checking for pending offline changes...');

        // Replay pending changes directly to avoid extra LLEN calls on startup.
        const processedToDb = await this.processPendingChanges('db');
        const processedToSheet = await this.processPendingChanges('sheet');

        if (processedToDb === 0 && processedToSheet === 0) {
            console.log('✅ No pending offline changes');
        }
    }

    /**
     * Load snapshot from Redis cache (for offline resilience)
     */
    private async loadSnapshotFromRedis(): Promise<boolean> {
        try {
            const cached = await redisClient.get(REDIS_KEYS.SHEET_SNAPSHOT);
            if (cached) {
                const data = JSON.parse(cached);
                this.lastSnapshot = new Map(Object.entries(data));
                console.log(`📦 Loaded ${this.lastSnapshot.size} cells from Redis cache`);
                return true;
            }
        } catch (error) {
            console.warn('⚠️ Could not load snapshot from Redis:', error);
        }
        return false;
    }

    /**
     * Save current snapshot to Redis (for offline resilience)
     */
    private async saveSnapshotToRedis(data: Map<string, string>): Promise<void> {
        try {
            const obj: Record<string, string> = {};
            for (const [key, value] of data.entries()) {
                obj[key] = value;
            }
            await redisClient.set(
                REDIS_KEYS.SHEET_SNAPSHOT, 
                JSON.stringify(obj), 
                'EX', 
                SNAPSHOT_TTL
            );
        } catch (error) {
            console.warn('⚠️ Could not save snapshot to Redis:', error);
        }
    }

    /**
     * Queue a change for later sync when target is offline
     */
    private async queuePendingChange(
        target: 'sheet' | 'db',
        change: { row: number; col: string; value: string; source: string }
    ): Promise<void> {
        const key = target === 'sheet' ? REDIS_KEYS.PENDING_TO_SHEET : REDIS_KEYS.PENDING_TO_DB;
        try {
            await redisClient.rpush(key, JSON.stringify({
                ...change,
                timestamp: Date.now()
            }));
            console.log(`📥 Queued change to ${target}: ${change.col}${change.row} = "${change.value}"`);
        } catch (error) {
            console.error(`❌ Failed to queue change to ${target}:`, error);
        }
    }

    /**
     * Process pending changes when connectivity is restored
     */
    private async processPendingChanges(target: 'sheet' | 'db'): Promise<number> {
        const key = target === 'sheet' ? REDIS_KEYS.PENDING_TO_SHEET : REDIS_KEYS.PENDING_TO_DB;
        let processed = 0;

        try {
            console.log(`\n🔄 Processing pending changes to ${target}...`);

            while (true) {
                const item = await redisClient.lpop(key);
                if (!item) break;

                const change = JSON.parse(item);
                console.log(`   📤 Replaying: ${change.col}${change.row} = "${change.value}" (queued at ${new Date(change.timestamp).toLocaleTimeString()})`);
                
                try {
                    if (target === 'sheet') {
                        await this.pushSingleCellToSheet(change.row, change.col, change.value);
                    } else {
                        await this.pushSingleCellToDb(change.row, change.col, change.value, change.source);
                    }
                    processed++;
                    console.log(`   ✅ Replayed ${change.col}${change.row} to ${target}`);
                } catch (error) {
                    // Re-queue failed changes
                    await redisClient.rpush(key, item);
                    console.error(`❌ Failed to process pending change, re-queued:`, error);
                    break; // Stop processing if we hit an error
                }
            }

            if (processed > 0) {
                console.log(`✅ Processed ${processed} pending changes to ${target}`);
            }
        } catch (error) {
            console.error(`❌ Error processing pending ${target} changes:`, error);
        }

        return processed;
    }

    /**
     * Push a single cell to Google Sheet
     */
    private async pushSingleCellToSheet(row: number, col: string, value: string): Promise<void> {
        const range = `Sheet1!${col}${row}`;
        await this.sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range,
            valueInputOption: 'RAW',
            requestBody: { values: [[value]] }
        });
    }

    /**
     * Push a single cell to DB
     */
    private async pushSingleCellToDb(row: number, col: string, value: string, source: string): Promise<void> {
        if (value === '') {
            await pool.query('DELETE FROM users WHERE row_num = ? AND col_name = ?', [row, col]);
        } else {
            await pool.query(
                `INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE cell_value = VALUES(cell_value), last_modified_by = VALUES(last_modified_by)`,
                [row, col, value, source]
            );
        }
    }

    /**
     * Check and update connectivity status
     */
    async checkConnectivity(): Promise<{ sheet: boolean; db: boolean }> {
        // Check DB
        try {
            await pool.query('SELECT 1');
            if (!this.dbOnline) {
                console.log('✅ Database connectivity restored');
                this.dbOnline = true;
                this.lastDbError = '';
                // Process pending DB changes
                await this.processPendingChanges('db');
            }
        } catch (error: any) {
            if (this.dbOnline) {
                console.warn('⚠️ Database is offline:', error.message);
                this.dbOnline = false;
                this.lastDbError = error.message;
            }
        }

        // Check Sheet (done during fetch, just return current status)
        return { sheet: this.sheetOnline, db: this.dbOnline };
    }

    /**
     * Get current connectivity and cache status (for API endpoint)
     */
    getStatus(): {
        sheetOnline: boolean;
        dbOnline: boolean;
        lastSheetError: string;
        lastDbError: string;
        snapshotSize: number;
        rateLimited: boolean;
        rateLimitBackoffMs: number;
    } {
        return {
            sheetOnline: this.sheetOnline,
            dbOnline: this.dbOnline,
            lastSheetError: this.lastSheetError,
            lastDbError: this.lastDbError,
            snapshotSize: this.lastSnapshot.size,
            rateLimited: Date.now() < this.rateLimitedUntil,
            rateLimitBackoffMs: this.rateLimitBackoffMs
        };
    }

    /**
     * Get cached data (for offline reads)
     */
    getCachedSnapshot(): Map<string, string> {
        return new Map(this.lastSnapshot);
    }

    private mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
        if (a.size !== b.size) return false;

        for (const [key, value] of a.entries()) {
            if (b.get(key) !== value) return false;
        }

        return true;
    }

    private async loadInitialSnapshot() {
        const data = await this.fetchSheetData();
        if (!data) {
            console.warn('⚠️ Could not fetch initial sheet data, using cached snapshot');
            return;
        }

        for (const [key, value] of data.entries()) {
            this.lastSnapshot.set(key, value);
        }

        // Save to Redis for offline resilience
        await this.saveSnapshotToRedis(data);

        await this.syncToDatabase(data);
        console.log(`📊 Initial snapshot loaded: ${data.size} cells`);
    }

    /**
     * Fetches data from the Google Sheets API with rate-limit protection.
     * Uses exponential backoff when rate-limited to avoid flooding the API.
     * Falls back to cached data when offline.
     */
    private async fetchSheetData(): Promise<Map<string, string> | null> {
        // If we're in a rate-limit backoff window, skip this fetch
        const now = Date.now();
        if (now < this.rateLimitedUntil) {
            // Silently skip - don't log every time
            return null;
        }

        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: SHEET_RANGE,
            });

            // Success - reset backoff and mark online
            if (this.consecutiveRateLimits > 0) {
                console.log('✅ Rate limit cleared, resuming normal polling');
            }
            this.consecutiveRateLimits = 0;
            this.rateLimitBackoffMs = 5000;

            // Mark sheet as online and process pending changes
            if (!this.sheetOnline) {
                console.log('✅ Google Sheets connectivity restored');
                this.sheetOnline = true;
                this.lastSheetError = '';
                // Process any pending changes that were queued while offline
                await this.processPendingChanges('sheet');
            }

            const rows = response.data.values || [];
            const cellMap = new Map<string, string>();

            rows.forEach((row: string[], rowIndex: number) => {
                row.forEach((value: string, colIndex: number) => {
                    const colName = String.fromCharCode(65 + colIndex);
                    const rowNum = rowIndex + 1;
                    const key = `${rowNum}:${colName}`;
                    cellMap.set(key, value || '');
                });
            });

            // Save to Redis only when sheet data actually changes.
            if (!this.mapsEqual(cellMap, this.lastSnapshot)) {
                await this.saveSnapshotToRedis(cellMap);
            }

            return cellMap;
        } catch (error: any) {
            if (error.code === 429 || error.status === 429) {
                this.consecutiveRateLimits++;
                // Exponential backoff: 5s, 10s, 20s, 40s, max 60s
                this.rateLimitBackoffMs = Math.min(60000, this.rateLimitBackoffMs * 2);
                this.rateLimitedUntil = Date.now() + this.rateLimitBackoffMs;
                
                // Only log the first hit and when backoff increases
                if (this.consecutiveRateLimits === 1) {
                    console.warn(`⚠️ Rate limited by Google Sheets API. Backing off for ${this.rateLimitBackoffMs / 1000}s...`);
                } else if (this.consecutiveRateLimits % 5 === 0) {
                    console.warn(`⚠️ Still rate limited (attempt ${this.consecutiveRateLimits}). Backoff: ${this.rateLimitBackoffMs / 1000}s`);
                }
            } else {
                // Network error or other issue - mark as offline
                if (this.sheetOnline) {
                    console.warn('⚠️ Google Sheets is offline:', error.message || error);
                    this.sheetOnline = false;
                    this.lastSheetError = error.message || 'Unknown error';
                }
            }
            return null;
        }
    }

    private async syncToDatabase(data: Map<string, string>) {
        for (const [key, value] of data.entries()) {
            const [rowStr, col] = key.split(':');
            const row = parseInt(rowStr);

            if (!value || value.trim() === '') continue;

            try {
                await pool.query(
                    `INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
                     VALUES (?, ?, ?, 'sheet')
                     ON DUPLICATE KEY UPDATE 
                        cell_value = VALUES(cell_value),
                        last_modified_by = 'sheet'`,
                    [row, col, value]
                );
                
                // Mark DB as online if it was offline
                if (!this.dbOnline) {
                    console.log('✅ Database connectivity restored');
                    this.dbOnline = true;
                    this.lastDbError = '';
                    await this.processPendingChanges('db');
                }
            } catch (error: any) {
                // If DB is offline, queue the change
                if (this.isDbOfflineError(error)) {
                    if (this.dbOnline) {
                        console.warn('⚠️ Database is offline:', error.message);
                        this.dbOnline = false;
                        this.lastDbError = error.message;
                    }
                    await this.queuePendingChange('db', { row, col, value, source: 'sheet' });
                } else {
                    console.error(`❌ Failed to sync cell ${col}${row}:`, error);
                }
            }
        }
    }

    /**
     * Check if an error indicates DB is offline
     */
    private isDbOfflineError(error: any): boolean {
        const offlineErrors = [
            'ECONNREFUSED',
            'ETIMEDOUT',
            'ENOTFOUND',
            'PROTOCOL_CONNECTION_LOST',
            'ER_ACCESS_DENIED_ERROR',
            'ECONNRESET'
        ];
        return offlineErrors.some(e => 
            error.code === e || 
            error.message?.includes(e) ||
            error.errno === e
        );
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        console.log(`🔄 CDC Monitor started (polling every ${POLL_INTERVAL}ms)`);

        this.intervalId = setInterval(async () => {
            await this.pollForChanges();
        }, POLL_INTERVAL);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        console.log('⏹️ CDC Monitor stopped');
    }

    private async pollForChanges() {
        // Prevent overlapping polls (if a fetch is slow and the next interval fires)
        if (this.isPollInProgress) return;
        this.isPollInProgress = true;

        try {
            // Check DB connectivity periodically
            await this.checkConnectivity();

            const currentData = await this.fetchSheetData();
            if (!currentData) return;

            const changes: { row: number; col: string; oldValue: string; newValue: string }[] = [];

            for (const [key, newValue] of currentData.entries()) {
                const oldValue = this.lastSnapshot.get(key) || '';
                if (oldValue !== newValue) {
                    const [rowStr, col] = key.split(':');
                    changes.push({
                        row: parseInt(rowStr),
                        col,
                        oldValue,
                        newValue,
                    });
                }
            }

            for (const [key, oldValue] of this.lastSnapshot.entries()) {
                if (!currentData.has(key) && oldValue !== '') {
                    const [rowStr, col] = key.split(':');
                    changes.push({
                        row: parseInt(rowStr),
                        col,
                        oldValue,
                        newValue: '',
                    });
                }
            }

            if (changes.length > 0) {
                const now = Date.now();
                const timeSinceLastChange = this.lastChangeDetectedAt > 0 
                    ? ` (Δ${now - this.lastChangeDetectedAt}ms since last detection)` 
                    : ' (first detection)';
                
                console.log(`\n📝 Detected ${changes.length} change(s) from Google Sheet${timeSinceLastChange}:`);

                for (const change of changes) {
                    console.log(`   ${change.col}${change.row}: "${change.oldValue}" → "${change.newValue}"`);

                    const ignoreKey = `ignore:${change.row}:${change.col}`;
                    await redisClient.set(ignoreKey, '1', 'EX', 10).catch(() => {});

                    try {
                        if (change.newValue === '') {
                            await pool.query(
                                'DELETE FROM users WHERE row_num = ? AND col_name = ?',
                                [change.row, change.col]
                            );
                        } else {
                            await pool.query(
                                `INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
                                 VALUES (?, ?, ?, 'sheet')
                                 ON DUPLICATE KEY UPDATE cell_value = VALUES(cell_value), last_modified_by = 'sheet'`,
                                [change.row, change.col, change.newValue]
                            );
                        }
                        
                        const now = Date.now();
                        const timeSinceLastSync = this.lastSyncToDbAt > 0 
                            ? ` (Δ${now - this.lastSyncToDbAt}ms since last sync to DB)` 
                            : '';
                        console.log(`   ✅ Synced ${change.col}${change.row} to database${timeSinceLastSync}`);
                        this.lastSyncToDbAt = now;
                        
                        // Mark DB as online
                        if (!this.dbOnline) {
                            this.dbOnline = true;
                            this.lastDbError = '';
                            console.log('✅ Database connectivity restored');
                        }
                    } catch (error: any) {
                        // If DB is offline, queue the change
                        if (this.isDbOfflineError(error)) {
                            if (this.dbOnline) {
                                console.warn('⚠️ Database is offline:', error.message);
                                this.dbOnline = false;
                                this.lastDbError = error.message;
                            }
                            await this.queuePendingChange('db', {
                                row: change.row,
                                col: change.col,
                                value: change.newValue,
                                source: 'sheet'
                            });
                        } else {
                            console.error(`   ❌ Failed to sync ${change.col}${change.row}:`, error);
                        }
                    }
                }
                
                this.lastChangeDetectedAt = now;
            }

            this.lastSnapshot = currentData;
        } catch (error: any) {
            if (error.code === 'ECONNRESET' || error.syscall === 'read') {
                if (this.sheetOnline) {
                    console.warn('⚠️ Google Sheets connection reset, will retry on next poll');
                    this.sheetOnline = false;
                    this.lastSheetError = 'Connection reset';
                }
            } else {
                console.error('❌ Polling error:', error.message || error);
            }
        } finally {
            this.isPollInProgress = false;
        }
    }

    debouncedSyncFromDatabase() {
        this.dbDirtySinceLastSync = true;
        if (this.syncDebounceTimer) {
            clearTimeout(this.syncDebounceTimer);
        }
        this.syncDebounceTimer = setTimeout(async () => {
            try {
                await this.syncFromDatabase();
            } catch (err) {
                console.error('❌ Debounced DB → Sheet sync failed:', err);
            }
        }, this.SYNC_DEBOUNCE);
    }

    async syncFromDatabase() {
        if (!this.dbDirtySinceLastSync) {
            return;
        }
        this.dbDirtySinceLastSync = false;

        try {
            // Check if DB is online
            let dbRows: any[];
            try {
                const [rows]: any = await pool.query(
                    `SELECT row_num, col_name, cell_value, last_modified_by FROM users 
                     ORDER BY row_num, col_name`
                );
                dbRows = rows;
                
                // Mark DB as online
                if (!this.dbOnline) {
                    console.log('✅ Database connectivity restored');
                    this.dbOnline = true;
                    this.lastDbError = '';
                    await this.processPendingChanges('db');
                }
                
                // Save DB snapshot to Redis
                await this.saveDbSnapshotToRedis(dbRows);
            } catch (error: any) {
                if (this.isDbOfflineError(error)) {
                    if (this.dbOnline) {
                        console.warn('⚠️ Database is offline:', error.message);
                        this.dbOnline = false;
                        this.lastDbError = error.message;
                    }
                    // Try to load from Redis cache
                    dbRows = await this.loadDbSnapshotFromRedis();
                    if (dbRows.length === 0) {
                        console.warn('⚠️ No cached DB data available');
                        return;
                    }
                    console.log(`📦 Using cached DB snapshot (${dbRows.length} rows)`);
                } else {
                    throw error;
                }
            }

            // Check if Sheet is online - use cached snapshot if not
            let sheetData: Map<string, string> | null;
            if (this.sheetOnline) {
                sheetData = await this.fetchSheetData();
            } else {
                sheetData = null;
            }
            
            if (!sheetData) {
                // Sheet is offline - queue changes for later
                console.log('⚠️ Google Sheets offline - queuing changes for later sync');
                
                for (const row of dbRows) {
                    if (row.last_modified_by !== 'sheet') {
                        await this.queuePendingChange('sheet', {
                            row: row.row_num,
                            col: row.col_name,
                            value: row.cell_value || '',
                            source: row.last_modified_by
                        });
                    }
                }
                return;
            }

            const updates: { range: string; values: string[][] }[] = [];
            const cellsToSync: Set<string> = new Set();
            const syncedCells: { row: number; col: string; value: string }[] = [];

            for (const row of dbRows) {
                const key = `${row.row_num}:${row.col_name}`;
                cellsToSync.add(key);
                
                const sheetValue = sheetData.get(key) || '';
                const dbValue = row.cell_value || '';

                if (dbValue !== sheetValue && row.last_modified_by !== 'sheet') {
                    const range = `Sheet1!${row.col_name}${row.row_num}`;
                    updates.push({
                        range,
                        values: [[dbValue]],
                    });
                    syncedCells.push({ row: row.row_num, col: row.col_name, value: dbValue });
                    console.log(`   📤 DB→Sheet: ${row.col_name}${row.row_num} = "${dbValue}"`);
                }
            }

            for (const [key, sheetValue] of sheetData.entries()) {
                if (!cellsToSync.has(key) && sheetValue !== '') {
                    const [rowStr, col] = key.split(':');
                    const range = `Sheet1!${col}${rowStr}`;
                    updates.push({
                        range,
                        values: [['']],
                    });
                    console.log(`   🗑️  DB→Sheet delete: ${col}${rowStr}`);
                }
            }

            if (updates.length === 0) {
                return;
            }

            console.log(`📡 Pushing ${updates.length} update(s) to Google Sheet...`);

            try {
                await this.sheets.spreadsheets.values.batchUpdate({
                    spreadsheetId: SHEET_ID,
                    requestBody: {
                        valueInputOption: 'RAW',
                        data: updates,
                    },
                });

                // Mark sheet as online
                if (!this.sheetOnline) {
                    console.log('✅ Google Sheets connectivity restored');
                    this.sheetOnline = true;
                    this.lastSheetError = '';
                }

                // Mark only the SPECIFIC cells we just synced (not a blanket update)
                for (const cell of syncedCells) {
                    await pool.query(
                        `UPDATE users SET last_modified_by = 'sheet' 
                         WHERE row_num = ? AND col_name = ? AND last_modified_by != 'sheet'`,
                        [cell.row, cell.col]
                    ).catch(() => {}); // Ignore DB errors here, we already synced to sheet
                }

                // Update the in-memory snapshot so the next poll doesn't
                // re-detect the values we just pushed as "sheet changes"
                for (const cell of syncedCells) {
                    this.lastSnapshot.set(`${cell.row}:${cell.col}`, cell.value);
                }

                const now = Date.now();
                const timeSinceLastSync = this.lastSyncToSheetAt > 0 
                    ? ` (Δ${now - this.lastSyncToSheetAt}ms since last sync to Sheet)` 
                    : '';
                console.log(`✅ Synced ${updates.length} cell(s) DB → Google Sheet${timeSinceLastSync}`);
                this.lastSyncToSheetAt = now;
            } catch (error: any) {
                // Sheet went offline during sync - queue the changes
                const errorMsg = error.code === 'ECONNRESET' 
                    ? 'Connection reset during sync'
                    : error.message || 'Unknown error';
                    
                if (this.sheetOnline) {
                    console.warn(`⚠️ Google Sheets went offline during sync: ${errorMsg}`);
                    this.sheetOnline = false;
                    this.lastSheetError = errorMsg;
                }
                
                // Queue all pending changes
                for (const cell of syncedCells) {
                    await this.queuePendingChange('sheet', {
                        row: cell.row,
                        col: cell.col,
                        value: cell.value,
                        source: 'db_sync'
                    });
                }
            }
        } catch (error: any) {
            const errorMsg = error.code === 'ECONNRESET' 
                ? 'Connection reset' 
                : error.message || 'Unknown error';
            console.error(`❌ DB → Sheet sync failed: ${errorMsg}`);
            if (error.response) {
                console.error('Google API Error:', error.response.data);
            }
        }
    }

    /**
     * Save DB snapshot to Redis
     */
    private async saveDbSnapshotToRedis(rows: any[]): Promise<void> {
        try {
            await redisClient.set(
                REDIS_KEYS.DB_SNAPSHOT,
                JSON.stringify(rows),
                'EX',
                SNAPSHOT_TTL
            );
        } catch (error) {
            console.warn('⚠️ Could not save DB snapshot to Redis:', error);
        }
    }

    /**
     * Load DB snapshot from Redis
     */
    private async loadDbSnapshotFromRedis(): Promise<any[]> {
        try {
            const cached = await redisClient.get(REDIS_KEYS.DB_SNAPSHOT);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (error) {
            console.warn('⚠️ Could not load DB snapshot from Redis:', error);
        }
        return [];
    }
}

export default new CDCMonitor();