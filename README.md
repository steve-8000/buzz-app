# Gram

Gram is a desktop fork of [Buzz](https://github.com/block/buzz-app). An Oh My Pi
(omp) agent in a thread shows its work there as a session: its text, tool
calls, plans and questions, in order, readable by everyone in the conversation.

## Self-hosted setup

Gram starts with a local identity and a community address supplied by the user.
It does not configure the public Builderlab sign-in server or hosted
communities by default. An operator can explicitly configure an identity
server for a self-hosted deployment with `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG`.
The community Relay must be running separately.

omp runs on this computer; the selected model provider may still send prompts
to its own remote API.

On macOS, Gram stores its own identities, agent keys and tokens in
`~/.gram/secrets` as unencrypted local files, with a `0700` directory and `0600`
files. Other processes running as the same user and backups of that directory
can read them. Existing Gram Keychain items are not imported automatically.
The explicit Buzz identity import reads the old Buzz Keychain without removing
its original. omp manages its own provider authentication.

## Agent sessions

Create an agent with the **Oh My Pi** harness (plugin `buzz.omp`, type `omp`)
and choose its model, repository folders and workspace. The `omp` executable
must be installed and authenticated. Mention the agent in a channel and it
answers in a thread; each thread is one omp session in its own git worktree.

The agent drives omp in `--mode rpc-ui` on this computer. What it does is
written to the conversation as items: one NIP-AR artifact (kind 45010, type
`gram.session.item`) per step, rewritten as the step changes. The thread draws
them between its messages, so every member who can read the thread follows the
run, and the computer that runs the agent shows it without waiting for the
relay. Only Gram draws these items; other Buzz clients show the thread's
messages and ignore the artifacts.

The request, the agent's final answer and its approval questions stay ordinary
messages, so replies, mentions and the mobile buttons keep working. An approval
or question also appears as a card in the thread; only the computer that runs
the agent can answer it, and answering from the card or by message settles the
same question.

Items include tool input and output, file contents and diffs, and are readable
by every member of the channel. Strings that look like credentials (API keys,
tokens, private keys, `NAME_TOKEN=value` assignments) are masked and each item
is cut to fit one event, but masking is a heuristic: do not point an agent at
secrets you do not want the channel to read. An item is written at most every
few seconds while it changes, within the relay's write limit for agents.

Data lives under `~/.gram/omp`: sessions in `sessions/`, worktrees in
`worktrees/`. Sessions and worktrees an earlier build kept under `~/.buzz/omp`
are not read or moved. The default non-repository workspace is
`~/.gram/workspaces`. The application identifier is `one.clab.gram`, with
separate credential namespaces from Buzz.

A conversation that is not a thread has no thread to show its session in: a DM,
a Solo chat, or an agent set to one conversation per channel. The agent answers
there as before.

The activity bubble under a request opens the session in a side panel, with each
run's prompt and, from two runs on, an outline rail to jump between them. For a
conversation that is not a thread the panel is the only place to read the
session, and it shows only what this computer ran.

How a session reads is a per-device choice, as in Paseo, under **Settings** →
**Appearance** → **Agent sessions**. *Always expand reasoning* shows thinking
open instead of as one line. *Chat display* is Full; Collapse tool calls, which
folds a run of tool calls into one line such as "Edited 2 files and ran 3
commands"; or Collapse turns, which folds a finished run into one line under its
request (a run that failed, stopped or never answered stays open, and so does
the one still working). *Chat outline* turns the rail on or off.

## Build

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
Node.js, Rust and pnpm, then run:

```sh
pnpm install
pnpm tauri build --bundles app
```

On macOS (13.5+) the bundle is `target/release/bundle/macos/Gram.app`.
Use `pnpm tauri dev` for development. The bundled `buzz` CLI and community
protocols keep their upstream names for interoperability.

Local builds do not enable the upstream release updater. This fork does not
claim upstream signing or notarization.

## Upstream and licensing

Buzz and Paseo are Apache-2.0 projects. The omp tool-call mapping in
`src/bundled/omp/transcript` follows Paseo's omp provider, source revision
`d13438ba50ed74c0d9057370b5f5c781aee0f687`; Paseo itself is not embedded or
run.

- [Buzz license](LICENSE) and [source attribution](NOTICE.md)
- [Paseo license](LICENSE.paseo)
- [Plugin architecture](docs/plugin-architecture.md)
- [Upstream contributing guide](docs/contributing.md)
