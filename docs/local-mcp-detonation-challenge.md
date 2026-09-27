---
cursor:
  subagentId: "bc-de84264d-12cf-5b92-81e8-2b24b8442f12"
---

# Local MCP Detonation, explained

Prepared for Nikhil Aggarwal as a plain-language guide to the Local MCP Detonation brief.

The source is [the brief on Google Docs](https://docs.google.com/document/d/1fXeD-Up4eK85Z48_KKzk6jc9amTmRBp2dq1SJa5GvrA/edit?tab=t.0), tab t.0, fetched on 26 September 2026.

## How to read the tags

Each claim in this note ends with one of these tags:

- [brief] means the brief says it, in a direct quote or a close paraphrase.
- [inferred] means this note concludes it from the brief without the brief saying it.
- [background] means general AI or security knowledge that the brief assumes but does not state.
- [open question] means the brief leaves it unresolved.

A [background] tag that names a source means the claim was checked in that source. The sources are listed at the end. This note avoids guesses, so it has no [guess] tags.

## 1. What this is

Forge, the company that wrote the brief, wants a prototype "detonator" for local MCP servers [brief]. MCP, the Model Context Protocol, is a standard way to plug outside capabilities into an AI assistant [background, MCP spec]. An MCP server is a program that provides those capabilities [background, MCP spec]. A local MCP server runs on your own computer [background, MCP spec]. A tool is a named action the assistant can ask a server to perform, such as "get the weather" [background, MCP spec]. To detonate a program is to run it in a monitored environment and watch what it actually does [brief]. The detonator first reads the server's code and its advertised tools [brief]. It then runs the server, calls its tools, and records the processes, files, and network activity that follow [brief]. It ends with a report that ties each observed action to the startup phase or the tool call that caused it [brief].

Forge appears to be a security company, since the brief talks about assessing risk for customers worried about threats [inferred]. The brief reads like a hiring work trial [inferred]. It calls itself a "trial", sets its deadline at the end of "the on-site", and says it will "measure your ability" [brief]. The on-site is probably a working session at Forge where the prototype is due [inferred].

## 2. The problem it solves

People download MCP servers and skills from the internet into their environment [brief]. A skill is a folder of instructions, and often scripts, that an AI assistant loads when it needs a particular ability [background, Agent Skills docs]. The brief calls MCP servers and skills "the fastest-growing attack surface in agentic AI" [brief]. An attack surface is the set of places where an attacker can get in [background]. Agentic AI means AI systems that take actions, such as calling tools, instead of only writing text [background].

The brief says "almost nobody actually knows what an MCP server or skill does before they run it" [brief]. People "read a README, maybe skim the code, and trust it" [brief]. A README is the introductory document that comes with a software project [background]. The official MCP specification asks users to understand what each tool does before authorizing its use [background, MCP spec]. The brief says this trial is about "building the thing that closes that gap" [brief].

### Why reading the code is not enough

One example in the brief involves a skill rather than an MCP server [brief]. Researchers at Cato Networks took Anthropic's legitimate GIF Creator Skill and added a single hidden helper function [brief]. That change turned the skill into a MedusaLocker ransomware dropper [brief]. Ransomware is malware that locks a victim's files and demands payment [background]. A dropper is a program that downloads and installs other malware [background]. The change did not trip any additional approval prompt [brief]. The brief says Claude's consent flow covers the visible script, not what the script later fetches and runs [brief]. A consent flow is the approval step an AI app shows before it runs something [background]. Code fetched while a program runs never appears in the files a reviewer reads [inferred]. That is why the brief pairs reading the code with watching it run [inferred].

### The evidence the brief cites

The brief supports the problem with these findings:

- A February 2026 audit found 43% of public MCP servers vulnerable to command execution [brief]. Command execution means an attacker can make the server run commands of the attacker's choosing [background].
- A separate scan of more than 7,000 servers found 36.7% exposed to SSRF [brief]. SSRF, short for server-side request forgery, is tricking a server into sending network requests for an attacker [background].
- Nearly 500 servers were sitting on the open internet with zero authentication [brief]. Zero authentication means anyone who finds the server can use it [background].
- Snyk's ToxicSkills study scanned roughly 4,000 skills on marketplaces like ClawHub [brief]. It found detectable prompt injection in 36% of them [brief]. Prompt injection is text crafted to override an AI model's instructions [background]. It found 1,467 skills with at least one security flaw [brief]. It found that 91% of confirmed-malicious skills combined prompt injection with traditional malware [brief].
- Koi Security flagged 341 malicious skills in one marketplace audit [brief]. A coordinated campaign called "ClawHavoc" pushed infostealer malware through 335 of them [brief]. An infostealer is malware that steals passwords, browser cookies, and keys [background].
- The MCPTox benchmark found that tool-poisoning attempts succeed 84% of the time when tool auto-approval is on [brief]. Tool poisoning is hiding instructions for the AI inside a tool's description, where the user usually does not see them [background, Invariant Labs]. Tool auto-approval is a setting that lets the AI call tools without asking the user each time [background].

The brief gives no links for these findings [brief]. This note repeats them as stated. It does not verify them. Some findings describe servers exposed on the open internet [brief]. The detonator is aimed at servers that run on your own machine [brief]. So not every finding maps directly onto the detonator's job [inferred].

### Who feels the problem

- Forge's customers are "increasingly worried" about MCP servers and skills downloaded from the internet [brief].
- The brief names end users of local MCP servers as one possible audience [brief].
- The other possible audience is security analysts who decide whether their company may use a server [brief].
- Forge says it has always assessed risk through "behavior and intent" [brief].
- A detonator observes behavior directly, so it fits that approach [inferred].

## 3. Words you need

Some terms were defined in passing above. They are repeated here so this list stands alone.

### The basics

- **MCP**, the Model Context Protocol, is an open standard that lets AI applications connect to outside tools and data [background, MCP spec].
- An **MCP server** is a program that offers tools and data to an AI application through MCP [background, MCP spec].
- **"An MCP"** is the brief's shorthand for an MCP server [inferred].
- The **host** is the AI application that starts MCP servers and talks to them [background, MCP spec].
- A **local MCP server** is an MCP server that runs on your own computer, usually as a child program started by the host [background, MCP spec].
- A **remote MCP server** is an MCP server that runs on another machine and is reached over the network [background].
- A **tool** is a named action that a server offers for the AI model to call [background, MCP spec].
- A **tool definition** is a tool's advertised name, description, and input schema [background, MCP spec].
- An **input schema** is a machine-readable description of the arguments a tool accepts [background, MCP spec].
- The **MCP interface**, which the brief also calls the public interface, is what a server advertises about itself, mainly its tool definitions [inferred].
- A **tool call**, or tool invocation, is one request from the host asking the server to run a tool with specific arguments [background, MCP spec].
- The **lifecycle** is the sequence of initialization, normal operation, and shutdown that every MCP connection follows [background, MCP spec].
- **Initialization** is the opening exchange where the host and server agree on a protocol version and features, before any tool is called [background, MCP spec].
- A **skill** is a folder of instructions, and often scripts, that an AI assistant loads when it needs a particular ability [background, Agent Skills docs].
- An **agent** is an AI model that takes actions, such as calling tools, instead of only writing text [background].
- **Agentic AI** is the broad category of AI systems built as agents [background].
- An **LLM**, or large language model, is the kind of AI model behind assistants such as Claude [background].

### Detonation and analysis

- **Detonation** is running a suspicious program in a monitored environment and watching what it actually does [brief].
- A **detonator** is the system this project builds to run that experiment and report on it [brief].
- A **sandbox** is an isolated environment where untrusted code can run without harming the real system [background].
- An **instrumented environment** is a sandbox fitted with sensors that record what a program does [background].
- **Runtime instrumentation** is the sensor layer that captures process, file, and network activity while a program runs [background].
- **Static analysis** is learning about software by reading its code and descriptions without running it [background].
- **Runtime observation**, also called dynamic analysis, is learning about software by watching it run [background].
- **Behavioral attribution** is linking each observed action to the lifecycle event or tool call that caused it [brief].
- A **process** is a running program [background].
- A **subprocess** is another program that the server starts [background].
- The **filesystem** is the computer's files and folders [background].
- A **side effect** is anything a tool does beyond returning its answer, such as writing a file [background].
- **Dependencies** are the outside code libraries a program relies on [background].
- **Dynamic code loading** is pulling in code while a program runs, so that code was never in the files anyone reviewed [background].
- An **API key** is a secret string that lets a program use an online service [background].
- **Environment variables** are named settings a program receives at startup, often including API keys [background].
- **Credentials** are secrets that prove identity, such as passwords, API keys, and access tokens [background].
- A **deterministic** step gives the same output for the same input every time, like a fixed rule [background].
- A **malware classifier** is a system that labels software as malicious or safe [background].
- **Agent evals** are tests that measure how well an AI agent performs a task [background].

### Threats named in the brief

- An **attack surface** is the set of places where an attacker can get in [background].
- **Command execution** is a flaw that lets an attacker make a program run commands of the attacker's choosing [background].
- **SSRF**, or server-side request forgery, is tricking a server into sending network requests for an attacker [background].
- **Zero authentication** means a server accepts connections from anyone without a password or key [background].
- **Prompt injection** is text crafted to override an AI model's instructions [background].
- **Tool poisoning** is prompt injection hidden in a tool's description, which the model reads but the user usually does not see [background, Invariant Labs].
- **Tool auto-approval** is a host setting that lets the AI call tools without asking the user each time [background].
- A **consent flow** is the approval step a host shows before it runs something [background].
- An **infostealer** is malware that steals passwords, browser cookies, and keys [background].
- A **ransomware dropper** is a program that installs ransomware, which locks a victim's files and demands payment [background].

### Names in the brief

- **Forge** is the company that wrote the brief [brief].
- **FireEye** is the brief's example of a company built almost entirely around file detonation [brief].
- **Snyk**, **Koi Security**, and **Cato Networks** are the organizations whose research the brief cites [brief].
- **ClawHub** is a skills marketplace named in the brief [brief].
- **ClawHavoc** is the malicious skill campaign in Koi Security's audit [brief].
- **MCPTox** is the benchmark the brief cites for tool-poisoning success rates [brief].
- **MedusaLocker** is the ransomware in the brief's Cato Networks example [brief].
- **OpenRouter** is a service that gives access to many LLMs through a single API key [background].
- The **on-site** is the event by whose end the prototype is due [brief].
- A **CLI** is a command-line tool that runs in a terminal [background].
- A **headless API** is an interface that other programs call directly, with no screen of its own [background].

## 4. The challenge

### The goal

- The primary goal is to build "a detonator for local MCP servers" [brief].
- The detonator should help answer one question, "What does this piece of software actually do?" [brief]
- The system "should combine static analysis with runtime observation" [brief].
- Before running the server, it should inspect the code and the MCP interface [brief].
- That inspection covers the tools, their descriptions and input schemas, the dependencies, and the permissions or resources the server appears to need [brief].
- Then it should run the server "in an instrumented environment" and observe it "across its lifecycle" [brief].

### The questions it should answer

The brief lists these questions:

- What the server does when it initializes, before any tool has been called [brief].
- Which processes and subprocesses it creates [brief].
- Which files it reads, writes, creates, or modifies [brief].
- Which environment variables, credentials, configuration, or other local resources it accesses [brief].
- Which network connections and requests it makes [brief].
- Which code or dependencies it loads dynamically [brief].
- What happens when individual tools are invoked [brief].
- Whether a specific tool call can be correlated with the process, filesystem, and network activity it caused [brief].
- Whether runtime behavior matches what the tool's name, description, schema, and source code suggest [brief].
- Which behaviors or side effects would have been hard to identify from the MCP interface alone [brief].

### What makes it hard

- The brief calls this "a largely unexplored systems and security problem" [brief].
- The field is young, since Anthropic introduced MCP in November 2024 [background, Anthropic MCP announcement].
- The brief separates what a server claims to do from what it actually does [brief].
- The claims live in its source code, tool definitions, descriptions, and schemas [brief].
- The actual behavior appears when the server starts up and when its tools are invoked [brief].
- That behavior can include reading local files, accessing credentials, spawning subprocesses, making network requests, changing the filesystem, and loading more code [brief].
- None of that has to be obvious from the public interface [brief].
- The brief stresses attribution in both its questions and its definition of done [brief].
- Attribution is hard because a tool can hand work to a subprocess or to code that runs later in the background [inferred].
- Startup behavior happens before any tool call, so it can only be tied to a lifecycle phase [inferred].
- Some behavior may only appear with particular tool inputs, so the choice of test inputs shapes what the detonator sees [inferred].
- Many servers need an account or API key to do real work [background].
- The sandbox therefore has to supply real credentials, fake ones, or none [inferred].
- The sandbox must contain possibly malicious code while still letting the server behave normally [inferred].
- Ordinary startup work, such as loading libraries, creates routine file and network activity that can bury the meaningful events [inferred].
- Malware in general sometimes hides its behavior when it detects a sandbox [background].
- The brief does not mention that evasion risk [brief].

### Decisions the brief leaves to the builder

- The builder picks the audience, either end users of local MCP servers or security analysts vetting servers for their company [brief].
- The builder picks the interface, such as a web tool, a CLI, or a headless API [brief].
- The builder decides what to do deterministically and what "makes more sense for an LLM or agent to interpret" [brief].
- The builder decides what information matters most and how to present it [brief].

### What success looks like

The brief says Forge wants to see these by the end of the on-site:

- A working prototype Forge can point at a real local MCP server to get back "a concrete report of what it observed" [brief].
- Useful static analysis of the server's tools, inputs, dependencies, and source behavior [brief].
- Runtime observation during initialization and during one or more tool calls, covering processes spawned, filesystem activity, network activity, and resources accessed [brief].
- The ability to connect runtime behavior back to lifecycle events or specific tool calls, "so that we can understand why a particular system action occurred" [brief].
- "Some kind of interface that you're ready to justify" [brief].

The brief says its goal is to measure "your ability to make intelligent design choices" [brief]. It cares more about "useful infrastructure for observing, attributing, and explaining" behavior than about "a perfect malware classifier" [brief]. It prefers depth over breadth [brief]. A prototype that "deeply analyzes one or two MCP servers" is "worth more" than "a broad, shallow scanner" [brief].

### Constraints

The goal and the definition of done above already set most constraints. These are the rest.

- The target is local MCP servers [brief].
- The deadline is the end of the on-site [brief].
- The brief supplies an OpenRouter API key for any LLM or agent features [brief].
- The brief does not name a programming language, operating system, or framework [brief].

This note does not repeat the API key.

### Out of scope

The brief has very few explicit exclusions [brief]. The only statements close to exclusions are these:

- A perfect malware classifier is "not necessarily" the goal [brief].
- A broad, shallow scanner is worth less than a narrow, deep prototype [brief].
- Agent evals are optional [brief].

Skills and internet-facing servers appear in the background but not in the stated goal [brief]. That makes them look out of scope [inferred]. The brief never says they are excluded [brief].

## 5. Map of the work

The brief names five areas of consideration:

- sandbox infrastructure [brief]
- runtime instrumentation [brief]
- static analysis [brief]
- behavioral attribution [brief]
- agent evals, marked optional [brief]

The pieces below turn those areas into parts of one system [inferred].

1. The **static analyzer** reads the code, dependencies, and tool definitions without running the server [brief]. It produces a profile of what the server claims and appears to do [inferred].
2. The **sandbox** is the isolated environment where the server runs [inferred]. It controls which network, files, and credentials the server can reach [inferred].
3. The **sensors** record processes, file activity, environment and credential access, network activity, and code loading [brief]. The brief does not say how to capture these signals [brief].
4. The **MCP driver** plays the role of the host [inferred]. It starts the server, runs initialization, lists the tools, and calls them with chosen inputs [inferred]. It records the time of every message [inferred].
5. The **attribution step** matches sensor events to the driver's timeline [inferred]. Its output says which lifecycle phase or tool call caused each action [brief].
6. The **explainer** compares observed behavior with claimed behavior [brief]. It flags mismatches and side effects that the interface did not reveal [brief]. The builder decides which of its parts are fixed rules and which are LLM judgment [brief].
7. The **report and interface** show the findings to the chosen audience [brief].
8. **Agent evals** are an optional extra that the brief does not define further [brief].

How the pieces depend on each other:

- The sandbox comes first, because the sensors and the driver both operate on the sandboxed server [inferred].
- The static analyzer does not need the server to run, so it can be built in parallel [inferred].
- The authoritative tool list is an exception, because it normally comes from asking a running server [background, MCP spec].
- Attribution needs the driver's timeline and the sensor events on a shared clock [inferred].
- The explainer needs both the static profile and the attributed events [inferred].
- The report comes last and draws on every other piece [inferred].

The same dependencies appear below in compact form.

```
sandbox, sensors, MCP driver    ->  attribution
attribution, static analyzer    ->  explainer
explainer                       ->  report
```

### The first thing to understand

A local MCP server is an ordinary program with the same access as the person who runs it [background]. The MCP specification warns that tools "represent arbitrary code execution" [background, MCP spec]. The host talks to the server by writing JSON messages to the server's standard input and reading replies from its standard output [background, MCP spec]. JSON is a common text format for structured data [background]. Standard input and output are the default text channels a program reads from and writes to [background]. The messages `tools/list` and `tools/call` ask the server to list its tools and to run one [background, MCP spec]. Those messages are the only record of what the server was asked to do [inferred]. Everything else the server does is visible only to the operating system and the network [inferred]. The detonator's central job is to line up those two streams in time [inferred]. Every attribution in the report depends on that alignment being right [inferred].

The sketch below is a made-up example of one run, not observed data.

```
step  driver sends             sensors might record
1     start the server         program starts, libraries load, maybe a download
2     initialize               config files read, environment variables read
3     tools/list               little or nothing
4     tools/call search        outbound web request
5     tools/call save_note     file written, subprocess started
6     close input              exit, maybe one last network call
```

## 6. Open questions

This section lists what the brief leaves unresolved. This note does not try to answer any of it.

### Scope

- The brief discusses skills at length in its background [brief]. It does not say whether the detonator should handle skills [open question].
- The brief does not say whether remote MCP servers are excluded [open question].
- The brief does not name the one or two servers to analyze [open question].
- It does not say who picks them [open question].
- The brief wants a prototype Forge "can point at a real local MCP server" [brief]. It also favors deep analysis of one or two servers [brief]. It does not say whether Forge will bring its own server to the demo [open question].

### Environment

- The brief does not name an operating system for the sandbox [open question]. That choice decides which sensors are available [inferred].
- The brief does not say whether "local" covers only servers that the host starts and talks to over standard input and output [open question]. The MCP specification also lets a server on the same machine accept web-style connections [background, MCP spec].
- The brief does not say whether the sandbox should allow real internet access, block it, or simulate it [open question].
- The brief does not say whether the server should get real credentials, decoy credentials, or none [open question].

### Method

- The brief asks for inspection of the MCP interface "before execution" [brief]. A server's tool list normally comes from asking the running server [background, MCP spec]. The brief does not say whether a sandboxed start to fetch the tool list counts as static analysis [open question].
- The brief asks what happens when tools are invoked [brief]. It does not say how to choose the inputs for those calls [open question]. It does not say whether an LLM agent should drive the calls [open question].
- The brief uses "resources" in the everyday sense of local files and settings [inferred]. MCP servers can also offer formal features called resources and prompts [background, MCP spec]. The brief does not say whether the detonator should exercise those along with tools [open question].

### Output and evaluation

- The brief asks for "a concrete report" [brief]. It does not define the report's format [open question]. It does not say whether the report should include a risk score or a verdict [open question].
- The brief lists agent evals as optional [brief]. It does not say what they would evaluate [open question].
- The brief does not say how long the on-site lasts [open question].
- The brief does not say how the work will be scored beyond "intelligent design choices" [open question].

## Sources checked

- [The brief on Google Docs](https://docs.google.com/document/d/1fXeD-Up4eK85Z48_KKzk6jc9amTmRBp2dq1SJa5GvrA/edit?tab=t.0), tab t.0, was fetched through its plain-text export on 26 September 2026. The tab t.0 export matched the default export byte for byte.
- A raw copy of the brief is saved in this Project's store at `internal/brief-raw.txt`. Its OpenRouter API key is replaced with a redaction marker.
- The brief contains no hyperlinks, so none of its statistics carry a source in the document [brief].
- "MCP spec" means the [MCP specification overview](https://modelcontextprotocol.io/specification/2025-11-25) and its [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) pages, version 2025-11-25.
- "Anthropic MCP announcement" means [Introducing the Model Context Protocol](https://www.anthropic.com/news/model-context-protocol), dated 25 November 2024.
- "Invariant Labs" means the [Invariant Labs post on tool poisoning attacks](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks), dated 1 April 2025.
- "Agent Skills docs" means Anthropic's [Agent Skills overview](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview).
