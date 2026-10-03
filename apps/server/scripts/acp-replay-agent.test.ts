// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { expect, it } from "vite-plus/test";

const agentPath = NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url));

it("records a frame as consumed before a client can see it and stop the agent", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-replay-agent-"));
  try {
    const statusPath = NodePath.join(directory, "status.json");
    const transcriptPath = NodePath.join(directory, "transcript.json");
    NodeFS.writeFileSync(
      transcriptPath,
      JSON.stringify({
        scenario: "stop-after-last-frame",
        entries: [
          {
            type: "emit_inbound",
            frame: { kind: "notification", method: "session/update", params: {} },
          },
        ],
      }),
    );
    // Slow every status write the way a descheduled agent on a busy runner is slow, so a
    // client stopping the agent at its last frame lands while the status is still pending.
    const slowStatusWrites = NodePath.join(directory, "slow-status-writes.mjs");
    NodeFS.writeFileSync(
      slowStatusWrites,
      [
        'import { createRequire, syncBuiltinESMExports } from "node:module";',
        'const fs = createRequire(import.meta.url)("node:fs");',
        "const writeFileSync = fs.writeFileSync;",
        "fs.writeFileSync = (path, ...rest) => {",
        `  if (String(path).startsWith(${JSON.stringify(statusPath)})) {`,
        "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);",
        "  }",
        "  return writeFileSync(path, ...rest);",
        "};",
        "syncBuiltinESMExports();",
      ].join("\n"),
    );
    const agent = NodeChildProcess.spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        NodeURL.pathToFileURL(slowStatusWrites).href,
        agentPath,
      ],
      {
        env: {
          ...process.env,
          T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
          T3_ACP_REPLAY_STATUS_PATH: statusPath,
        },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    const exited = new Promise<void>((resolve) => agent.once("exit", () => resolve()));
    // Stop the agent the moment its last frame arrives, as closing a session does.
    const lines = NodeReadline.createInterface({ input: agent.stdout });
    const lastFrame = await new Promise<string>((resolve) => lines.once("line", resolve));
    agent.kill("SIGKILL");
    await exited;

    expect(JSON.parse(lastFrame)).toMatchObject({ method: "session/update" });
    expect(JSON.parse(NodeFS.readFileSync(statusPath, "utf8"))).toEqual({
      scenario: "stop-after-last-frame",
      cursor: 1,
      total: 1,
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
