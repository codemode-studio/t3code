# Automations

Automations run an agent for you on a schedule or when something happens on GitHub. Each run
opens a thread in the automation's project, so you can follow and continue it like any other.

## Create an automation

Open **Automations** from the top of the sidebar or the command palette. Pick an example or start
from scratch, choose a project, add triggers, and write the instructions the agent receives as its
first message. In the instructions, type `$` to pick a skill for the selected model's provider and
`@` to reference a project file. Press **Create**, then **Run now** to try it once without waiting
for a trigger.

The environment picker next to the project chooses which connected server runs the automation;
the project list shows that server's projects. The server must be awake and running T3 Code at the
scheduled time. Switching a saved automation to another environment moves it there when you press
**Move**, keeping the same project when that server has it. Recent runs start over; threads from
earlier runs stay on the old server.

## Triggers

- **Scheduled** runs hourly, daily, on weekdays, or weekly, at a time in the server's time zone.
  If the server was asleep at that time, it still runs when it wakes within the catch-up window
  under **Advanced**. Older missed runs are skipped. Choose **Custom (cron)** to paste a
  five-field cron expression (minute, hour, day of month, month, day of week), such as
  `0 */2 * * *`; the row shows how it reads, for example "Every 2 hours".
- **GitHub** watches the project's repository for new pull requests, draft pull requests, or
  issues, using the server's `gh` sign-in. It checks every couple of minutes and only reacts to
  activity after the automation was created. The run's instructions include the item's number,
  title, and link.

An automation without triggers only runs when you press **Run now**. Turn off **Active** to pause
every trigger without deleting the automation.

## Sessions

**Working copy** chooses between a fresh worktree for each run and the project checkout itself.
Worktree runs start from the checkout's current branch and run the project's setup script. A run
triggered by a pull request instead checks out that pull request's latest commit without a branch,
because the pull request's branch is often already checked out in another worktree. The thread is
linked to the pull request. To review newer commits, ask the agent to run
`gh pr checkout <number> --detach`.

**Conversation** chooses between a new thread for each run and continuing the previous run's
thread.

**Delete thread when done** deletes each run's thread once the agent finishes, for automations
whose results live elsewhere, such as a pushed branch or a pull request comment. A run that fails
or that you stop keeps its thread so you can see what happened, and so does a thread you send a
message in. It only applies to new threads for each run, and turning it off also spares runs that
are still going. The run's worktree is removed too when **Delete worktrees with deleted threads** is on
in **Settings → Storage**.

**Permissions** work like [permission modes](./permission-modes.md). Runs start with nobody
watching, so a mode that asks before acting waits until you answer in the thread.
