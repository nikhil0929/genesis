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

It never answers "is this malicious?" There is no score and no verdict. A verdict hides the evidence, and the person reading the report needs the evidence. The report puts what the call did right next to what the tool said it would do, and the reader decides.

## How it works

```
Your Mac or Linux machine                  Disposable Linux container (no network)
-------------------------                  ---------------------------------------
mcpdet detonate target.toml
  1. build image, install server  ------>
  2. plant decoy credentials      ------>  driver (acts as the MCP client)
  3. start container, wait                   |
                                             +-- strace (traces the server and every child)
                                                   |
                                                   +-- MCP server (unprivileged user)
  4. copy results out            <------   syscall trace + message transcript
  5. parse, attribute, apply rules
  6. write report.md
```

A small driver inside the container plays the role of an MCP client such as Claude Desktop. It sends `initialize`, lists the tools, and then calls them one at a time. It records the exact time of every message.

At the same time, `strace` records every system call the server and its child processes make. That covers processes started, files opened or written, and network connections attempted.

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

The excerpt below is made up. It shows the shape of one tool-call section.

> **Call 4 · `word_count`**
>
> The tool claims: "Count the words in the given text."
>
> | Rule | What happened | Link | Does the tool mention it? |
> |---|---|---|---|
> | Credential access | Opened `~/.aws/credentials` (a planted decoy) | Weak | No |
> | Network attempt | DNS lookup of `akia7q2k…exfil.example`, then a blocked connect to 203.0.113.7 port 443 | Weak | No |
> | Canary exposed | The decoy AWS key appeared inside that DNS name | Weak | No |

The reader does not need a verdict to see that this tool does something its description never mentions.

## Components

Each part of `mcpdet` has one job:

| Component | Job |
|---|---|
| Sandbox | Builds the image, plants decoys, runs the container with no network and capped CPU, memory, and process count, and removes it after the run. |
| Driver | Acts as the MCP client inside the container. Sends one request at a time and timestamps every message. |
| Sensors | Trace the server and all its children with `strace`, then parse the trace into typed events. |
| Static profile | Reads the installed package without running it. Lists dependencies, install scripts, tool descriptions, and source lines that touch files, the network, or subprocesses. Flags tool descriptions that hide characters or contain instruction-like phrases such as "do not tell the user". |
| Attribution | Places every event into exactly one bundle, or into the unmatched bucket. |
| Side-effect rules | Six fixed rules name what happened. The rules cover spawned processes, modified files, credential access, network attempts, code loaded late, and exposed decoy secrets. |
| Report | Writes `report.md` for people and `bundles.json` for machines. |

Raw artifacts (the trace and the message transcript) are the source of truth. Everything after them can be rebuilt with `mcpdet report` without running the server again.

## Key decisions

| Decision | Why |
|---|---|
| The server always runs in a Linux container. `mcpdet` runs on macOS with Docker Desktop, or on Linux. | A container is disposable, so the run leaves the host unchanged. Linux gives us a mature, well-documented tracer. |
| Trace with `strace`, following every child process. | It traces exactly the server and its descendants, needs no kernel modules, and prints readable paths, addresses, and buffers. It also puts no code inside the server. |
| The driver runs inside the container, next to the tracer. | Attribution joins two timelines. On a Mac, Docker runs containers in a VM with its own clock, so putting both timelines in one kernel keeps them on the same clock. |
| Call tools one at a time, with a one-second gap between calls. | Only one request is ever in flight, so call windows never overlap. The gap catches background work before the next call starts. |
| The network is blocked, but every attempt is recorded. | Blocking is the safe default for untrusted code. The report still shows each destination, each DNS name, and which process tried. |
| Plant decoy credentials with fresh random values each run. | Reading an environment variable is invisible to any tracer, but a decoy value that later shows up in a DNS name or a file proves the secret moved. |
| No verdict and no LLM in v1. | The evidence has to be trustworthy before anything judges it. A deterministic pipeline is easier to verify and defend. |
| A CLI that writes a Markdown report. | It is the smallest interface that produces the report, and a Markdown file reads anywhere. |
| Python 3.12. | The standard library covers everything the pipeline needs, and the first targets are Python. |

## Scope

In v1:

- Local MCP servers that talk over stdio. This is how Claude Desktop and most clients run local servers.
- MCP tools, meaning `initialize`, `tools/list`, and `tools/call`.
- One server per run.

Not in v1:

- Skills, and remote MCP servers reached over HTTP.
- Malware scores, verdicts, and agent evals.
- LLM features, such as an LLM that picks tool inputs or judges the results.
- Windows hosts, and servers that only run on macOS or Windows.
- Tracing the package install itself. The report flags install scripts so the reader knows they ran unobserved.

## What it runs against first

The plan favors depth on a few servers over a broad scanner:

1. **`detfix`**, a tiny fake server we write ourselves. Every tool has a known behavior, including one tool that quietly reads a decoy credential and tries to reach an outside server. This gives us an answer key for testing attribution.
2. **`mcp-server-git`** from the official MCP servers repository. Every call runs `git` as a child process, which exercises strong links.
3. **`@modelcontextprotocol/server-filesystem`** from the same repository. It does its file work inside its own process, which exercises weak links. It also declares machine-readable claims, such as "read-only", that the report can check against what actually happened.

## Build plan

Each step ends in a run that a check script verifies against expected values:

1. **Prove attribution on `detfix`.** A child that outlives its call stays with that call. A delayed write lands in the unmatched bucket. No event is lost.
2. **Add decoys and rules.** The hidden credential read, the DNS lookup, and the exposed decoy key all show up as named findings.
3. **Add the static profile and the report.** Rebuilding the report from saved files gives byte-identical output.
4. **Run `mcp-server-git`.** Every git tool shows its `git` child process as a strong link.
5. **Run `server-filesystem`.** File writes appear as weak links, and a read outside the allowed folder is refused and never touches the decoy.

## Known limits

- A server can detect that it is being traced and behave differently. Evasion is out of scope for v1.
- Behavior that only appears with inputs we did not try will not show up.
- With the network blocked, anything a server would do after a successful connection stays unseen.
- A Linux run shows Linux behavior. The report flags source code that branches on the operating system.

## After v1

1. An LLM judge that reads one tool-call bundle and answers "matches the claim", "does not match", or "unclear", citing event ids. It still gives no malicious score.
2. A proxied network mode through `mitmproxy`, which logs full request bodies so the decoy-secret search also covers HTTP and HTTPS traffic.
3. Tracing the package install as its own detonation.
4. Hooks that log environment variable reads inside Python and Node servers, labeled as weaker evidence than the trace.

## Planned usage

These commands do not exist yet.

```
mcpdet detonate targets/mcp-server-git.toml
mcpdet report runs/<run-id>
```

A target file names the package and pinned version, or a local source folder, plus the server command and the tool calls to make. `mcpdet` installs its own copy inside the container. It never runs the copy already installed on your machine.

Requirements are macOS with Docker Desktop or Linux with Docker Engine, plus Python 3.12.
