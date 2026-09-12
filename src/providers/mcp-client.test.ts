import { describe, expect, it } from "vitest";
import { withMcpClient } from "./mcp-client.ts";

describe("MCP response limits", () => {
  it.each(["application/json", "text/event-stream"])(
    "bounds %s while reading and cancels the response stream",
    async (contentType) => {
      let cancelled = false;
      const fetcher: typeof fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(1025)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": contentType } },
        );
      await expect(
        withMcpClient(
          {
            endpoint: new URL("https://example.com/mcp"),
            transport: "streamable_http",
            fetcher,
            maxResponseBytes: 1024,
            signal: AbortSignal.timeout(1000),
          },
          (client) => client.listTools(),
        ),
      ).rejects.toThrow("size limit");
      expect(cancelled).toBe(true);
    },
  );
});
