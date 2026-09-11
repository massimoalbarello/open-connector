import type { VersionNegotiationMode } from "@modelcontextprotocol/client";

import { Client } from "@modelcontextprotocol/client";
import { SSEClientTransport } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { providerFetch, providerResponseError } from "./provider-runtime.ts";

const mcpConnectTimeoutMs = 60_000;
const modernMcpProtocolVersion = "2026-07-28";
const mcpJsonSchemaValidator = new CfWorkerJsonSchemaValidator();

export type McpHttpTransport = "streamable_http" | "sse";
export type McpProtocolVersion = "legacy" | "modern";

export interface McpClientOptions {
  endpoint: URL;
  transport: McpHttpTransport;
  fetcher?: typeof fetch;
  headers?: HeadersInit;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
  protocolVersion?: McpProtocolVersion;
  mapError?: (error: unknown) => unknown;
  /** Bound each response while retaining streaming JSON/SSE protocol framing. */
  maxResponseBytes?: number;
}

export async function withMcpClient<T>(options: McpClientOptions, run: (client: Client) => Promise<T>): Promise<T> {
  let responseSizeError: Error | undefined;
  const transportOptions = {
    fetch:
      options.maxResponseBytes === undefined
        ? options.fetcher
        : limitMcpResponseBytes(options.fetcher ?? providerFetch, options.maxResponseBytes, (error) => {
            responseSizeError = error;
            // An SSE read error alone does not reject pending RPCs. Closing the client unblocks them.
            void client.close().catch(() => undefined);
          }),
    requestInit: {
      headers: options.headers,
      redirect: options.redirect,
      signal: options.signal,
    },
  };
  const transport =
    options.transport === "sse"
      ? new SSEClientTransport(options.endpoint, transportOptions)
      : new StreamableHTTPClientTransport(options.endpoint, transportOptions);
  const client = new Client(
    { name: "open-connector", version: "1.0.0" },
    {
      jsonSchemaValidator: mcpJsonSchemaValidator,
      versionNegotiation: { mode: resolveVersionNegotiationMode(options.protocolVersion) },
    },
  );

  try {
    await client.connect(transport, { timeout: mcpConnectTimeoutMs, signal: options.signal });
    return await run(client);
  } catch (error) {
    if (responseSizeError) throw responseSizeError;
    throw options.mapError ? options.mapError(error) : error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function limitMcpResponseBytes(fetcher: typeof fetch, maxBytes: number, onLimit: (error: Error) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.body) return response;
    let size = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > maxBytes) {
            const error = providerResponseError("MCP response exceeds the size limit.");
            onLimit(error);
            throw error;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function resolveVersionNegotiationMode(protocolVersion: McpProtocolVersion | undefined): VersionNegotiationMode {
  return protocolVersion === "modern" ? { pin: modernMcpProtocolVersion } : "legacy";
}
