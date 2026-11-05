// Jobs: Python/PySpark scripts run in Spark containers on this context's network.
import { h, table, action, button, formDialog, confirmDialog, toast, loading, errorBox, empty, fmtTime, fmtDuration } from "../dom.js";

const POLL_MS = 2000;
const TEMPLATE = `from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()

df = spark.range(10).withColumnRenamed("id", "n")
df.show()
`;

export function runStatus(run) {
  const life = run?.state?.life_cycle_state;
  const result = run?.state?.result_state;
  if (result === "SUCCESS") return { label: "Succeeded", tone: "ok" };
  if (result === "CANCELED" || life === "SKIPPED") return { label: "Cancelled", tone: "" };
  if (result || life === "INTERNAL_ERROR") return { label: result === "TIMEDOUT" ? "Timed out" : "Failed", tone: "err" };
  if (life === "PENDING" || life === "QUEUED") return { label: "Pending", tone: "warn" };
  return { label: "Running", tone: "warn" };
}

const statusBadge = (run) => {
  const s = runStatus(run);
  return h("span", { class: `status-badge ${s.tone}` }, s.tone === "warn" && h("span", { class: "loading" }), s.label);
};
const runDuration = (r) => (r.start_time ? fmtDuration((r.end_time || Date.now()) - r.start_time) : "");
export const splitParams = (text) => (text?.match(/"[^"]*"|\S+/g) ?? []).map((p) => p.replace(/^"|"$/g, ""));
const joinParams = (params) => (params ?? []).map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(" ");

export function createJobsView(ui) {
  const { lake } = ui;
  const el = h("section", { class: "view", "aria-label": "Jobs" });
  let token = 0;
  let pollTimer;
  let current = { kind: "list" };

  const page = (...children) => el.replaceChildren(h("div", { class: "page" }, ...children));
  const section = (title, count, ...body) =>
    h("div", { class: "section" }, h("h2", {}, title, count != null && h("span", {}, String(count))), ...body);
  const titleRow = (title, badges, actions) =>
    h("div", { class: "title-row" }, h("h1", {}, title), badges, h("div", { class: "actions" }, actions));

  async function show(parts) {
    clearTimeout(pollTimer);
    const t = ++token;
    const [kind, id] = parts;
    current = kind === "job" || kind === "run" ? { kind, id: Number(id) } : { kind: "list" };
    page(loading());
    try {
      if (current.kind === "job") await jobPage(current.id, () => t === token);
      else if (current.kind === "run") await runPage(current.id, () => t === token);
      else await listPage(() => t === token);
    } catch (err) {
      if (t === token) page(errorBox(err.message));
    }
  }

  async function listPage(live) {
    const [jobs, runs] = await Promise.all([lake.listJobs(), lake.listRuns({ limit: 50 })]);
    if (!live()) return;
    const lastRun = {};
    for (const r of runs) if (r.job_id && !lastRun[r.job_id]) lastRun[r.job_id] = r;
    page(
      titleRow("Jobs", null, [button("Run a script", () => scriptDialog("run")), button("New job", () => scriptDialog("job"), "primary")]),
      h("p", { class: "lede" }, "Python and PySpark scripts run in Spark containers on this context's network, so they can read its tables and volumes. The first run downloads the Spark image."),
      section("Jobs", jobs.length, table(jobs, [
        ["Name", (j) => h("a", { href: `#/jobs/job/${j.job_id}` }, j.settings?.name ?? `Job ${j.job_id}`)],
        ["Script", (j) => h("span", { class: "mono" }, lake.jobScript(j)?.python_file ?? "—")],
        ["Last run", (j) => (lastRun[j.job_id] ? statusBadge(lastRun[j.job_id]) : h("span", { class: "muted" }, "never"))],
        ["", (j) => action("Run now", async () => {
          const { run_id } = await lake.runNow(j.job_id);
          ui.navigate("jobs", "run", run_id);
        })],
      ], { onRow: (j) => ui.navigate("jobs", "job", j.job_id), empty: "No jobs yet. A job is a saved script you can run again." })),
      section("Recent runs", runs.length, runsTable(runs)),
    );
    if (runs.some((r) => !lake.isRunDone(r))) poll(live);
  }

  function runsTable(runs) {
    return table(runs, [
      ["Run", (r) => h("a", { href: `#/jobs/run/${r.run_id}` }, `#${r.run_id}`)],
      ["Name", (r) => r.run_name ?? ""],
      ["Status", statusBadge],
      ["Started", (r) => fmtTime(r.start_time)],
      ["Duration", runDuration],
    ], { onRow: (r) => ui.navigate("jobs", "run", r.run_id), empty: "No runs yet." });
  }

  async function jobPage(id, live) {
    const [job, runs] = await Promise.all([lake.getJob(id), lake.listRuns({ jobId: id, limit: 25 })]);
    const task = lake.jobScript(job);
    const source = task?.python_file ? await lake.exportWorkspace(task.python_file).catch(() => null) : null;
    if (!live()) return;
    const name = job.settings?.name ?? `Job ${id}`;
    const editor = h("textarea", { class: "editor code-editor", spellcheck: "false", "aria-label": "Script" }, source ?? "");
    const params = h("input", { class: "input mono", value: joinParams(task?.parameters), placeholder: "Arguments passed to the script", "aria-label": "Parameters" });
    // Saving writes the editor over the script, so only offer it when the script loaded.
    const editable = Boolean(task?.python_file) && source != null;
    const saveJob = () => lake.updateJob(id, { name, file: task.python_file, source: editor.value, parameters: splitParams(params.value) });
    const runsBox = h("div", {}, section("Runs", runs.length, runsTable(runs)));

    page(
      h("div", { class: "crumbs" }, h("a", { href: "#/jobs" }, "jobs")),
      titleRow(name, h("span", { class: "badge" }, `job ${id}`), [
        action("Delete", async () => {
          if (!(await confirmDialog({ title: `Delete job “${name}”?`, body: "The job and its run history are removed. The script stays in the workspace." }))) return;
          await lake.deleteJob(id);
          toast(`Deleted job ${name}`);
          ui.navigate("jobs");
        }, "danger-ghost"),
        editable && action("Save", async () => {
          await saveJob();
          toast("Saved");
        }),
        action(editable ? "Save & run" : "Run", async () => {
          if (editable) await saveJob();
          const { run_id } = await lake.runNow(id);
          ui.navigate("jobs", "run", run_id);
        }, "primary"),
      ]),
      h("p", { class: "context-dir mono" }, task?.python_file ?? "No Python task"),
      section("Script", null, source == null ? errorBox("Could not load the script from the workspace.") : editor),
      section("Parameters", null, params),
      runsBox,
    );
    // Refresh only the runs while one is going, so edits to the script and parameters survive.
    const refreshRuns = (list) => {
      if (!list.some((r) => !lake.isRunDone(r))) return;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => {
        if (!live() || el.hidden) return;
        const next = await lake.listRuns({ jobId: id, limit: 25 }).catch(() => list);
        if (!live()) return;
        runsBox.replaceChildren(section("Runs", next.length, runsTable(next)));
        refreshRuns(next);
      }, POLL_MS);
    };
    refreshRuns(runs);
  }

  async function runPage(id, live) {
    const run = await lake.getRun(id);
    const done = lake.isRunDone(run);
    // Output lives on the task run; one-off submits have a single task.
    const taskRunId = run.tasks?.[0]?.run_id ?? id;
    const output = done ? await lake.getRunOutput(taskRunId).catch((err) => ({ error: err.message })) : null;
    if (!live()) return;
    const task = run.tasks?.[0]?.spark_python_task;

    page(
      h("div", { class: "crumbs" }, h("a", { href: "#/jobs" }, "jobs"), run.job_id && ["/", h("a", { href: `#/jobs/job/${run.job_id}` }, run.run_name ?? `job ${run.job_id}`)]),
      titleRow(`Run #${id}`, statusBadge(run), [
        !done && action("Cancel", async () => {
          await lake.cancelRun(id);
          toast("Cancel requested. MiniLake may let the script finish.");
          show(["run", id]);
        }, "danger-ghost"),
        done && action("Run again", async () => {
          const { run_id } = run.job_id ? await lake.runNow(run.job_id) : await lake.submitFile(run.run_name ?? "rerun", task.python_file, task.parameters);
          ui.navigate("jobs", "run", run_id);
        }, "primary"),
      ]),
      h("dl", { class: "kv" },
        h("dt", {}, "Name"), h("dd", {}, run.run_name ?? ""),
        h("dt", {}, "Script"), h("dd", {}, task?.python_file ?? ""),
        task?.parameters?.length && [h("dt", {}, "Parameters"), h("dd", {}, joinParams(task.parameters))],
        h("dt", {}, "Started"), h("dd", {}, fmtTime(run.start_time)),
        h("dt", {}, "Duration"), h("dd", {}, runDuration(run)),
        run.state?.state_message && [h("dt", {}, "Message"), h("dd", {}, run.state.state_message)]),
      section("Output", null,
        !done
          ? empty(h("span", { class: "loading" }), " Running. MiniLake shows the output when the run finishes.")
          : [
            output?.error && errorBox(output.error),
            output?.error_trace && h("pre", { class: "logs err-text" }, output.error_trace),
            h("pre", { class: "logs" }, output?.logs || "(no output)"),
            output?.logs_truncated && h("p", { class: "help muted" }, "Output was truncated by MiniLake."),
          ]),
    );
    if (!done) poll(live);
  }

  function poll(live) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      if (live() && !el.hidden) show(current.kind === "list" ? [] : [current.kind, current.id]);
    }, POLL_MS);
  }

  async function scriptDialog(mode) {
    const v = await formDialog({
      title: mode === "job" ? "New job" : "Run a script",
      intro: mode === "job"
        ? "The script is saved to the workspace under /Shared/pond and can be run again from here."
        : "Runs once without creating a job. The script is still saved under /Shared/pond.",
      fields: [
        { name: "name", label: "Name", required: true, value: mode === "job" ? "" : "adhoc", pattern: "[\\w .-]+" },
        { name: "source", label: "Python", type: "textarea", value: TEMPLATE, rows: 14, required: true },
        { name: "params", label: "Parameters", placeholder: "Optional arguments, space separated" },
      ],
      submit: mode === "job" ? "Create job" : "Run",
    });
    if (!v) return;
    try {
      if (mode === "job") {
        const { job_id } = await lake.createScriptJob(v.name, v.source, splitParams(v.params));
        toast(`Created job ${v.name}`);
        ui.navigate("jobs", "job", job_id);
      } else {
        const { run_id } = await lake.runScript(v.name, v.source, splitParams(v.params));
        ui.navigate("jobs", "run", run_id);
      }
    } catch (err) {
      toast(err.message, "err");
    }
  }

  return {
    el,
    show,
    snapshot: () => ({ jobs_view: current }),
  };
}
