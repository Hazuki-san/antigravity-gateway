/**
 * Antigravity Gateway
 * Entry point - starts the universal AI gateway server
 */

import app from './server.js';
import { DEFAULT_PORT } from './constants.js';
import { logger } from './utils/logger.js';
import path from 'path';
import os from 'os';

const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || process.env.DEBUG === 'true';
const isFallbackEnabled = args.includes('--fallback') || process.env.FALLBACK === 'true';

logger.setDebug(isDebug);

if (isDebug) {
    logger.debug('Debug mode enabled');
}

if (isFallbackEnabled) {
    logger.info('Model fallback mode enabled');
}

export const FALLBACK_ENABLED = isFallbackEnabled;

const PORT = process.env.PORT || DEFAULT_PORT;

const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.config/antigravity-gateway');

app.listen(PORT, () => {
    console.clear();

    const border = '║';
    const align = (text) => text + ' '.repeat(Math.max(0, 60 - text.length));
    const align4 = (text) => text + ' '.repeat(Math.max(0, 58 - text.length));
    
    let controlSection = '║  Control:                                                    ║\n';
    if (!isDebug) {
        controlSection += '║    --debug            Enable debug logging                   ║\n';
    }
    if (!isFallbackEnabled) {
        controlSection += '║    --fallback         Enable model fallback on quota exhaust ║\n';
    }
    controlSection += '║    Ctrl+C             Stop server                            ║';

    let statusSection = '';
    if (isDebug || isFallbackEnabled) {
        statusSection = '║                                                              ║\n';
        statusSection += '║  Active Modes:                                               ║\n';
        if (isDebug) {
            statusSection += '║    ✓ Debug mode enabled                                      ║\n';
        }
        if (isFallbackEnabled) {
            statusSection += '║    ✓ Model fallback enabled                                  ║\n';
        }
    }

    logger.log(`
╔══════════════════════════════════════════════════════════════╗
║               Antigravity Gateway v2.0.0                     ║
║         Universal AI Gateway for Claude & Gemini             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
${border}  ${align(`Server running at: http://localhost:${PORT}`)}${border}
${statusSection}║                                                              ║
${controlSection}
║                                                              ║
║  API Endpoints:                                              ║
║    POST /v1/chat/completions - OpenAI-compatible API         ║
║    POST /v1/messages         - Anthropic-compatible API      ║
║    GET  /v1/models           - List available models         ║
║    GET  /health              - Health check                  ║
║    GET  /account-limits      - Account status & quotas       ║
║                                                              ║
${border}  ${align(`Configuration:`)}${border}
${border}    ${align4(`Storage: ${CONFIG_DIR}`)}${border}
║                                                              ║
║  Quick Start (any OpenAI-compatible client):                 ║
${border}    ${align4(`Base URL: http://localhost:${PORT}/v1`)}${border}
║    API Key: any-value                                        ║
║                                                              ║
║  Add Google accounts:                                        ║
║    antigravity-gateway accounts add                          ║
║    agw accounts add                                          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
    
    logger.success(`Server started successfully on port ${PORT}`);
    if (isDebug) {
        logger.warn('Running in DEBUG mode - verbose logs enabled');
    }
});
