/**
 * Hook Handlers Module
 * 
 * Contains handlers for all Cursor hook events.
 * Each handler creates appropriate Langfuse observations (spans, generations, events).
 */

import { 
  calculateEditStats, 
  getFileExtension, 
  formatDuration,
  determineLevel,
  generateTags,
} from './utils.js';
import { addCompletionScores, addTagsToTrace } from './langfuse-client.js';

/**
 * Handle beforeSubmitPrompt hook
 * Creates a generation for the user's prompt input
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {object} Response to send back to Cursor
 */
export function handleBeforeSubmitPrompt(trace, input) {
  // Update trace name with the actual prompt
  trace.update({
    name: input.prompt?.substring(0, 100) || 'User Prompt',
  });
  
  // Create generation for the prompt
  const generation = trace.generation({
    name: 'User Prompt',
    input: input.prompt,
    model: input.model,
    metadata: {
      generation_id: input.generation_id,
      attachment_count: input.attachments?.length || 0,
      attachments: input.attachments?.map(a => ({
        type: a.type,
        path: a.filePath,
        extension: getFileExtension(a.filePath),
      })),
    },
  });
  
  // If there are attachments, create child spans for them
  if (input.attachments && input.attachments.length > 0) {
    for (const attachment of input.attachments) {
      generation.span({
        name: `Attachment: ${attachment.type}`,
        input: {
          type: attachment.type,
          filePath: attachment.filePath,
          extension: getFileExtension(attachment.filePath),
        },
      }).end();
    }
  }
  
  // Allow the prompt to continue
  return { continue: true };
}

/**
 * Handle afterAgentResponse hook
 * Creates a generation for the agent's response
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {null} No response needed
 */
export function handleAfterAgentResponse(trace, input) {
  // Calculate response metrics
  const responseLength = input.text?.length || 0;
  const lineCount = input.text?.split('\n').length || 0;
  
  trace.generation({
    name: 'Agent Response',
    output: input.text,
    model: input.model,
    metadata: {
      generation_id: input.generation_id,
      response_length: responseLength,
      line_count: lineCount,
    },
  });
  
  return null;
}

/**
 * Handle afterAgentThought hook
 * Creates a span for the agent's thinking/reasoning
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {null} No response needed
 */
export function handleAfterAgentThought(trace, input) {
  const span = trace.span({
    name: 'Agent Thinking',
    input: { type: 'thinking' },
    output: input.text,
    metadata: {
      generation_id: input.generation_id,
      duration_ms: input.duration_ms,
      duration_formatted: formatDuration(input.duration_ms),
      thinking_length: input.text?.length || 0,
    },
  });
  
  span.end();
  
  // Add thinking tag to trace
  addTagsToTrace(trace, generateTags('afterAgentThought', input));
  
  return null;
}

/**
 * Handle beforeShellExecution hook
 * Creates a span for the shell command before execution
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {object} Permission response
 */
export function handleBeforeShellExecution(trace, input) {
  const span = trace.span({
    name: `Shell: ${input.command?.substring(0, 50) || 'command'}`,
    input: {
      command: input.command,
      cwd: input.cwd,
    },
    metadata: {
      generation_id: input.generation_id,
      command_length: input.command?.length || 0,
    },
  });
  
  span.end();
  
  // Add shell tag to trace
  addTagsToTrace(trace, generateTags('beforeShellExecution', input));
  
  return { permission: 'allow' };
}

/**
 * Handle afterShellExecution hook
 * Creates a span for the shell command after execution
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {null} No response needed
 */
export function handleAfterShellExecution(trace, input) {
  // Detect if command might have failed (simple heuristic)
  const outputLower = (input.output || '').toLowerCase();
  const mightHaveFailed = outputLower.includes('error') || 
                          outputLower.includes('failed') ||
                          outputLower.includes('not found');
  
  const span = trace.span({
    name: `Shell Result: ${input.command?.substring(0, 40) || 'command'}`,
    input: {
      command: input.command,
    },
    output: input.output,
    level: mightHaveFailed ? 'WARNING' : 'DEFAULT',
    metadata: {
      generation_id: input.generation_id,
      duration_ms: input.duration,
      duration_formatted: formatDuration(input.duration),
      output_length: input.output?.length || 0,
      might_have_failed: mightHaveFailed,
    },
  });
  
  span.end();
  
  return null;
}

/**
 * Handle beforeMCPExecution hook
 * Creates a span for the MCP tool before execution
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {object} Permission response
 */
export function handleBeforeMCPExecution(trace, input) {
  const span = trace.span({
    name: `MCP: ${input.tool_name || 'tool'}`,
    input: {
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      server_url: input.url,
      server_command: input.command,
    },
    metadata: {
      generation_id: input.generation_id,
    },
  });
  
  span.end();
  
  // Add MCP tag to trace
  addTagsToTrace(trace, generateTags('beforeMCPExecution', input));
  
  return { permission: 'allow' };
}

/**
 * Handle afterMCPExecution hook
 * Creates a span for the MCP tool after execution
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {null} No response needed
 */
export function handleAfterMCPExecution(trace, input) {
  // Try to parse result for size info
  let resultSize = 0;
  try {
    resultSize = JSON.stringify(input.result_json).length;
  } catch {
    resultSize = String(input.result_json).length;
  }
  
  const span = trace.span({
    name: `MCP Result: ${input.tool_name || 'tool'}`,
    input: {
      tool_name: input.tool_name,
      tool_input: input.tool_input,
    },
    output: input.result_json,
    metadata: {
      generation_id: input.generation_id,
      duration_ms: input.duration,
      duration_formatted: formatDuration(input.duration),
      result_size: resultSize,
    },
  });
  
  span.end();
  
  return null;
}

/**
 * Handle beforeReadFile hook
 * Creates a span for file read before it happens
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {object} Permission response
 */
export function handleBeforeReadFile(trace, input) {
  const extension = getFileExtension(input.file_path);
  
  const span = trace.span({
    name: `Read: ${input.file_path?.split('/').pop() || 'file'}`,
    input: {
      file_path: input.file_path,
      extension: extension,
    },
    metadata: {
      generation_id: input.generation_id,
      file_extension: extension,
    },
  });
  
  span.end();
  
  // Add file-ops tag
  addTagsToTrace(trace, generateTags('beforeReadFile', input));
  
  return { permission: 'allow' };
}

/**
 * Handle afterFileEdit hook
 * Creates a span for file edit with statistics
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {null} No response needed
 */
export function handleAfterFileEdit(trace, input) {
  const extension = getFileExtension(input.file_path);
  const editStats = calculateEditStats(input.edits);
  const fileName = input.file_path?.split('/').pop() || 'file';
  
  const span = trace.span({
    name: `Edit: ${fileName}`,
    input: {
      file_path: input.file_path,
      extension: extension,
    },
    output: {
      edit_count: editStats.editCount,
      lines_added: editStats.linesAdded,
      lines_removed: editStats.linesRemoved,
      net_change: editStats.netChange,
      edits: input.edits,
    },
    metadata: {
      generation_id: input.generation_id,
      file_extension: extension,
      ...editStats,
    },
  });
  
  span.end();
  
  return null;
}

/**
 * Handle stop hook
 * Adds completion event and scores to the trace
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {object} Optional followup response
 */
export function handleStop(trace, input) {
  const level = determineLevel(input.status);
  
  // Add completion event
  trace.event({
    name: 'Agent Stopped',
    level: level,
    metadata: {
      status: input.status,
      loop_count: input.loop_count,
      generation_id: input.generation_id,
    },
  });
  
  // Add completion scores
  addCompletionScores(trace, input);
  
  // Update trace with final status tag
  addTagsToTrace(trace, [`status-${input.status}`]);
  
  return {};
}

/**
 * Handle beforeTabFileRead hook
 * Creates a span for Tab file read
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {object} Permission response
 */
export function handleBeforeTabFileRead(trace, input) {
  const extension = getFileExtension(input.file_path);
  const fileName = input.file_path?.split('/').pop() || 'file';
  
  const span = trace.span({
    name: `Tab Read: ${fileName}`,
    input: {
      file_path: input.file_path,
      extension: extension,
    },
    metadata: {
      generation_id: input.generation_id,
      file_extension: extension,
      source: 'tab',
    },
  });
  
  span.end();
  
  return { permission: 'allow' };
}

/**
 * Handle afterTabFileEdit hook
 * Creates a span for Tab file edit with statistics
 * 
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {null} No response needed
 */
export function handleAfterTabFileEdit(trace, input) {
  const extension = getFileExtension(input.file_path);
  const editStats = calculateEditStats(input.edits);
  const fileName = input.file_path?.split('/').pop() || 'file';
  
  const span = trace.span({
    name: `Tab Edit: ${fileName}`,
    input: {
      file_path: input.file_path,
      extension: extension,
    },
    output: {
      edit_count: editStats.editCount,
      edits: input.edits?.map(e => ({
        range: e.range,
        old_line: e.old_line,
        new_line: e.new_line,
      })),
    },
    metadata: {
      generation_id: input.generation_id,
      file_extension: extension,
      source: 'tab',
      ...editStats,
    },
  });
  
  span.end();
  
  return null;
}

/**
 * Route hook event to appropriate handler
 * 
 * @param {string} hookName - The name of the hook event
 * @param {object} trace - The Langfuse trace
 * @param {object} input - Hook input data
 * @returns {object|null} Response to send back to Cursor (if any)
 */
export function routeHookHandler(hookName, trace, input) {
  const handlers = {
    'beforeSubmitPrompt': handleBeforeSubmitPrompt,
    'afterAgentResponse': handleAfterAgentResponse,
    'afterAgentThought': handleAfterAgentThought,
    'beforeShellExecution': handleBeforeShellExecution,
    'afterShellExecution': handleAfterShellExecution,
    'beforeMCPExecution': handleBeforeMCPExecution,
    'afterMCPExecution': handleAfterMCPExecution,
    'beforeReadFile': handleBeforeReadFile,
    'afterFileEdit': handleAfterFileEdit,
    'stop': handleStop,
    'beforeTabFileRead': handleBeforeTabFileRead,
    'afterTabFileEdit': handleAfterTabFileEdit,
  };
  
  const handler = handlers[hookName];
  
  if (!handler) {
    console.error(`Unknown hook type: ${hookName}`);
    return null;
  }
  
  return handler(trace, input);
}

