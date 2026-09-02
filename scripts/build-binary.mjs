import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const target = process.env.OPEN_CONNECTOR_BINARY_TARGET ?? "bun-linux-x64";
const output = process.env.OPEN_CONNECTOR_BINARY_OUTPUT ?? join(root, "dist/open-connector-linux-x64");

await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/server/index.ts")],
  compile: {
    target,
    outfile: output,
    assets: [join(root, "migrations"), join(root, "catalog"), join(root, "dist/web")],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  // urllib only loads this optional peer when Aliyun OSS proxy mode is enabled;
  // OpenConnector never enables that mode. Bun still tries to resolve the
  // dormant require while bundling unless it is explicitly externalized.
  external: ["proxy-agent"],
  format: "esm",
  minify: {
    syntax: true,
    whitespace: true,
  },
  naming: {
    asset: "[dir]/[name].[ext]",
  },
  target: "bun",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await chmod(output, 0o755);
const bytes = (await stat(output)).size;
console.log(`Built ${output} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
