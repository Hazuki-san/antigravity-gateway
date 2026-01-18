/**
 * Request Builder for Cloud Code
 *
 * Builds request payloads and headers for the Cloud Code API.
 */

import crypto from 'crypto';
import {
    ANTIGRAVITY_HEADERS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertAnthropicToGoogle } from '../format/index.js';
import { deriveSessionId } from './session-manager.js';

/**
 * Model name mapping for Google Cloud Code API
 * Note: Antigravity-Manager sends model names directly (gemini-3-pro-high, not gemini-3-pro-preview)
 * The API accepts these friendly names directly
 */

/**
 * Map user-facing model name to internal API model name
 * Most models pass through directly - the API understands friendly names
 * @param {string} model - User-facing model name
 * @returns {string} Internal API model name
 */
function mapToApiModelName(model) {
    // Pass through all model names directly
    // Antigravity-Manager sends gemini-3-pro-high, gemini-3-flash, etc. as-is
    return model;
}

/**
 * Determine request type based on model and request characteristics
 * @param {string} model - Model name
 * @returns {string} Request type: "agent", "web_search", or "image_gen"
 */
function getRequestType(model) {
    // Image generation models
    if (model.startsWith('gemini-3-pro-image')) {
        return 'image_gen';
    }
    // Default to agent for all other requests
    return 'agent';
}

/**
 * Build the wrapped request body for Cloud Code API
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} projectId - The project ID to use
 * @returns {Object} The Cloud Code API request payload
 */
export function buildCloudCodeRequest(anthropicRequest, projectId) {
    const model = anthropicRequest.model;
    const apiModel = mapToApiModelName(model);
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Note: Antigravity-Manager does NOT add sessionId to the request body
    // They only use it for signature injection into functionCall parts
    // Removed: googleRequest.sessionId = deriveSessionId(anthropicRequest);

    const payload = {
        project: projectId,
        model: apiModel,
        request: googleRequest,
        userAgent: 'antigravity',
        requestId: 'openai-' + crypto.randomUUID(),
        requestType: getRequestType(model) // Required by Cloud Code API
    };

    return payload;
}

/**
 * Build headers for Cloud Code API requests
 *
 * @param {string} token - OAuth access token
 * @param {string} model - Model name
 * @param {string} accept - Accept header value (default: 'application/json')
 * @returns {Object} Headers object
 */
export function buildHeaders(token, model, accept = 'application/json') {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    const modelFamily = getModelFamily(model);

    // Add interleaved thinking header only for Claude thinking models
    if (modelFamily === 'claude' && isThinkingModel(model)) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    if (accept !== 'application/json') {
        headers['Accept'] = accept;
    }

    return headers;
}
