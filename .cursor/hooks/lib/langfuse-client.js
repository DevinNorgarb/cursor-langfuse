/**
 * Langfuse Client Module
 * 
 * Handles Langfuse SDK initialization and trace management
 * with support for sessions, scoring, and dynamic metadata.
 */

import { Langfuse } from 'langfuse';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateTraceName, generateSessionId, generateTags } from './utils.js';

// Get the directory of this script
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from the project root's .env file
const projectRoot = resolve(__dirname, '..', '..', '..');
config({ path: resolve(projectRoot, '.env') });

// Hook handler version for release tracking
export const HOOK_HANDLER_VERSION = '1.1.0';

// Initialize Langfuse client (singleton)
let langfuseInstance = null;

/**
 * Get or create the Langfuse client instance
 * @returns {Langfuse} The Langfuse client
 */
export function getLangfuseClient() {
  if (!langfuseInstance) {
    langfuseInstance = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
      release: HOOK_HANDLER_VERSION,
    });
  }
  return langfuseInstance;
}

/**
 * Create or retrieve a trace for the conversation
 * 
 * @param {object} input - The hook input data
 * @param {string} [customName] - Optional custom name for the trace
 * @returns {object} The Langfuse trace object
 */
export function getOrCreateTrace(input, customName = null) {
  const langfuse = getLangfuseClient();
  
  // Generate session ID from workspace
  const sessionId = generateSessionId(input.workspace_roots);
  
  // Generate trace name (use custom or derive from prompt if available)
  const traceName = customName || 
    generateTraceName(input.prompt, input.model) || 
    `Cursor ${input.model || 'Agent'}`;
  
  // Generate initial tags
  const tags = generateTags(input.hook_event_name, input);
  
  return langfuse.trace({
    id: input.conversation_id,
    name: traceName,
    sessionId: sessionId,
    userId: input.user_email || undefined,
    release: HOOK_HANDLER_VERSION,
    version: input.cursor_version,
    metadata: {
      cursor_version: input.cursor_version,
      model: input.model,
      workspace_roots: input.workspace_roots,
      generation_id: input.generation_id,
    },
    tags: tags,
  });
}

/**
 * Update trace with additional tags
 * 
 * @param {object} trace - The Langfuse trace
 * @param {string[]} newTags - Additional tags to add
 */
export function addTagsToTrace(trace, newTags) {
  if (trace && newTags && newTags.length > 0) {
    trace.update({
      tags: newTags,
    });
  }
}

/**
 * Add a score to a trace
 * 
 * @param {object} trace - The Langfuse trace
 * @param {string} name - Score name
 * @param {number} value - Score value (0-1 for normalized, any number otherwise)
 * @param {string} [comment] - Optional comment
 * @param {string} [dataType] - 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL'
 */
export function addScore(trace, name, value, comment = null, dataType = 'NUMERIC') {
  if (trace) {
    trace.score({
      name: name,
      value: value,
      comment: comment,
      dataType: dataType,
    });
  }
}

/**
 * Calculate and add completion scores based on stop status
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - The stop hook input
 */
export function addCompletionScores(trace, input) {
  // Completion status score (1 = completed, 0.5 = aborted, 0 = error)
  let statusScore = 0;
  let statusComment = '';
  
  switch (input.status) {
    case 'completed':
      statusScore = 1;
      statusComment = 'Agent completed successfully';
      break;
    case 'aborted':
      statusScore = 0.5;
      statusComment = 'Agent was aborted by user';
      break;
    case 'error':
      statusScore = 0;
      statusComment = 'Agent encountered an error';
      break;
    default:
      statusScore = 0.5;
      statusComment = `Unknown status: ${input.status}`;
  }
  
  addScore(trace, 'completion_status', statusScore, statusComment);
  
  // Loop count score (fewer loops = more efficient, normalized)
  // Assuming 10+ loops is excessive
  if (typeof input.loop_count === 'number') {
    const efficiencyScore = Math.max(0, 1 - (input.loop_count / 10));
    addScore(
      trace, 
      'efficiency', 
      efficiencyScore, 
      `Completed in ${input.loop_count} loops`
    );
  }
}

/**
 * Flush all pending events to Langfuse
 * Call this before the process exits
 */
export async function flushLangfuse() {
  const langfuse = getLangfuseClient();
  await langfuse.flushAsync();
}

/**
 * Shutdown Langfuse client gracefully
 */
export async function shutdownLangfuse() {
  const langfuse = getLangfuseClient();
  await langfuse.shutdownAsync();
}

