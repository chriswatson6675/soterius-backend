'use strict';

// Tool registry — the ONLY way the planner/orchestrator may invoke a tool.
// A tool name not present here cannot be executed, however the planner (or
// an LLM) phrases its decision — this is what keeps the agent from having
// "invisible or unrestricted browsing": every capability is a named,
// registered, auditable tool.

function createToolRegistry(tools) {
  const map = new Map();
  for (const tool of tools) {
    if (!tool || !tool.name) throw new Error('Every tool must have a name.');
    map.set(tool.name, tool);
  }
  return {
    get(name) {
      return map.get(name) || null;
    },
    has(name) {
      return map.has(name);
    },
    list() {
      return [...map.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },
    names() {
      return [...map.keys()];
    },
  };
}

module.exports = { createToolRegistry };
