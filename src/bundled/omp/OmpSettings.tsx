import { useState } from "react";
import type { AgentViewProps } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { type Config, config, THINKING_LEVELS } from "./config";

const THINKING = [
  {
    label: "Thinking",
    options: THINKING_LEVELS.map((level) => ({
      value: level,
      label: level || "omp's own choice",
    })),
  },
];

const SCOPES = [
  {
    label: "Conversations",
    options: [
      { value: "thread", label: "One worktree per thread" },
      { value: "channel", label: "One worktree per channel" },
    ],
  },
];

const number = (text: string, fallback: number) => {
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
};

export function OmpSettings({ agent, save }: AgentViewProps<Config>) {
  const saved = config(agent.config);
  const [draft, setDraft] = useState<Config>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const next = config(draft);
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);
  const set = <Key extends keyof Config>(key: Key, value: Config[Key]) =>
    setDraft({ ...draft, [key]: value });

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await save(next);
      setDraft(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup>
      <Field
        label="Repository folders"
        description="One per line: folders holding git repositories, or repositories themselves. A conversation works in the repository named like its channel, or named in its first message as repo:<name>. Otherwise it uses the repository below."
        optional
      >
        <Textarea
          value={draft.roots.join("\n")}
          placeholder={"~/4pillars\n~/thegram"}
          onChange={(event) => set("roots", event.target.value.split("\n"))}
        />
      </Field>
      <Field
        label="Repository"
        description="Each conversation works in its own git worktree of this repository. Leave empty to work in the folder below."
      >
        <Input
          value={draft.repo}
          placeholder="~/clab-one/my-repo"
          onChange={(event) => set("repo", event.target.value)}
        />
      </Field>
      <Field label="Base branch" description="New worktrees start from it.">
        <Input
          value={draft.base}
          onChange={(event) => set("base", event.target.value)}
        />
      </Field>
      <Field label="Folder" description="Used when no repository is set.">
        <Input
          value={draft.workspace}
          onChange={(event) => set("workspace", event.target.value)}
        />
      </Field>
      <Field
        label="Model"
        description="provider/model, such as anthropic/claude-sonnet-5-5. Empty keeps omp's own choice."
      >
        <Input
          value={draft.model}
          onChange={(event) => set("model", event.target.value)}
        />
      </Field>
      <Select
        label="Thinking"
        variant="field"
        value={draft.thinking}
        groups={THINKING}
        onValueChange={(value) => set("thinking", value)}
      />
      <Select
        label="Sessions"
        variant="field"
        value={draft.scope}
        groups={SCOPES}
        onValueChange={(value) =>
          set("scope", value === "channel" ? "channel" : "thread")
        }
      />
      <Field
        label="Turns at once"
        description="How many of this agent's turns run together on the repository (1–8)."
      >
        <Input
          type="number"
          min={1}
          max={8}
          value={String(draft.maxConcurrent)}
          onChange={(event) =>
            set(
              "maxConcurrent",
              number(event.target.value, draft.maxConcurrent),
            )
          }
        />
      </Field>
      <Field
        label="Approval wait (minutes)"
        description="A question to the owner is refused after this long without an answer."
      >
        <Input
          type="number"
          min={1}
          max={240}
          value={String(draft.approvalMinutes)}
          onChange={(event) =>
            set(
              "approvalMinutes",
              number(event.target.value, draft.approvalMinutes),
            )
          }
        />
      </Field>
      <Field label="Instructions" optional>
        <Textarea
          value={draft.instructions}
          onChange={(event) => set("instructions", event.target.value)}
        />
      </Field>
      {error && <p role="alert">{error}</p>}
      <Button
        variant="primary"
        disabled={!dirty || saving}
        loading={saving}
        onClick={() => void submit()}
      >
        Save
      </Button>
    </SettingsGroup>
  );
}
