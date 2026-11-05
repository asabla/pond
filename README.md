# pond

A local data lake per directory. Run `pond` in a folder and you get a [MiniLake](https://dmux.github.io/minilake) (a local Databricks emulator) for that folder, a web UI to work with it, and **MCP** and **WebMCP** endpoints so agents can work with it too. Run it in several folders and one page shows all of their lakes side by side.

Use it to try out Databricks-style catalogs, Delta tables, SQL and PySpark jobs on your own machine, with each project's data kept separate and next to the project.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/graph-dark.png">
  <img alt="The pond workbench with two contexts, social and shop, in the navigator, and the example messaging network open in a graph tab: 300 people coloured by community in six clusters" src="docs/images/graph-light.png">
</picture>

## Requirements

- Go 1.25 or later, if you build pond yourself.
- Docker, through Docker Desktop, OrbStack or colima. Pond runs MiniLake in a container.

Pond is a single binary with the UI embedded. It has no other dependencies.

## Install

With [Homebrew](https://brew.sh) on macOS:

```sh
brew install --cask asabla/tap/pond
```

Or with Go:

```sh
go install github.com/asabla/pond@latest   # installs `pond` into $(go env GOPATH)/bin
```

Prebuilt binaries for macOS and Linux are on the [releases page](https://github.com/asabla/pond/releases).

Or build from a checkout:

```sh
git clone https://github.com/asabla/pond && cd pond
go build -o pond .
```

## Quick start

```sh
cd ~/code/my-project
pond
```

```
pond · my-project  (/Users/me/code/my-project)
Starting MiniLake…
  UI    http://localhost:8700/
  MCP   http://localhost:8700/mcp
        claude mcp add --transport http pond-my-project http://localhost:8700/mcp
  Data  /Users/me/code/my-project/.pond/data
Ctrl-C stops this context's containers. Data is kept.
```

Open the UI URL in a browser, or run the printed `claude mcp add` command to give an agent access. Press Ctrl-C to stop. Your data stays in `.pond/` for the next run.

## Usage

```sh
pond [up] [DIR] [flags]          # start the context for DIR (default: current directory)
pond ls                          # list running contexts across directories
pond down [DIR]                  # stop a context and remove its containers (keeps data)
pond open [DIR]                  # open a running context's UI in the browser
pond logs [DIR] [-f] [--tail N]  # show the context's MiniLake logs
pond seed [DIR]                  # run the seed scripts again (see Seed data)
pond reset [DIR] [--yes]         # delete the lake's data, then seed it again
pond export [DIR] [-o FILE]      # snapshot a stopped context's data to a .tar.gz
pond import FILE [DIR] [--yes]   # replace a stopped context's data with a snapshot
pond version                     # print the version
```

Flags for `up` (each flag can also be set with an environment variable):

| Flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--port N` | `POND_PORT` | the context's last port, else 8700, else the next free one | UI port. With an explicit port, pond fails instead of picking another one. |
| `--host HOST` | `POND_HOST` | `127.0.0.1` | Address the UI binds to. See [Sharing a context](#sharing-a-context). |
| `--image IMAGE` | `POND_MINILAKE_IMAGE` | `ghcr.io/dmux/minilake:1.9.1` | MiniLake container image. |
| `--minilake URL` | `MINILAKE_URL` | none | Use a MiniLake you run yourself instead of starting a container. |
| `--open` | none | off | Open the UI in a browser. |

Set `POND_VERBOSE=1` to log every HTTP request pond serves.

`reset` and `import` ask you to type the context's name before deleting data, unless you pass `--yes`.

The directory has to be visible to Docker. colima and Docker Desktop share your home directory by default. If Docker can't see the path, pond refuses to start and explains why.

## Contexts

Each directory is its own **context**, so data from different projects never mixes and you always know which one you're in:

- **Data** lives in `<dir>/.pond/`, which contains its own `.gitignore` so git ignores it. Catalogs, Delta files, volumes, jobs, queries and secrets survive restarts.
- **One MiniLake container** runs per context, named `pond-<name>-<hash>-minilake`, on its own Docker network, `pond-<name>-<hash>`. MiniLake's Spark job containers join that network, so they are scoped to the context and can call back into its MiniLake.
- **The URL is stable.** The context remembers its UI port, so an MCP registration keeps pointing at the same context. If another program holds that port, pond uses a free one for that run and tells you which MCP registrations won't reach it.
- **One pond per context.** The running pond holds a lock on `.pond/lock`, so a second `pond` in the same directory points you at the first one instead of starting another lake.
- **The context name is visible everywhere:** in the terminal banner, the UI's navigator and tabs (each context has its own colour), the browser tab title, the suggested MCP server name and WebMCP's `get_view` tool.
- **Every pond's UI shows every context.** Open any of them and the navigator lists all running contexts, plus recently used ones that are stopped, with the command to start them. Tables, queries and graphs from different directories open as tabs side by side. Requests for another context go through the pond you have open, so the page stays on one origin. MCP stays per context, so an agent works in one lake at a time.
- **Copy a table between contexts** with **Copy to…** on its page. It is copied as it is then, through a Parquet file, so the copy doesn't change when the original does.

Ctrl-C stops the context gracefully (MiniLake snapshots its state), then removes every container on the context's network and the network itself. If pond was killed, the next `pond` in that directory cleans up the leftovers first.

## Seed data

A project can describe its sample data instead of committing it. Put `.sql` and `.py` files in `pond-seed/` in the project directory. The first time a context starts with an empty lake, pond runs them in filename order:

```
my-project/
  pond-seed/
    01_catalog.sql
    02_generate.py
```

```sql
-- pond-seed/01_catalog.sql
CREATE CATALOG IF NOT EXISTS shop;
CREATE SCHEMA IF NOT EXISTS shop.raw;
CREATE OR REPLACE TABLE shop.raw.customers AS
  SELECT i AS id, 'customer_' || i AS name FROM range(1000) t(i);
```

- **SQL files** can hold several statements, separated by semicolons, in MiniLake's DuckDB dialect. Pond runs `CREATE CATALOG [IF NOT EXISTS] name` and `CREATE SCHEMA [IF NOT EXISTS] catalog.schema` through Unity Catalog itself: DuckDB has no `CREATE CATALOG`, and a schema made in SQL works but doesn't appear in the catalog tree. The Query tab does the same.
- **Python files** run as one-off jobs, so they can use PySpark. They are saved in the workspace under `/Shared/pond/seed/`.

Seeding stops at the first failure and prints the error, including the end of a failed Python run's output. A Python script that runs for more than an hour is stopped. Fix the script, then run `pond reset` to start from an empty lake, or `pond seed` to run all the scripts again. Scripts that use `IF NOT EXISTS` or `CREATE OR REPLACE` can safely run more than once. If seeding didn't finish, the next `pond` start says so, because the lake may be half seeded.

### Example

[`examples/social`](examples/social/pond-seed) generates a small company messaging network: 300 people in six teams (`demo.social.people`) and 2,302 sender → recipient edges weighted by message count (`demo.social.messages`). Most messages stay within a team, and a few connectors message across teams. To explore it:

```sh
pond examples/social
```

![Terminal output of pond up seeding the example, and pond ls listing the running context](docs/images/cli.png)

In the navigator, open **Tables** → `demo` → `social` → `messages`, choose **Open as graph**, and pick `demo.social.people` as the node table with `name` as the label.

[`examples/shop`](examples/shop/pond-seed) is a second context: a web shop with products and 1,200 orders whose customer ids are the people of `examples/social`. Run both (`pond examples/social` and `pond examples/shop` in two terminals) to try working across contexts: copy `shop.sales.orders` into `social` with **Copy to…**, then join it with `demo.social.people` there.

## Snapshots

`pond export` writes a stopped context's lake data to a `.tar.gz` file, and `pond import` loads one into a stopped context, replacing its data. Use them to back up a lake or hand it to someone else. Snapshots leave out MiniLake's download caches. If a snapshot is damaged or contains paths outside the lake, `import` refuses it and leaves the existing data unchanged.

## Sharing a context

By default, pond listens on `127.0.0.1`, so only your machine can reach it. To let others on your network use a context, start it with a host that other machines can reach:

```sh
pond --host 0.0.0.0
```

Pond prints a warning and the URLs others can use. Anyone who can reach the port can read and change the lake and run code in it, because MiniLake has no authentication. Pond accepts requests addressed to this machine's hostname and IP addresses, and refuses other names, which keeps DNS-rebinding attacks out.

Whether shared or not, pond refuses requests to the lake that another web page sent, using the `Origin` and `Sec-Fetch-Site` headers browsers add. So a site you visit can't reach the lake through `localhost`. MCP clients, curl and scripts don't send these headers and work as before.

## UI

The UI is a workbench:

- **The navigator** on the left lists each context with its tables (catalog → schema → table), saved queries, graphs and jobs, plus its files, workspace and settings. Filter it from the box at the top.
- **Tabs** hold what you open: a table, a query, a graph, a job run. Following a link inside a tab replaces what it shows, and ⌘-click (Ctrl-click) opens a new tab instead. Tabs, and what is expanded in the navigator, survive a reload.
- **⌘K** (Ctrl-K) searches tables, saved queries, graphs and jobs across every context, and runs commands such as **New query**, **Import a file** or switching the theme.
- **Activity**, on the right, lists what you and agents did in this page. It also holds the setting that lets agents delete or replace data without asking.

| Tab | What you can do |
| --- | --- |
| **Overview** | A context at a glance: its tables with row counts, recent queries, saved queries and graphs, recent runs, and how to connect an agent. Drop a file on it to import it. |
| **Tables** | Browse catalogs → schemas → tables and volumes. Create and drop catalogs, schemas and volumes; drop tables. Import CSV, TSV, JSON, JSON Lines or Parquet into a table by dropping a file (create, replace or append). Table pages show a preview, the columns and storage details, and can copy the table to another context. |
| **Query** | A SQL editor with highlighting (⌘↵ runs, ⌘S saves), result grid, CSV export and the lake's query history. Each query tab keeps its own draft. MiniLake runs the DuckDB dialect, not Spark SQL. |
| **Graph** | Explore relationships in your tables as an interactive network. See [Graphs](#graphs). |
| **Jobs** | Write and run Python/PySpark scripts once, or save them as jobs and run them again. Runs show status, duration and output. |
| **Files** | Browse the lake's files (DBFS and `/Volumes`): upload by drag and drop, create folders, download, delete, preview data files as tables, query a file in place or turn it into a table. Browse and edit workspace scripts, and run them. |
| **Settings** | Context details, connecting an agent, SQL warehouses, secret scopes and keys, and resetting this context's lake. |

The theme follows your system; the button next to **Activity** switches between system, light and dark.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/query-dark.png">
  <img alt="The Query tab with a saved SQL query joining the example tables, and its results grid" src="docs/images/query-light.png">
</picture>

Destructive actions (dropping, deleting folders, resetting) ask for confirmation. When a lot is at stake, you confirm by typing the object's name. If MiniLake stops responding, the page says so and reconnects by itself.

### Known limitations

These come from MiniLake 1.9.1:

- Cancelling a run doesn't stop the script.
- Run output appears only when the run finishes.

## Graphs

The **Graph** tab draws a network from your tables and analyses it. A graph is defined by SQL:

- **Edges:** a query whose first two columns are the source and target node ids. A column named `weight` weights edges. Other columns become edge attributes.
- **Nodes (optional):** a query whose first column is the node id. A column named `label` names nodes. Other columns become attributes you can colour by.

Create one with **New graph** (pick an edge table and map its columns), with **Open as graph** on a table page, or with **Show as graph** on any Query result whose first two columns are source and target. Save a graph to reopen it later. Saved graphs are stored in the lake under `/pond/graphs/`.

What you can do with a graph:

- **Size nodes** by degree, in-degree, out-degree, PageRank, betweenness, closeness, eigenvector centrality, HITS hub and authority scores, or clustering coefficient.
- **Colour nodes** by Louvain community, connected component, strongly connected component, or any node column. The eight largest groups get their own colour, and the rest share "Other".
- **Find shortest paths** between two nodes. Weights count as distances when the graph has a weight column.
- **Inspect** a node's attributes, metrics and neighbours, and see graph statistics: density, average degree, components, communities with modularity, average clustering and diameter.
- **Switch to the table view** to see every node with its metrics, export them as CSV, or save them as a lake table to join in SQL.

Graphs with up to 30,000 edges load in full, and every metric is exact. Bigger graphs open on their 20 best-connected nodes and those nodes' neighbours. Double-click a node to load its neighbours. Metrics then describe the loaded nodes, while shortest paths search the whole graph in SQL, up to 20 hops and ignoring weights.

The graph libraries ([sigma.js](https://www.sigmajs.org) and [graphology](https://graphology.github.io)) ship inside pond and load the first time you open the tab, so graphs work offline. Their licences are in `web/static/vendor/LICENSES.md`.

### Graph commands

The CLI and MCP use the same graph analysis code as the browser. No open browser or Node.js installation is needed. Start Pond, then run graph commands from the context directory. Use `--dir PATH` for another running directory, or `--url URL` for another Pond server. These options cannot be combined. Commands do not start or stop containers.

For the social example, the edge columns are `sender`, `recipient` and `weight`:

```sh
pond graph save Messaging --dir examples/social \
  --edges-table demo.social.messages --source sender --target recipient --weight weight \
  --nodes-table demo.social.people --node-id id --label name
pond graph list --dir examples/social
pond graph show Messaging --dir examples/social
pond graph stats Messaging --dir examples/social
pond graph metrics Messaging pagerank --top 10 --dir examples/social
pond graph metrics Messaging community --json --dir examples/social
pond graph neighbors Messaging --node 0 --dir examples/social
pond graph path Messaging --from 0 --to 25 --dir examples/social
pond graph open Messaging --dir examples/social
```

`save` also accepts `--edges-sql-file FILE` with optional `--nodes-sql-file FILE`, or `--definition FILE` containing the existing JSON graph format. Choose one input form. Table and SQL input is directed by default; use `--undirected` for undirected edges. A JSON definition supplies its own direction (omitting `directed` means true). Replacing a saved definition requires `--replace`. Analysis commands accept `--definition FILE` instead of a saved name, for example `pond graph metrics pagerank --definition graph.json`. Saved definitions stay in `/pond/graphs/` and appear in the browser when its list refreshes.

Use `--json` for one result object on stdout. Errors go to stderr. Without this option, results use labelled text. `--timeout` sets the client deadline (default `60s`); server analysis also has a 60-second limit, including queue time. Exit codes are 0 for success, 1 for an operation failure and 2 for invalid arguments. A completed search with no path is successful and returns `result: null`.

Available metrics are `degree`, `in_degree`, `out_degree`, `pagerank`, `betweenness`, `closeness`, `eigenvector`, `hub`, `authority` and `clustering`. Groupings are `community`, `component`, `strong_component` and `attr:COLUMN`. Rankings and group summaries return the top 10 by default, with `--top` from 1 to 100. Node arguments are exact IDs, not labels. Neighbour lists return up to 200 entries per direction and report truncation.

CLI and MCP analysis require a complete graph by default. The limits are 30,000 source edge rows, 60,000 nodes including isolated nodes, and 32 MiB of row data. A limit or incomplete SQL result causes an error. Use `--scope overview` explicitly to analyse a limited graph selected by the browser's overview rules. Results identify the scope, loaded source rows, merged edges, loaded nodes, total source edge rows and limits. Repeated source/target pairs merge; their weights add when the graph has a weight column.

Paths use non-negative weights as distances on complete weighted graphs. Use `--unweighted` to minimise hops. For graphs above the edge limit, `--unweighted` is required and paths search the full graph through SQL, within 20 hops and a 20,000-node frontier. A search limit is an error, not evidence that no path exists. An overview path is never used as proof of the shortest path through the full graph.

The CLI uses `GET /pond/graphs`, `GET/PUT /pond/graphs/{name}` and `POST /pond/graph/{stats|metrics|neighbors|path}`. Save bodies contain `definition` and `replace`. Analysis bodies contain exactly one of `name` or `definition`, plus operation options (`scope`, `metric`, `top`, `node`, `from`, `to`, `unweighted`). Definition reads and saves return a definition and a browser route; the CLI and MCP turn that route into a full URL.

## Agents

### MCP (Claude Code, Claude Desktop, Codex and other MCP clients)

`/mcp` combines Pond's graph tools with MiniLake's tools, resources and prompts. Register one server per context:

```sh
claude mcp add --transport http pond-my-project http://localhost:8700/mcp
```

Pond adds `pond_graph_list`, `pond_graph_get`, `pond_graph_save`, `pond_graph_stats`, `pond_graph_metrics`, `pond_graph_neighbors` and `pond_graph_path`. Analysis tools take either a saved `name` or an inline `definition`; they do not use the browser's current graph. `pond_graph_save` takes `definition` and requires `replace: true` to overwrite an existing name. Limits and result scope match the CLI. Get and save return the graph's browser URL.

MiniLake tool names, schemas, resource URIs and prompts are preserved. Each client has a separate upstream session. Reconnect after upgrading Pond to discover the new tools; the registration URL stays the same. If MiniLake MCP is disabled, Pond's graph tools still use MiniLake's REST API. `/pond/config` reports Pond MCP in `mcp` and upstream availability in `minilake_mcp`.

### WebMCP (agents in the browser)

The page registers its actions as tools on `navigator.modelContext` ([spec](https://webmachinelearning.github.io/webmcp/)). Tools act through the UI, so you see what the agent does, and every call is listed under **Agent** in the header.

| Area | Tools |
| --- | --- |
| Orientation | `get_view` |
| Data | `list_catalogs`, `list_schemas`, `list_tables`, `describe_table`, `open_table`, `create_catalog`, `create_schema`, `create_volume`, `import_data`, `create_table_from_file`, `drop_object` |
| Query | `run_sql`, `draft_sql`, `save_query`, `list_saved_queries`, `query_history` |
| Jobs | `list_jobs`, `list_runs`, `get_run`, `run_script`, `create_job`, `run_job` |
| Graph | `list_graphs`, `open_graph`, `save_graph`, `graph_metrics`, `graph_stats`, `shortest_path`, `graph_neighbors` |
| Files | `list_files`, `read_file`, `write_file`, `delete_path`, `list_workspace`, `read_workspace_file`, `write_workspace_file` |
| Settings | `list_warehouses`, `list_secrets`, `put_secret`, `reset_lake` |

`drop_object`, `delete_path` and `reset_lake` open the same confirmation dialog a person gets, through `requestUserInteraction` when the browser provides it. Tools also ask before they delete or replace data in other ways:
- `run_sql` with a statement that drops, deletes, truncates or replaces data, anywhere in the SQL;
- imports in `replace` mode;
- `write_file`, `write_workspace_file`, `save_query`, `save_graph` or `put_secret` on something that already exists.

Queries, inserts, updates and schema changes that keep data run without asking, so an agent can analyse and reshape data freely. Python runs without asking too. One-off scripts (`run_script`) are saved under `/Shared/pond/runs`, and each new job gets its own script file, so an agent's script never replaces another one. The dialog has a "Don't ask again until this page is reloaded" box. Dropping objects, deleting files and resetting the lake ask every time regardless. If the user cancels, the tool fails with "The user declined." Secret values are never returned or shown in the activity log.

In browsers without native WebMCP, load a WebMCP polyfill (for example MCP-B's `@mcp-b/global`) or call the same tools from `window.pond.tools`.

## Development

```sh
go run . ~/some/dir          # run from a checkout
go test ./...                # Go tests use a fake docker CLI and fake MiniLake; no daemon needed
node --test web/test/*.test.js # UI tests only (go test runs these too when node is installed)
golangci-lint run            # Go linters, configured in .golangci.yml
deno lint                    # UI linter, configured in deno.json
deno check web/static/*.js web/static/views/*.js   # type-checks the UI modules
go build -ldflags "-X main.version=$(git describe --tags --always)" -o pond .
```

The graph tests compare every metric and grouping in the embedded runtime with the same fixtures in Node's JavaScript engine. For the optional live check, start an isolated context with the social seeds, save the graph as `Messaging` using the command above, and run `POND_GRAPH_ACCEPTANCE_URL=http://localhost:PORT go test ./internal/server -run TestLiveGraphAcceptance -v`. This check needs MiniLake 1.9.1 and includes large-graph scope and SQL path limits.

Pushing a `v*` tag runs the tests, then [GoReleaser](https://goreleaser.com) publishes binaries to GitHub Releases, with the Homebrew cask `pond.rb` attached. Copy it into `Casks/` in [asabla/homebrew-tap](https://github.com/asabla/homebrew-tap) to update `brew install`. CI runs the same tests, plus the linters and `govulncheck`, on every push and pull request.

The UI is embedded in the binary, so UI changes need a rebuild (`go build`) or a fresh `go run`. While working on it, set `POND_UI_DIR=web/static` and pond serves the UI from disk instead, so a reload shows your changes.

```
main.go, graph_cli.go        context commands and graph analysis CLI
internal/pondctx/            per-directory contexts: containers, network, lock, .pond/ data and snapshots
internal/server/             embedded UI, REST proxy, combined MCP, graph API, /pond/config, other contexts
internal/graph/              shared JavaScript runtime, graph loading, saved definitions and analysis
internal/lake/               MiniLake calls pond makes itself: warehouse, SQL, catalogs, runs, reset
internal/seed/               runs pond-seed/ scripts
web/static/                  UI: plain HTML/CSS/JS modules, no build step
  lake.js                    MiniLake API client, shared by UI and WebMCP
  graph-core.js              graph definitions, SQL builders and analysis, shared with the server
  graph.js                   browser module exports and saved graph file access
  workbench.js               shell: contexts, navigator, tabs, ⌘K palette, activity, routing
  editor.js                  code editor with SQL and Python highlighting
  sql.js                     quote-aware SQL scanner: statements, destructive SQL
  views/                     home, data, query, graph, jobs, files, admin; one instance per tab
  fonts/                     Schibsted Grotesk and Fragment Mono, with their licences (OFL)
  vendor/                    sigma.js and graphology browser builds, with their licences
  webmcp.js                  WebMCP tool definitions
web/test/                    UI unit tests (node --test, no dependencies)
examples/social/             seed scripts for a generated example network
examples/shop/               a second example context: a shop whose customers are social's people
docs/images/                 README screenshots, taken from the example
```

## License

[MIT](LICENSE)
