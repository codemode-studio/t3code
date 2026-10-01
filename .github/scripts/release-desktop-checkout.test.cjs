const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("macOS release checkout replaces a previous job's repository and build outputs", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../workflows/release-desktop.yml"),
    "utf8",
  );
  const checkout = workflow.match(
    /      - name: Checkout\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
  );
  assert.ok(checkout, "The release checkout shell step must exist.");
  const script = checkout[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n")
    .replaceAll("${{ inputs.platform }}", "mac");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3 release checkout-"));
  try {
    const origin = path.join(root, "fixture.git");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(origin);
    fs.mkdirSync(workspace);
    const git = (args) =>
      execFileSync("git", args, { cwd: origin, encoding: "utf8", stdio: "pipe" });
    git(["init", "--quiet"]);
    const commit = (version) => {
      fs.writeFileSync(path.join(origin, "package.json"), JSON.stringify({ version }));
      git(["add", "package.json"]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        version,
      ]);
      return git(["rev-parse", "HEAD"]).trim();
    };
    const first = commit("1.0.0");
    const second = commit("2.0.0");
    const runCheckout = (ref) =>
      execFileSync("bash", ["-e", "-c", script], {
        cwd: workspace,
        env: {
          ...process.env,
          GITHUB_SERVER_URL: root,
          GITHUB_REPOSITORY: "fixture",
          CHECKOUT_REF: ref,
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: "pipe",
      });

    runCheckout(first);
    fs.writeFileSync(path.join(workspace, "package.json"), "modified by the first build");
    fs.mkdirSync(path.join(workspace, "release-publish"));
    fs.writeFileSync(path.join(workspace, "release-publish", "old.dmg"), "stale artifact");
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.writeFileSync(path.join(workspace, "node_modules", "stale"), "old dependencies");

    runCheckout(second);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8")).version,
      "2.0.0",
    );
    assert.equal(fs.existsSync(path.join(workspace, "release-publish")), false);
    assert.equal(fs.existsSync(path.join(workspace, "node_modules")), false);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(),
      second,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
