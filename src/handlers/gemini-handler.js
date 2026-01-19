/**
 * Gemini Handler
 * Handles native Google Generative AI API format requests
 * 
 * Endpoints:
 * - POST /v1beta/models/{model}:generateContent
 * - POST /v1beta/models/{model}:streamGenerateContent
 */

import { logger } from '../utils/logger.js';
import { buildCloudCodeRequest, buildHeaders } from '../cloudcode/request-builder.js';
import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_HEADERS } from '../constants.js';
import { parseSSEChunk } from '../cloudcode/sse-parser.js';

/**
 * Parse model and method from path
 * E.g., "gemini-pro:generateContent" -> { model: "gemini-pro", method: "generateContent" }
 */
function parseModelAction(modelAction) {
    const colonIndex = modelAction.lastIndexOf(':');
    if (colonIndex === -1) {
        return { model: modelAction, method: 'generateContent' };
    }
    return {
        model: modelAction.substring(0, colonIndex),
        method: modelAction.substring(colonIndex + 1)
    };
}

/**
 * Wrap Gemini request body for Cloud Code API
 */
function wrapGeminiRequest(body, projectId, model) {
    return {
        project: projectId,
        model: model,
        request: body,
        userAgent: 'antigravity',
        requestId: 'gemini-' + crypto.randomUUID(),
        requestType: 'generate'
    };
}

/**
 * Handle Gemini generateContent request
 */
export async function handleGeminiGenerate(req, res, accountManager) {
    const modelAction = req.params[0]; // Capture from wildcard route
    const { model, method } = parseModelAction(modelAction);

    // Validate method
    if (method !== 'generateContent' && method !== 'streamGenerateContent') {
        return res.status(400).json({
            error: {
                code: 400,
                message: `Unsupported method: ${method}. Use generateContent or streamGenerateContent.`,
                status: 'INVALID_ARGUMENT'
            }
        });
    }

    const isStream = method === 'streamGenerateContent' || req.query.alt === 'sse';
    logger.info(`[Gemini] ${method} request for model: ${model}`);

    try {
        // Get account with token
        const account = await accountManager.getNextAccount();
        if (!account) {
            return res.status(503).json({
                error: {
                    code: 503,
                    message: 'No available accounts',
                    status: 'UNAVAILABLE'
                }
            });
        }

        const { accessToken, projectId, email } = account;
        logger.info(`[Gemini] Using account: ${email}`);

        // Wrap request
        const wrappedRequest = wrapGeminiRequest(req.body, projectId, model);

        // Try endpoints
        for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
            const upstreamMethod = isStream ? 'streamGenerateContent' : 'generateContent';
            const url = `https://${endpoint}/v1internal:${upstreamMethod}`;

            const headers = {
                ...ANTIGRAVITY_HEADERS,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': isStream ? 'text/event-stream' : 'application/json'
            };

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(wrappedRequest)
                });

                if (response.status === 429) {
                    logger.warn(`[Gemini] Rate limited at ${endpoint}, trying next...`);
                    continue;
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error(`[Gemini] Error from ${endpoint}: ${response.status}`, errorText);

                    // Try to parse as JSON error
                    try {
                        const errorJson = JSON.parse(errorText);
                        return res.status(response.status).json(errorJson);
                    } catch {
                        return res.status(response.status).send(errorText);
                    }
                }

                // Handle streaming response
                if (isStream) {
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            const chunk = decoder.decode(value, { stream: true });
                            // Pass through SSE chunks directly (already in correct format)
                            res.write(chunk);
                        }
                    } finally {
                        res.end();
                    }
                    return;
                }

                // Handle non-streaming response
                const responseData = await response.json();
                return res.json(responseData);

            } catch (fetchError) {
                logger.error(`[Gemini] Fetch error for ${endpoint}:`, fetchError.message);
                continue;
            }
        }

        // All endpoints failed
        return res.status(503).json({
            error: {
                code: 503,
                message: 'All endpoints failed',
                status: 'UNAVAILABLE'
            }
        });

    } catch (error) {
        logger.error('[Gemini] Handler error:', error);
        return res.status(500).json({
            error: {
                code: 500,
                message: error.message,
                status: 'INTERNAL'
            }
        });
    }
}
