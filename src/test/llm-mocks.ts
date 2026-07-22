/**
 * Shared test doubles for the LLM-backed generation pipeline.
 *
 * The real pipeline routes every model call through the Tauri `llm_chat`
 * command; tests route that command to canned JSON here. `routeLlmChat`
 * dispatches on the mode marker in the system prompt (system blocks plus any
 * inline system messages): CREATE MODE returns SAMPLE_COMPOSED, EDIT MODE
 * returns SAMPLE_EDITED_CONTRACT, and the blueprint leg returns
 * SAMPLE_TODO_CONTRACT.
 */

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

/** The single-call creation response: spec header plus the contract. */
export const SAMPLE_COMPOSED = {
  spec: {
    goal: 'Create a todo list app',
    assumptions: ['Todos are kept only on this device'],
    openQuestions: [],
  },
  contract: SAMPLE_TODO_CONTRACT,
};

/**
 * The todo contract after an edit: same ids, plus a caption showing how many
 * items are left. Returned for edit-leg requests so tests can drive the loop.
 */
export const SAMPLE_EDITED_CONTRACT = {
  ...SAMPLE_TODO_CONTRACT,
  elements: [
    ...SAMPLE_TODO_CONTRACT.elements,
    {
      id: 'items-left',
      type: 'text',
      properties: { role: 'caption' },
      dataBindings: [
        {
          property: 'content',
          source: 'state',
          sourceId: 'todos',
          transforms: [
            { type: 'filterBy', parameters: { field: 'completed', value: 'false' } },
            { type: 'count', parameters: {} },
            { type: 'format', parameters: { template: '{{value}} items left' } }
          ]
        }
      ],
      eventBindings: []
    }
  ]
};

interface LlmChatArgs {
  request?: {
    messages?: Array<{ role: string; content: string }>;
    systemBlocks?: Array<{ text: string; cache?: boolean }>;
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
  const request = (args as LlmChatArgs)?.request ?? {};
  const messages = request.messages ?? [];
  const system = [
    ...(request.systemBlocks ?? []).map((block) => block.text),
    ...messages.filter((m) => m.role === 'system').map((m) => m.content),
  ].join('\n');
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  const isEdit = system.includes('EDIT MODE') || user.includes('Current contract:');
  const isCompose = system.includes('CREATE MODE');
  const payload = isEdit
    ? SAMPLE_EDITED_CONTRACT
    : isCompose
      ? SAMPLE_COMPOSED
      : SAMPLE_TODO_CONTRACT;
  return { content: JSON.stringify(payload), provider: 'mock', model: 'mock' };
}
