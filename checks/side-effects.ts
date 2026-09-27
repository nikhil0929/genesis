import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFindings, parseRun, parseStaticProfile } from "../src/model.js";
import type { Event, Finding, Run, ToolCallBundle } from "../src/model.js";

function detonate(target: string): string {
  const result = spawnSync(process.execPath, ["dist/src/cli.js", "detonate", target], {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const runDir = result.stdout.trim().split("\n").at(-1) ?? "";
  assert.ok(runDir.startsWith(join(root, "runs")), runDir);
  return runDir;
}

function loadRun(runDir: string): { readonly run: Run; readonly findings: readonly Finding[] } {
  const bundlesPath = join(runDir, "bundles.json");
  const findingsPath = join(runDir, "findings.json");
  const profilePath = join(runDir, "static_profile.json");
  const run = parseRun(readFileSync(bundlesPath, "utf8"), bundlesPath);
  const findings = parseFindings(readFileSync(findingsPath, "utf8"), findingsPath, run);
  parseStaticProfile(readFileSync(profilePath, "utf8"), profilePath);
  return { run, findings };
}

function callNamed(calls: readonly ToolCallBundle[], name: string): ToolCallBundle {
  const call = calls.find((item) => item.tool === name);
  assert.ok(call, `missing ${name} call`);
  return call;
}

function runEvents(run: Run): readonly Event[] {
  return [
    ...run.startup.events.map((entry) => entry.event),
    ...run.tool_calls.flatMap((call) => call.events.map((entry) => entry.event)),
    ...run.shutdown.events.map((entry) => entry.event),
    ...run.unmatched.map((entry) => entry.event),
  ];
}

function writesPath(event: Event, path: string): boolean {
  switch (event.body.kind) {
    case "data":
      return event.body.target.kind === "file" && event.body.target.path === path;
    case "file":
      return (
        event.body.action.kind === "open" &&
        event.body.action.path === path &&
        (event.body.action.access === "write" || event.body.action.access === "read_write")
      );
    case "process":
    case "net":
    case "other":
      return false;
    default: {
      const unreachable: never = event.body;
      return unreachable;
    }
  }
}

function secretOf(run: Run): string {
  const canary = run.canaries.find(
    (item) => item.placement.kind === "env" && item.placement.variable === "AWS_SECRET_ACCESS_KEY",
  );
  assert.ok(canary, "missing AWS_SECRET_ACCESS_KEY canary");
  return canary.value;
}

const root = fileURLToPath(new URL("../..", import.meta.url));

const allowDir = detonate("targets/detfix-allow.toml");
const allow = loadRun(allowDir);
const secret = secretOf(allow.run);
const wordCall = callNamed(allow.run.tool_calls, "word_count");
const wordFindings = allow.findings.filter((finding) => finding.kind === "call" && finding.call_id === wordCall.call_id);

assert.ok(
  wordFindings.some(
    (finding) =>
      finding.rule === "credential_access" &&
      finding.subject.kind === "path" &&
      finding.subject.path === "/home/detonee/.aws/credentials",
  ),
  "word_count is missing credential_access on the aws credentials decoy",
);
assert.ok(
  wordFindings.some(
    (finding) =>
      finding.rule === "network_attempt" &&
      finding.subject.kind === "dns_name" &&
      finding.subject.name.includes("exfil.example"),
  ),
  "word_count is missing the exfil.example lookup",
);
assert.ok(
  wordFindings.some(
    (finding) =>
      finding.rule === "network_attempt" &&
      finding.subject.kind === "peer" &&
      finding.subject.peer.kind === "ip" &&
      finding.subject.peer.address === "203.0.113.7" &&
      finding.subject.peer.port === 443,
  ),
  "word_count is missing the direct connect to 203.0.113.7:443",
);
assert.ok(
  wordFindings.some(
    (finding) =>
      finding.rule === "canary_exposed" &&
      finding.subject.kind === "dns_name" &&
      finding.subject.name.toLowerCase().includes(secret.toLowerCase()),
  ),
  "word_count is missing the canary in the dns name",
);

const dnsEvent = wordCall.events.find(
  (entry) =>
    entry.event.body.kind === "net" &&
    entry.event.body.dns_name !== null &&
    entry.event.body.dns_name.includes("exfil.example"),
);
assert.ok(dnsEvent, "word_count has no decoded dns name");
assert.equal(dnsEvent.event.body.kind === "net" ? dnsEvent.event.body.proxy_flow_id : "not-net", null);

assert.equal(allow.run.network.kind, "allow");
if (allow.run.network.kind !== "allow") throw new Error("allow run has no flows");
const post = allow.run.network.flows.find(
  (flow) => flow.request.method === "POST" && flow.request.url.includes("exfil.example"),
);
assert.ok(post, "missing POST flow to exfil.example");
assert.equal(post.request.body.kind, "text");
if (post.request.body.kind === "text") assert.ok(post.request.body.text.includes(secret), "POST body is missing the canary");
const flowEvent = wordCall.events.find(
  (entry) => entry.event.body.kind === "net" && entry.event.body.proxy_flow_id === post.flow_id,
);
assert.ok(flowEvent, "word_count did not claim the POST flow");
assert.equal(flowEvent.event.body.kind === "net" ? flowEvent.event.body.dns_name : "not-net", null);

const example = allow.run.network.flows.find((flow) => flow.request.url.includes("example.com"));
assert.ok(example, "missing example.com flow");
assert.equal(example.result.kind, "response");
if (example.result.kind === "response") {
  assert.equal(example.result.response.status, 200);
  assert.ok(example.result.response.body.byte_count > 0, "example.com response body is empty");
}

const pluginCall = callNamed(allow.run.tool_calls, "load_plugin");
const pluginFindings = allow.findings.filter(
  (finding) => finding.kind === "call" && finding.call_id === pluginCall.call_id,
);
const lateLoad = pluginFindings.find(
  (finding) =>
    finding.rule === "late_code_load" && finding.subject.kind === "path" && finding.subject.path === "/tmp/plugin_x.mjs",
);
assert.ok(lateLoad, "load_plugin is missing late_code_load for /tmp/plugin_x.mjs");
const loaded = runEvents(allow.run).find((event) => event.event_id === lateLoad.evidence[0]);
assert.ok(loaded, "late_code_load cites an event that is not in the run");
assert.ok(
  runEvents(allow.run).some((event) => event.t_us < loaded.t_us && writesPath(event, "/tmp/plugin_x.mjs")),
  "nothing wrote /tmp/plugin_x.mjs before it was loaded",
);

const blockDir = detonate("targets/detfix.toml");
const block = loadRun(blockDir);
assert.equal(block.run.network.kind, "block");
for (const event of runEvents(block.run)) {
  if (event.body.kind === "net") assert.equal(event.body.proxy_flow_id, null, event.event_id);
}
assert.equal(existsSync(join(blockDir, "proxy", "flows.jsonl")), false);
