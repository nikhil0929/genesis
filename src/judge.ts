import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseJudgeAnswer, parseJudgments } from "./model.js";
import type {
  EventId,
  Finding,
  JudgeAnswer,
  Run,
  StaticProfile,
  ToolCallBundle,
  ToolDefinition,
} from "./model.js";

export type JudgeMode = "skip" | "if_absent" | "again";

const JUDGE_MODEL = "openai/gpt-4.1-mini";

const JUDGE_SYSTEM =
  "The question is whether what the call did matches what the tool claims. Citations must be event ids from the brief. The answer is not a maliciousness score.";

const JUDGE_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "judge_answer",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        opinion: { type: "string", enum: ["matches", "does_not_match", "unclear"] },
        mismatches: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              event_ids: { type: "array", items: { type: "string" } },
              explanation: { type: "string" },
            },
            required: ["event_ids", "explanation"],
          },
        },
        summary: { type: "string" },
      },
      required: ["opinion", "mismatches", "summary"],
    },
  },
} as const;

type JudgeBrief = {
  readonly call: ToolCallBundle;
  readonly profile: StaticProfile;
  readonly findings: readonly Finding[];
};

type ModelReply =
  | { readonly kind: "answer"; readonly answer: JudgeAnswer }
  | { readonly kind: "invalid"; readonly raw_text: string; readonly error: string };

function citableIds(call: ToolCallBundle): ReadonlySet<EventId> {
  return new Set(call.events.map((entry) => entry.event.event_id));
}

function advertisedTool(call: ToolCallBundle): ToolDefinition | null {
  switch (call.definition.kind) {
    case "advertised":
      return call.definition.tool;
    case "not_advertised":
      return null;
    default: {
      const unreachable: never = call.definition;
      throw new Error(String(unreachable));
    }
  }
}

function eventCounts(call: ToolCallBundle): { data: number; file: number; process: number; net: number; other: number } {
  const counts = { data: 0, file: 0, process: 0, net: 0, other: 0 };
  for (const entry of call.events) {
    switch (entry.event.body.kind) {
      case "data":
      case "file":
      case "process":
      case "net":
      case "other":
        counts[entry.event.body.kind] += 1;
        break;
      default: {
        const unreachable: never = entry.event.body;
        throw new Error(String(unreachable));
      }
    }
  }
  return counts;
}

function promptFor(brief: JudgeBrief): string {
  const tool = advertisedTool(brief.call);
  const text = brief.profile.tool_texts.find((item) => item.tool === brief.call.tool);
  const sites = brief.profile.tool_sites.find((item) => item.tool === brief.call.tool)?.sites ?? [];
  const files = new Set(sites.map((site) => site.file));
  const hints = brief.profile.api_hints.filter((hint) => files.has(hint.file));
  const callFindings = brief.findings.filter(
    (finding) => finding.kind === "call" && finding.call_id === brief.call.call_id,
  );
  return JSON.stringify({
    tool: brief.call.tool,
    escaped_description: text?.escaped_description ?? null,
    schema: tool?.input_schema ?? null,
    annotations: tool?.annotations ?? null,
    sites,
    hints,
    arguments: brief.call.arguments,
    outcome: brief.call.outcome,
    findings: callFindings,
    event_counts: eventCounts(brief.call),
  });
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function assistantContent(body: string): string {
  const root = record(JSON.parse(body));
  const choices = root?.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("completion has no choices");
  const message = record(record(choices[0])?.message);
  const content = message?.content;
  if (typeof content !== "string") throw new Error("assistant content is not a string");
  return content;
}

async function requestJudgment(brief: JudgeBrief, citable: ReadonlySet<EventId>): Promise<ModelReply> {
  let raw_text = "";
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: promptFor(brief) },
        ],
        response_format: JUDGE_RESPONSE_FORMAT,
      }),
    });
    raw_text = await response.text();
    if (!response.ok) return { kind: "invalid", raw_text, error: `HTTP ${String(response.status)}` };
    const content = assistantContent(raw_text);
    raw_text = content;
    return { kind: "answer", answer: parseJudgeAnswer(content, "judge", citable) };
  } catch (error) {
    return { kind: "invalid", raw_text, error: error instanceof Error ? error.message : String(error) };
  }
}

async function askModel(brief: JudgeBrief, citable: ReadonlySet<EventId>): Promise<ModelReply> {
  const first = await requestJudgment(brief, citable);
  switch (first.kind) {
    case "answer":
      return first;
    case "invalid":
      return requestJudgment(brief, citable);
    default: {
      const unreachable: never = first;
      throw new Error(String(unreachable));
    }
  }
}

function writeJudgments(runDir: string, run: Run, judgments: readonly unknown[]): void {
  const text = JSON.stringify(judgments);
  parseJudgments(text, "judgments.json", run);
  const temporary = join(runDir, `.judgments.json.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, join(runDir, "judgments.json"));
}

export async function judgeRun(
  runDir: string,
  run: Run,
  profile: StaticProfile,
  findings: readonly Finding[],
  mode: JudgeMode,
): Promise<void> {
  switch (mode) {
    case "skip":
      return;
    case "if_absent":
      if (existsSync(join(runDir, "judgments.json"))) return;
      break;
    case "again":
      break;
    default: {
      const unreachable: never = mode;
      throw new Error(String(unreachable));
    }
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (key === undefined || key.length === 0) return;
  const judgments: unknown[] = [];
  for (const call of run.tool_calls) {
    const reply = await askModel({ call, profile, findings }, citableIds(call));
    const answered_at_us = Date.now() * 1000;
    switch (reply.kind) {
      case "answer":
        judgments.push({
          kind: "answer",
          call_id: call.call_id,
          model: JUDGE_MODEL,
          answered_at_us,
          answer: reply.answer,
        });
        break;
      case "invalid":
        judgments.push({
          kind: "invalid",
          call_id: call.call_id,
          model: JUDGE_MODEL,
          answered_at_us,
          raw_text: reply.raw_text,
          error: reply.error,
        });
        break;
      default: {
        const unreachable: never = reply;
        throw new Error(String(unreachable));
      }
    }
  }
  writeJudgments(runDir, run, judgments);
}
