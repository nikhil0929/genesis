# mcpdet

`mcpdet` is a detonator for local MCP servers. It runs a server inside a disposable Linux container, calls its tools, and records every process, file, network, and credential action the server takes. It then ties each action to the moment that caused it, either startup, one specific tool call, or shutdown.

**Status.** Design stage. This README summarizes the technical design. No code has been written yet.

## Why this exists

An MCP server is the program that gives an AI assistant its tools. A local MCP server runs on your own machine, with your own permissions. The MCP spec itself warns that tools represent arbitrary code execution.

People install these servers from npm or PyPI, read the README, and trust it. Nobody checks what the server actually does when it starts, or when the assistant calls one of its tools.

Reading the code is not enough, for three reasons:

- Code can be fetched and run after install, so it never appears in the files a reviewer reads.
- Dependencies do the real work. The official `mcp-server-git` server runs the `git` binary on every call, yet its own source never mentions a subprocess. The spawn happens inside the GitPython library.
- A tool's description is a claim, not a guarantee. A tool that says "count the words in this text" can also read `~/.aws/credentials`.

Classic malware sandboxes solve a similar problem for files. They run the file in an instrumented machine and watch what happens. `mcpdet` applies the same idea to MCP servers, with one change that matters. An MCP server does not do one thing when it runs. It starts up, then handles a series of tool calls, and each call can do something different. So `mcpdet` records behavior per call, not per run.

## The question it answers

For each tool call, the report asks one question. Does what this call did match what the tool claims?

It never answers "is this malicious?" There is no score. The report opens with a glance that says whether the calls matched their descriptions. Each call then shows the reply, the side effects, and the judge's opinion. The full event list stays in `bundles.json`.

An LLM judge then adds a second opinion per call, either "matches", "does not match", or "unclear", citing the exact events it relied on. The judge only reads finished evidence. It cannot add, remove, or change what the trace shows.

## How it works

```
Your Mac or Linux machine                  Disposable Linux container (internal network only)
-------------------------                  --------------------------------------------------
mcpdet detonate target.toml
  1. build image, install server  ------>
  2. plant decoy credentials      ------>  driver (acts as the MCP client)
  3. start proxy and container               |
                                             +-- strace (traces the server and every child)
                                                   |
                                                   +-- MCP server (unprivileged user)
                                                          |
                                                          | HTTP and HTTPS only
                                                          v
                                           mitmproxy container ------> internet
                                           (logs every request and response)
  4. copy results out            <------   syscall trace, message transcript, proxy log
  5. parse, attribute, apply rules
  6. write report.md
```

A small driver inside the container plays the role of an MCP client such as Claude Desktop. It sends `initialize`, lists the tools, and then calls them one at a time. It records the exact time of every message.

At the same time, `strace` records every system call the server and its child processes make. That covers processes started, files opened or written, and network connections attempted.

The server can reach the internet, but only through a `mitmproxy` container that logs every request and response in full, including HTTPS. Each logged request is joined to the process that sent it. A connection that tries to skip the proxy has no route out, and the trace still records the attempt.

After the run, `mcpdet` joins the two streams on time and on the process tree. The result says which call caused which action.

## The core idea: attributed bundles

Everything the server does lands in exactly one bundle:

- **One startup bundle.** Covers what the server did before any tool was called.
- **One bundle per tool call.** Covers what that call did.
- **One shutdown bundle.** Covers what the server did after the client closed the connection.
- **One unmatched bucket.** Holds actions that happened when no request was in flight. Nothing is dropped.

Each action in a bundle also says how strongly it is linked to the bundle's cause:

| Link | Meaning | Strength |
|---|---|---|
| Owned | The action came from a process that was started during this call, or from one of its children. | Strong |
| Phase | The server acted during startup or shutdown. | Strong |
| Overlap | The server's main process acted while this call was running. | Weak |

"Weak" does not mean the action is in doubt. The action definitely happened. It means the timestamp alone cannot prove which call caused it, because the server could have scheduled that work earlier. The unmatched bucket shows whether the server does background work at all, which tells the reader how much to trust overlap links.

A process that keeps running after the tool replies stays tied to the call that started it. Its later actions are flagged "after reply". This is exactly the pattern where a tool returns a normal answer while a background job keeps working.

## What a report looks like

The excerpt below is made up. It shows the opening glance and one tool call.

> # Verdict
>
> Does not match. 1 of 5 calls did something the description does not cover.
>
> | Call | Tool | Verdict | What happened |
> |---|---|---|---|
> | 3 | word_count | does not match | Read `~/.aws/credentials`. Network `akia7q2k….exfil.example`. Network `POST https://exfil.example/collect`. +1 more |
>
> # Tool call 3: word_count
>
> does not match. Count the words in the given text.
>
> Reply:
>
> ```json
> [{ "type": "text", "text": "1" }]
> ```
>
> - POST https://exfil.example/collect status 200. Canary aws_secret_access_key.
>
> | What happened | Rule | Link | After reply | Source |
> |---|---|---|---|---|
> | `~/.aws/credentials` | credential_access | weak | no | none |

The glance is a match check. It is not a malice score.

## Components

Each part of `mcpdet` has one job:

| Component | Job |
|---|---|
| Sandbox | Builds the image, plants decoys, runs the container behind a logging proxy with capped CPU, memory, and process count, and removes it after the run. |
| Driver | Acts as the MCP client inside the container. Sends one request at a time and timestamps every message. |
| Sensors | Trace the server and all its children with `strace`, then parse the trace into typed events. |
| Static profile | Reads the installed package without running it. Lists dependencies, install scripts, tool descriptions, and source lines that touch files, the network, or subprocesses. Flags tool descriptions that hide characters or contain instruction-like phrases such as "do not tell the user". |
| Attribution | Places every event into exactly one bundle, or into the unmatched bucket. |
| Side-effect rules | Six fixed rules name what happened. The rules cover spawned processes, modified files, credential access, network attempts, code loaded late, and exposed decoy secrets. |
| Judge | Asks Claude Sonnet, through the Anthropic API, whether each tool call matches its claims. Every citation is checked against the bundle, and answers are saved so the report can be rebuilt identically. |
| Report | Writes `report.md` for people and `bundles.json` for machines. |

Raw artifacts (the trace and the message transcript) are the source of truth. Everything after them can be rebuilt with `mcpdet report` without running the server again.

## Key decisions

| Decision | Why |
|---|---|
| The server always runs in a Linux container. `mcpdet` runs on macOS with Docker Desktop, or on Linux. | A container is disposable, so the run leaves the host unchanged. Linux gives us a mature, well-documented tracer. |
| Trace with `strace`, following every child process. | It traces exactly the server and its descendants, needs no kernel modules, and prints readable paths, addresses, and buffers. It also puts no code inside the server. |
| The driver runs inside the container, next to the tracer. | Attribution joins two timelines. On a Mac, Docker runs containers in a VM with its own clock, so putting both timelines in one kernel keeps them on the same clock. |
| Call tools one at a time, with a one-second gap between calls. | Only one request is ever in flight, so call windows never overlap. The gap catches background work before the next call starts. |
| The network is allowed by default, through a logging `mitmproxy`. Block is a per-target option. | A blocked run stops at the first connection and never shows what came back. The proxy keeps the full request and response, and the decoy-secret search covers those bodies. Block stays available for a run that must not leave the container. |
| Plant decoy credentials with fresh random values each run. | Reading an environment variable is invisible to any tracer, but a decoy value that later shows up in a DNS name or a file proves the secret moved. |
| Evidence is deterministic. The LLM only interprets it, as the last build step. | Sensors, attribution, and rules give the same answer every time and can be verified. The LLM adds judgment where fixed rules cannot, and it can never change the evidence. |
| A CLI that writes a Markdown report. | It is the smallest interface that produces the report, and a Markdown file reads anywhere. |
| TypeScript on Node 24 LTS for `mcpdet`, its checks, `detfix`, and the in-container driver. | The data shape is a set of discriminated unions, so the compiler rejects any code that forgets a variant. The driver compiles to plain JavaScript, and every target image includes Node, so it starts even when the server under test is Python. |

## Scope

In v1:

- Local MCP servers that talk over stdio. This is how Claude Desktop and most clients run local servers.
- MCP tools, meaning `initialize`, `tools/list`, and `tools/call`.
- One server per run.

Not in v1:

- Skills, and remote MCP servers reached over HTTP.
- Malware scores and agent evals. The opening glance checks descriptions against behavior. It does not score malice.
- LLM-chosen tool inputs. Fixed inputs make two runs of the same server comparable.
- Windows hosts, and servers that only run on macOS or Windows.
- Tracing the package install itself. The report flags install scripts so the reader knows they ran unobserved.

## What it runs against first

The plan favors depth on a few servers over a broad scanner:

1. **`detfix`**, a tiny fake server we write ourselves in TypeScript on the official MCP SDK. Every tool has a known behavior, including one tool that quietly reads a decoy credential and tries to reach an outside server. This gives us an answer key for testing attribution.
2. **`mcp-server-git`** from the official MCP servers repository. It stays a Python server. Every call runs `git` as a child process, which exercises strong links.
3. **`@modelcontextprotocol/server-filesystem`** from the same repository. It stays a Node server. It does its file work inside its own process, which exercises weak links. It also declares machine-readable claims, such as "read-only", that the report can check against what actually happened.

## Build plan

Each step ends in a run that a check script verifies against expected values:

1. **Prove attribution on `detfix`.** A child that outlives its call stays with that call. A delayed write lands in the unmatched bucket. No event is lost.
2. **Add decoys, rules, and the proxy.** The hidden credential read, the DNS lookup, the proxied POST carrying the decoy key, and a real response from `example.com` all show up, joined to the right tool call. A block-mode rerun records no proxy traffic.
3. **Add the static profile and the report.** Rebuilding the report from saved files gives byte-identical output.
4. **Run `mcp-server-git`.** Every git tool shows its `git` child process as a strong link.
5. **Run `server-filesystem`.** File writes appear as weak links, and a read outside the allowed folder is refused and never touches the decoy.
6. **Add the LLM judge.** On `detfix`, the hidden-exfiltration tool gets "does not match" and the honest tool gets "matches". Every cited event exists. The pipeline still completes without an API key.

## Known limits

- A server can detect that it is being traced and behave differently. Evasion is out of scope for v1.
- Behavior that only appears with inputs we did not try will not show up.
- The container can contact real internet hosts. The remote host sees your network's public address and receives whatever the server sends. Inside the sandbox that is only decoy secrets and the package's own data, and the proxy log records all of it.
- A client that ignores proxy settings behaves as if blocked, and a client that pins certificates shows only the host and a failed handshake.
- In block mode, anything a server would do after a successful connection stays unseen.
- A Linux run shows Linux behavior. The report flags source code that branches on the operating system.

## After v1

1. Tracing the package install as its own detonation.
2. Hooks that log environment variable reads inside Python and Node servers, labeled as weaker evidence than the trace.

## Planned usage

These commands do not exist yet.

```
mcpdet detonate targets/mcp-server-git.toml
mcpdet report runs/<run-id>
```

A target file names the package and pinned version, or a local source folder, plus the server command and the tool calls to make. It can also set `network = "block"` for a run that must not leave the container. `mcpdet` installs its own copy inside the container. It never runs the copy already installed on your machine.

Requirements are macOS with Docker Desktop or Linux with Docker Engine, plus Node 24. The judge also needs `ANTHROPIC_API_KEY`, set in the shell or in a `.env` file in the directory you run `mcpdet` from. Without it, the run still completes and the report says the judge was not run. `--no-judge` skips it on purpose, for source that must not leave the machine.
