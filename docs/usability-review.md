# Usability, accessibility, and runtime review

Reviewed on 5 November 2026, against commit `e27038b`.

## Implementation status

The initial fixes below were merged and released in `v0.2.0`. Context removal
followed in `v0.2.1`. The original
review follows this section and describes the baseline commit, including its
failures. Those observations are retained as the reason for each change.

### Workspace layout follow-up

The nine browser comments are addressed on `codex/workspace-layout`:

| Comment | Change |
| --- | --- |
| 1 | Removed the visible Reopen control and close notification. Cmd/Ctrl-Shift-T still recovers closed drafts in the selected workspace. |
| 2 | Shared agent setup in Overview and Settings offers Codex, Claude Code, Cursor, VS Code / Copilot, and a generic URL. Commands and JSON use the selected workspace's MCP address. |
| 3 | Recent queries have short operation/table labels and separate result metadata. Expand an entry to inspect highlighted SQL or open it in another editor tab. |
| 4 | Counts load automatically after the main page, in batches of at most 40 tables. Cached counts expire after 30 seconds and are invalidated by foreground SQL. Background statements stay out of normal query history. |
| 5–6 | Removed the global command palette and extra context row. Workspace, path, theme and Activity share one header. |
| 7 | The sidebar can be collapsed on desktop. Its state survives reload. Narrow navigation retains its drawer, inert content and Escape focus handling. |
| 8 | A searchable workspace picker follows the Pond brand. Only that workspace's navigation and tabs are visible. Each workspace retains its tabs, drafts and last selected tab. Stopped entries can be removed in the picker. |
| 9 | Healthy connections have no status text. Connection failures and stopped workspaces still have an explicit notice. |

Browser tools bind the selected workspace once per call. A workspace change
during an asynchronous check or confirmation cannot redirect the later write.
External MCP connections retain their registered server target.

Verification used two isolated example lakes on MiniLake 1.9.1 with Docker
29.2.1 through Colima. Built-in Browser checks covered automatic counts,
workspace search and arrow/Enter selection, separate SQL drafts across workspace
changes and reload, closed-tab recovery, expanded SQL, all five harness choices,
Settings setup, desktop collapse, a 320-pixel layout, mobile drawer focus, and
removal of the stopped sample from the picker. Clicking Run returns focus to
the button after completion. The user's running lake was not changed.

The 63 JavaScript tests, Deno check/lint, Go web race tests and build passed.
Tests include history label parsing, client configuration, count invalidation,
and workspace binding across asynchronous browser-tool steps. Screenshot evidence
is retained locally in `dist/workspace-layout/evidence/` (untracked). These checks
do not establish screen-reader certification, large-lake count performance, or
live compatibility with the external agent clients. Client formats follow the
[official setup examples](https://developers.openai.com/learn/docs-mcp).

### Graph follow-up

The graph comments are addressed on the same workspace-layout branch:

- Removed the permanent instruction paragraph. Find stays visible; Display holds
  size, colour, labels and layout; Graph holds definition actions.
- Details starts closed, opens on selection and can be closed with its button
  or Escape. On narrow screens it is a bottom panel. Closing it restores focus.
- The collapsible legend explains computed communities, shows example members
  and node counts, and highlights a selected group. Node properties such as type
  provide domain labels when supplied by the node query.
- A relationship table and inspector read original SQL rows, including multiple
  rows between the same nodes. Type, IDs and other properties stay visible.
  The table mapper retains properties and offers a relationship type column.
  Node search presents duplicate names with their IDs instead of choosing one.
- Relationship search runs in SQL before the 1,000-row preview limit. More rows
  are disclosed; export includes shown rows, and Open in SQL removes this preview
  limit. The SQL service's own result limits still apply. Graph analytics retain
  their combined-connection model; this is not multigraph analytics.

Verification used synthetic people, films and separate ACTED_IN/DIRECTED rows
in the isolated sample lake. Built-in Browser checks covered node properties,
duplicate names, connection clicks, property search, keyboard row selection,
graph/table redraw, selected relationship labels, display-control names and
focus, legend highlighting, inspector collapse, themes and a 320-pixel layout.
Live SQL checks also found a property match beyond the first 1,000 rows and
verified that a table containing only source and target still maps correctly.
The 67 JavaScript tests, Deno check/lint, graph-engine and web race tests passed.
Evidence is retained locally under `dist/graph-review/evidence/` (untracked).
This does not establish screen-reader certification or large-graph interaction
performance. The user's lake was not changed.

| Findings | Implemented change |
| --- | --- |
| U1–U3 | Persistent query, job and script drafts, saved-query identity, dirty state, remote-change checks, Save as/export, and recovery of the last 20 closed tabs. Query history opens another tab. |
| A1 | Closed narrow navigation is inert and hidden from assistive tools. An open drawer makes the main area inert. Escape restores focus to Contexts. |
| A2 | Metadata colours now have at least 5.16:1 contrast on the four main light surfaces and 5.97:1 on the four dark surfaces. These are calculated CSS colour ratios. |
| A3–A4 | Named Activity, search controls and dialogs; associated field hints; announced/focused form errors; focus return after dialogs and actions; scrollable keyboard table regions; one indentation handler and a documented editor exit key. |
| U4 | Read-only health checks continue after a healthy start. Pond, MiniLake and engine outages have separate messages. Recovery retains editors and disables actions that need the unavailable lake. The private MiniLake port stays fixed across a container restart. |
| U5–U7 | Visible context/path and browser-agent target, explicit approval scope and activity retention, stable navigation/tab nodes during refresh, and immediate job-list refresh. |
| U8 | Network forms keep their values until success, show pending state and retain errors for retry. This includes import, saved queries, job creation, graphs, scripts, warehouses and secrets. |
| U9 | First import creates its catalog/schema/volume, uses `pond` as the empty-project catalog default, and stages a unique file without overwriting previous uploads. Volume SQL paths use volume storage; external mode discovers the service data root. Counts are explicit, background queries can be hidden, exports state result limits, and Settings explains persistence and snapshots. |
| A5 | Keyboard routes are explained beside the graph, node selections are announced, the canvas has one descriptive name, text tables/details remain available, and reduced motion disables automatic layout and animated camera movement. |
| Runtimes | Docker and Podman adapters, Docker-provider selection, stored connection/socket/image, read-only doctor, startup mount/API checks, private migration backups, ownership checks and visible cleanup errors. External MiniLake works without a local container CLI. |

### Implementation evidence

- `go test -race -shuffle=on ./...` passed. The final UI changes also pass the
  Node tests, Deno type checking and lint. `go vet` and `golangci-lint` passed.
  `govulncheck` found no vulnerabilities reachable by this code; it reported two
  findings in required modules that this code does not call.
- Built-in Browser checks on isolated samples passed for saved-query reload and
  update, retained job source/parameters across tab changes and reload, closed
  query recovery, duplicate-name errors with form retention, narrow navigation
  focus, graph ID search and its table alternative, and runtime diagnostics.
  A live MiniLake stop/start returned to Connected with the SQL draft and editor
  focus retained. The private port remained unchanged.
- A real Spark job on Docker Engine 29.2.1 through Colima read its shared script,
  called back to MiniLake over the context network, wrote three Delta rows, and
  passed a SQL Delta read. The opt-in `TestLiveRuntimeAcceptance` records this
  journey without adding container/image work to ordinary tests.
- Managed and external CSV imports passed against MiniLake 1.9.1. External mode
  started and its doctor passed with PATH limited to system tools, without a
  Docker or Podman executable. The upstream service still owned its runtime.
- Stopped the synthetic import context, exported a mode-0600 archive without a
  container CLI on PATH, imported it into another directory, and started it.
  SQL rows, saved query, graph, script/job and secret key metadata survived.
  Secret values were not printed or written to evidence reports.
- Podman fixtures cover discovery, engine-side sockets, pinned lifecycle/log
  commands, migration refusal/backup, corrupt metadata, ownership refusal,
  failed graceful shutdown, unavailable sockets, and a startup path with no
  Docker executable. These fixtures do not establish real Podman compatibility.

Evidence and synthetic data are retained in `dist/usability-implementation/`,
which is ignored by Git. Screenshots include `runtime-settings.png`,
`reconnected-draft.png`, `narrow-layout.png`, and `graph-access.png` in its
`evidence/` directory. The temporary servers, containers and networks were
stopped and removed. Only the three implementation-review entries were removed
from the recent-context list; the two existing entries were kept.

### Follow-up: removing stopped contexts

The first usability pass missed removal of a stopped context from discovery.
The `v0.2.1` follow-up adds `pond ls --all`, `pond forget DIR`, and **Remove from
list** in an expanded stopped context, including context-filter results.
These operations keep lake data, open tabs and browser drafts. Starting the
context again adds it back. Running/starting contexts are refused.

Registry updates use a shared file lock and atomic replacement. Tests cover
concurrent additions/removal, refusal while a startup lock is held, missing
project directories, corrupt registry data, cache refresh, no container CLI,
cross-origin rejection and API error handling.

Built-in Browser checks with two isolated live contexts passed removal, retained
SQL after reload, closed-tab recovery after removal, and reappearance after
restart. CLI removal without a container CLI kept all nine project state/data
files byte for byte. Test contexts use a separate recent-context registry;
evidence is in the ignored `dist/forget-review/evidence/` directory.

### Remaining qualification work

The implementation does not establish WCAG conformance. VoiceOver/NVDA,
forced colours, text resize/zoom, all narrow forms, and graph cases beyond the
displayed table limit still need manual acceptance. The native file-picker
journey was not completed through the available Browser controls; the import
pipeline was checked through the actual API and retry fixtures.

Live Podman, OrbStack, Rancher Desktop, native/rootless Linux, SELinux and other
architectures were not available for this run. Their implemented connection
paths require the per-platform acceptance below before a qualified support
claim. containerd/nerdctl and Apple container remain outside the managed runtime
contract. No release was published by this implementation pass.

## Assessment

Keep the project-directory model and the workbench. They give Pond a clear purpose:
start a project's lake, inspect data, keep useful queries and graphs, and run the
same work again. The main gaps concern loss of unsaved work, recovery, keyboard
access, and clear context and runtime status. Fix these before adding more screens.

Support for Podman is a suitable next runtime project. It is not a command-name
substitution. Pond starts MiniLake through a CLI, but MiniLake starts Spark
containers through the Docker API. Both paths must reach the same engine and use
the same project data and context network.

The original review records the evaluation and proposed requirements. See the
implementation status above for the changes and their verification limits.

## Evidence and limits

- Built the current source and ran `go test ./...`. All packages passed, including
  the Node UI tests invoked by the Go test suite.
- Used the built-in Browser with isolated copies of the social and shop seeds in
  `dist/usability-review/`. The original example contexts were not changed.
- Started both samples with MiniLake 1.9.1 on Docker Engine 29.2.1 through the
  existing Colima connection. Opened the workbench at `localhost:18700` and used
  the peer context at `localhost:18701` through that page.
- Checked overview, query execution and saving, reload, query-tab closure, job
  creation and editing, graph search, files, settings, and cross-context search
  and query execution. Checked the graph and shell at 320 CSS pixels wide.
- Ran a real PySpark job from the UI. It completed with `POND_REVIEW_ROWS 3`.
  This proves basic sibling-container execution on this Docker/Colima setup.
  It does not prove Spark-to-MiniLake callbacks or Delta interoperability.
- Stopped the social sample, exported its data, imported the snapshot into a new
  empty review directory, and restarted the original sample. All eight restored
  data files matched the archive by SHA-256. The browser showed the original two
  tables, saved review query, and succeeded run after restart. The restored copy
  was checked as files; it was not started as another MiniLake service.
- Inspected the runtime, UI, agent, and persistence code. Calculated contrast
  from the declared CSS colours with the WCAG relative-luminance formula.
- Podman is not installed here. No Podman compatibility result is claimed.
  Other Docker providers, Linux rootless operation, SELinux, other browser
  engines, and remote runtimes were not exercised.
- An accessibility tree and keyboard checks do not replace a screen-reader test.
  VoiceOver/NVDA, 200% text resize, 400% zoom, forced colours, touch targets, and
  all narrow-screen forms still need manual checks. This is not a WCAG conformance
  claim or a complete production/release acceptance result.

Local screenshots and the Spark-run accessibility snapshot are retained under
`dist/usability-review/evidence/`. These files and the sample data are ignored by
Git. `snapshot-check.json` records the snapshot checksum and file comparison.
The review's temporary servers, containers, and networks were stopped and removed
after the checks. Only their entries were removed from the recent-context list;
the prior entries were preserved. Sample data and evidence remain available.

## Use over time

| Stage | User task | Required behaviour |
| --- | --- | --- |
| First use | Open a project and get a working lake | Explain what a context is. Check the selected engine, its connection, shared path, storage access, and required images. Give a precise repair step for each failure. |
| First result | Import a file or run a seed, then query it | Offer a direct import path that can create a catalog and schema. State where the file and table will be stored. |
| Daily work | Return to a project and continue analysis | Restore open items and drafts. Preserve each saved object's identity. Show the active context in text beside the main actions. |
| Repeat work | Turn an experiment into a saved query, graph, or job | Show unsaved changes, Save, and Save as separate actions. Do not reload over edits when another tab is selected. |
| Several projects | Inspect or copy data across contexts | Name source and destination explicitly. Keep query execution scoped to its tab. Explain that a copied table is a snapshot. |
| Stop and resume | End a session and return later | State that the terminal owns the process. Keep data after stop. Distinguish lake data from browser-only drafts and layout. |
| Back up or move | Export and restore a project lake | Show the stopped-context requirement, destination, replacement scope, and restore instructions. Distinguish a data snapshot from files committed to the project. |
| Upgrade or change engine | Continue using existing data | Show the engine and MiniLake version. Check compatibility and ownership before opening data. Require a stopped context and a backup for an explicit migration. |
| Recover | Handle a stopped engine, failed job, failed seed, or lost server | Keep edits. State what failed, what remains stored, and what to do next. Resume status checks without requiring a page reload. |

The present foreground CLI is a reasonable first product boundary. Keep
`pond DIR`, `pond open`, `pond down`, and snapshots as the lifecycle controls.
A browser page depends on the Pond process that serves it. Stopping that process
also removes the page's access to its peer contexts. If start/stop must move into
the UI, design a separate launcher or supervisor first. A button in a context-owned
page cannot provide a durable global control surface by itself.

Use `pond-seed/` for reproducible starting data and definitions. Use saved objects
for ongoing local work. Use snapshots for the current lake state. Add a clear
route to export selected queries, graphs, and scripts into project files for Git;
the current seed loader deliberately preserves existing saved definitions.

## Surface review

| Surface | Keep | Improve |
| --- | --- | --- |
| Terminal and CLI | Small lifecycle commands, stable-port preference, context lock, readable status, offline snapshot commands | Add runtime diagnostics. Distinguish missing CLI, stopped service, wrong endpoint, denied socket, and unshared path. Make startup and cleanup failures actionable. |
| Context navigator and tabs | Project paths, same-origin peer access, separate query tabs, keyboard tab navigation | Preserve focus during refresh. Show the active context as visible text. Give repeated names enough path detail. Provide recovery for closed drafts. |
| Overview | Clear entry points for import and query; saved items and recent runs | Guide empty lakes through their first import. Separate system queries from user history. Avoid automatic full row counts when they can delay normal work. |
| Tables and import | Catalog/schema/table hierarchy, preview/columns/details, copy destination and snapshot explanation | Show the full context and table target in import and replacement forms. Offer catalog/schema creation during first import. Show progress and retain input after a failed request. |
| Queries | Labelled textarea, DuckDB dialect notice, local drafts, explicit result truncation, CSV export | Preserve saved identity on reload. Protect drafts on close and history selection. Fix duplicate Tab handling. Announce running/completed/failed states. |
| Graphs | Keyboard node search, text details and neighbour buttons, table alternative, scope notices, CLI/MCP analysis | Make these alternatives discoverable beside the canvas. Keep selected-node and path changes understandable without sight. Respect reduced-motion settings in JavaScript layout. |
| Jobs and runs | Separate definition and run pages, saved script path, output and final status | Preserve script/parameter drafts on tab activation. Refresh the navigator after creation. Put the cancellation limitation beside Cancel before it is used. |
| Files and workspace | Upload button as a drag-and-drop alternative, breadcrumbs, file preview, script editing | Explain Files versus Scripts in task terms. Show the target context and path. Protect script edits during route changes. State that Run saves the current source first. |
| Settings | Context/data paths, agent connection instructions, separate reset area | Add runtime identity, capabilities, diagnostics, backup guidance, and version information. Keep warehouse and secret details available without making them the first setup task. |
| Activity and agents | Actor distinction and context tags, secret-value masking, separate agent SQL tab | State the control's scope: browser tools only. Show the agent target context. Explain retention and distinguish page activity from durable query/run history. |

## Findings and acceptance checks

P1 means fix before treating the workbench as dependable for repeated use or
claiming the relevant accessibility level. P2 means address in the next usability
pass. Browser-confirmed findings are separate from source-based findings.

### U1 — P1 — Unsaved job edits disappear on tab switch

**Browser confirmed.** Create a job with `print('original sample')`, edit its
script without saving, select another workbench tab, then return. The script
returns to the saved text with no prompt. Parameters use the same rebuild path.

Cause: `createJobsView.activate()` calls `show()`, and `jobPage()` creates a new
editor from the server response. See [jobs.js](../web/static/views/jobs.js).

**Acceptance:** script and parameter drafts survive tab switches, reload, and
status refresh. Closing or navigating away offers Save, Discard, and Cancel, or
retains a recoverable draft. Refresh runs separately from editable fields.

### U2 — P1 — Saved-query identity is lost on reload

**Browser confirmed.** Save a query, reload the page, then press Save. The tab
still has its title and SQL, but the form says “Save query” with an empty name.
It should offer an update to the same saved record.

Cause: workbench persistence stores the tab title and route; the draft stores
SQL alone. The new query view starts with `savedId: null`. See
[workbench.js](../web/static/workbench.js) and [query.js](../web/static/views/query.js).

**Acceptance:** retain context ID, saved-query ID, saved name, draft text, and
dirty state. Reload and Save update the same record. If the saved record has
changed or been removed, explain the conflict and offer Save as.

### U3 — P1 — Closing a query removes its draft without recovery

**Browser confirmed; removal confirmed in source.** Type an unexecuted query and
close its workbench tab. There is no confirmation or reopen action.
`closeTab()` clears `pond.draft.<tab id>`. A recent-query list cannot recover SQL
that was never run. Loading history into the same editor also replaces its draft.

**Acceptance:** confirm closure of dirty work or keep a bounded closed-draft
history. Loading saved/history text must preserve the current draft or ask first.

### A1 — P1 — Closed mobile navigation remains in keyboard order

**Browser confirmed at 320px.** With the Contexts button collapsed, focus Theme,
press Tab to Activity, then Tab again. Focus moves to the hidden navigation filter.
The drawer uses a CSS transform but is not made inert or hidden to assistive tools.

**Acceptance:** closed navigation is absent from focus order and the accessibility
tree. Opening it moves focus to a useful control. Escape closes it and returns
focus to Contexts. Desktop navigation remains available after crossing the breakpoint.
Check WCAG 2.4.3 and 2.4.11 against the final implementation.

### A2 — P1 — Metadata text lacks minimum contrast

**Calculated from source colours.** `--ink-3` is used for normal-size status and
metadata text, including 11.5–12.5px text. These foreground/background pairs are
below the 4.5:1 requirement for normal text:

| Theme and background | Foreground | Background | Ratio |
| --- | --- | --- | --- |
| Light page | `#6f817a` | `#f6f8f6` | 3.86:1 |
| Light data surface | `#6f817a` | `#ffffff` | 4.12:1 |
| Light navigation | `#6f817a` | `#e9eeeb` | 3.51:1 |
| Dark page | `#6c817a` | `#0f1a17` | 4.29:1 |
| Dark data surface | `#6c817a` | `#13201c` | 4.04:1 |

**Acceptance:** check the used text/background pairs in both themes, including
hover, selection, placeholders, errors, and focus. Keep meaningful status text
legible. Do not apply the large-text exception to metadata.
See [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

### A3 — P2 — Some controls and dialogs lack accessible context

**Browser and source confirmed.** On the narrow layout, Activity loses its visible
text and its accessible name becomes only the unread count; without a count it
has no explicit label. The command-palette combobox has no explicit label.
Generic forms create a dialog without `aria-labelledby`; field hints and custom
errors have no programmatic association or announcement.

**Acceptance:** Activity keeps a stable label at every width. Name the palette
input. Name each dialog from its heading, associate field hints, announce custom
validation errors, and return focus to the invoking control or a logical successor.
Use the [WAI modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

### A4 — P2 — SQL indentation has two keyboard handlers

**Browser confirmed.** One Tab key press inserted four spaces. The shared editor
adds two spaces and the Query view adds two more. Shift+Tab moves focus out of the
editor, so this observation does not establish a complete keyboard trap.

**Acceptance:** one component owns indentation. Provide a documented way to move
focus forward out of the editor, with the same rule in SQL and Python editors.
Check that indentation changes are saved as drafts; `setRangeText()` does not
dispatch an input event by itself.

### U4 — P1 — Recovery monitoring is incomplete after a healthy start

**Source confirmed; outage not injected in this review.** `watch()` repeats only
while a context is already offline. Periodic context discovery does not check
MiniLake health for existing healthy contexts. If the Pond server itself fails,
`loadContexts()` retains the old state without a page-level connection message.
This is weaker than the README's general automatic-reconnect description.

**Acceptance:** distinguish Pond connection, engine connection, and lake health.
Detect failures after a healthy start. Show the failed layer, last successful
contact, retry state, and diagnostic action. On reconnection, refresh data without
rebuilding over unsaved editors. Test each failure and recovery independently.

### U5 — P1 — Agent controls need a clear scope and target

**Source and UI confirmed.** A visible tab can belong to shop while page WebMCP
tools remain bound to the serving social context. `get_view` reports both, but
the shell does not keep this distinction visible. “Ask before agents delete or
replace data” applies to browser tools. Server MCP forwards upstream tools and
does not use that page control. Python execution can change data without SQL
statement inspection. Activity is held in page memory and is not a server audit.

**Acceptance:** label the control “Browser agent confirmations”; show its target
context and session scope. State that external MCP clients use their own approval
controls. Do not imply that these prompts enforce read-only access. Keep execution
permissions separate from page navigation. A reload must clearly start a new
page activity session.

### U6 — P2 — Background refresh replaces focused controls

**Source confirmed; repeated stale Browser targets also observed.** Every context
poll calls `renderNav()` and `renderTabs()`. Both replace their children even when
nothing changed. Focused buttons in those regions can be removed. Native row
disclosure names are also only “Expand” and “Collapse”.

**Acceptance:** update changed items without replacing unchanged controls. Keep
focus and scroll through polling. Give disclosure controls names such as “Expand
demo tables”. Test tab selection, close, and navigator expansion across a poll.

### U7 — P2 — Newly created jobs do not refresh the navigator

**Browser confirmed.** After creating and running a job, its page existed while
the navigator continued to show “Jobs 0 / No jobs”. Job creation and deletion do
not call `refreshTree()` as query and graph saves do.

**Acceptance:** successful job changes update the navigator and search results.
Refresh the relevant group after agent-side changes too. Avoid replacing editors.

### U8 — P2 — Form submission closes before the operation succeeds

**Source confirmed.** Generic forms close and return values before callers perform
network work. If an import, save, or job creation fails, the user receives an error
but must reopen and fill the form again. First import also requires a catalog and
schema to exist before the form can open.

**Acceptance:** keep form values on failure. Show an inline error and a Retry
action. State the context, path/table, and replacement mode. Let first import
create its required catalog/schema without leaving the task. Use a consistent
replacement review across table import, file-to-table, and cross-context copy.

### U9 — P2 — Routine use needs clearer persistence and result limits

**Source confirmed.** Tabs and SQL drafts are browser-origin storage. Saved
queries, graphs, scripts, and runs are lake data. Activity is page memory.
Changing the serving port or opening another context URL gives another browser
origin and therefore another workbench state. Overview automatically counts up
to 40 tables with SQL, which can add cost and history entries as lakes grow.
CSV exports contain the fetched result, which may already be truncated upstream.

**Acceptance:** explain these storage boundaries in the UI. Offer project-file
export and snapshot guidance. Make expensive counts explicit or cached. State
“Export fetched rows” when a result is incomplete. Show full context names in
main actions; colour and hover text alone are insufficient with many contexts.

### A5 — P2 — Graph accessibility needs end-to-end acceptance

**Partial browser check passed.** Typing a name in Find node and pressing Enter
selected a node and exposed its attributes and neighbour buttons as text. The
table alternative and explicit Expand button exist in source. The canvas exposes
images rather than an independently useful network description. CSS reduced-motion
rules do not prevent the JavaScript force layout from starting.

**Acceptance:** keep search, node inspection, expansion, paths, statistics, and
export usable with the keyboard and a screen reader. Explain these routes before
the canvas. Announce selection and result changes without moving focus unexpectedly.
Respect reduced motion in the layout and camera code. Test nodes beyond the
table's displayed top 1,000 and repeated labels.

## Runtime decision

### Keep the layers distinct

1. **Pond surfaces:** browser, CLI, MCP, and WebMCP.
2. **Data service:** MiniLake's HTTP APIs and data semantics.
3. **Container engine:** Docker or a compatible Podman service that runs MiniLake
   and its Spark containers.

Changing the container engine should not change SQL, saved definitions, or normal
workbench tasks. A different data service is a separate project because Pond uses
MiniLake/Databricks-style SQL, catalog, files, workspace, and jobs APIs.

Docker is already optional for Pond-managed startup when `--minilake URL` is used.
That attaches to an existing service; it does not start containers, seed a managed
directory, or take ownership of that service's persistence. Discovery still makes
a best-effort Docker query. MiniLake's own job runtime remains the service owner's
responsibility. Present this as **External MiniLake**, with clear capabilities.

### Options

| Option | Assessment | Support boundary |
| --- | --- | --- |
| Docker Engine through the current provider | Retain | This review exercised Docker through Colima only. Do not infer live acceptance on every listed provider from that result. |
| Docker CLI pointed at Podman's compatibility API | Useful compatibility experiment | The Docker CLI still has to exist. The fixed socket mount, API behaviour, shared path, network, and Spark execution still require verification. |
| Explicit Podman adapter | Recommended next supported engine | Add engine selection, endpoint/socket resolution, capability checks, stored runtime identity, and complete lifecycle testing. |
| Rancher Desktop with Moby/dockerd | Add to the provider acceptance matrix | This mode exposes the Docker API. Rancher Desktop's containerd mode does not satisfy MiniLake's current executor contract. |
| OrbStack | Retain as an explicit provider target | It supplies a Docker engine and context. Verify its socket mapping, shared paths, sibling jobs, and lifecycle rather than inferring support from the CLI alone. |
| Colima with Docker | Retain as an explicit provider target | This review exercised this configuration. Colima's other runtime modes need separate acceptance. |
| Native Docker Engine, including rootless mode | Add explicit Linux acceptance | Rootless mode uses a different socket and user-namespace ownership. Check both host-to-engine access and MiniLake-to-engine access. |
| External MiniLake | Retain and explain | Pond attaches to the HTTP service. Display which features work and who owns start, stop, data, and backups. |
| containerd through nerdctl | Separate future investigation | A similar CLI does not provide the Docker API used by MiniLake. It needs an additional execution integration or compatible service. |
| Apple container | Separate future investigation | Runs OCI images in lightweight VMs on Apple silicon and requires supported macOS versions. Running the MiniLake image alone does not establish its Docker API and sibling-job requirements. |
| Native or reduced MiniLake execution | Separate capability profile | Upstream documents non-container server operation and has a subprocess job fallback. It is not evidence of equivalent PySpark/Delta behaviour in Pond. |

The support target should include several alternatives to Docker Desktop:
Colima, OrbStack, Rancher Desktop in Moby mode, and Podman. Keep native Docker
Engine and Docker Desktop in the matrix as well. These are planned acceptance
targets; only Docker through Colima was exercised in this review. A provider's
own platform support does not establish Pond support on that platform.

Colima, OrbStack, and Rancher Desktop in Moby mode still use Docker Engine.
Podman is a different engine with a compatibility API. Reflect this distinction in
the implementation: one Docker-compatible connection path with provider-specific
diagnostics, an explicit Podman runtime adapter where needed, and an external
MiniLake connection. Keep the provider name visible to users and retain it in
test results. Do not implement a separate copy of the lifecycle for each product.

Provider references:
[Colima runtimes](https://colima.run/docs/runtimes/),
[OrbStack Docker engine and context](https://docs.orbstack.dev/docker/),
[Rancher Desktop engine selection](https://docs.rancherdesktop.io/ui/preferences/container-engine/general/),
[Docker rootless socket configuration](https://docs.docker.com/engine/security/rootless/tips/),
and [Apple container requirements](https://github.com/apple/container#requirements).

[Podman documents a Docker-compatible API](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html),
with different rootless/rootful socket paths. On macOS the engine runs in a VM;
host-to-VM file sharing must also work. See
[Podman machine mounts](https://docs.podman.io/en/stable/markdown/podman-machine-init.1.html).
The host connection socket and the socket path mounted by the engine are separate
configuration facts. Do not assume that a host-forwarded socket exists at the
same path inside the VM.

MiniLake's executor calls `docker.from_env()`, inspects its own mounts, and creates
sibling containers on the configured network. This was checked in the running
1.9.1 sample. The same architecture is described in the
[upstream executor](https://github.com/dmux/minilake/blob/main/src/minilake/docker_executor.py).
Current upstream source is supporting context, not a substitute for testing the
pinned image. [nerdctl](https://github.com/containerd/nerdctl) supplies a
Docker-compatible command interface for containerd; that alone does not satisfy
this executor contract.

### Implementation requirements

- Add a small runtime interface around probe, image checks, network creation,
  start, inspect, port lookup, logs, stop, and owned-resource cleanup. Do not spread
  engine conditionals through the views.
- Proposed CLI: `--runtime docker|podman`, with a corresponding environment or
  context setting. Keep `--minilake` as the explicit external-service mode.
  These flags are proposals, not available commands.
- Proposed diagnostic command: `pond doctor`. Report engine identity/version,
  endpoint, VM/service state, project mount, permissions, and job capability.
  Running code or creating a probe container must be an explicit diagnostic step.
- Persist the selected engine and endpoint identity with context runtime state.
  Use it for list, logs, stop, crash cleanup, and offline commands. Never fall back
  to another engine while opening existing data or removing containers.
- Keep project data ownership clear across rootful/rootless engines. Detect an
  incompatible owner before startup. Do not apply recursive ownership changes or
  blanket SELinux workarounds as an automatic repair.
- Resolve the API socket source for the selected engine, map it to the path used
  by MiniLake, and verify access from MiniLake. Handle API versions and runtime
  errors explicitly. A shell alias does not affect Go's direct `exec.Command`.
- Retain the mount-marker check. It correctly rejected the review's first
  `/private/tmp` sample path because the VM could not see it.
- Preserve context network isolation and graceful persistence on shutdown.
  Surface cleanup failures; the current `Stop()` ignores command errors.
- Treat engine socket access as permission to control that engine. Rootless
  Podman changes the privilege scope; it does not make arbitrary jobs read-only.
  Explain this once in setup and keep diagnostics local.
- Report capabilities such as SQL, files, graphs, jobs, and MCP. Disable an
  unavailable action with its reason instead of failing after a user fills a form.
- In Settings, show “Runtime: Podman/Docker/External”, health, version, data path,
  and diagnostics. Use `pond logs DIR` in guidance instead of hard-coded Docker
  commands. Normal data tasks should not require engine knowledge.

### Acceptance before claiming a backend supported

For each claimed platform and root mode, record the exact engine, MiniLake image,
and connection configuration, then verify:

1. First start, cached-image start, missing image, unavailable engine, denied
   socket, and unshared project path produce useful results.
2. The host data marker is visible and lake writes land in the project directory.
3. SQL, import, saved query, graph, workspace file, and a secret survive a normal
   stop and restart. Do not print secret values as evidence.
4. A real PySpark job starts through MiniLake's API connection, reads its script
   and the shared data, and reaches MiniLake on its context network.
5. Spark writes and SQL reads a supported Delta table, within MiniLake's actual
   managed/external table limitations.
6. Two contexts run together without data, network, port, or cleanup collisions.
7. Logs and status use the selected engine, including after another engine's
   default connection changes.
8. Shutdown and crash recovery remove only resources owned by the context and
   report failures. Test a failed start after partial resource creation.
9. Snapshot export/restore works on a stopped context. An engine change refuses
   unsafe ownership or endpoint mismatches without changing the original data.
10. Rootless permissions, VM file sharing, SELinux where applicable, and supported
    architectures are exercised explicitly.

## Work order and completion criteria

1. **Preserve work:** U1–U3. Use one draft model for query/script editors, saved
   identity, conflict handling, and close/reopen recovery.
2. **Make interaction accessible:** A1–A4 and U6. Fix hidden focus, text contrast,
   names, dialog errors, and editor keys. Verify complete keyboard journeys and
   screen-reader use; include A5 in graph acceptance.
3. **Make state reliable:** U4–U9. Show connection and context clearly, keep lists
   current, retain failed forms, and explain agent and persistence boundaries.
4. **Add Podman deliberately:** runtime adapter, explicit selection, diagnostics,
   stored endpoint identity, capability reporting, and the backend acceptance
   matrix above.

The application is ready for a stronger usability claim when a user can start an
empty project, import data, save and reopen analysis, edit and run a job, switch
contexts, stop/restart, and restore a snapshot without losing work or relying on
pointer-only controls. Repeat that journey with a keyboard, a screen reader,
narrow layout, and each supported runtime. Passing unit tests alone does not
establish that result.
