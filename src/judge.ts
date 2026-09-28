import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

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

const JUDGE_MODEL = "claude-sonnet-5";

const JUDGE_SYSTEM =
  "The question is whether what this call did matches what the tool claims. Base the opinion on this call's events. The sites and hints describe the whole source file that defines the tool, including code other tools use, so they explain events but are not evidence of what this call did. Each mismatch cites the event_id values of the events that show it. The answer is not a maliciousness score.";

function outputFormat(citable: ReadonlySet<EventId>) {
  return {
    type: "json_schema",
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
              event_ids: { type: "array", items: { type: "string", enum: [...citable] } },
              explanation: { type: "string" },
            },
            required: ["event_ids", "explanation"],
          },
        },
        summary: { type: "string" },
      },
      required: ["opinion", "mismatches", "summary"],
    },
  } as const;
}

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
    events: brief.call.events.map((entry) => ({
      event_id: entry.event.event_id,
      pid: entry.event.pid,
      syscall: entry.event.syscall,
      result: entry.event.result,
      link: entry.link,
      body: entry.event.body,
    })),
  });
}

async function requestJudgment(
  client: Anthropic,
  brief: JudgeBrief,
  citable: ReadonlySet<EventId>,
): Promise<ModelReply> {
  let raw_text = "";
  try {
    const response = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 16000,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: promptFor(brief) }],
      output_config: { format: outputFormat(citable) },
    });
    raw_text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (response.stop_reason !== "end_turn") {
      return { kind: "invalid", raw_text, error: `stop_reason ${String(response.stop_reason)}` };
    }
    return { kind: "answer", answer: parseJudgeAnswer(raw_text, "judge", citable) };
  } catch (error) {
    return { kind: "invalid", raw_text, error: error instanceof Error ? error.message : String(error) };
  }
}

async function askModel(
  client: Anthropic,
  brief: JudgeBrief,
  citable: ReadonlySet<EventId>,
): Promise<ModelReply> {
  const first = await requestJudgment(client, brief, citable);
  switch (first.kind) {
    case "answer":
      return first;
    case "invalid":
      return requestJudgment(client, brief, citable);
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
  const key = process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key.length === 0) return;
  const client = new Anthropic({ apiKey: key });
  const judgments: unknown[] = [];
  for (const call of run.tool_calls) {
    const reply = await askModel(client, { call, profile, findings }, citableIds(call));
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
