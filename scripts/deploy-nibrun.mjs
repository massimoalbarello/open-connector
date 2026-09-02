import { spawnSync } from "node:child_process";

const FAILURE_EXIT_CODE = 1;
const APP_NAME = "open-connector";
const APP_SLUG_PREFIX = `${APP_NAME}-`;
const BINARY_FILE = "dist/open-connector-linux-x64";
const DEFAULT_PORT = "3000";
const REQUIRED_SECRETS = ["OOMOL_CONNECT_ENCRYPTION_KEY", "OOMOL_CONNECT_ADMIN_TOKEN", "OOMOL_CONNECT_RUNTIME_TOKEN"];

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (result.error?.code === "ENOENT") {
    console.error(
      [
        `The required executable \`${command}\` was not found on PATH.`,
        command === "nib"
          ? "Install nibrun with `curl -fsSL https://nibrun.com/install.sh | sh`, then run `nib login`."
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    process.exit(FAILURE_EXIT_CODE);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? FAILURE_EXIT_CODE);
  }
  return result.stdout ?? "";
}

function nibJson(args) {
  const serialized = run("nib", ["--json", ...args], { capture: true }).trim();
  const lines = serialized.split("\n");
  if (lines.length !== 1 || !lines[0]) {
    unexpectedNibResponse(args);
  }
  try {
    return JSON.parse(lines[0]);
  } catch {
    unexpectedNibResponse(args);
  }
}

function unexpectedNibResponse(args) {
  console.error(`nib --json ${args.join(" ")} returned an unexpected response; update nib and try again.`);
  process.exit(FAILURE_EXIT_CODE);
}

const response = nibJson(["apps", "list"]);
if (!Array.isArray(response.apps)) {
  unexpectedNibResponse(["apps", "list"]);
}

const matchingApps = response.apps
  .map((app) => app?.slug)
  .filter((slug) => typeof slug === "string" && slug.startsWith(APP_SLUG_PREFIX));

if (matchingApps.length > 1) {
  console.error(
    [
      "Found multiple OpenConnector apps on nibrun:",
      ...matchingApps.map((slug) => `  ${slug}`),
      "",
      "Deploy with `nib run` directly so the target is explicit.",
    ].join("\n"),
  );
  process.exit(FAILURE_EXIT_CODE);
}

const [appSlug] = matchingApps;
const target = appSlug ? ["--app", appSlug] : ["--name", APP_NAME];
const secretArguments = [];

if (!appSlug) {
  const missingSecrets = REQUIRED_SECRETS.filter((name) => !process.env[name]);
  if (missingSecrets.length > 0) {
    console.error(
      [
        "The first deployment requires these environment variables:",
        ...missingSecrets.map((name) => `  ${name}`),
        "",
        "Generate and save long random values before running this command again. For example:",
        ...missingSecrets.map((name) => `  export ${name}="$(openssl rand -base64 32)"`),
        "",
        "The encryption key must remain available for as long as its persisted data is needed.",
      ].join("\n"),
    );
    process.exit(FAILURE_EXIT_CODE);
  }

  for (const name of REQUIRED_SECRETS) {
    secretArguments.push("--env", `${name}=${process.env[name]}`);
  }
}

run("npm", ["run", "build:binary"]);
run("nib", ["run", BINARY_FILE, ...target, "--port", DEFAULT_PORT, ...secretArguments]);
