# Gram

Gram is a desktop fork of [Buzz](https://github.com/block/buzz-app). Its main
community chat opens the original Paseo agent chat in a Thread on the right.

## Self-hosted setup

Gram starts with a local identity and a community address supplied by the user.
It does not configure the public Builderlab sign-in server or hosted
communities by default. An operator can explicitly configure an identity
server for a self-hosted deployment with `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG`.
The community Relay must be running separately.

The embedded Paseo runtime is local; the selected model provider may still
send prompts to its own remote API.

On macOS, Gram stores its own identities, agent keys and tokens in
`~/.gram/secrets` as unencrypted local files, with a `0700` directory and `0600`
files. Other processes running as the same user and backups of that directory
can read them. Existing Gram Keychain items are not imported automatically.
The explicit Buzz identity import reads the old Buzz Keychain without removing
its original. Provider CLIs manage their own authentication.

## Agent workspaces

Enable **Gram Agent** in **Settings → Plugins**, then create an agent with the
**Gram Agent** harness. Choose its provider, model, workspace and repository
settings. The inherited plugin identity `buzz.omp/omp` remains unchanged.
Provider, model, instructions and workspace settings apply when a workstream
is created; existing sessions retain their captured configuration.

Mention an agent in the main chat to open its Paseo conversation in a Thread.
The original Paseo conversation, composer and permission controls run directly
inside Gram's existing Thread panel. Gram retains its channels, workspaces and
tab navigation; supporting Paseo views open in Gram tabs. Multiple agents in
one Thread can be selected separately. If startup fails, the request and local
error remain visible while Gram is open.

Gram owns one authenticated Paseo runtime bound to an ephemeral loopback port.
It exposes the daemon's WebSocket, not a hosted Paseo web app; Paseo Relay and
hosted Paseo services are not enabled. The short-lived runtime password is
passed in memory, not in a URL or persistent host registry. Provider execution
is not duplicated through the old direct OMP launcher. OMP is explicitly
enabled and new sessions use a non-unattended permission mode. A configured
model provider may still require its own network service.

The request is a community message. Once the Paseo Thread opens, its results
and follow-up messages remain local and only a completion notice is posted.
An initial answer that completed before the Thread opened may already have
been posted to the community. Tool output, permissions, terminal I/O, diffs
and runtime diagnostics are not automatically published.

Session bindings, new conversation drafts and queued messages persist in Gram's
local app data. Drafts from the previous embedded browser origin are not
automatically migrated; its existing WebKit data is not deleted. The runtime
and session database live under `~/.gram/runtime`; repository worktrees live
under `~/.gram/worktrees` and are retained with the sessions.
The default non-repository workspace is `~/.gram/workspaces`, separate from
the runtime's private data. Paseo dictation and voice mode are disabled so
startup does not download speech models.
The application identifier is `one.clab.gram`, with separate credential
namespaces from Buzz. Provider CLIs and their existing authentication are
still used; Gram does not copy their credentials.

## Build

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
Node.js, Rust and pnpm, then run:

```sh
pnpm install
pnpm tauri build --bundles app
```

The Tauri build hook stages the pinned Paseo server, CLI, production
dependencies, native PTY module and Node executable before building the app.
On macOS (13.5+) the bundle is `target/release/bundle/macos/Gram.app`.
Use `pnpm tauri dev` for development; it also stages the runtime.
The chosen provider executable (for example `omp`) must be installed and
authenticated. The bundled `buzz` CLI and community protocols keep their
upstream names for interoperability.
Node `26.7.0` is an official standalone distribution, pinned with SHA-256 in
`runtime/node.json`; Homebrew's dynamically linked executable is not copied.
Stage the native runtime on a matching OS/architecture build host.
Dependencies use a hoisted deployment layout so Tauri includes real package
directories rather than dropping pnpm's directory symlinks.

Local builds do not enable the upstream release updater. This fork does not
claim upstream signing or notarization.

## Upstream and licensing

Buzz and Paseo are Apache-2.0 projects. The embedded Paseo server and client are
pinned to `0.16.0-beta.2`; the original conversation components are built from
Paseo source revision `d13438ba50ed74c0d9057370b5f5c781aee0f687`.

- [Buzz license](LICENSE) and [source attribution](NOTICE.md)
- [Paseo license](LICENSE.paseo)
- [Plugin architecture](docs/plugin-architecture.md)
- [Upstream contributing guide](docs/contributing.md)

