import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitNote } from "../src/note.js";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const COMMIT = `Commit 1a2b3c4 in acme/docs: https://github.com/acme/docs/commit/${SHA}`;

/** The environment of a push run, with the event payload in a file. */
function pushEnv(event: unknown, over: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cowl-event-"));
  const path = join(dir, "event.json");
  writeFileSync(path, typeof event === "string" ? event : JSON.stringify(event));
  return {
    GITHUB_SHA: SHA,
    GITHUB_REPOSITORY: "acme/docs",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_EVENT_PATH: path,
    ...over,
  };
}

describe("commitNote", () => {
  it("names the subject of the pushed commit and links the commit", () => {
    const env = pushEnv({
      head_commit: { message: "Fix the install steps\n\nThe old URL broke." },
    });
    expect(commitNote(env)).toBe(`Fix the install steps. ${COMMIT}`);
  });

  it("keeps the punctuation at the end of the subject", () => {
    const env = pushEnv({ head_commit: { message: "Is the cache gone?\r\nYes." } });
    expect(commitNote(env)).toBe(`Is the cache gone? ${COMMIT}`);
  });

  it("cuts a long subject to 200 characters", () => {
    const env = pushEnv({ head_commit: { message: "x".repeat(300) } });
    expect(commitNote(env)).toBe(`${"x".repeat(197)}... ${COMMIT}`);
  });

  it("names only the commit when the event has no head commit or cannot be read", () => {
    expect(commitNote(pushEnv({ inputs: {} }))).toBe(COMMIT);
    expect(commitNote(pushEnv("not json"))).toBe(COMMIT);
    expect(commitNote(pushEnv({}, { GITHUB_EVENT_PATH: "/no/such/event.json" }))).toBe(COMMIT);
    const { GITHUB_EVENT_PATH: _path, ...noEvent } = pushEnv({});
    expect(commitNote(noEvent)).toBe(COMMIT);
  });

  it("links the commit on GitHub Enterprise Server", () => {
    const env = pushEnv({}, { GITHUB_SERVER_URL: "https://git.acme.test/" });
    expect(commitNote(env)).toBe(
      `Commit 1a2b3c4 in acme/docs: https://git.acme.test/acme/docs/commit/${SHA}`,
    );
  });

  it("returns no note outside GitHub Actions", () => {
    expect(commitNote({})).toBeUndefined();
    expect(commitNote({ GITHUB_SHA: SHA })).toBeUndefined();
  });
});
