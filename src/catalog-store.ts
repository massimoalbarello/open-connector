import type { ActionDefinition, AuthType, JsonSchema, ProviderDefinition, ProviderScenario } from "./core/types.ts";

import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sortProviders } from "./core/catalog.ts";
import { resolveProviderScenario } from "./core/provider-scenarios.ts";

export type ActionExecutionStatus = {
  locallyExecutable: boolean;
  catalogOnly: boolean;
  requiredAuthTypes: AuthType[];
  noAuthRunnable: boolean;
  needsCredential: boolean;
};

export type RuntimeActionDefinition = ActionDefinition & {
  execution: ActionExecutionStatus;
};

export type RuntimeProviderDefinition = Omit<ProviderDefinition, "actions"> & {
  actions: RuntimeActionDefinition[];
  /** Stable task-oriented category supplied to local catalog clients. */
  scenario: ProviderScenario;
  execution: {
    actionCount: number;
    locallyExecutableActionCount: number;
    catalogOnlyActionCount: number;
  };
};

/**
 * Action without its JSON schemas.
 *
 * `inputSchema`/`outputSchema` are ~85% of the serialized catalog but are only
 * needed by the single action detail view, which fetches the full action from
 * `/api/actions/:actionId`. List views read metadata only.
 */
type ActionSummaryDefinition = Omit<RuntimeActionDefinition, "inputSchema" | "outputSchema">;

/** One provider as `/api/providers` serves it to list views: metadata plus schema-free actions. */
export type ProviderSummaryDefinition = Omit<RuntimeProviderDefinition, "actions"> & {
  actions: ActionSummaryDefinition[];
};

/**
 * In-memory view of generated catalog JSON.
 *
 * `actionsById` is built at load time so request handlers do not repeatedly
 * scan every provider.
 */
export type CatalogStore = {
  providers: RuntimeProviderDefinition[];
  /**
   * Schema-free view of `providers`, pre-serialized once because the catalog is
   * immutable at runtime. Served verbatim by `/api/providers` so the dashboard
   * does not download every action schema on load, and so the response is
   * neither re-serialized per request nor able to drift from
   * {@link providerSummariesEtag}.
   */
  providerSummariesJson: string;
  /**
   * Stable ETag for `providerSummariesJson`. The catalog is immutable at
   * runtime, so this is computed once and lets `/api/providers` answer
   * conditional requests with `304 Not Modified`.
   */
  providerSummariesEtag: string;
  actions: RuntimeActionDefinition[];
  actionsById: Map<string, RuntimeActionDefinition>;
  executableActionIds: Set<string>;
};

export interface CreateCatalogStoreOptions {
  executableActionIds?: Iterable<string>;
}

export interface LoadCatalogOptions extends CreateCatalogStoreOptions {
  /** Mark every catalog action owned by these locally loaded provider services as executable. */
  executableServices?: Iterable<string>;
}

interface ActionSchemas {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const actionSchemaSource = Symbol("catalog action schema source");
const schemaCacheSize = 8;

interface LazyActionDefinition extends ActionDefinition {
  [actionSchemaSource]?: FileActionSchemaSource;
}

interface LazyRuntimeActionDefinition extends RuntimeActionDefinition {
  [actionSchemaSource]: FileActionSchemaSource;
}

export function createCatalogStore(
  providers: ProviderDefinition[],
  options: CreateCatalogStoreOptions = {},
): CatalogStore {
  const sortedProviders = sortProviders(providers);
  const executableActions = new Set(options.executableActionIds ?? []);
  const runtimeProviders = sortedProviders.map((provider): RuntimeProviderDefinition => {
    const actions = provider.actions.map((action): RuntimeActionDefinition => {
      const runtimeAction: RuntimeActionDefinition = {
        ...action,
        execution: createActionExecutionStatus(provider, action, executableActions),
      };
      const source = (action as LazyActionDefinition)[actionSchemaSource];
      if (source) {
        attachLazyActionSchemas(runtimeAction, source);
      }
      return runtimeAction;
    });

    return {
      ...provider,
      actions,
      scenario: resolveProviderScenario(provider),
      execution: {
        actionCount: actions.length,
        locallyExecutableActionCount: actions.filter((action) => action.execution.locallyExecutable).length,
        catalogOnlyActionCount: actions.filter((action) => action.execution.catalogOnly).length,
      },
    };
  });
  const actions = runtimeProviders.flatMap((provider) => provider.actions);
  const providerSummaries = runtimeProviders.map(toProviderSummary);
  const providerSummariesJson = JSON.stringify(providerSummaries);

  return {
    providers: runtimeProviders,
    providerSummariesJson,
    providerSummariesEtag: weakEtag(providerSummariesJson),
    actions,
    actionsById: new Map(actions.map((action) => [action.id, action])),
    executableActionIds: executableActions,
  };
}

/**
 * Content-derived ETag using a pure-JS FNV-1a hash. Runtime-agnostic (no
 * `node:crypto`, so the Cloudflare Workers build shares this path) and computed
 * once per catalog. Emitted as a weak validator because the response body may
 * be gzip-transformed downstream.
 */
function weakEtag(content: string): string {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  const digest = (hash >>> 0).toString(16).padStart(8, "0");
  return `W/"${content.length.toString(16)}-${digest}"`;
}

function toProviderSummary(provider: RuntimeProviderDefinition): ProviderSummaryDefinition {
  return {
    ...provider,
    actions: provider.actions.map((action) => {
      const summary: Record<string, unknown> = {};
      for (const key of Object.keys(action)) {
        if (key === "inputSchema" || key === "outputSchema") {
          continue;
        }
        summary[key] = action[key as keyof RuntimeActionDefinition];
      }
      return summary as ActionSummaryDefinition;
    }),
  };
}

/**
 * Load catalog metadata from disk while keeping the large action schemas
 * file-backed and bounded by a small least-recently-used cache.
 */
export async function loadCatalog(
  catalogDir: string = join(process.cwd(), "catalog/apps"),
  options: LoadCatalogOptions = {},
): Promise<CatalogStore> {
  const entries = await readdir(catalogDir, { withFileTypes: true });
  const providers: ProviderDefinition[] = [];
  const schemaLoader = new FileActionSchemaLoader(schemaCacheSize);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = join(catalogDir, entry.name);
    const content = await readFile(filePath, "utf8");
    const provider = JSON.parse(content) as ProviderDefinition;
    const source = new FileActionSchemaSource(filePath, schemaLoader);
    providers.push({
      ...provider,
      actions: provider.actions.map((action) => createLazyActionDefinition(action, source)),
    });
  }
  return createCatalogStore(providers, {
    executableActionIds: resolveExecutableActionIds(providers, options),
  });
}

function createLazyActionDefinition(action: ActionDefinition, source: FileActionSchemaSource): ActionDefinition {
  const { inputSchema: _inputSchema, outputSchema: _outputSchema, ...metadata } = action;
  Object.defineProperty(metadata, actionSchemaSource, { value: source });
  return metadata as ActionDefinition;
}

function attachLazyActionSchemas(action: RuntimeActionDefinition, source: FileActionSchemaSource): void {
  Object.defineProperties(action, {
    [actionSchemaSource]: { value: source },
    inputSchema: { get: readLazyInputSchema, enumerable: true },
    outputSchema: { get: readLazyOutputSchema, enumerable: true },
  });
}

function readLazyInputSchema(this: LazyRuntimeActionDefinition): JsonSchema {
  return this[actionSchemaSource].get(this.id).inputSchema;
}

function readLazyOutputSchema(this: LazyRuntimeActionDefinition): JsonSchema {
  return this[actionSchemaSource].get(this.id).outputSchema;
}

class FileActionSchemaSource {
  readonly filePath: string;
  private readonly loader: FileActionSchemaLoader;

  constructor(filePath: string, loader: FileActionSchemaLoader) {
    this.filePath = filePath;
    this.loader = loader;
  }

  get(actionId: string): ActionSchemas {
    return this.loader.get(this.filePath, actionId);
  }
}

class FileActionSchemaLoader {
  private readonly cache = new Map<string, Map<string, ActionSchemas>>();
  private readonly maxCachedFiles: number;

  constructor(maxCachedFiles: number) {
    this.maxCachedFiles = maxCachedFiles;
  }

  get(filePath: string, actionId: string): ActionSchemas {
    let schemas = this.cache.get(filePath);
    if (schemas) {
      this.cache.delete(filePath);
      this.cache.set(filePath, schemas);
    } else {
      const provider = JSON.parse(readFileSync(filePath, "utf8")) as ProviderDefinition;
      schemas = new Map(
        provider.actions.map((action) => [
          action.id,
          { inputSchema: action.inputSchema, outputSchema: action.outputSchema },
        ]),
      );
      this.cache.set(filePath, schemas);
      if (this.cache.size > this.maxCachedFiles) {
        const oldestFile = this.cache.keys().next().value;
        if (oldestFile) {
          this.cache.delete(oldestFile);
        }
      }
    }

    const result = schemas.get(actionId);
    if (!result) {
      throw new Error(`Catalog action schemas not found for ${actionId} in ${filePath}`);
    }
    return result;
  }
}

/** Resolve provider-level executable services into the exact action ids present in a loaded catalog. */
export function resolveExecutableActionIds(
  providers: ProviderDefinition[],
  options: LoadCatalogOptions = {},
): Set<string> {
  const actionIds = new Set(options.executableActionIds ?? []);
  const services = new Set(options.executableServices ?? []);
  for (const provider of providers) {
    if (services.has(provider.service)) {
      for (const action of provider.actions) {
        actionIds.add(action.id);
      }
    }
  }
  return actionIds;
}

function createActionExecutionStatus(
  provider: ProviderDefinition,
  action: ActionDefinition,
  executableActions: Set<string>,
): ActionExecutionStatus {
  const locallyExecutable = executableActions.has(action.id);
  return {
    locallyExecutable,
    catalogOnly: !locallyExecutable,
    requiredAuthTypes: provider.authTypes,
    noAuthRunnable: provider.authTypes.includes("no_auth"),
    needsCredential: !provider.authTypes.includes("no_auth"),
  };
}
