const { assertReleaseSource, shouldReleaseNightly } = require("./check-nightly-release.cjs");

// Decides whether a Fork Release run publishes, and the UTC date its version
// carries. Manual dispatch skips the six-hour gap but must build main, since a
// published branch build would leave main behind it and stall later scheduled
// checks. The date is when the run was created, so a run that queues past
// midnight or is retried on another day keeps the same tag.
async function resolveForkRelease({ github, context, core }) {
  if (context.eventName === "workflow_dispatch") {
    await assertReleaseSource({ github, context, releaseChannel: "nightly" });
  } else if (!(await shouldReleaseNightly({ github, context, core }))) {
    return { due: false };
  }

  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...context.repo,
    run_id: context.runId,
  });
  return { due: true, date: run.created_at.slice(0, 10).replaceAll("-", "") };
}

module.exports = { resolveForkRelease };
