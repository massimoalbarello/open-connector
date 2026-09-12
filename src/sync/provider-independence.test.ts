import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps shared sync execution independent of concrete providers and sync definitions", () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const dependencies = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .flatMap((file) => {
      const source = readFileSync(join(directory, file), "utf8");
      // Shared provider infrastructure is allowed; concrete adapters and definitions belong in composition.
      return [...source.matchAll(/["']((?:\.\.\/)+(?:sync-definitions\/|providers\/[^/"']+\/)[^"']+)["']/g)].map(
        (match) => `${file}: ${match[1]}`,
      );
    });
  expect(dependencies).toEqual([]);
});
