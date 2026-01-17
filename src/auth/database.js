/**
 * SQLite Database Access Module
 * Provides cross-platform database operations for Antigravity state.
 *
 * Uses better-sqlite3 when available for:
 * - Windows compatibility (no CLI dependency)
 * - Native performance
 * - Synchronous API (simple error handling)
 * 
 * On platforms where better-sqlite3 is not available (e.g., Termux/Android),
 * these functions will gracefully return null/false, and the gateway will
 * rely on OAuth accounts added via `agw accounts add` instead.
 */

import { createRequire } from 'module';
import { ANTIGRAVITY_DB_PATH } from '../constants.js';

// Lazy-load better-sqlite3 - it's optional for platforms like Termux
let Database = null;
let sqliteLoadAttempted = false;

/**
 * Attempt to load better-sqlite3 module synchronously
 * @returns {boolean} True if sqlite3 is available
 */
function ensureSqliteLoaded() {
    if (sqliteLoadAttempted) {
        return Database !== null;
    }

    sqliteLoadAttempted = true;

    try {
        const require = createRequire(import.meta.url);
        Database = require('better-sqlite3');
        return true;
    } catch {
        // This is expected on Termux/Android - not an error
        return false;
    }
}

/**
 * Check if SQLite support is available
 * @returns {boolean} True if better-sqlite3 is loaded
 */
export function isSqliteAvailable() {
    ensureSqliteLoaded();
    return Database !== null;
}

/**
 * Query Antigravity database for authentication status
 * @param {string} [dbPath] - Optional custom database path
 * @returns {Object|null} Parsed auth data with apiKey, email, name, etc. Returns null if SQLite unavailable.
 * @throws {Error} If database doesn't exist, query fails, or no auth status found
 */
export function getAuthStatus(dbPath = ANTIGRAVITY_DB_PATH) {
    // If SQLite is not available, return null (caller should use OAuth instead)
    if (!ensureSqliteLoaded()) {
        return null;
    }

    let db;
    try {
        // Open database in read-only mode
        db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true
        });

        // Prepare and execute query
        const stmt = db.prepare(
            "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'"
        );
        const row = stmt.get();

        if (!row || !row.value) {
            throw new Error('No auth status found in database');
        }

        // Parse JSON value
        const authData = JSON.parse(row.value);

        if (!authData.apiKey) {
            throw new Error('Auth data missing apiKey field');
        }

        return authData;
    } catch (error) {
        // Enhance error messages for common issues
        if (error.code === 'SQLITE_CANTOPEN') {
            throw new Error(
                `Database not found at ${dbPath}. ` +
                'Make sure Antigravity is installed and you are logged in.'
            );
        }
        // Re-throw with context if not already our error
        if (error.message.includes('No auth status') || error.message.includes('missing apiKey')) {
            throw error;
        }
        throw new Error(`Failed to read Antigravity database: ${error.message}`);
    } finally {
        // Always close database connection
        if (db) {
            db.close();
        }
    }
}

/**
 * Check if database exists and is accessible
 * @param {string} [dbPath] - Optional custom database path
 * @returns {boolean} True if database exists and can be opened. Returns false if SQLite unavailable.
 */
export function isDatabaseAccessible(dbPath = ANTIGRAVITY_DB_PATH) {
    // If SQLite is not available, database is not accessible
    if (!ensureSqliteLoaded()) {
        return false;
    }

    let db;
    try {
        db = new Database(dbPath, {
            readonly: true,
            fileMustExist: true
        });
        return true;
    } catch {
        return false;
    } finally {
        if (db) {
            db.close();
        }
    }
}

export default {
    getAuthStatus,
    isDatabaseAccessible,
    isSqliteAvailable
};
