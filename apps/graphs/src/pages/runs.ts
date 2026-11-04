// SPDX-License-Identifier: Apache-2.0
/**
 * What a shared document runs on the installer's machine.
 *
 * A graph or node document is code: check and gate nodes run shell
 * commands with the user's permissions, hooks run commands too, and
 * agent nodes carry prompts that steer an agent able to edit files and
 * run tools. This module reads those out of an already-loaded validated
 * document — it never fetches, never validates, never throws — so the
 * document pages can show every command verbatim and every agent
 * instruction readable before anyone installs.
 *
 * Commands come from check/gate `config.command` and hook `command`
 * fields. Prompts come from agent `prompt_template`/`prompt_override`,
 * ensemble `prompt_template` plus each member's `prompt_override`, hook
 * `prompt` fields, and `prompt_preset` references: the bundled preset
 * content when the document ships it (a graph's format v6 `presets`
 * map, a node's `preset`), otherwise the preset name itself — a canopy
 * builtin such as implementer, reviewer or resilience, whose text lives
 * in the harness, not the document.
 *
 * The attention patterns below name the command shapes worth a second
 * look. A match only earns a chip; it never hides or blocks anything.
 */
import type { DocumentKind, JsonValue } from "../../../../src/schema.js";
import { isArray, isRecord, isString } from "../json.js";

/** One shell command: where it runs and its verbatim text. */
export interface RunCommand {
  where: string;
  text: string;
}

/** Where a prompt's text came from: written inline, bundled, or a builtin. */
export type PromptSource = "inline" | "bundled" | "builtin";

/** One agent instruction: where it steers, its text, and its source. */
export interface RunPrompt {
  where: string;
  text: string;
  source: PromptSource;
}

/** Everything a document runs: shell commands and agent instructions. */
export interface Runs {
  commands: RunCommand[];
  prompts: RunPrompt[];
}

/** One command shape worth a second look: its name and its matcher. */
export interface AttentionPattern {
  /** Stable id, for tests. */
  id: string;
  /** The name the chip shows. */
  label: string;
  /** True when one command line carries the shape. */
  test: (line: string) => boolean;
}

/**
 * A command token starts the line or follows a shell separator — never
 * inside another word, so `evaluation` is not `eval` and `no-sudo-here`
 * is not `sudo`.
 */
const TOKEN = "(?:^|[\\s;&|()])";
const SUDO_RE = new RegExp(`${TOKEN}sudo(?=[\\s;&|()"']|$)`);
const RM_RF_RE = new RegExp(`${TOKEN}rm\\s+-(?=[A-Za-z]*[rR])(?=[A-Za-z]*[fF])[A-Za-z]+\\b`);
const CHMOD_RE = new RegExp(`${TOKEN}chmod\\b[^|;&]*777`);
const GIT_PUSH_RE = new RegExp(`${TOKEN}git\\s+push\\b`);
const FORCE_RE = /--force([-=\s]|$)/;
const SENSITIVE_PATH_RE = /(?:^|[\s"'=])~\/\.(ssh|config)(?:\/|$)|(?:^|[\s"'=])\/etc(?:\/|$)/;
const WRITE_VERB_RE = new RegExp(`${TOKEN}(cp|mv|install|tee|mkdir|touch|chmod|chown|ln|rsync|scp)\\b`);
const EVAL_RE = new RegExp(`${TOKEN}eval(?=[\\s;&|()"']|$)`);
const BASE64_RE = new RegExp(`${TOKEN}base64\\b[^|;&]*?(?:-d\\b|--decode\\b)`);
const PIPE_PYTHON_RE = /\|\s*python[23]?(?:\.\d+)?\s+-c\b/;
const PIPE_NODE_RE = /\|\s*node\s+-e\b/;
const PIPE_SHELL_RE = /\|\s*(\S*\/)?(bash|sh)(\s|$|[;&])/;

/**
 * The command shapes that earn an `attention` chip, in chip order. Each
 * entry is one spec bullet: pipes into a shell, sudo, rm -rf, chmod
 * 777, git push or --force, writes under the sensitive paths, eval,
 * and decode-then-execute. Every entry has its unit test in
 * test/runs.test.ts, example and benign near-miss alike.
 */
export const ATTENTION_PATTERNS: AttentionPattern[] = [
  {
    id: "pipe-to-shell",
    label: "pipe to shell",
    test: (line) => PIPE_SHELL_RE.test(line),
  },
  {
    id: "sudo",
    label: "sudo",
    test: (line) => SUDO_RE.test(line),
  },
  {
    id: "rm-rf",
    label: "rm -rf",
    test: (line) => RM_RF_RE.test(line),
  },
  {
    id: "chmod-777",
    label: "chmod 777",
    test: (line) => CHMOD_RE.test(line),
  },
  {
    id: "git-push-force",
    label: "git push or --force",
    test: (line) => GIT_PUSH_RE.test(line) || FORCE_RE.test(line),
  },
  {
    id: "sensitive-path",
    label: "sensitive path write",
    test: (line) =>
      SENSITIVE_PATH_RE.test(line) && (line.includes(">") || WRITE_VERB_RE.test(line)),
  },
  {
    id: "eval",
    label: "eval",
    test: (line) => EVAL_RE.test(line),
  },
  {
    id: "decode-execute",
    label: "decode and execute",
    test: (line) => BASE64_RE.test(line) || PIPE_PYTHON_RE.test(line) || PIPE_NODE_RE.test(line),
  },
];

/**
 * The attention labels for one command, in pattern order: every pattern
 * matching any of its lines, each named once.
 */
export function attentionFor(text: string): string[] {
  const labels: string[] = [];
  for (const pattern of ATTENTION_PATTERNS) {
    if (text.split(/\r?\n/).some((line) => pattern.test(line))) {
      labels.push(pattern.label);
    }
  }
  return labels;
}

/** The hook events, in document order. */
const HOOK_EVENTS = ["on_completed", "on_failed", "on_blocked", "on_spec_completed"];

/** A string field, or null when absent or not a string. */
function field(record: { [key: string]: JsonValue }, key: string): string | null {
  const value = record[key];
  return isString(value) ? value : null;
}

/** A record field, or null when absent or not an object. */
function recordField(value: unknown): { [key: string]: JsonValue } | null {
  return isRecord(value) ? value : null;
}

/** Preset content as prompt text: strings verbatim, anything else as JSON. */
function contentText(content: JsonValue | undefined): string | null {
  if (content === undefined) {
    return null;
  }
  return isString(content) ? content : (JSON.stringify(content, null, 2) ?? "null");
}

/** The bundled content of a graph preset, by name. */
function bundledPreset(presets: { [key: string]: JsonValue } | null, name: string): string | null {
  if (presets === null) {
    return null;
  }
  const preset = recordField(presets[name]);
  if (preset === null) {
    return null;
  }
  return contentText(preset["content"]);
}

/** One agent node's prompts: template, override, then its preset. */
function agentPrompts(
  where: string,
  config: { [key: string]: JsonValue } | null,
  presets: { [key: string]: JsonValue } | null,
): RunPrompt[] {
  if (config === null) {
    return [];
  }
  const prompts: RunPrompt[] = [];
  const template = field(config, "prompt_template");
  if (template !== null) {
    prompts.push({ where, text: template, source: "inline" });
  }
  const override = field(config, "prompt_override");
  if (override !== null) {
    prompts.push({ where, text: override, source: "inline" });
  }
  const preset = field(config, "prompt_preset");
  if (preset !== null) {
    const bundled = bundledPreset(presets, preset);
    prompts.push(
      bundled === null
        ? { where, text: preset, source: "builtin" }
        : { where, text: bundled, source: "bundled" },
    );
  }
  return prompts;
}

/** A graph's completion hooks: every command and every prompt, by event. */
function hookRuns(hooks: unknown): Runs {
  const commands: RunCommand[] = [];
  const prompts: RunPrompt[] = [];
  if (!isRecord(hooks)) {
    return { commands, prompts };
  }
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event];
    if (!isArray(entries)) {
      continue;
    }
    let position = 0;
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }
      position += 1;
      const where = `hook ${event} #${position}`;
      const command = field(entry, "command");
      if (command !== null) {
        commands.push({ where, text: command });
      }
      const prompt = field(entry, "prompt");
      if (prompt !== null) {
        prompts.push({ where, text: prompt, source: "inline" });
      }
    }
  }
  return { commands, prompts };
}

/** What a graph document runs: node commands, node and ensemble prompts, hooks. */
function graphRuns(document: { [key: string]: JsonValue }): Runs {
  const commands: RunCommand[] = [];
  const prompts: RunPrompt[] = [];
  const presets = recordField(document["presets"]);
  const nodes = document["nodes"];
  if (isArray(nodes)) {
    for (const node of nodes) {
      if (!isRecord(node)) {
        continue;
      }
      const name = field(node, "name") ?? "node";
      const where = `node "${name}"`;
      const kind = field(node, "kind");
      const config = recordField(node["config"]);
      if ((kind === "check" || kind === "gate") && config !== null) {
        const command = field(config, "command");
        if (command !== null) {
          commands.push({ where, text: command });
        }
      }
      if (kind === "agent") {
        prompts.push(...agentPrompts(where, config, presets));
      }
    }
  }
  const ensembles = document["ensembles"];
  if (isArray(ensembles)) {
    for (const ensemble of ensembles) {
      if (!isRecord(ensemble)) {
        continue;
      }
      const name = field(ensemble, "name") ?? "ensemble";
      const template = field(ensemble, "prompt_template");
      if (template !== null) {
        prompts.push({ where: `ensemble "${name}"`, text: template, source: "inline" });
      }
      const members = ensemble["members"];
      if (isArray(members)) {
        members.forEach((member, index) => {
          if (!isRecord(member)) {
            return;
          }
          const override = field(member, "prompt_override");
          if (override !== null) {
            prompts.push({ where: `ensemble "${name}" member ${index + 1}`, text: override, source: "inline" });
          }
        });
      }
    }
  }
  const hooks = hookRuns(document["hooks"]);
  return { commands: [...commands, ...hooks.commands], prompts: [...prompts, ...hooks.prompts] };
}

/** What a node document runs: its command, or its template, or its preset. */
function nodeRuns(document: { [key: string]: JsonValue }): Runs {
  const commands: RunCommand[] = [];
  const prompts: RunPrompt[] = [];
  const where = `node "${field(document, "name") ?? "node"}"`;
  const config = recordField(document["config"]);
  if (config !== null) {
    const command = field(config, "command");
    if (command !== null) {
      commands.push({ where, text: command });
    }
    const template = field(config, "prompt_template");
    if (template !== null) {
      prompts.push({ where, text: template, source: "inline" });
    }
    const override = field(config, "prompt_override");
    if (override !== null) {
      prompts.push({ where, text: override, source: "inline" });
    }
  }
  const preset = recordField(document["preset"]);
  const content = preset === null ? null : contentText(preset["content"]);
  const referenced = config === null ? null : field(config, "prompt_preset");
  if (referenced !== null) {
    prompts.push(
      content === null
        ? { where, text: referenced, source: "builtin" }
        : { where, text: content, source: "bundled" },
    );
  } else if (content !== null && preset !== null && isString(preset["content"])) {
    // A preset shipped without a reference still steers the node — but a
    // non-string content is harness parameters, not an instruction.
    prompts.push({ where, text: content, source: "bundled" });
  }
  return { commands, prompts };
}

/**
 * What a validated document runs. Total: anything unreadable simply runs
 * nothing, so a page never fails to render for this section.
 */
export function runsOf(kind: DocumentKind, document: unknown): Runs {
  if (!isRecord(document)) {
    return { commands: [], prompts: [] };
  }
  return kind === "graph" ? graphRuns(document) : nodeRuns(document);
}
