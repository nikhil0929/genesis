---
cursor:
  subagentId: "bc-7461c48b-65b4-5836-accb-e841a56ca503"
---

# Existing detonators, and what to steal

Prepared for Nikhil Aggarwal. This note explains how public file detonators are built, then keeps only the ideas that help a prototype watch a local MCP server.

A link in a sentence is the source for that claim. A vendor blog, vendor datasheet, vendor product page, or conference slide is named as such. [background] means general knowledge, not a claim about one product. [inferred] means a conclusion drawn for this prototype.

## 1. What a classic detonator is

A classic detonator runs a suspicious file in a controlled machine and records what that file does. A 2020 VMRay whitepaper, which is a vendor whitepaper, calls that controlled run detonation. The same paper defines static analysis as inspecting the file without executing it ([VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf)).

FireEye is the public lineage for doing this as a product. A Network World profile says Ashar Aziz founded FireEye in February 2004 around a security appliance that used virtual machines ([Network World](https://www.networkworld.com/article/850024/lan-wan-start-up-fireeye-debuts-with-virtual-machine-security-approach.html)). A Sequoia Capital account of the same year says the idea was to find malware by opening files in a virtual environment ([Sequoia](https://sequoiacap.com/article/fireeye-a-story-of-vision-and-conviction)). In an Infosecurity Magazine interview, Aziz said the analysis mechanism was virtual-machine introspection ([Infosecurity Magazine](https://www.infosecurity-magazine.com/interviews/prm/a-qa-with-ashar-aziz-founder-ceo-cto-fireeye/)).

A 2014 FireEye platform document, which is a vendor document, names the engine Multi-Vector Virtual Execution. It says that engine detonates suspicious files, web objects, and email attachments inside instrumented virtual machines, and it names the AX series as the analyst appliance for that test environment ([FireEye platform overview, 2014](https://federalnewsnetwork.com/wp-content/uploads/pdfs/071514_fireeye_advanced_threat_protection.pdf)). The AX 9.1.1 user guide says the appliance uses that engine to report on files and URLs and to track outbound connection attempts ([AX overview](https://docs.fireeye.com/docs/docs_en/AX/sw/9.1.1/UG/Content/Topics/overview/AX_ProductIntro_Overview.htm)). On 19 January 2022, a Symphony Technology Group press release announced Trellix as the company formed from the merger of McAfee Enterprise and FireEye ([Trellix press release](https://www.trellix.com/news/press-releases/symphony-technology-group-announces-the-launch-of-extended-detection-and-response-provider-trellix/)). A CRN news report from that period says Trellix leadership planned to keep selling FireEye's MVX engine together with McAfee network inspection ([CRN](https://www.crn.com/news/security/fireeye-mcafee-enterprise-xdr-business-renamed-trellix)).

## 2. The shared architecture

The public descriptions line up on five stages. [inferred]

**Sample intake** is the step that accepts the file or web address to run and records its identity.

**Sandbox** is an isolated place where that untrusted program can run.

A **guest** is the operating system inside the sandbox. The **host** is the machine that manages the guest. A **snapshot** is a saved clean state of the guest that can be restored so the next run starts from the same point.

**Instrumentation** is the set of sensors that record what the program does while it runs.

**Network handling** is the choice of what the program may contact, plus the capture of that traffic.

The **behavioral report** is the written result, built from the sensor logs after the run ends.

Cuckoo Sandbox is the system that documents the whole path. Its introduction says a host runs the management software and each analysis is launched in a fresh, isolated virtual machine ([What is Cuckoo?](https://cuckoosandbox.org/downloads-sub/docs/introduction/what)). The 1.2 book tells the operator to save that guest as a snapshot and restore it for the runs ([Cuckoo 1.2 book](https://cuckoo.readthedocs.io/_/downloads/en/1.2/pdf/)). An analysis package inside the guest starts the sample, usually by creating it suspended, injecting a monitoring DLL, and then resuming it ([Analysis Packages](https://cuckoo.readthedocs.io/en/latest/customization/packages/)). A DLL is a Windows library loaded into a process. The host records packets with tcpdump ([Analysis Results](https://cuckoo.readthedocs.io/en/latest/usage/results/)). After the guest stops, the host runs processing modules, then signatures, then reporting ([scheduler.py](https://github.com/cuckoosandbox/cuckoo/blob/master/cuckoo/core/scheduler.py)).

The other systems in the next section publish pieces of that same path. Some replace the injected DLL with a sensor outside the guest. Some add a verdict at the end. The public documents do not all describe every stage. [inferred]

## 3. How specific systems actually work

### Cuckoo Sandbox

Cuckoo is open source, and the book is the best public description of a detonator. It says the results are traces of Win32 API calls from processes the sample spawned, files created, deleted, and downloaded, process memory dumps, a packet capture, desktop screenshots, and an optional full memory dump of the machine ([What is Cuckoo?](https://cuckoosandbox.org/downloads-sub/docs/introduction/what)). An API call is a request from a program to a library function.

The current package code starts the sample suspended, injects a DLL, and resumes it, unless the `free` option is set, in which case no monitoring DLL is injected ([Analysis Packages](https://cuckoo.readthedocs.io/en/latest/customization/packages/)). The 1.2 book names that DLL `cuckoomon.dll` ([Cuckoo 1.2 packages](https://cuckoo.readthedocs.io/en/1.2/usage/packages/)). The later history of the monitor is a fork story, covered under CAPE below. This note does not assume the current file is still named `cuckoomon.dll`.

Raw monitor logs land in `logs/`. The analyzer's own `analysis.log` records process creation, files, and errors. `files/` holds files the monitor could dump, and `files.json` records which processes touched them when that is known. `dump.pcap` is the tcpdump capture. `shots/` holds screenshots. `tlsmaster.txt` holds TLS secrets captured so encrypted web traffic can be decrypted later ([Analysis Results](https://cuckoo.readthedocs.io/en/latest/usage/results/)). TLS is the encryption used by HTTPS.

The behavior processing module turns those raw logs into a process trace, a behavioral summary, and a process tree ([Processing Modules](https://cuckoo.readthedocs.io/en/latest/customization/processing/)). A process tree is the parent and child relationship among running programs. The network module parses the packet capture for DNS, domains, IP addresses, HTTP, IRC, and SMTP. A separate static module inspects PE32 files, which are Windows executables, and another module extracts strings. Since version 1.2, signatures are evented. Each signature can subscribe to API names, and `on_call` runs once per matching call ([Signatures](https://cuckoo.readthedocs.io/en/latest/customization/signatures/)).

Network routing is per analysis. The documented choices are no special routing, drop all non-Cuckoo traffic, full internet, InetSim, Tor, or a VPN ([routing.rst](https://github.com/cuckoosandbox/cuckoo/blob/2.0.6.2/docs/book/installation/host/routing.rst)). InetSim is a program that offers fake network services for the sample to talk to. Drop routing blocks DNS and outgoing connections. The Cuckoo docs say Tor for malware analysis is a bad idea, and they still document it.

### CAPE

CAPE is an open-source sandbox derived from Cuckoo. Its manual says the Cuckoo-era core is API-hook instrumentation, capture of files created, modified, and deleted, packet capture, classification by behavioral and network signatures, screenshots, and full memory dumps ([What is CAPE?](https://capev2.readthedocs.io/en/latest/introduction/what.html)). A hook is extra code placed so that a call is recorded and then allowed to continue.

The same page gives the history. In 2015 the original Cuckoo monitor's development stopped in the main project. A fork called cuckoo-modified kept that monitor. CAPE began at Context Information Security as a command-line tool whose name stands for Config And Payload Extraction. The first version used Microsoft Detours for API hooks. The authors write that hooks alone were not precise enough to unpack arbitrary payloads. They added a debugger that avoids Microsoft's debugging interfaces, then swapped Detours for the cuckoo-modified hook engine. CAPE was presented at 44con in September 2016. The 2021 additions named on that page include an interactive desktop, capture of AMSI buffers, syscall hooking based on Microsoft Nirvana, and debugger countermeasures for direct and indirect syscalls. A syscall is the request a program makes when it asks the operating system kernel to do something.

The behavior module still builds a process trace, a summary, and a process tree ([CAPE processing](https://capev2.readthedocs.io/en/latest/customization/processing.html)). Submission options show how the monitor is actually controlled. `hook-type` can be `indirect`, `pushret`, `direct`, or `safe`. `native` installs only ntdll hooks. `syscall` enables syscall hooks on Windows 10 and later. `single-process` limits monitoring to the first process. `full-logs` turns off a suppression that otherwise drops logs from before the first network or file activity. `dump-on-api` dumps the calling module when a named API is called. `free=True` is documented as a way to turn hooking off when it would disturb a memory dump ([Submit an Analysis](https://capev2.readthedocs.io/en/latest/usage/submit.html)).

On Linux guests, CAPE documents an optional community integration that runs Tracee, an eBPF tracer, inside an Ubuntu guest ([Linux guest](https://capev2.readthedocs.io/en/latest/installation/guest/linux.html)). eBPF is a way to run small observation programs inside the Linux kernel. [background]

### Joe Sandbox

Joe Security's current cloud page, which is a vendor product page, says the service executes files and URLs in a controlled environment and monitors application and operating-system behavior. It says reports cover system, network, browser, and tampering behavior, and that generic behavior signatures highlight activity such as persistence, data spying, and command-and-control communication. The same page says analysts can attach their own YARA, Sigma, and Suricata rules. YARA is a rule language for matching patterns in files or memory. [background] Sigma is a rule format for log events. [background] Suricata is an engine that matches rules against network traffic. [background] The page also says the service stores created and dropped files, screenshots, memory dumps, and a packet capture that includes decrypted HTTPS, and that HTTPS inspection is done by installing an intercepting SSL proxy ([Joe Sandbox Cloud](https://www.joesecurity.org/joe-sandbox-cloud)).

That page says customers can submit cookbooks to automate user behavior. A Joe Security blog, which is a vendor blog, defines a cookbook as a small script that defines how an analysis is executed, and it shows one that installs Microsoft Sysmon, starts the analysis engines, starts the sample, waits, and then stops the engines ([Sysmon cookbook blog](https://www.joesecurity.org/blog/4184136948312019722)). Sysmon is a Microsoft logger for process, file, and network events on Windows. [background] Another vendor blog shows a cookbook that starts a second analysis only if the first one saw traffic on TCP port 443, and that patches API arguments so an HTTPS connection is forced down to HTTP ([Cookbook blog](https://www.joesecurity.org/blog/3032572784220682797)).

A 2017 Joe Security blog, also a vendor blog, says the product at that time used a kernel-mode driver to intercept system calls, kernel calls, and memory events, and that this misses user-mode functions that never enter the kernel. The example given is `GetSystemTime`. The same post introduces hypervisor inspection as an added method and lists the other techniques then in use as generic instrumentation, simulation of internet traffic and cookbooks, hybrid code analysis of branches that did not execute, and execution-graph analysis ([Hypervisor introduction, 2017](https://www.joesecurity.org/blog/68779205757215410)). The current hypervisor product page says that plugin captures system calls, kernel calls, and user-mode calls with arguments, plus reads and writes of memory areas such as the process environment block, performance counters, and instructions such as CPUID. It says the hypervisor is their own code, not KVM or Xen, and that it can inspect virtual machines and bare metal ([Joe Sandbox Hypervisor](https://www.joesecurity.org/joe-sandbox-hypervisor)). The 2017 post is the source for the kernel driver. The current cloud page does not restate that driver, so this note does not claim it is still the default sensor.

### ANY.RUN

ANY.RUN's own blog, which is a vendor blog, describes an interactive sandbox and what the report shows. The process tree records the sample's processes and the processes those spawn, and a process entry includes a start time, command line, and events classified by the product ([Process tree, 4 April 2024](https://any.run/cybersecurity-blog/process-tree-analysis/)). A separate post says the network view records HTTP, other connections, DNS, and Suricata alerts, and that each connection is tied to the process name and process id that opened it. The same post says packet captures and SSL keys can be downloaded ([Network traffic blog](https://any.run/cybersecurity-blog/how-to-analyze-malicious-network-traffic/)). A report post says the text report includes processes, registry events and files, network activity, screenshots, and a process graph, plus a packet capture ([Report blog](https://any.run/cybersecurity-blog/malware-analysis-report/)). The registry is the Windows database of system and application settings. [background]

Those posts describe the observations and the links between them. They do not describe the sensor inside the virtual machine. Public technical detail on how ANY.RUN records a call is thin, so this note does not fill that gap.

### VMRay

The 2020 VMRay whitepaper is a vendor argument for one architecture, and it is specific about the mechanism. It says VMRay monitors the guest from the hypervisor with virtual-machine introspection, using a method it names Intermodular Transition Monitoring, and that the guest operating system is unmodified. It says there is no in-guest agent, no hook, and no emulation. It says monitoring adapts to the highest available meaning, so an ordinary API call, a direct jump into the kernel, and a COM method are all intercepted. It says the monitor follows dropped and downloaded code, survives reboots, and records only activity related to the analysis, so unrelated programs such as a starting Word or a browser are left out of the report ([VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf)). COM is a Windows mechanism for calling objects in another component. [background]

The paper also describes the two designs it is rejecting. Full-system emulation implements the CPU in software. Hooking places sensors inside a real guest. The paper says emulation is slow and leaves timing differences that malware can notice, and that hooks live in memory the sample can see. Those are the vendor's claims about its own product and about the alternatives. This note does not have an independent teardown of VMRay.

### FireEye AX series

The AX 9.1.1 user guide is the public technical source. It says the appliance reports on executables, files, and URLs, tracks outbound connection attempts, and lets an analyst examine the execution path. Sandbox mode is the default. In that mode the sample runs in the virtual test environment and is not allowed to communicate with external sources. Live mode is separate. The configuration page says live mode sends the sample's command-and-control traffic out a chosen interface, and it has fields for a DNS server, a default gateway, and an external address ([AX overview](https://docs.fireeye.com/docs/docs_en/AX/sw/9.1.1/UG/Content/Topics/overview/AX_ProductIntro_Overview.htm), [live settings](https://docs.fireeye.com/docs/docs_en/AX/sw/9.1.1/UG/Content/Topics/malware/AX_MalwareAnalysisConfigure_Web.htm)). Guest images are factory virtual-machine snapshots ([Guest images](https://docs.fireeye.com/docs/docs_en/AX/sw/9.1.1/UG/Content/Topics/config/all_GuestImages_Ovr.htm)).

Unattended mode polls a network share, runs each file, and moves it to a `bad` directory or a `good` directory ([Malware repository](https://docs.fireeye.com/docs/docs_en/AX/sw/9.1.1/UG/Content/Topics/malware/AX_MalwareRepository_Overview.htm)). That is a verdict pipeline.

The guide does not say whether the guest contains a hook, a driver, or an outside monitor. Public detail on AX instrumentation is thin.

### Cisco Secure Malware Analytics, formerly Threat Grid

Cisco's product documentation says dynamic analysis submits a file to Secure Malware Analytics, runs it in a sandbox, and returns a threat score ([Dynamic analysis](https://docs.manage.security.cisco.com/cdfmc/c_dynamic_analysis.html)). A Cisco XDR integration page says static analysis inspects submission attributes, and dynamic analysis executes the file or browses the URL ([Secure Malware Analytics integration](https://docs.xdr.security.cisco.com/Content/Integrations/secure-malware-analytics-integration.htm)).

A 2022 Cisco Live slide deck, which is vendor conference material, says the approach is "outside looking in" with no presence in the virtual machine. The same deck says a report contains behavioral indicators, network activity, processes, artifacts, registry activity, and file activity, plus a video of the virtual-machine session and a packet capture. It also lists Glovebox as the way to interact with a running sample ([BRKSEC-2242](https://www.ciscolive.com/c/dam/r/ciscolive/global-event/docs/2022/pdf/BRKSEC-2242.pdf)). Cisco's own integration notes say the Glovebox URL exists only while the sample state is running ([Threat Grid submit workflow](https://github.com/CiscoSecurity/tg-00-integration-workflows/blob/main/docs/source/tg/submit.rst)).

The slide line about no presence in the virtual machine is the most specific public statement of how observation is placed. The deck does not explain the sensor beyond that line. Public detail on Threat Grid instrumentation is thin.

### Hybrid Analysis and Falcon Sandbox

Hybrid Analysis is the public service powered by CrowdStrike Falcon Sandbox, as the service's own FAQ describes it ([Hybrid Analysis FAQ](https://hybrid-analysis.com/faq)). The FAQ says a behavior indicator is a small script that registers for a data type or event and turns that input into a named behavior. The examples are an autostart registry entry, a firewall change, injection into another process, and data sent on an unusual port. The FAQ says indicators are classified malicious, suspicious, or informative, and that they can trigger on registry access, strings in process memory, API calls, created files, network traffic, injected processes, and disassembly. The same FAQ says hybrid analysis combines runtime data with static analysis of memory dumps, so indicators can be extracted for code that did not execute.

A CrowdStrike Falcon Sandbox datasheet, which is a vendor datasheet, says file monitoring runs in the kernel so user-mode programs do not see it, and that the product does not use an agent that malware can easily identify. It says the operator can set the date, the time, environment variables, and user behavior before detonation. It says reports include memory captures and stack traces ([Falcon Sandbox datasheet](https://www.crowdstrike.com/wp-content/uploads/2022/12/crowdstrike-falcon-sandbox-data-sheet.pdf)). The datasheet does not document the kernel monitor's implementation past those sentences.

## 4. The mechanisms worth understanding

### API hooking

A hook records a library call, including arguments, and then lets the call continue. Cuckoo does this by injecting a DLL into a suspended process ([Analysis Packages](https://cuckoo.readthedocs.io/en/latest/customization/packages/)). CAPE documents several hook styles and says its own early Detours hooks were not precise enough to unpack arbitrary malware ([What is CAPE?](https://capev2.readthedocs.io/en/latest/introduction/what.html)).

What it buys is the function name and the arguments, in the process that made the call. What it misses is a call that jumps straight into the kernel, a call that skips the hooked instructions, and any program that notices the hook and stops. The VMRay whitepaper states that last limit as the reason hooks are visible to the sample ([VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf)). The 2017 Joe Security blog states a related limit from the other direction. A kernel hook never sees a user-mode function that does not enter the kernel ([Hypervisor introduction, 2017](https://www.joesecurity.org/blog/68779205757215410)).

### Syscall or kernel tracing

A syscall trace records the operating-system requests themselves. CAPE can enable syscall hooks on modern Windows ([Submit an Analysis](https://capev2.readthedocs.io/en/latest/usage/submit.html)). The Joe hypervisor page says that plugin records system calls with arguments ([Joe Sandbox Hypervisor](https://www.joesecurity.org/joe-sandbox-hypervisor)). The VMRay whitepaper says direct syscalls are intercepted from outside the guest ([VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf)). The Falcon datasheet says file monitoring runs in the kernel ([Falcon Sandbox datasheet](https://www.crowdstrike.com/wp-content/uploads/2022/12/crowdstrike-falcon-sandbox-data-sheet.pdf)).

What it buys is activity that never passes through a hooked library, including file and network requests made by a language runtime. What it misses is the library-level meaning. A raw write does not by itself say that the program performed an HTTP POST. [inferred] Reconstructing that meaning is a later step.

### Full-system emulation versus a virtual machine

Full-system emulation pretends to be the CPU in software. A virtual machine runs the guest on the real CPU, with a hypervisor underneath. The VMRay whitepaper draws that distinction and says practical emulators take shortcuts that malware can detect, while a virtual machine is fast enough to run a real operating system ([VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf)). Cuckoo and CAPE document guest virtual machines, not an emulated CPU ([What is Cuckoo?](https://cuckoosandbox.org/downloads-sub/docs/introduction/what), [What is CAPE?](https://capev2.readthedocs.io/en/latest/introduction/what.html)). Joe's hypervisor page says their inspector can sit under a virtual machine or on bare metal ([Joe Sandbox Hypervisor](https://www.joesecurity.org/joe-sandbox-hypervisor)).

What a virtual machine buys is a real operating system at near native speed. What it misses is a sample that looks for virtual-machine artifacts and refuses to run. The Joe product page gives that as the reason they also offer physical machines ([Joe Sandbox Cloud](https://www.joesecurity.org/joe-sandbox-cloud)). What emulation buys is control of every instruction. What it misses is fidelity to the machine the program expects. None of the current public documents for the products above describe full-system emulation as the sensor they ship.

### Process trees

Cuckoo and CAPE build a process tree from the monitor logs ([Processing Modules](https://cuckoo.readthedocs.io/en/latest/customization/processing/), [CAPE processing](https://capev2.readthedocs.io/en/latest/customization/processing.html)). ANY.RUN's blog says the tree includes grandchildren, and that a process entry has a start time ([Process tree, 4 April 2024](https://any.run/cybersecurity-blog/process-tree-analysis/)).

What it buys is the handoff from the program you started to a program it started. What it misses is work that stays inside one process, including a thread, a callback, or an in-process library load. [background] CAPE's `single-process` option makes that miss deliberate ([Submit an Analysis](https://capev2.readthedocs.io/en/latest/usage/submit.html)).

### File and registry diffs

CAPE says it captures files created, modified, and deleted during execution ([What is CAPE?](https://capev2.readthedocs.io/en/latest/introduction/what.html)). Cuckoo dumps files the monitor saw and records which processes touched them ([Analysis Results](https://cuckoo.readthedocs.io/en/latest/usage/results/)). The Threat Grid slide deck lists file activity and registry activity as report sections ([BRKSEC-2242](https://www.ciscolive.com/c/dam/r/ciscolive/global-event/docs/2022/pdf/BRKSEC-2242.pdf)). ANY.RUN's report blog lists registry events and files ([Report blog](https://any.run/cybersecurity-blog/malware-analysis-report/)).

A before-and-after diff of the disk shows the net change. It misses a file that was written and then deleted, and it misses every read, because a read does not change the disk. [inferred] An event log of open, read, write, and delete keeps the process and the time. The registry is a Windows-specific settings store. A program on another operating system keeps those settings in files instead. [background]

### Packet capture

A packet capture is a recording of the bytes on the network. Cuckoo takes it with tcpdump on the host side of the guest network ([Analysis Results](https://cuckoo.readthedocs.io/en/latest/usage/results/)). CAPE, Joe, ANY.RUN, and the Threat Grid deck all list a packet capture in the results ([What is CAPE?](https://capev2.readthedocs.io/en/latest/introduction/what.html), [Joe Sandbox Cloud](https://www.joesecurity.org/joe-sandbox-cloud), [Network traffic blog](https://any.run/cybersecurity-blog/how-to-analyze-malicious-network-traffic/), [BRKSEC-2242](https://www.ciscolive.com/c/dam/r/ciscolive/global-event/docs/2022/pdf/BRKSEC-2242.pdf)).

What it buys is the destination, the time, and the payload when the payload is visible. What it misses is the process, unless a second sensor records that. ANY.RUN's blog says they store the process name and process id on each connection ([Network traffic blog](https://any.run/cybersecurity-blog/how-to-analyze-malicious-network-traffic/)). Encryption hides the payload. Cuckoo stores TLS secrets for later decryption ([Analysis Results](https://cuckoo.readthedocs.io/en/latest/usage/results/)). Joe's product page says an intercepting proxy decrypts HTTPS ([Joe Sandbox Cloud](https://www.joesecurity.org/joe-sandbox-cloud)). CAPE documents a TLS-secret dump and optional proxy tools ([Submit an Analysis](https://capev2.readthedocs.io/en/latest/usage/submit.html)).

### DNS

DNS is the lookup from a name to an address. Cuckoo's network module extracts DNS from the packet capture ([Processing Modules](https://cuckoo.readthedocs.io/en/latest/customization/processing/)). ANY.RUN's blog shows DNS requests as their own report section ([Network traffic blog](https://any.run/cybersecurity-blog/how-to-analyze-malicious-network-traffic/)). FireEye's live-mode settings include a DNS server for the guest ([live settings](https://docs.fireeye.com/docs/docs_en/AX/sw/9.1.1/UG/Content/Topics/malware/AX_MalwareAnalysisConfigure_Web.htm)).

What it buys is the name the program wanted, even when the later connection fails or is blocked. [inferred] What it misses is a program that connects to a raw IP address and never looks up a name. Cuckoo's drop routing blocks DNS along with every other outgoing connection, so a dropped network produces no DNS evidence ([routing.rst](https://github.com/cuckoosandbox/cuckoo/blob/2.0.6.2/docs/book/installation/host/routing.rst)).

### Dropped files

A dropped file is a file the running program creates, which the sandbox copies out for later inspection. Cuckoo stores those copies and their guest paths ([Analysis Results](https://cuckoo.readthedocs.io/en/latest/usage/results/)). Joe's product page lists created files, unpacked executables, and downloaded files as downloadable artifacts ([Joe Sandbox Cloud](https://www.joesecurity.org/joe-sandbox-cloud)). CAPE can dump the calling module when a chosen API runs ([Submit an Analysis](https://capev2.readthedocs.io/en/latest/usage/submit.html)).

What it buys is code or data that was not in the original sample. What it misses is a file the sensor did not classify as worth keeping, and content that existed only in memory. Falcon's FAQ says the memory-dump pass exists for that second gap ([Hybrid Analysis FAQ](https://hybrid-analysis.com/faq)).

### Screenshots

Cuckoo and CAPE take desktop screenshots during the run ([What is Cuckoo?](https://cuckoosandbox.org/downloads-sub/docs/introduction/what), [What is CAPE?](https://capev2.readthedocs.io/en/latest/introduction/what.html)). ANY.RUN's report blog includes screenshots ([Report blog](https://any.run/cybersecurity-blog/malware-analysis-report/)). The Threat Grid deck lists a video of the session ([BRKSEC-2242](https://www.ciscolive.com/c/dam/r/ciscolive/global-event/docs/2022/pdf/BRKSEC-2242.pdf)).

What it buys is evidence of a window, a document, or a prompt that a log line describes poorly. What it misses is everything a headless program does. A server with no desktop will produce an empty or useless picture. [inferred]

### Signatures and behavior rules

A signature is a rule that names a pattern in the trace. Cuckoo streams API calls to Python signatures and can also match files, registry keys, mutexes, domains, and URLs ([Signatures](https://cuckoo.readthedocs.io/en/latest/customization/signatures/)). A mutex is a named flag programs use to say an instance is already running. [background] CAPE adds YARA over unpacked payloads and Suricata over the packet capture ([What is CAPE?](https://capev2.readthedocs.io/en/latest/introduction/what.html)). Falcon's FAQ says each indicator keeps the data that made it fire, and that the label is malicious, suspicious, or informative ([Hybrid Analysis FAQ](https://hybrid-analysis.com/faq)). Joe's product page describes the same job with behavior signatures, Sigma, YARA, and Suricata ([Joe Sandbox Cloud](https://www.joesecurity.org/joe-sandbox-cloud)).

What it buys is a short name and the evidence under that name. What it misses is any behavior no rule describes. A match also does not say which request from the operator caused the event. The rule runs after the whole trace exists. [inferred]

## 5. What transfers to a local MCP server

A local MCP server is an ordinary process. The host starts it and talks to it by writing JSON messages to its standard input and reading replies from its standard output. JSON is a text format for structured data. Standard input and output are the default text channels of a process. The opening handshake is `initialize`. The request for the advertised tools is `tools/list`. The request to run one tool is `tools/call` ([MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)). [background]

The useful transfers land on four jobs.

### Static analysis

Classic static analysis reads the file before the run. Cuckoo's static module inspects Windows executables and extracts strings ([Processing Modules](https://cuckoo.readthedocs.io/en/latest/customization/processing/)). The Threat Grid materials separate "what the file is" from "what it does" ([BRKSEC-2242](https://www.ciscolive.com/c/dam/r/ciscolive/global-event/docs/2022/pdf/BRKSEC-2242.pdf)). Falcon's FAQ then goes back to memory after the run and looks for code that never executed ([Hybrid Analysis FAQ](https://hybrid-analysis.com/faq)).

The MCP equivalent is a profile built from the source, the dependency list, and the tool name, description, and input schema. The hybrid-analysis idea transfers as a second pass over code the chosen tool calls never reached. That pass belongs in the static profile, updated after the run. It does not belong in a malware verdict. [inferred]

### Runtime observation

The sensors that transfer are the process tree, file open and read and write, DNS, connections, and files or code that appear only after start. Cuckoo, CAPE, ANY.RUN, Joe, and the Threat Grid report sections all publish some of that set. Screenshots do not earn a place for a server with no desktop. [inferred]

The sensor placement that transfers is outside the server process. VMRay's whitepaper and the Threat Grid slide both argue for watching without putting code in the guest ([VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf), [BRKSEC-2242](https://www.ciscolive.com/c/dam/r/ciscolive/global-event/docs/2022/pdf/BRKSEC-2242.pdf)). CAPE's Linux guest notes show one public version of that idea, an eBPF tracer in the guest ([Linux guest](https://capev2.readthedocs.io/en/latest/installation/guest/linux.html)). For one local process, the smaller version is an operating-system trace of that process and its children. [inferred] A Win32 API hook is the wrong layer for a Python or Node server. [inferred]

Joe's cookbook that installs Sysmon shows a related trick. Turn on the operating system's own process and file log for the duration of the run ([Sysmon cookbook blog](https://www.joesecurity.org/blog/4184136948312019722)). The log source can be whatever the host operating system already has. [inferred]

Environment variables and credential files are a gap in the classic report sections cited above. Those sections emphasize processes, files, registry, and network. A prototype that must say which secrets were touched has to record reads of those files, and it has to record the environment the process was given at start, because a later read of an environment variable may never become a syscall. [background]

### Attribution to a phase or a tool call

Classic logs are already sliced by process. Cuckoo keeps monitor logs and a process tree, and `files.json` names the processes that touched a file ([Analysis Results](https://cuckoo.readthedocs.io/en/latest/usage/results/), [Processing Modules](https://cuckoo.readthedocs.io/en/latest/customization/processing/)). ANY.RUN ties each connection to a process id ([Network traffic blog](https://any.run/cybersecurity-blog/how-to-analyze-malicious-network-traffic/)). That join names the process. The driver message that caused the process is a separate fact.

The missing piece is a second clock from the program that drives the sample. Cuckoo's analysis package is that driver for a file. It decides how the sample is started ([Analysis Packages](https://cuckoo.readthedocs.io/en/latest/customization/packages/)). Joe's cookbook is that driver as a script, and it can branch on something the first run already observed ([Cookbook blog](https://www.joesecurity.org/blog/3032572784220682797)). The MCP equivalent is a driver that writes down the time of process start, `initialize`, `tools/list`, each `tools/call`, and shutdown. Sensor events join that log on time, and child processes join it through the process tree. [inferred]

Two CAPE defaults are warnings. `full-logs` exists because logs from before the first network or file activity are normally suppressed ([Submit an Analysis](https://capev2.readthedocs.io/en/latest/usage/submit.html)). Startup is one of the phases this prototype has to keep, so that suppression is the wrong default. [inferred] `single-process` drops children. A tool that hands work to a subprocess would vanish. The scope to copy is the server plus its descendants, which is the idea in the VMRay claim that unrelated system activity stays out of the report ([VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf)). [inferred]

Events that fall between tool calls, or that continue after the reply, stay visible and get labeled as unmatched or still running. Dropping them would hide a background action. [inferred]

### The report

Cuckoo's pipeline is the shape to copy. Raw logs are kept. Processing builds a structure. Rules add names. A report is rendered last ([scheduler.py](https://github.com/cuckoosandbox/cuckoo/blob/master/cuckoo/core/scheduler.py)). Falcon's FAQ says each indicator keeps the data that triggered it ([Hybrid Analysis FAQ](https://hybrid-analysis.com/faq)).

The MCP report is that structure with a different index. One section for startup. One section per tool call. One section for events that matched no phase. Each line cites the process, the file or destination, and the driver message it was joined to. A short rule can name a side effect, in the style of a Cuckoo signature or a Falcon indicator, and the static profile says whether the tool's name and source suggested it. [inferred]

## 6. What does not transfer

File detonation assumes an untrusted sample, a disposable virtual machine, and a verdict.

The sample is often opaque. The AX unattended mode's last act is to move the file into `good` or `bad` ([Malware repository](https://docs.fireeye.com/docs/docs_en/AX/sw/9.1.1/UG/Content/Topics/malware/AX_MalwareRepository_Overview.htm)). Cisco's dynamic analysis returns a threat score ([Dynamic analysis](https://docs.manage.security.cisco.com/cdfmc/c_dynamic_analysis.html)). Falcon indicators are labeled malicious, suspicious, or informative ([Hybrid Analysis FAQ](https://hybrid-analysis.com/faq)). Joe's product page is organized around a detection status ([Joe Sandbox Cloud](https://www.joesecurity.org/joe-sandbox-cloud)).

This prototype has the source and the advertised tools, and it wants a trace tied to a phase or a tool call. A perfect malware label is a different product. [inferred] A signature pack aimed at malware families will mostly stay quiet, or it will shout about ordinary library loads. [inferred]

A disposable virtual machine still matters if the server is untrusted, because the run must be able to end and leave the analyst's machine clean. Cuckoo's snapshot restore is that property ([Cuckoo 1.2 book](https://cuckoo.readthedocs.io/_/downloads/en/1.2/pdf/)). Hiding the sensor from malware that refuses to run in a lab is a different problem. Joe's product page offers physical machines because evasive malware may not run on a virtual system ([Joe Sandbox Cloud](https://www.joesecurity.org/joe-sandbox-cloud)). The VMRay paper's point is that an in-guest hook is visible to the sample ([VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf)). A local server that is an ordinary script will usually run. [inferred] The prototype's question is what that server did. [inferred]

One more mismatch is the shape of a run. A classic detonation is one execution window for one file. A local server has a startup phase and then several tool calls, and the calls depend on the arguments the driver chooses. A single untouched execution misses that structure. [inferred] Desktop video, PE unpacking, and a community lookup against millions of other samples are report features for a different question.

## 7. Design ideas worth stealing

**Script the run the way an analysis package or a cookbook does.** The classic mechanism is Cuckoo's analysis package, which starts the sample in a defined way, and Joe's cookbook, which scripts the procedure and can chain a second run on traffic the first run saw ([Analysis Packages](https://cuckoo.readthedocs.io/en/latest/customization/packages/), [Cookbook blog](https://www.joesecurity.org/blog/3032572784220682797)). The MCP equivalent is a driver that sends `initialize`, `tools/list`, and chosen `tools/call` messages, and that writes a timestamp for each one. It earns its place because every later attribution step is a join against that timeline. [inferred]

**Trace the server and its children from outside, and keep the quiet start.** The classic mechanism is a process tree plus a syscall or kernel trace, as in CAPE's syscall hooks, the Joe hypervisor's system-call capture, and VMRay's claim that only the sample's activity is recorded ([Submit an Analysis](https://capev2.readthedocs.io/en/latest/usage/submit.html), [Joe Sandbox Hypervisor](https://www.joesecurity.org/joe-sandbox-hypervisor), [VMRay Technology Whitepaper](https://www.vmray.com/wp-content/uploads/2024/03/VMRay-Technology-Whitepaper.pdf)). CAPE's `full-logs` switch is the caution. The product otherwise suppresses logs from before the first file or network event ([Submit an Analysis](https://capev2.readthedocs.io/en/latest/usage/submit.html)). The MCP equivalent is an operating-system trace of the server process and every descendant, including the interval before the first tool call. It earns its place because startup behavior and subprocess work are otherwise invisible, and because a hook inside a Python process is aimed at the wrong layer. [inferred]

**Choose the network on purpose, and capture the attempt even when you fake the answer.** The classic mechanism is Cuckoo's per-analysis routing, including a full drop and InetSim's fake services, next to FireEye's split between a closed sandbox and a live mode that allows callbacks ([routing.rst](https://github.com/cuckoosandbox/cuckoo/blob/2.0.6.2/docs/book/installation/host/routing.rst), [AX overview](https://docs.fireeye.com/docs/docs_en/AX/sw/9.1.1/UG/Content/Topics/overview/AX_ProductIntro_Overview.htm)). The MCP equivalent is a recorded packet capture, with DNS kept, joined to the process id the way ANY.RUN's blog describes ([Network traffic blog](https://any.run/cybersecurity-blog/how-to-analyze-malicious-network-traffic/)). A fake or blocked network still shows the name and the attempt. A live network shows the payload when it is visible. It earns its place because the network question is unanswerable if the route is an accident, and because a sinkhole that returns nothing still attributes the request to a tool call. [inferred]

**Name side effects with rules, and compare them to the static profile.** The classic mechanism is Cuckoo's evented signature and Falcon's behavior indicator. Both attach a label to the evidence that fired ([Signatures](https://cuckoo.readthedocs.io/en/latest/customization/signatures/), [Hybrid Analysis FAQ](https://hybrid-analysis.com/faq)). Dropped-file capture and Falcon's look at memory that did not execute cover code that was absent from the original file ([Analysis Results](https://cuckoo.readthedocs.io/en/latest/usage/results/), [Hybrid Analysis FAQ](https://hybrid-analysis.com/faq)). The MCP equivalent is a small set of rules for file writes, credential and environment reads, unexpected destinations, and code loaded after start, each tied to a phase or a tool call, set next to what the tool definition and the source suggested. It earns its place because the report should say what happened and whether the advertised tool suggested it. It should stop before a malicious or clean score. [inferred]
