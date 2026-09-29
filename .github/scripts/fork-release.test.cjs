const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveForkRelease } = require("./fork-release.cjs");

const hour = 60 * 60 * 1000;
const core = { info() {} };

function fixture({
  eventName = "workflow_dispatch",
  ref = "refs/heads/main",
  comparisonStatus = "ahead",
  nightlyHoursAgo = 7,
  createdAt = "2026-09-29T23:59:30Z",
} = {}) {
  const runLookups = [];
  return {
    runLookups,
    options: {
      core,
      context: {
        eventName,
        payload: { repository: { default_branch: "main" } },
        ref,
        repo: { owner: "example", repo: "app" },
        runId: 42,
        sha: "candidate",
      },
      github: {
        async paginate() {
          return [
            {
              tag_name: "v0.0.43-nightly.20260929.19",
              draft: false,
              published_at: new Date(Date.now() - nightlyHoursAgo * hour).toISOString(),
            },
          ];
        },
        rest: {
          actions: {
            async getWorkflowRun(params) {
              runLookups.push(params);
              return { data: { created_at: createdAt } };
            },
          },
          repos: {
            async compareCommitsWithBasehead() {
              return { data: { status: comparisonStatus } };
            },
          },
        },
      },
    },
  };
}

test("rejects a manual release dispatched from a feature branch", async () => {
  const { options, runLookups } = fixture({ ref: "refs/heads/feature" });
  await assert.rejects(resolveForkRelease(options), /must be dispatched from main/);
  assert.equal(runLookups.length, 0);
});

test("rejects a manual release whose commit is not on main", async () => {
  const { options } = fixture({ comparisonStatus: "diverged" });
  await assert.rejects(resolveForkRelease(options), /not contained in main \(diverged\)/);
});

test("a manual release from main skips the six-hour gap", async () => {
  const { options } = fixture({ nightlyHoursAgo: 1 });
  assert.deepEqual(await resolveForkRelease(options), { due: true, date: "20260929" });
});

test("a scheduled run waits for the six-hour gap", async () => {
  const { options, runLookups } = fixture({ eventName: "schedule", nightlyHoursAgo: 1 });
  assert.deepEqual(await resolveForkRelease(options), { due: false });
  assert.equal(runLookups.length, 0);
});

test("a run created before midnight keeps its date when it runs or retries after", async () => {
  const { options, runLookups } = fixture({ eventName: "schedule" });
  assert.deepEqual(await resolveForkRelease(options), { due: true, date: "20260929" });
  assert.equal(runLookups[0].run_id, 42);
});
