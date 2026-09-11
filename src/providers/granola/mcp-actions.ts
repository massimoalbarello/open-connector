import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

export const granolaMcpActions: ActionDefinition[] = [
  defineProviderAction("granola", {
    name: "mcp_list_tools",
    description:
      "Discover Granola MCP tools and their current input schemas. Requires OAuth. Available tools depend on your Granola plan.",
    requiredScopes: [],
    followUpActions: ["granola.mcp_call_tool"],
    inputSchema: s.object({
      cursor: s.optional(s.nonEmptyString("Continue from the nextCursor returned by a previous tool listing.")),
    }),
    outputSchema: s.requiredObject("A page of available Granola MCP tools.", {
      tools: s.array(
        s.looseRequiredObject("A tool offered by Granola.", {
          name: s.nonEmptyString("Tool name to pass to mcp_call_tool."),
          description: s.optional(s.string("Description supplied by Granola.")),
          inputSchema: s.looseObject("JSON Schema for this tool's arguments."),
        }),
      ),
      nextCursor: s.optional(s.string("Cursor for the next page of tools.")),
    }),
  }),
  defineProviderAction("granola", {
    name: "mcp_call_tool",
    description:
      "Call a Granola MCP tool discovered with mcp_list_tools, such as list_meetings, get_meetings, query_granola_meetings, or get_meeting_transcript. Requires OAuth. Free plans cover personal notes from the last 30 days; some tools require a paid plan.",
    requiredScopes: [],
    inputSchema: s.requiredObject("Granola MCP tool and arguments.", {
      toolName: s.nonEmptyString("Exact tool name returned by mcp_list_tools."),
      arguments: s.optional(s.looseObject("Arguments matching the discovered tool's inputSchema.")),
    }),
    outputSchema: s.requiredObject("Successful Granola MCP tool result.", {
      result: s.looseRequiredObject("Original MCP content blocks and any structured output.", {
        content: s.array(
          s.looseRequiredObject("An MCP content block.", {
            type: s.nonEmptyString("Content kind, such as text or resource."),
          }),
        ),
        structuredContent: s.optional(s.looseObject("Structured tool output when supplied by Granola.")),
        isError: s.optional(s.boolean("Whether the tool reported a failure.")),
      }),
    }),
  }),
];
