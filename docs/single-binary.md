# Standalone Binary

OpenConnector can be packaged as one Linux x86-64 glibc executable. The generated provider catalog,
SQLite migrations, and built web console are embedded in the executable and materialized under a
replaceable hidden directory inside the runtime data directory on startup. The directory is removed
on a graceful shutdown and reused on restart, so hard-killed processes cannot leave accumulating
copies in the operating system's temporary filesystem.

Build it from a clean checkout with a current Node.js release, npm, and Bun:

```bash
npm ci
npm run build:binary
```

The output is `dist/open-connector-linux-x64`. It defaults to the normal local server settings. A
public deployment should configure `OOMOL_CONNECT_ENCRYPTION_KEY`,
`OOMOL_CONNECT_ADMIN_TOKEN`, and `OOMOL_CONNECT_RUNTIME_TOKEN` before exposing it publicly.

On nibrun, the executable automatically:

- listens on the assigned `NIBRUN_HTTP_PORT` at `0.0.0.0`;
- stores SQLite, transit-file data, and materialized runtime assets under `NIBRUN_DATA_DIR`;
- derives its OAuth and transit-file public origin from `https://$NIBRUN_HOSTNAME`.

The platform-owned `NIBRUN_HTTP_PORT`, `NIBRUN_DATA_DIR`, and `NIBRUN_HOSTNAME` values take effect
without deployment-specific wrappers. Explicit `PORT`, `HOST`, `OOMOL_CONNECT_DATA_DIR`, and
`OOMOL_CONNECT_ORIGIN` values continue to override the corresponding defaults.

The README deploy button uses the latest successful `main` build and asks for those secrets before
creating an app. To build and deploy from a checkout instead, install and authenticate the CLI,
then export secrets for the first deployment:

```bash
curl -fsSL https://nibrun.com/install.sh | sh
nib login

export OOMOL_CONNECT_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export OOMOL_CONNECT_ADMIN_TOKEN="$(openssl rand -base64 32)"
export OOMOL_CONNECT_RUNTIME_TOKEN="$(openssl rand -base64 32)"

npm run deploy:nibrun
```

Save all three values in a password manager before deploying. The command builds the binary and
creates an OpenConnector app on its first run. Later runs find that app and update it without
changing its environment.

The encryption key must remain stable across redeployments. Losing it makes encrypted credentials
in the persistent SQLite database unreadable.
