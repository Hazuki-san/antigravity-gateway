/**
 * Gemini Handler
 * Handles native Google Generative AI API format requests
 * 
 * Endpoints:
 * - POST /v1beta/models/{model}:generateContent
 * - POST /v1beta/models/{model}:streamGenerateContent
 * 
 * Based on Antigravity-Manager commit b1eb557 (fix: SSE interruption and 0-token issues)
 */

import { logger } from '../utils/logger.js';
import { ANTIGRAVITY_ENDPOINT_FALLBACKS } from '../constants.js';
import { getSystemInstruction } from '../gateway-config.js';
import crypto from 'crypto';

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
 * Determine request type based on model
 */
function getRequestType(model) {
    if (model.startsWith('gemini-3-pro-image')) {
        return 'image_gen';
    }
    return 'agent';
}

/**
 * Map model name for upstream API
 * Antigravity-Manager maps "preview" models to their actual API names
 */
function mapModelForUpstream(model) {
    const mapping = {
        'gemini-3-pro-preview': 'gemini-3-pro-high',
        'gemini-3-pro-image-preview': 'gemini-3-pro-image',
        'gemini-3-flash-preview': 'gemini-3-flash'
    };
    return mapping[model] || model;
}

/**
 * Deep clean undefined/null values from object
 * Antigravity-Manager does this to prevent API validation failures
 * Removes properties with value null, undefined, or "[undefined]" string
 */
function deepCleanUndefined(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
        return obj.map(item => deepCleanUndefined(item)).filter(item => item !== undefined);
    }
    if (typeof obj === 'object') {
        const cleaned = {};
        for (const [key, value] of Object.entries(obj)) {
            // Skip undefined, null, and "[undefined]" string
            if (value === undefined || value === null || value === '[undefined]') {
                continue;
            }
            cleaned[key] = deepCleanUndefined(value);
        }
        return cleaned;
    }
    return obj;
}

/**
 * Unwrap v1internal response wrapper
 * Antigravity-Manager unwraps response.response before returning
 */
function unwrapResponse(data) {
    if (data && data.response) {
        return data.response;
    }
    return data;
}

/**
 * Wrap Gemini request body for Cloud Code API
 * Injects Antigravity system instruction like the reference does
 */
function wrapGeminiRequest(body, projectId, model) {
    // Clone and deep clean body (like Antigravity-Manager's deep_clean_undefined)
    // This removes undefined/null values that cause API validation failures
    const innerRequest = deepCleanUndefined(JSON.parse(JSON.stringify(body)));

    // Inject Antigravity system instruction if not present
    const antigravityIdentity = getSystemInstruction();

    if (innerRequest.systemInstruction) {
        // Add role if missing
        if (!innerRequest.systemInstruction.role) {
            innerRequest.systemInstruction.role = 'user';
        }
        // Check if Antigravity identity is already present
        const parts = innerRequest.systemInstruction.parts;
        if (Array.isArray(parts)) {
            const hasAntigravity = parts.some(p =>
                p.text && p.text.includes('You are Antigravity')
            );
            if (!hasAntigravity) {
                parts.unshift({ text: antigravityIdentity });
            }
        }
    } else {
        // Create new systemInstruction
        innerRequest.systemInstruction = {
            role: 'user',
            parts: [{ text: antigravityIdentity }]
        };
    }

    // Clean generationConfig
    if (innerRequest.generationConfig) {
        // candidateCount is sent by some clients but not needed
        delete innerRequest.generationConfig.candidateCount;
    }

    // Map model name for upstream API (e.g., preview -> high)
    const upstreamModel = mapModelForUpstream(model);

    return {
        project: projectId,
        model: upstreamModel,
        request: innerRequest,
        userAgent: 'antigravity',
        requestId: 'agent-' + crypto.randomUUID(),
        requestType: getRequestType(model)
    };
}

/**
 * Handle Gemini generateContent request
 * Implements peek-and-retry logic from Antigravity-Manager commit b1eb557
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

    // ALWAYS use streamGenerateContent - generateContent gets 429 on Cloud Code API
    // This is API-level rate limiting (streamGenerateContent has more lenient quotas)
    const upstream_method = 'streamGenerateContent';
    const query_string = '?alt=sse';

    // Match Antigravity-Manager: PROD first, then DAILY
    const endpoints = [
        'https://cloudcode-pa.googleapis.com',
        'https://daily-cloudcode-pa.sandbox.googleapis.com'
    ];

    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Get account for this attempt
        const account = accountManager.pickNext(model);
        if (!account) {
            return res.status(503).json({
                error: {
                    code: 503,
                    message: 'No available accounts',
                    status: 'UNAVAILABLE'
                }
            });
        }

        try {
            // Get token and project for account
            const accessToken = await accountManager.getTokenForAccount(account);
            const projectId = await accountManager.getProjectForAccount(account, accessToken);

            logger.info(`[Gemini] Attempt ${attempt + 1}/${maxAttempts} using account: ${account.email}`);

            // Wrap request
            const wrappedRequest = wrapGeminiRequest(req.body, projectId, model);

            // Try each endpoint
            for (const endpoint of endpoints) {
                const url = `${endpoint}/v1internal:${upstream_method}${query_string}`;

                const headers = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': 'antigravity/1.11.9 windows/amd64'
                };

                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(wrappedRequest)
                    });

                    if (response.status === 429) {
                        const errorBody = await response.text();
                        logger.warn(`[Gemini] Rate limited at ${endpoint}: ${errorBody}`);
                        continue;
                    }

                    if (response.status === 404) {
                        logger.warn(`[Gemini] Model not found at ${endpoint}, trying next...`);
                        continue;
                    }

                    if (!response.ok) {
                        const errorText = await response.text();
                        logger.error(`[Gemini] Error from ${endpoint}: ${response.status}`, errorText);

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
                        let buffer = '';
                        let hasData = false;

                        try {
                            // [FIX #859] Peek first chunk to detect empty response
                            const firstRead = await Promise.race([
                                reader.read(),
                                new Promise((_, reject) =>
                                    setTimeout(() => reject(new Error('Timeout')), 30000)
                                )
                            ]);

                            if (firstRead.done || (firstRead.value && firstRead.value.length === 0)) {
                                logger.warn('[Gemini] Empty first chunk, retrying with next account...');
                                lastError = 'Empty response';
                                reader.releaseLock();
                                break; // Break endpoint loop to retry with next account
                            }

                            // Process first chunk
                            const firstChunk = decoder.decode(firstRead.value, { stream: true });
                            buffer += firstChunk;

                            // Parse and forward SSE lines, unwrapping v1internal wrapper
                            const lines = buffer.split('\n');
                            buffer = lines.pop() || '';

                            for (const line of lines) {
                                if (line.startsWith('data: ')) {
                                    const dataStr = line.slice(6).trim();
                                    if (dataStr === '[DONE]') {
                                        res.write('data: [DONE]\n\n');
                                    } else {
                                        try {
                                            const parsed = JSON.parse(dataStr);
                                            const unwrapped = unwrapResponse(parsed);
                                            res.write(`data: ${JSON.stringify(unwrapped)}\n\n`);
                                            hasData = true;
                                        } catch {
                                            res.write(`${line}\n\n`);
                                        }
                                    }
                                } else if (line.trim()) {
                                    res.write(`${line}\n\n`);
                                }
                            }

                            // Continue reading remaining chunks
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;

                                const chunk = decoder.decode(value, { stream: true });
                                buffer += chunk;

                                const chunkLines = buffer.split('\n');
                                buffer = chunkLines.pop() || '';

                                for (const line of chunkLines) {
                                    if (line.startsWith('data: ')) {
                                        const dataStr = line.slice(6).trim();
                                        if (dataStr === '[DONE]') {
                                            res.write('data: [DONE]\n\n');
                                        } else {
                                            try {
                                                const parsed = JSON.parse(dataStr);
                                                const unwrapped = unwrapResponse(parsed);
                                                res.write(`data: ${JSON.stringify(unwrapped)}\n\n`);
                                                hasData = true;
                                            } catch {
                                                res.write(`${line}\n\n`);
                                            }
                                        }
                                    } else if (line.trim()) {
                                        res.write(`${line}\n\n`);
                                    }
                                }
                            }
                        } catch (e) {
                            if (e.message === 'Timeout') {
                                logger.warn('[Gemini] Timeout waiting for first chunk, retrying...');
                                lastError = 'Timeout';
                                break; // Break endpoint loop to retry with next account
                            }
                            logger.error('[Gemini] Stream error:', e.message);
                        } finally {
                            res.end();
                        }
                        return;
                    }

                    // Non-streaming client: parse SSE and merge all chunks
                    // (since we always use streamGenerateContent, response is SSE)
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    // Accumulate response - merge all parts from all chunks
                    let mergedResponse = null;
                    let allParts = [];
                    let usageMetadata = null;

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split('\n');
                            buffer = lines.pop() || '';

                            for (const line of lines) {
                                if (line.startsWith('data: ')) {
                                    const dataStr = line.slice(6).trim();
                                    if (dataStr !== '[DONE]') {
                                        try {
                                            const parsed = JSON.parse(dataStr);
                                            const data = unwrapResponse(parsed);

                                            // Store base response structure from first chunk
                                            if (!mergedResponse && data) {
                                                mergedResponse = JSON.parse(JSON.stringify(data));
                                                if (mergedResponse.candidates?.[0]?.content?.parts) {
                                                    mergedResponse.candidates[0].content.parts = [];
                                                }
                                            }

                                            // Collect all parts from each chunk
                                            if (data?.candidates?.[0]?.content?.parts) {
                                                allParts.push(...data.candidates[0].content.parts);
                                            }

                                            // Keep latest usageMetadata
                                            if (data?.usageMetadata) {
                                                usageMetadata = data.usageMetadata;
                                            }
                                        } catch {
                                            // Ignore parse errors
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        logger.error('[Gemini] Error parsing SSE for non-stream:', e.message);
                    }

                    // Build final response with all merged parts
                    if (mergedResponse) {
                        if (mergedResponse.candidates?.[0]?.content) {
                            mergedResponse.candidates[0].content.parts = allParts;
                        }
                        if (usageMetadata) {
                            mergedResponse.usageMetadata = usageMetadata;
                        }
                        return res.json(mergedResponse);
                    }
                    return res.status(500).json({ error: 'No response data received' });

                } catch (fetchError) {
                    logger.error(`[Gemini] Fetch error for ${endpoint}:`, fetchError.message);
                    lastError = fetchError.message;
                    continue;
                }
            }

        } catch (error) {
            logger.error(`[Gemini] Attempt ${attempt + 1} error:`, error.message);
            lastError = error.message;
        }
    }

    // All attempts failed
    return res.status(429).json({
        error: {
            code: 429,
            message: lastError || 'All endpoints rate limited or unavailable',
            status: 'RESOURCE_EXHAUSTED'
        }
    });
}
