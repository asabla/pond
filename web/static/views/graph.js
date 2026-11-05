// Graph: network analytics over lake tables. Draws a graph defined by SQL with sigma.js,
// computes metrics with graphology, and finds paths. Graphs too big to load open on their
// best-connected nodes and grow by expanding nodes; paths then come from SQL.
import { h, grid, toCsv, download, store, toast, formDialog, confirmDialog, empty, errorBox, loading, guard, syncTabs } from "../dom.js";
import * as G from "../graph.js";

// replaceChildren, skipping the null and false a conditional child leaves behind.
const put = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));

const LAYOUT_MS = (nodes) => Math.min(15000, 2500 + nodes * 2);
const TABLE_ROWS = 1000;
const LABELS_KEY = "pond.graphLabels";

// Metrics a node can be sized or ranked by. `heavy` ones say so before running on big graphs.
export const METRICS = {
  degree: { label: "Degree" },
  in_degree: { label: "In-degree", directed: true },
  out_degree: { label: "Out-degree", directed: true },
  pagerank: { label: "PageRank" },
  betweenness: { label: "Betweenness", heavy: true },
  closeness: { label: "Closeness", heavy: true },
  eigenvector: { label: "Eigenvector" },
  hub: { label: "Hub score (HITS)", directed: true },
  authority: { label: "Authority score (HITS)", directed: true },
  clustering: { label: "Clustering coefficient" },
};
// Groupings a node can be coloured by, besides its own attributes.
export const GROUPINGS = {
  community: { label: "Community (Louvain)" },
  component: { label: "Connected component" },
  strong_component: { label: "Strongly connected component", directed: true },
};
const HEAVY_NODES = 5000;

let libsPromise;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = h("script", { src });
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}
// The graph libraries are only fetched when the Graph tab is first used.
function loadLibs() {
  libsPromise ??= (async () => {
    await loadScript("/vendor/graphology.umd.min.js");
    await loadScript("/vendor/graphology-library.min.js");
    await loadScript("/vendor/sigma.min.js");
    return { Graph: window.graphology.Graph ?? window.graphology, lib: window.graphologyLibrary, Sigma: window.Sigma };
  })().catch((err) => {
    libsPromise = undefined;
    throw err;
  });
  return libsPromise;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function theme() {
  return {
    ink: css("--ink"), ink2: css("--ink-2"), ink3: css("--ink-3"), line: css("--line"), surface: css("--surface"),
    accent: css("--accent"), agent: css("--agent"), node: css("--graph-node"), edge: css("--graph-edge"),
    series: Array.from({ length: G.SLOTS }, (_, i) => css(`--series-${i + 1}`)),
    other: css("--series-other"),
    ramp: Array.from({ length: 5 }, (_, i) => css(`--seq-${i + 1}`)),
  };
}

// Thrown inside a graph load that a newer load replaced.
const STALE = Symbol("stale graph load");

export function createGraphView(ui) {
  const { lake } = ui;
  let loadSeq = 0;
  const s = {
    def: null, // the graph definition being shown
    mode: null, // "full" | "overview"
    totalEdges: 0,
    columns: null, // { source, target, numeric }
    graph: null,
    sigma: null,
    layout: null,
    layoutTimer: null,
    metrics: {}, // name -> { node: value }
    groups: {}, // name -> { node: group } plus .meta
    size: store("pond.graphSize") ?? "degree",
    color: store("pond.graphColor") ?? "community",
    selected: null,
    hovered: null,
    path: null, // { nodes: [...keys], edges: Set }
    panel: "node",
    showTable: false,
    labels: store(LABELS_KEY) ?? true,
    loading: null,
    error: null,
    saved: [],
  };

  const stage = h("div", { class: "graph-stage", "aria-label": "Graph canvas" });
  const tableWrap = h("div", { class: "graph-table", hidden: true });
  const legend = h("div", { class: "graph-legend", "aria-label": "Legend" });
  const status = h("div", { class: "graph-status" });
  const toolbar = h("div", { class: "graph-toolbar" });
  const panelTabs = h("div", { class: "panel-tabs", role: "tablist" });
  const panelBody = h("div", { class: "panel-body graph-panel-body", id: "graph-panel", role: "tabpanel" });
  const main = h("div", { class: "graph-main" }, toolbar, status, h("div", { class: "graph-canvas-wrap" }, stage, tableWrap, legend));
  const panel = h("aside", { class: "query-panel graph-panel" }, panelTabs, panelBody);
  const el = h("section", { class: "view graph-view", "aria-label": "Graph" }, main, panel);

  /* ---------- Loading a graph ---------- */

  async function open(input, { byAgent = false } = {}) {
    const def = typeof input === "string" ? s.saved.find((g) => g.name === input) ?? (await G.listGraphs(lake)).find((g) => g.name === input) : input;
    if (!def) throw new Error(`No saved graph named “${input}”.`);
    const problem = G.validateDefinition(def);
    if (problem) throw new Error(problem);
    const norm = G.normalize(def);
    if (norm.name && location.hash !== `#/graph/${encodeURIComponent(norm.name)}`) history.replaceState(null, "", `#/graph/${encodeURIComponent(norm.name)}`);
    teardown();
    // A newer open() (the user switching graphs, or an agent) makes this one stale: it
    // checks after every await and stops before touching the newer graph.
    const load = ++loadSeq;
    const live = () => {
      if (load !== loadSeq) throw STALE;
    };
    Object.assign(s, { def: norm, graph: null, mode: null, metrics: {}, groups: {}, diameter: null, selected: null, path: null, error: null, loading: "Loading graph…", byAgent });
    render();
    try {
      const { Graph } = await loadLibs();
      live();
      const head = await lake.runSql(G.columnsSql(norm));
      live();
      if (head.columns.length < 2) throw new Error("The edge query needs at least two columns: source and target.");
      s.columns = {
        source: head.columns[0].name,
        target: head.columns[1].name,
        weighted: head.columns.some((c, i) => i > 1 && c.name.toLowerCase() === "weight"),
        numeric: /INT|LONG|SHORT|BYTE|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i.test(head.columns[0].type ?? ""),
      };
      const total = Number((await lake.runSql(G.countEdgesSql(norm))).rows[0]?.[0] ?? 0);
      live();
      s.totalEdges = total;
      s.graph = new Graph({ type: norm.directed ? "directed" : "undirected", allowSelfLoops: true });
      if (s.totalEdges <= G.FULL_LOAD_EDGES) {
        s.mode = "full";
        const edgeRows = await lake.runSql(G.loadEdgesSql(norm, G.FULL_LOAD_EDGES));
        live();
        addEdges(G.edgeRecords(edgeRows));
        if (norm.nodes_sql) {
          const nodeRows = await lake.runSql(G.nodesSql(norm));
          live();
          addNodes(G.nodeRecords(nodeRows), { onlyExisting: false });
        }
      } else {
        s.mode = "overview";
        // The best-connected nodes with their neighbours, then every edge among those nodes.
        const top = (await lake.runSql(G.topNodesSql(norm, s.columns))).rows.map((r) => r[0]);
        live();
        for (const id of top) ensureNode(id);
        const touching = await lake.runSql(G.edgesTouchingSql(norm, s.columns, top));
        live();
        addEdges(G.edgeRecords(touching));
        const loaded = s.graph.nodes().map((n) => s.graph.getNodeAttribute(n, "raw"));
        const among = await lake.runSql(`${G.edgesAmongSql(norm, s.columns, loaded)} LIMIT ${G.FULL_LOAD_EDGES}`);
        live();
        addEdges(G.edgeRecords(among));
        await loadNodeAttributes(loaded);
        live();
      }
      s.loading = null;
      await draw();
      live();
      return summary();
    } catch (err) {
      if (err === STALE) throw new Error("Another graph was opened before this one finished loading.");
      s.loading = null;
      s.error = err.message;
      render();
      throw err;
    }
  }

  function ensureNode(raw) {
    const key = G.keyOf(raw);
    if (!s.graph.hasNode(key)) s.graph.addNode(key, { raw, label: key, attributes: {}, x: Math.random(), y: Math.random(), size: 4 });
    return key;
  }

  function addEdges(records) {
    for (const r of records) {
      const a = ensureNode(r.source);
      const b = ensureNode(r.target);
      const existing = s.graph.edge(a, b);
      // Repeated pairs merge into one edge; with a weight column their weights add up.
      if (!existing) s.graph.addEdge(a, b, { weight: r.weight, count: 1, attributes: r.attributes });
      else {
        s.graph.updateEdgeAttribute(existing, "count", (c) => (c ?? 1) + 1);
        if (s.columns.weighted) s.graph.updateEdgeAttribute(existing, "weight", (w) => (w ?? 0) + r.weight);
      }
    }
  }

  function addNodes(records, { onlyExisting = true } = {}) {
    for (const r of records) {
      const key = G.keyOf(r.id);
      if (!s.graph.hasNode(key)) {
        if (onlyExisting) continue;
        ensureNode(r.id);
      }
      s.graph.mergeNodeAttributes(key, { label: r.label, attributes: r.attributes });
    }
  }

  async function loadNodeAttributes(ids) {
    const graph = s.graph;
    if (!s.def.nodes_sql || !ids.length) return;
    const head = await lake.runSql(`${G.nodesSql(s.def)} LIMIT 0`);
    const rows = await lake.runSql(G.nodesSql(s.def, { column: head.columns[0].name, values: ids }));
    if (s.graph === graph) addNodes(G.nodeRecords(rows));
  }

  // Overview mode: pull in a node's neighbours from SQL.
  async function expand(key) {
    if (s.mode !== "overview" || !s.graph.hasNode(key)) return 0;
    const before = s.graph.order;
    const { x, y } = s.graph.getNodeAttributes(key);
    const graph = s.graph;
    const records = G.edgeRecords(await lake.runSql(G.neighborsSql(s.def, s.columns, s.graph.getNodeAttribute(key, "raw"))));
    if (s.graph !== graph) return 0; // another graph was opened meanwhile
    addEdges(records);
    const added = s.graph.nodes().slice(before);
    for (const n of added) s.graph.mergeNodeAttributes(n, { x: x + (Math.random() - 0.5) * 0.1, y: y + (Math.random() - 0.5) * 0.1 });
    await loadNodeAttributes(added.map((n) => s.graph.getNodeAttribute(n, "raw")));
    if (s.graph !== graph) return 0;
    s.metrics = {};
    s.groups = {};
    await restyle();
    startLayout(1500);
    renderToolbar();
    return added.length;
  }

  /* ---------- Metrics ---------- */

  function rawId(key) {
    if (s.graph?.hasNode(key)) return s.graph.getNodeAttribute(key, "raw");
    // Only use a number when it round-trips: a BIGINT id past 2^53 stays a string,
    // which DuckDB casts to the column's type when comparing.
    return s.columns?.numeric && String(Number(key)) === key ? Number(key) : key;
  }

  // Only a weight column makes a graph weighted; repeated rows alone don't.
  function weighted() {
    return Boolean(s.columns?.weighted);
  }

  async function metric(name) {
    if (s.metrics[name]) return s.metrics[name];
    const { lib } = await loadLibs();
    const g = s.graph;
    const c = lib.metrics.centrality;
    const weight = weighted() ? "weight" : null;
    let out;
    switch (name) {
      case "degree": out = Object.fromEntries(g.nodes().map((n) => [n, g.degree(n)])); break;
      case "in_degree": out = Object.fromEntries(g.nodes().map((n) => [n, g.inDegree(n)])); break;
      case "out_degree": out = Object.fromEntries(g.nodes().map((n) => [n, g.outDegree(n)])); break;
      case "pagerank": out = c.pagerank(g, { getEdgeWeight: weight }); break;
      case "betweenness": out = c.betweenness(g, { getEdgeWeight: weight, normalized: true }); break;
      case "closeness": out = c.closeness(g); break;
      case "eigenvector":
        try {
          out = c.eigenvector(g, { getEdgeWeight: weight, maxIterations: 500 });
        } catch (err) {
          throw new Error(`Eigenvector centrality did not converge on this graph (${err.message}).`);
        }
        break;
      case "hub":
      case "authority": {
        const { hubs, authorities } = c.hits(g, { getEdgeWeight: weight, maxIterations: 500 });
        s.metrics.hub = hubs;
        s.metrics.authority = authorities;
        return s.metrics[name];
      }
      case "clustering": out = G.clusteringCoefficients(g.nodes(), (n) => g.neighbors(n)); break;
      default: throw new Error(`Unknown metric ${name}. Use one of: ${Object.keys(METRICS).join(", ")}.`);
    }
    s.metrics[name] = out;
    return out;
  }

  async function grouping(name) {
    if (s.groups[name]) return s.groups[name];
    const { lib } = await loadLibs();
    const g = s.graph;
    let byNode = {};
    let meta = {};
    if (name === "community") {
      const res = lib.communitiesLouvain.detailed(g, { getEdgeWeight: weighted() ? "weight" : null, rng: seeded(42) });
      byNode = numberBySize(res.communities, "Community");
      meta = { count: res.count, modularity: res.modularity };
    } else if (name === "component" || name === "strong_component") {
      const comps = name === "component" ? lib.components.connectedComponents(g) : lib.components.stronglyConnectedComponents(g);
      comps.sort((a, b) => b.length - a.length);
      const prefix = name === "component" ? "Component" : "Strong component";
      comps.forEach((nodes, i) => nodes.forEach((n) => (byNode[n] = `${prefix} ${i + 1}`)));
      meta = { count: comps.length, largest: comps[0]?.length ?? 0 };
    } else if (name.startsWith("attr:")) {
      const attr = name.slice(5);
      g.forEachNode((n, a) => (byNode[n] = a.attributes?.[attr] ?? null));
    } else {
      throw new Error(`Unknown grouping ${name}. Use one of: ${Object.keys(GROUPINGS).join(", ")}, or attr:<column>.`);
    }
    s.groups[name] = { byNode, meta };
    return s.groups[name];
  }

  // Louvain's ids are arbitrary; name groups by size instead, largest first.
  function numberBySize(ids, prefix) {
    const counts = new Map();
    for (const id of Object.values(ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
    const rank = new Map([...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id], i) => [id, `${prefix} ${i + 1}`]));
    return Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, rank.get(id)]));
  }

  // Louvain is randomised; a fixed seed keeps colours the same between visits.
  function seeded(seed) {
    let x = seed;
    return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
  }

  async function stats() {
    const g = s.graph;
    const { lib } = await loadLibs();
    const comp = await grouping("component");
    const out = {
      nodes: g.order,
      edges: g.size,
      directed: g.type === "directed",
      weighted: weighted(),
      density: lib.metrics.graph.density(g),
      // Matches the Degree metric, which counts in- and out-edges.
      average_degree: g.order ? (2 * g.size) / g.order : 0,
      components: comp.meta.count,
      largest_component: comp.meta.largest,
      mode: s.mode,
      total_edges_in_lake: s.totalEdges,
    };
    if (s.groups.community) Object.assign(out, { communities: s.groups.community.meta.count, modularity: s.groups.community.meta.modularity });
    if (s.groups.strong_component) out.strong_components = s.groups.strong_component.meta.count;
    if (s.metrics.clustering) out.average_clustering = avg(Object.values(s.metrics.clustering));
    if (s.diameter != null) out.diameter = s.diameter;
    return out;
  }

  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  /* ---------- Paths ---------- */

  async function findPath(fromId, toId, { useWeights = true } = {}) {
    const from = G.keyOf(fromId);
    const to = G.keyOf(toId);
    const graph = s.graph;
    const stale = () => s.graph !== graph;
    const gone = () => new Error("Another graph was opened while the path search ran.");
    let keys;
    if (s.graph.hasNode(from) && s.graph.hasNode(to)) {
      const { lib } = await loadLibs();
      const w = useWeights && weighted();
      keys = w ? lib.shortestPath.dijkstra.bidirectional(s.graph, from, to, "weight") : lib.shortestPath.bidirectional(s.graph, from, to);
    }
    if (!keys && s.mode === "overview") {
      // Not connected among the loaded nodes: search the whole graph in SQL.
      const raw = await G.sqlShortestPath({ runSql: lake.runSql, def: s.def, columns: s.columns, from: rawId(from), to: rawId(to), directed: s.def.directed });
      if (stale()) throw gone();
      if (raw) {
        const before = s.graph.order;
        for (let i = 0; i + 1 < raw.length; i++) {
          const [a, b] = [raw[i], raw[i + 1]];
          const fwd = await lake.runSql(G.edgeBetweenSql(s.def, s.columns, a, b, s.def.directed));
          if (stale()) throw gone();
          addEdges(G.edgeRecords(fwd));
        }
        await loadNodeAttributes(s.graph.nodes().slice(before).map((n) => s.graph.getNodeAttribute(n, "raw")));
        if (stale()) throw gone();
        keys = raw.map(G.keyOf);
        placeAlong(keys, new Set(s.graph.nodes().slice(before)));
        s.metrics = {};
        s.groups = {};
        await restyle();
      }
    }
    if (!keys) {
      s.path = { nodes: [], from, to, none: true };
    } else {
      const edges = new Set();
      let total = 0;
      for (let i = 0; i + 1 < keys.length; i++) {
        const e = s.graph.edge(keys[i], keys[i + 1]) ?? (s.graph.type !== "directed" ? s.graph.edge(keys[i + 1], keys[i]) : undefined);
        if (e) {
          edges.add(e);
          total += s.graph.getEdgeAttribute(e, "weight");
        }
      }
      s.path = { nodes: keys, edges, from, to, hops: keys.length - 1, weight: total };
    }
    s.panel = "path";
    refresh();
    if (keys) fitNodes(keys);
    renderToolbar();
    renderPanel();
    return s.path;
  }

  // Nodes a path pulls in go on the line between its ends, so the path reads before layout.
  function placeAlong(keys, added) {
    const at = (k) => (added.has(k) ? null : s.graph.getNodeAttributes(k));
    const first = at(keys[0]) ?? { x: 0, y: 0 };
    const last = at(keys[keys.length - 1]) ?? { x: first.x + 100, y: first.y };
    keys.forEach((k, i) => {
      if (!added.has(k)) return;
      const t = i / (keys.length - 1);
      s.graph.mergeNodeAttributes(k, { x: first.x + (last.x - first.x) * t, y: first.y + (last.y - first.y) * t });
    });
  }

  /* ---------- Drawing ---------- */

  function teardown() {
    stopLayout();
    s.layout?.kill?.();
    s.layout = null;
    s.sigma?.kill();
    s.sigma = null;
  }

  async function draw() {
    const { Sigma, lib } = await loadLibs();
    if (s.graph.order && s.graph.nodes().every((n) => s.graph.getNodeAttribute(n, "x") < 1)) lib.layout.circular.assign(s.graph, { scale: 100 });
    await restyle();
    render();
    s.sigma = new Sigma(s.graph, stage, {
      renderEdgeLabels: false,
      defaultEdgeType: s.def.directed ? "arrow" : "line",
      labelColor: { color: s.theme.ink },
      allowInvalidContainer: true,
      labelFont: getComputedStyle(document.body).fontFamily,
      labelSize: 12,
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.5,
      renderLabels: s.labels,
      zIndex: true,
      defaultDrawNodeHover: drawHover,
      nodeReducer,
      edgeReducer,
    });
    s.sigma.on("enterNode", ({ node }) => ((s.hovered = node), s.sigma.refresh({ skipIndexation: true })));
    s.sigma.on("leaveNode", () => ((s.hovered = null), s.sigma.refresh({ skipIndexation: true })));
    s.sigma.on("clickNode", ({ node }) => select(node));
    s.sigma.on("doubleClickNode", (e) => {
      e.preventSigmaDefault();
      expand(e.node).catch((err) => toast(err.message, "err"));
    });
    s.sigma.on("clickStage", () => select(null));
    startLayout(LAYOUT_MS(s.graph.order));
  }

  // Hover labels on the page's own surface, so they read in dark mode too.
  function drawHover(ctx, data, settings) {
    const t = s.theme;
    const size = settings.labelSize;
    ctx.font = `${size}px ${settings.labelFont}`;
    const label = data.label ?? "";
    const w = ctx.measureText(label).width + 10;
    const hgt = size + 8;
    ctx.fillStyle = t.surface;
    ctx.strokeStyle = t.line;
    ctx.beginPath();
    ctx.roundRect(data.x + data.size + 3, data.y - hgt / 2, w, hgt, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = t.ink;
    ctx.fillText(label, data.x + data.size + 8, data.y + size / 3);
  }

  // Sizes and colours come from the chosen metric and grouping; reducers add focus.
  async function restyle() {
    const t = (s.theme = theme());
    const g = s.graph;
    // Fall back when a remembered choice doesn't fit this graph.
    const directed = g.type === "directed";
    if (METRICS[s.size]?.directed && !directed) s.size = "degree";
    if (GROUPINGS[s.color]?.directed && !directed) s.color = "component";
    if (s.color.startsWith("attr:") && !nodeAttributes().includes(s.color.slice(5))) s.color = "community";
    let sizes = null;
    try {
      sizes = s.size === "none" ? null : G.scale(await metric(s.size)).byNode;
    } catch (err) {
      toast(err.message, "err");
    }
    // Small nodes on big graphs; the metric adds up to three times the base size.
    const base = g.order > 2000 ? 1.5 : g.order > 300 ? 2 : g.order > 60 ? 3 : 5;
    g.forEachNode((n) => g.setNodeAttribute(n, "size", base + (sizes ? sizes[n] * base * 3 : base)));

    s.legend = null;
    let colorOf = () => t.node;
    if (s.color !== "none") {
      try {
        const grp = await grouping(s.color);
        // Numbers with few distinct values (a team id, a year) read better as categories.
        if (s.color.startsWith("attr:") && G.isNumeric(grp.byNode) && new Set(Object.values(grp.byNode)).size > G.SLOTS) {
          const { byNode, min, max } = G.scale(grp.byNode);
          colorOf = (n) => (grp.byNode[n] == null ? t.other : t.ramp[Math.min(4, Math.floor(byNode[n] * 5))]);
          s.legend = { kind: "ramp", min, max, title: s.color.slice(5) };
        } else {
          const cat = G.categorize(grp.byNode);
          colorOf = (n) => (cat.byNode[n] >= 0 ? t.series[cat.byNode[n]] : t.other);
          s.legend = { kind: "categories", ...cat, title: colorLabel(s.color) };
        }
      } catch (err) {
        toast(err.message, "err");
      }
    }
    g.forEachNode((n) => g.setNodeAttribute(n, "color", colorOf(n)));
    g.forEachEdge((e) => g.mergeEdgeAttributes(e, { color: t.edge, size: 0.6 }));
    renderLegend();
    s.sigma?.refresh();
  }

  function nodeReducer(node, data) {
    const t = s.theme;
    const focus = s.hovered ?? s.selected;
    const res = { ...data };
    if (s.path?.nodes.length) {
      if (s.path.nodes.includes(node)) return { ...res, highlighted: true, zIndex: 2, forceLabel: true };
      return { ...res, color: t.line, label: "", zIndex: 0 };
    }
    if (focus && s.graph.hasNode(focus)) {
      if (node === focus) return { ...res, highlighted: true, zIndex: 2, forceLabel: true };
      if (s.graph.areNeighbors(node, focus)) return { ...res, zIndex: 1 };
      return { ...res, color: t.line, label: "", zIndex: 0 };
    }
    return res;
  }

  function edgeReducer(edge, data) {
    const t = s.theme;
    const focus = s.hovered ?? s.selected;
    if (s.path?.nodes.length) {
      return s.path.edges?.has(edge) ? { ...data, color: t.accent, size: 2.5, zIndex: 2 } : { ...data, hidden: false, color: t.line, size: 0.3 };
    }
    if (focus && s.graph.hasNode(focus)) {
      return s.graph.hasExtremity(edge, focus) ? { ...data, color: t.ink3, size: 1.2, zIndex: 1 } : { ...data, hidden: true };
    }
    return data;
  }

  function refresh() {
    s.sigma?.refresh({ skipIndexation: true });
  }

  function startLayout(ms) {
    if (!s.graph?.order) return;
    loadLibs().then(({ lib }) => {
      if (!s.layout) {
        const settings = lib.layoutForceAtlas2.inferSettings(s.graph);
        // Small graphs keep nodes from overlapping; big ones trade that for Barnes-Hut speed.
        const small = s.graph.order <= 500;
        s.layout = new lib.FA2Layout(s.graph, { settings: { ...settings, barnesHutOptimize: !small, adjustSizes: small } });
      }
      clearTimeout(s.layoutTimer);
      if (!s.layout.isRunning()) s.layout.start();
      s.layoutTimer = setTimeout(stopLayout, ms);
      renderStatus();
    });
  }

  function stopLayout() {
    clearTimeout(s.layoutTimer);
    if (s.layout?.isRunning()) s.layout.stop();
    if (s.graph) renderStatus();
  }

  function focusNode(key) {
    if (!s.sigma || !s.graph.hasNode(key)) return;
    const d = s.sigma.getNodeDisplayData(key);
    if (d) s.sigma.getCamera().animate({ x: d.x, y: d.y, ratio: 0.35 }, { duration: 500 });
  }

  // Moves the camera so all the given nodes are in view (ratio 1 shows the whole graph).
  function fitNodes(keys) {
    const pts = keys.map((k) => s.sigma?.getNodeDisplayData(k)).filter(Boolean);
    if (!pts.length) return;
    const xs = pts.map((d) => d.x);
    const ys = pts.map((d) => d.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const ratio = Math.min(1, Math.max(0.2, Math.max(x1 - x0, y1 - y0) * 1.4));
    s.sigma.getCamera().animate({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, ratio }, { duration: 500 });
  }

  function select(key, { center = false } = {}) {
    s.selected = key && s.graph?.hasNode(key) ? key : null;
    if (s.selected) {
      s.panel = "node";
      if (center) focusNode(s.selected);
    }
    refresh();
    renderPanel();
    if (s.showTable) renderTable();
  }

  /* ---------- Rendering ---------- */

  function colorLabel(name) {
    return GROUPINGS[name]?.label ?? (name.startsWith("attr:") ? name.slice(5) : name);
  }

  function nodeAttributes() {
    const names = new Set();
    s.graph?.forEachNode((_, a) => Object.keys(a.attributes ?? {}).forEach((k) => names.add(k)));
    return [...names];
  }

  function select_(label, value, options, onchange) {
    return h("label", { class: "graph-select" }, h("span", {}, label),
      h("select", { onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h("option", { value: v, selected: v === value }, l))));
  }

  function renderToolbar() {
    const directed = s.def?.directed;
    const sizeOptions = [["none", "Same size"], ...Object.entries(METRICS).filter(([, m]) => !m.directed || directed).map(([k, m]) => [k, m.label])];
    const colorOptions = [["none", "No colour"], ...Object.entries(GROUPINGS).filter(([, m]) => !m.directed || directed).map(([k, m]) => [k, m.label]),
      ...nodeAttributes().map((a) => [`attr:${a}`, `Column: ${a}`])];
    const nodeOptions = s.graph ? s.graph.nodes().slice(0, 2000).map((n) => h("option", { value: s.graph.getNodeAttribute(n, "label") })) : [];
    const search = h("input", { class: "input graph-search", type: "search", placeholder: "Find node…", list: "graph-nodes", "aria-label": "Find node" });
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const key = findNode(search.value.trim(), { fuzzy: true });
      if (key) select(key, { center: true });
      else toast(`No node “${search.value}” in the loaded graph.`, "err");
    });
    put(toolbar,
      h("select", { class: "graph-pick", "aria-label": "Saved graphs", onchange: (e) => e.target.value && ui.navigate("graph", e.target.value) },
        h("option", { value: "", selected: !s.def?.name }, s.def && !s.def.name ? "Unsaved graph" : "Saved graphs…"),
        s.saved.map((g) => h("option", { value: g.name, selected: g.name === s.def?.name }, g.name))),
      h("button", { class: "btn", onclick: guard(() => newGraph()) }, "New graph"),
      s.def && h("button", { class: "btn", onclick: guard(() => saveDialog()) }, s.def.name ? "Edit" : "Save…"),
      s.graph && [
        h("span", { class: "graph-sep" }),
        select_("Size", s.size, sizeOptions, async (v) => {
          if (METRICS[v]?.heavy && s.graph.order > HEAVY_NODES && !(await confirmDialog({ title: `Compute ${METRICS[v].label.toLowerCase()}?`, body: `It takes a while on ${s.graph.order.toLocaleString()} nodes.`, confirm: "Compute" }))) return renderToolbar();
          s.size = v;
          store("pond.graphSize", v);
          await busy(restyle);
          if (s.showTable) renderTable();
        }),
        select_("Colour", s.color, colorOptions, async (v) => {
          s.color = v;
          store("pond.graphColor", v);
          await busy(restyle);
          renderPanel();
        }),
        search,
        h("datalist", { id: "graph-nodes" }, nodeOptions),
      ],
    );
    renderStatus();
  }

  // View toggles sit at the end of the status row.
  function viewControls() {
    const running = s.layout?.isRunning();
    return h("span", { class: "graph-view-controls" },
      h("button", { class: "btn ghost small", "aria-pressed": String(s.labels), title: "Show node labels", onclick: () => {
        s.labels = !s.labels;
        store(LABELS_KEY, s.labels);
        s.sigma?.setSetting("renderLabels", s.labels);
        renderStatus();
      } }, "Labels"),
      h("button", { class: "btn ghost small", disabled: s.showTable, onclick: () => (running ? stopLayout() : startLayout(LAYOUT_MS(s.graph.order))) }, running ? "Stop layout" : "Run layout"),
      h("button", { class: "btn ghost small", "aria-pressed": String(s.showTable), onclick: () => {
        s.showTable = !s.showTable;
        renderView();
      } }, s.showTable ? "Show graph" : "Show table"));
  }

  async function busy(fn) {
    status.classList.add("busy");
    await new Promise((r) => setTimeout(r, 20)); // let the page paint first
    try {
      await fn();
    } finally {
      status.classList.remove("busy");
    }
  }

  // An id, then an exact label (any case). With fuzzy, then a label containing the text:
  // only for people typing, so an id like "5" never lands on a loaded "Node 55".
  function findNode(text, { fuzzy = false } = {}) {
    if (!text || !s.graph) return null;
    if (s.graph.hasNode(text)) return text;
    const lower = text.toLowerCase();
    return s.graph.findNode((_, a) => String(a.label).toLowerCase() === lower)
      ?? (fuzzy ? s.graph.findNode((_, a) => String(a.label).toLowerCase().includes(lower)) : null)
      ?? null;
  }

  function renderStatus() {
    if (!s.graph) return put(status);
    const g = s.graph;
    const parts = [
      h("b", {}, `${g.order.toLocaleString()} nodes`), h("span", {}, `${g.size.toLocaleString()} edges`),
      h("span", { class: "muted" }, s.def.directed ? "directed" : "undirected"),
    ];
    if (s.mode === "overview") {
      parts.push(h("span", { class: "graph-note" },
        `Overview of a ${s.totalEdges.toLocaleString()}-edge graph: its ${G.OVERVIEW_SEEDS} best-connected nodes and their neighbours. Double-click a node to expand it. Metrics cover the loaded nodes; paths search the whole graph.`));
    }
    if (s.byAgent) parts.push(h("span", { class: "by-agent" }, "opened by agent"));
    put(status, ...parts, viewControls());
  }

  function renderLegend() {
    const L = s.legend;
    if (!L || s.showTable) return put(legend, );
    const t = s.theme;
    if (L.kind === "ramp") {
      put(legend, h("b", {}, L.title),
        h("div", { class: "ramp" }, t.ramp.map((c) => h("i", { style: `background:${c}` }))),
        h("div", { class: "ramp-ends" }, h("span", {}, fmt(L.min)), h("span", {}, fmt(L.max))));
      return;
    }
    put(legend, h("b", {}, L.title),
      h("ul", {}, L.legend.map((x) => h("li", {}, h("i", { style: `background:${t.series[x.slot]}` }), h("span", {}, x.category), h("small", {}, x.count.toLocaleString()))),
        L.other && h("li", {}, h("i", { style: `background:${t.other}` }), h("span", {}, `Other (${L.other.categories})`), h("small", {}, L.other.count.toLocaleString()))));
  }

  const fmt = (v) => (typeof v !== "number" ? String(v) : Number.isInteger(v) ? v.toLocaleString() : v.toPrecision(3));

  function renderPanelTabs() {
    syncTabs(panelTabs, [["node", "Node"], ["path", "Path"], ["stats", "Stats"]], s.panel, (key) => {
      s.panel = key;
      renderPanel();
    }, "graph-panel");
  }

  async function renderPanel() {
    renderPanelTabs();
    if (!s.graph) return put(panelBody, empty("Open a graph to inspect it."));
    if (s.panel === "node") return renderNodePanel();
    if (s.panel === "path") return renderPathPanel();
    put(panelBody, loading());
    const graph = s.graph;
    try {
      const st = await stats();
      if (s.panel !== "stats" || s.graph !== graph) return; // the user moved on meanwhile
      const rows = [
        ["Nodes", st.nodes], ["Edges", st.edges], ["Directed", st.directed ? "yes" : "no"], ["Weighted", st.weighted ? "yes" : "no"],
        ["Density", st.density], ["Average degree", st.average_degree], [st.directed ? "Weakly connected components" : "Connected components", st.components], ["Largest component", st.largest_component],
        st.strong_components != null && ["Strongly connected components", st.strong_components],
        st.communities != null && ["Communities", st.communities], st.modularity != null && ["Modularity", st.modularity],
        st.average_clustering != null && ["Average clustering", st.average_clustering],
        st.diameter != null && ["Diameter", st.diameter],
      ].filter(Boolean);
      put(panelBody,
        h("dl", { class: "kv graph-kv" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, fmt(v))])),
        h("div", { class: "graph-actions" },
          !s.groups.community && h("button", { class: "btn", onclick: async () => (await busy(() => grouping("community")), renderPanel()) }, "Find communities"),
          s.def.directed && !s.groups.strong_component && h("button", { class: "btn", onclick: async () => (await busy(() => grouping("strong_component")), renderPanel()) }, "Strong components"),
          !s.metrics.clustering && h("button", { class: "btn", onclick: async () => (await busy(() => metric("clustering")), renderPanel()) }, "Clustering"),
          s.diameter == null && h("button", { class: "btn", title: "Longest shortest path; slow on big graphs", onclick: async () => {
            if (s.graph.order > HEAVY_NODES && !(await confirmDialog({ title: "Compute the diameter?", body: `It takes a while on ${s.graph.order.toLocaleString()} nodes.`, confirm: "Compute" }))) return;
            const { lib } = await loadLibs();
            await busy(async () => {
              // graphology returns Infinity when some node can't reach another (following edge direction).
              const d = lib.metrics.graph.diameter(s.graph);
              s.diameter = Number.isFinite(d) ? d : "infinite: some nodes can't reach others";
            });
            renderPanel();
          } }, "Diameter")),
        s.mode === "overview" && h("p", { class: "help" }, "These describe the loaded nodes, not the whole graph."));
    } catch (err) {
      put(panelBody, errorBox(err.message));
    }
  }

  function renderNodePanel() {
    const key = s.selected;
    if (!key) return put(panelBody, empty("Click a node to see its details and neighbours."));
    const g = s.graph;
    const a = g.getNodeAttributes(key);
    const metricRows = Object.entries(s.metrics).filter(([m]) => m !== "degree").map(([m, vals]) => [METRICS[m]?.label ?? m, vals[key]]);
    const groupRows = Object.entries(s.groups).filter(([m]) => !m.startsWith("attr:")).map(([m, grp]) => [colorLabel(m), grp.byNode[key]]);
    const nbrList = (title, nodes) => nodes.length > 0 && h("div", { class: "graph-nbrs" },
      h("h3", {}, `${title} (${nodes.length.toLocaleString()})`),
      h("ul", {}, nodes.slice(0, 50).map((n) => h("li", {}, h("button", { class: "linkish", onclick: () => select(n, { center: true }) }, g.getNodeAttribute(n, "label")))),
        nodes.length > 50 && h("li", { class: "muted" }, `and ${(nodes.length - 50).toLocaleString()} more`)));
    put(panelBody,
      h("h2", { class: "graph-node-title" }, a.label),
      h("dl", { class: "kv graph-kv" },
        h("dt", {}, "Id"), h("dd", {}, key),
        h("dt", {}, "Degree"), h("dd", {}, fmt(g.degree(key))),
        Object.entries(a.attributes ?? {}).map(([k, v]) => [h("dt", {}, k), h("dd", {}, v == null ? "null" : String(v))]),
        [...metricRows, ...groupRows].map(([k, v]) => [h("dt", {}, k), h("dd", {}, v == null ? "—" : fmt(v))])),
      h("div", { class: "graph-actions" },
        s.mode === "overview" && h("button", { class: "btn", onclick: () => expand(key).then((n) => toast(n ? `Added ${n} nodes` : "No new neighbours")) }, "Expand"),
        h("button", { class: "btn", onclick: () => (Object.assign(pathForm, { from: a.label, fromKey: key }), (s.panel = "path"), renderPanel()) }, "Path from here"),
        h("button", { class: "btn", onclick: () => (Object.assign(pathForm, { to: a.label, toKey: key }), (s.panel = "path"), renderPanel()) }, "Path to here"),
        h("button", { class: "btn ghost", onclick: () => ui.views.query.open(G.neighborsSql(s.def, s.columns, a.raw, 1000)) }, "Edges in SQL")),
      g.type === "directed"
        ? [nbrList("Outgoing", g.outNeighbors(key)), nbrList("Incoming", g.inNeighbors(key))]
        : nbrList("Neighbours", g.neighbors(key)));
  }

  // fromKey/toKey remember the node picked with "Path from/to here", since labels can repeat.
  const pathForm = { from: "", to: "", fromKey: null, toKey: null };

  function renderPathPanel() {
    const from = h("input", { class: "input", list: "graph-nodes", value: pathForm.from, placeholder: "From node", "aria-label": "From node" });
    const to = h("input", { class: "input", list: "graph-nodes", value: pathForm.to, placeholder: "To node", "aria-label": "To node" });
    const useWeights = h("input", { type: "checkbox", checked: true });
    // In overview mode an unknown id goes to the SQL search rather than a fuzzy label match.
    const resolve = (text, key, typed) => (key && text === typed && s.graph?.hasNode(key) ? key : null)
      ?? findNode(text, { fuzzy: s.mode !== "overview" })
      ?? (s.mode === "overview" && text ? text : null);
    const go = async () => {
      const a = resolve(from.value.trim(), pathForm.fromKey, pathForm.from);
      const b = resolve(to.value.trim(), pathForm.toKey, pathForm.to);
      pathForm.from = from.value.trim();
      pathForm.to = to.value.trim();
      if (!a || !b) return toast(`Can't find ${!a ? pathForm.from || "the start" : pathForm.to || "the end"} in the graph.`, "err");
      try {
        await busy(() => findPath(a, b, { useWeights: useWeights.checked }));
      } catch (err) {
        toast(err.message, "err");
      }
    };
    const p = s.path;
    put(panelBody,
      h("form", { class: "graph-path-form", onsubmit: (e) => (e.preventDefault(), go()) },
        from, to,
        weighted() && h("label", { class: "check" }, useWeights, " Use edge weights"),
        h("div", { class: "graph-actions" }, h("button", { class: "btn primary", type: "submit" }, "Find shortest path"),
          p && h("button", { class: "btn ghost", type: "button", onclick: () => ((s.path = null), refresh(), renderPanel()) }, "Clear"))),
      p && (p.none
        ? h("p", { class: "help" }, `No path from ${label(p.from)} to ${label(p.to)}${s.def.directed ? " following edge directions" : ""}.`)
        : h("div", { class: "graph-path" },
          h("p", {}, h("b", {}, `${p.hops} hop${p.hops === 1 ? "" : "s"}`), weighted() ? ` · total weight ${fmt(p.weight)}` : ""),
          h("ol", {}, p.nodes.map((n) => h("li", {}, h("button", { class: "linkish", onclick: () => select(n, { center: true }) }, label(n))))))),
      !p && h("p", { class: "help" }, s.mode === "overview"
        ? `Paths between loaded nodes come from the loaded graph; otherwise pond searches the whole graph in SQL (up to ${G.PATH_MAX_HOPS} hops, ignoring weights).`
        : "Uses edge weights as distances when the graph has them."));
  }

  const label = (key) => (s.graph?.hasNode(key) ? s.graph.getNodeAttribute(key, "label") : key);

  // The table is the graph's accessible, sortable twin: one row per node with its metrics.
  function tableData({ display = false } = {}) {
    const g = s.graph;
    // Degree and attribute groupings are already columns of their own.
    const metricNames = Object.keys(s.metrics).filter((m) => m !== "degree");
    const groupNames = Object.keys(s.groups).filter((m) => !m.startsWith("attr:"));
    const attrNames = nodeAttributes();
    const columns = [{ name: "id", type: "" }, { name: "label", type: "" }, { name: "degree", type: "BIGINT" },
      ...attrNames.map((n) => ({ name: n, type: "" })), ...metricNames.map((n) => ({ name: n, type: "DOUBLE" })), ...groupNames.map((n) => ({ name: n, type: "" }))];
    const sortBy = s.metrics[s.size] ?? null;
    const nodes = g.nodes().sort((a, b) => (sortBy ? sortBy[b] - sortBy[a] : g.degree(b) - g.degree(a)));
    const num = (v) => (display && typeof v === "number" && !Number.isInteger(v) ? v.toPrecision(4) : v);
    const rows = nodes.map((n) => {
      const a = g.getNodeAttributes(n);
      return [String(a.raw), a.label, g.degree(n), ...attrNames.map((k) => a.attributes?.[k] ?? null),
        ...metricNames.map((m) => num(s.metrics[m][n] ?? null)), ...groupNames.map((m) => s.groups[m].byNode[n] ?? null)];
    });
    return { columns, rows };
  }

  function renderTable() {
    const data = tableData({ display: true });
    put(tableWrap,
      h("div", { class: "results-bar" },
        h("b", {}, `${data.rows.length.toLocaleString()} nodes`),
        data.rows.length > TABLE_ROWS && h("span", { class: "muted" }, `showing the top ${TABLE_ROWS.toLocaleString()}`),
        h("span", { class: "muted" }, s.metrics[s.size] ? `sorted by ${METRICS[s.size].label}` : "sorted by degree"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn ghost", onclick: () => download(`${s.def.name ?? "graph"}-nodes.csv`, toCsv(tableData()), "text/csv") }, "Export CSV"),
        h("button", { class: "btn", onclick: guard(() => saveMetricsDialog()) }, "Save as table…")),
      grid(data, { max: TABLE_ROWS }));
  }

  function renderView() {
    stage.hidden = s.showTable;
    tableWrap.hidden = !s.showTable;
    if (s.showTable) renderTable();
    renderLegend();
    renderToolbar();
  }

  function render() {
    renderToolbar();
    renderStatus();
    renderPanel();
    if (s.loading) {
      stage.hidden = false;
      tableWrap.hidden = true;
      put(stage, loading(s.loading));
      return;
    }
    if (s.error) {
      put(stage, h("div", { class: "graph-empty" }, errorBox(s.error), h("div", { class: "graph-actions" }, s.def && h("button", { class: "btn", onclick: guard(() => saveDialog()) }, "Edit definition"))));
      return;
    }
    if (!s.graph) {
      put(stage, h("div", { class: "graph-empty" },
        h("h1", {}, "Graph"),
        h("p", { class: "lede" }, "Explore relationships in your tables as a network: who connects to whom, which nodes matter most, which groups form and how things are linked."),
        h("p", { class: "help" }, "A graph comes from an edge table (or any SQL) with a source and a target column, and optionally a node table for labels and attributes."),
        h("div", { class: "graph-actions" }, h("button", { class: "btn primary", onclick: guard(() => newGraph()) }, "New graph from tables"), h("button", { class: "btn", onclick: guard(() => sqlDialog()) }, "New graph from SQL")),
        s.saved.length > 0 && [h("h2", {}, "Saved graphs"), h("ul", { class: "graph-saved" }, s.saved.map((g) => h("li", {}, h("a", { href: `#/graph/${encodeURIComponent(g.name)}` }, g.name), h("small", { class: "muted" }, g.directed ? " directed" : " undirected"))))]));
      return;
    }
    if (!stage.querySelector("canvas")) put(stage, );
    renderView();
  }

  /* ---------- Dialogs ---------- */

  async function allTables() {
    const out = [];
    for (const c of await lake.listCatalogs()) {
      for (const sc of await lake.listSchemas(c.name)) {
        for (const t of await lake.listTables(c.name, sc.name)) out.push(t.full_name);
      }
    }
    return out;
  }

  async function newGraph(prefill = {}) {
    const tables = await allTables();
    if (!tables.length) return sqlDialog();
    const first = await formDialog({
      title: "New graph from tables",
      intro: "Pick the table that holds the edges (one row per connection) and, optionally, a table describing the nodes.",
      fields: [
        { name: "edgeTable", label: "Edge table", type: "select", options: tables, value: prefill.edgeTable ?? tables[0] },
        { name: "nodeTable", label: "Node table (optional)", type: "select", options: [{ value: "", label: "None" }, ...tables], value: prefill.nodeTable ?? "" },
        { name: "directed", label: "Edges have a direction (A → B is not B → A)", type: "checkbox", value: true },
      ],
      submit: "Next",
    });
    if (!first) return;
    const cols = async (t) => (await lake.getTable(t)).columns?.map((c) => c.name) ?? [];
    const edgeCols = await cols(first.edgeTable);
    const nodeCols = first.nodeTable ? await cols(first.nodeTable) : [];
    const guess = (names, ...hints) => names.find((n) => hints.some((x) => n.toLowerCase() === x)) ?? names.find((n) => hints.some((x) => n.toLowerCase().includes(x)));
    const none = { value: "", label: "None" };
    const second = await formDialog({
      title: "Map the columns",
      fields: [
        { name: "source", label: "Source column", type: "select", options: edgeCols, value: guess(edgeCols, "source", "src", "from") ?? edgeCols[0] },
        { name: "target", label: "Target column", type: "select", options: edgeCols, value: guess(edgeCols, "target", "dst", "to") ?? edgeCols[1] },
        { name: "weight", label: "Weight column (optional)", type: "select", options: [none, ...edgeCols], value: guess(edgeCols, "weight", "amount", "count") ?? "", hint: "A distance for paths and a strength for PageRank and communities." },
        ...(first.nodeTable ? [
          { name: "nodeId", label: "Node id column", type: "select", options: nodeCols, value: guess(nodeCols, "id") ?? nodeCols[0] },
          { name: "label", label: "Label column (optional)", type: "select", options: [none, ...nodeCols], value: guess(nodeCols, "name", "label", "title") ?? "" },
        ] : []),
      ],
      validate: (v) => (v.source === v.target ? "Source and target must be different columns." : null),
      submit: "Open graph",
    });
    if (!second) return;
    const def = G.definitionFromTables({ ...first, ...second, name: null });
    await openAdhoc(def);
  }

  async function sqlDialog(def = {}) {
    const v = await formDialog({
      title: def.name ? `Edit “${def.name}”` : "New graph from SQL",
      intro: "The edge query's first two columns are the source and target. A column named weight weights edges; other columns become edge attributes. The node query's first column is the node id; a column named label names nodes.",
      fields: [
        { name: "edges_sql", label: "Edges", type: "textarea", rows: 6, required: true, value: def.edges_sql ?? "SELECT source, target\nFROM catalog.schema.edges" },
        { name: "nodes_sql", label: "Nodes (optional)", type: "textarea", rows: 4, value: def.nodes_sql ?? "" },
        { name: "directed", label: "Edges have a direction", type: "checkbox", value: def.directed ?? true },
        ...(def.name !== undefined ? [{ name: "name", label: "Name", required: true, value: def.name ?? "" }] : []),
      ],
      validate: (x) => G.validateDefinition({ ...x, name: x.name || null }),
      submit: def.name !== undefined ? "Save" : "Open graph",
    });
    if (!v) return null;
    return { ...def, ...v };
  }

  async function saveDialog() {
    const v = await sqlDialog({ ...s.def, name: s.def.name ?? "" });
    if (!v) return;
    const saved = await G.saveGraph(lake, v);
    s.saved = await G.listGraphs(lake);
    toast(`Saved graph “${saved.name}”`);
    ui.navigate("graph", saved.name);
    if (s.def?.name === saved.name) await open(saved);
  }

  async function saveMetricsDialog() {
    const v = await formDialog({
      title: "Save node metrics as a table",
      intro: "Writes one row per loaded node, with the metrics and groups computed so far, so you can join them in SQL.",
      fields: [{ name: "table", label: "Table", required: true, placeholder: "catalog.schema.table", value: s.def.name ? `${guessSchema()}.${s.def.name.replace(/\W+/g, "_")}_nodes` : "", pattern: "[^.]+\\.[^.]+\\.[^.]+" }],
      submit: "Save",
    });
    if (!v) return;
    const [catalog, schema, table] = v.table.split(".");
    const res = await lake.importFile({ data: new Blob([toCsv(tableData())], { type: "text/csv" }), fileName: `${table}.csv`, catalog, schema, table, mode: "replace" });
    toast(`Saved ${res.rows} rows to ${res.table}`);
    ui.refreshTree();
  }

  function guessSchema() {
    const m = s.def.edges_sql.match(/FROM\s+"?([^".\s]+)"?\."?([^".\s]+)"?\./i);
    return m ? `${m[1]}.${m[2]}` : "catalog.schema";
  }

  async function openAdhoc(def, opts) {
    history.replaceState(null, "", "#/graph");
    if (ui.state.route.view !== "graph") ui.navigate("graph");
    return open(G.normalize({ ...def, name: def.name ?? null }), opts);
  }

  async function refreshSaved() {
    try {
      s.saved = await G.listGraphs(lake);
    } catch {
      s.saved = [];
    }
  }

  function summary() {
    return {
      name: s.def?.name ?? null,
      mode: s.mode,
      nodes: s.graph?.order ?? 0,
      edges: s.graph?.size ?? 0,
      total_edges_in_lake: s.totalEdges,
      directed: s.def?.directed,
      weighted: s.graph ? weighted() : false,
      node_attributes: nodeAttributes(),
    };
  }

  // Ranked nodes for a metric or grouping, for agents and the table.
  async function ranking(name, top = 10) {
    if (!s.graph) throw new Error("No graph is open. Use open_graph first.");
    if (Object.hasOwn(METRICS, name)) {
      const vals = await metric(name);
      return Object.entries(vals).sort((a, b) => b[1] - a[1]).slice(0, top).map(([n, v]) => ({ node: s.graph.getNodeAttribute(n, "raw"), label: label(n), value: v }));
    }
    if (!Object.hasOwn(GROUPINGS, name) && !name.startsWith("attr:")) {
      throw new Error(`Unknown metric ${name}. Use one of: ${[...Object.keys(METRICS), ...Object.keys(GROUPINGS)].join(", ")}.`);
    }
    const grp = await grouping(name);
    const cat = G.categorize(grp.byNode, top);
    return { ...grp.meta, groups: cat.legend.map((x) => ({ group: x.category, nodes: x.count })), other: cat.other };
  }

  function neighbors(id) {
    const key = findNode(G.keyOf(id));
    if (!key) throw new Error(`No node ${id} in the loaded graph.`);
    const g = s.graph;
    const pick = (ns) => ns.slice(0, 200).map((n) => ({ node: g.getNodeAttribute(n, "raw"), label: label(n) }));
    return g.type === "directed"
      ? { node: g.getNodeAttribute(key, "raw"), label: label(key), out: pick(g.outNeighbors(key)), in: pick(g.inNeighbors(key)), out_degree: g.outDegree(key), in_degree: g.inDegree(key) }
      : { node: g.getNodeAttribute(key, "raw"), label: label(key), neighbors: pick(g.neighbors(key)), degree: g.degree(key) };
  }

  // Keep canvas colours in step with the OS theme.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!s.graph) return;
    restyle();
    s.sigma?.setSetting("labelColor", { color: s.theme.ink });
  });

  return {
    el,
    async show(parts) {
      await refreshSaved();
      const name = parts[0];
      if (name && name !== s.def?.name) {
        open(name).catch(() => {});
        return;
      }
      render();
      s.sigma?.refresh();
    },
    open,
    openAdhoc,
    newGraph,
    expand: (id) => expand(findNode(G.keyOf(id)) ?? G.keyOf(id)),
    ranking,
    stats: () => (s.graph ? stats() : Promise.reject(new Error("No graph is open. Use open_graph first."))),
    findPath: (from, to, opts) => {
      if (!s.graph) throw new Error("No graph is open. Use open_graph first.");
      const a = findNode(G.keyOf(from)) ?? (s.mode === "overview" ? G.keyOf(from) : null);
      const b = findNode(G.keyOf(to)) ?? (s.mode === "overview" ? G.keyOf(to) : null);
      if (!a || !b) throw new Error(`No node ${!a ? from : to} in the graph.`);
      return findPath(a, b, opts).then((p) => (p.none ? null : { nodes: p.nodes.map((n) => ({ node: rawId(n), label: label(n) })), hops: p.hops, weight: p.weight }));
    },
    neighbors,
    select: (id) => select(findNode(G.keyOf(id)), { center: true }),
    style: async ({ size, color }) => {
      if (size && size !== "none" && !Object.hasOwn(METRICS, size)) throw new Error(`Unknown size metric “${size}”. Use one of: none, ${Object.keys(METRICS).join(", ")}.`);
      const attr = color?.startsWith("attr:") && color.slice(5);
      if (color && color !== "none" && !Object.hasOwn(GROUPINGS, color) && !(attr && nodeAttributes().includes(attr))) {
        throw new Error(`Unknown colour “${color}”. Use none, ${Object.keys(GROUPINGS).join(", ")}, or attr:<node column>.`);
      }
      if (size) s.size = size;
      if (color) s.color = color;
      await restyle();
      renderToolbar();
    },
    refreshSaved,
    snapshot: () => ({
      graph: s.def && { ...summary(), size_by: s.size, color_by: s.color, selected_node: s.selected && rawId(s.selected) },
    }),
  };
}
