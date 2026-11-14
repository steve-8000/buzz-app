# Oh My Pi

Create agents that run [Oh My Pi](https://omp.sh) (`omp`) on your computer and answer you in Buzz. Each thread works in its own git worktree with its own omp session, and everyone in the thread watches the work as it happens.

## Getting started

1. Install `omp` and sign in to a model provider with it. Buzz starts `omp --mode rpc-ui`, so `omp` must be on this computer's `PATH`.
2. Turn on **Oh My Pi** in **Settings** → **Plugins**.
3. Choose **New agent** → **Create a new agent**, pick **Oh My Pi** as the **Harness**, and set the repository it works on.
4. Mention your agent in a conversation to give it work. Its reasoning, tool calls and results appear in the thread as they happen; approve or answer its requests there.

---

# Oh My Pi for Agents

One `omp --mode rpc-ui` process per agent ([`runtime.ts`](runtime.ts)). The plugin owns the turn after handover: it turns omp's events into session items ([`transcript/`](transcript)), and the agent publishes each item as its own artifact, so every member's thread shows the same session ([`src/features/agent-session`](../../features/agent-session)).

## Limits

- A session is shown in the thread it runs in. A Solo chat, a DM and a channel-wide session are shown only on this computer.
- Nothing prunes a session's items; they stay as long as the relay keeps artifacts.
- Items not yet sent when the app quits are never sent, and the run they belong to ends with the quit.
- Only the agent that is waiting on an approval or a question can have it answered from its card. A card from any other author is read-only.
