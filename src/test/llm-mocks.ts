/**
 * Shared test doubles for the LLM-backed generation pipeline.
 *
 * The real pipeline routes every model call through the Tauri `llm_chat`
 * command; tests route that command to canned JSON here. `routeLlmChat`
 * dispatches on the system prompt: intent extraction returns
 * SAMPLE_INTENT, contract generation returns SAMPLE_TODO_CONTRACT.
 */

export const SAMPLE_INTENT = {
  goal: 'Create a todo list app',
  requiredCapabilities: ['data-entry', 'list-display'],
  uiElements: [
    { type: 'input', purpose: 'Enter a todo', capabilities: ['data-entry'] },
    { type: 'button', purpose: 'Add the todo', capabilities: ['action'] },
    { type: 'list', purpose: 'Show todos', capabilities: ['list-display'] },
  ],
  operations: [
    {
      name: 'todos.add',
      purpose: 'Add a todo',
      inputs: ['title'],
      outputs: ['todos'],
      executionType: 'builtin',
    },
  ],
  ambiguities: [],
};

export const SAMPLE_TODO_CONTRACT = {
  name: 'todo-list',
  version: '1.0.0',
  initialState: { todos: [] },
  elements: [
    {
      id: 'title',
      type: 'text',
      properties: { content: 'My Todos' },
      dataBindings: [],
      eventBindings: [],
    },
    {
      id: 'todo-input',
      type: 'input',
      properties: { placeholder: 'What needs doing?' },
      dataBindings: [],
      eventBindings: [],
    },
    {
      id: 'add-btn',
      type: 'button',
      properties: { text: 'Add' },
      dataBindings: [],
      eventBindings: [{ event: 'click', operationId: 'op-add' }],
    },
    {
      id: 'todo-list',
      type: 'list',
      properties: {},
      dataBindings: [{ property: 'items', source: 'state', sourceId: 'todos' }],
      eventBindings: [],
      children: [
        {
          id: 'row-title',
          type: 'text',
          properties: {},
          dataBindings: [{ property: 'content', source: 'item', sourceId: 'title' }],
          eventBindings: [],
        },
        {
          id: 'row-toggle',
          type: 'button',
          properties: { text: 'Done' },
          dataBindings: [],
          eventBindings: [{ event: 'click', operationId: 'op-toggle' }],
        },
      ],
    },
  ],
  operations: [
    {
      id: 'op-add',
      operationName: 'todos.add',
      executionType: 'builtin',
      inputs: [{ name: 'title', source: 'ui-element', sourceId: 'todo-input' }],
      outputs: [{ name: 'reset', target: 'ui-element', targetId: 'todo-input' }],
      triggers: [],
    },
    {
      id: 'op-toggle',
      operationName: 'todos.toggle',
      executionType: 'builtin',
      inputs: [{ name: 'id', source: 'item', sourceId: 'id' }],
      outputs: [],
      triggers: [],
    },
  ],
  layout: { type: 'flex', properties: { flexDirection: 'column', gap: '12px' } },
  styling: { theme: 'default' },
};

interface LlmChatArgs {
  request?: {
    messages?: Array<{ role: string; content: string }>;
  };
}

/**
 * Returns the canned `llm_chat` response for a mocked invoke call. Use inside
 * a `vi.mock('@tauri-apps/api/core')` factory or `mockImplementation`:
 *
 *   invoke.mockImplementation(async (cmd, args) => {
 *     if (cmd === 'llm_chat') return routeLlmChat(args);
 *     return {};
 *   });
 */
export function routeLlmChat(args: unknown): { content: string; provider: string; model: string } {
  const messages = (args as LlmChatArgs)?.request?.messages ?? [];
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const isContract = system.includes('Contract JSON');
  const payload = isContract ? SAMPLE_TODO_CONTRACT : SAMPLE_INTENT;
  return { content: JSON.stringify(payload), provider: 'mock', model: 'mock' };
}
