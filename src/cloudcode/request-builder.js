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
 * Transforms friendly model names to internal API model names
 * Based on Antigravity-Manager's model_mapping.rs
 */
const MODEL_NAME_MAPPING = {
    // Gemini 3 models - all map to gemini-3-pro-preview
    'gemini-3-pro-high': 'gemini-3-pro-preview',
    'gemini-3-pro-low': 'gemini-3-pro-preview',
    'gemini-3-pro': 'gemini-3-pro-preview',

    // Direct pass-through models (already correct)
    'gemini-3-pro-preview': 'gemini-3-pro-preview',
    'gemini-3-flash': 'gemini-3-flash',
    'gemini-3-pro-image': 'gemini-3-pro-image',
    'gemini-2.5-flash': 'gemini-2.5-flash',
    'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-2.5-flash-thinking': 'gemini-2.5-flash-thinking',

    // Claude models pass through
    'claude-opus-4-5-thinking': 'claude-opus-4-5-thinking',
    'claude-sonnet-4-5': 'claude-sonnet-4-5',
    'claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-thinking'
};

/**
 * Map user-facing model name to internal API model name
 * @param {string} model - User-facing model name
 * @returns {string} Internal API model name
 */
function mapToApiModelName(model) {
    // Check exact match first
    if (MODEL_NAME_MAPPING[model]) {
        return MODEL_NAME_MAPPING[model];
    }

    // Check for gemini-3-pro-image variants (with aspect ratio suffixes)
    if (model.startsWith('gemini-3-pro-image')) {
        return model; // Pass through with suffix
    }

    // Pass through gemini-* and claude-* models as-is
    if (model.startsWith('gemini-') || model.startsWith('claude-')) {
        return model;
    }

    // Default: pass through unchanged
    return model;
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
    const apiModel = mapToApiModelName(model); // Transform to API model name
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Use stable session ID derived from first user message for cache continuity
    googleRequest.sessionId = deriveSessionId(anthropicRequest);

    const payload = {
        project: projectId,
        model: apiModel, // Use transformed model name
        request: googleRequest,
        userAgent: 'antigravity',
        requestId: 'agent-' + crypto.randomUUID()
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
