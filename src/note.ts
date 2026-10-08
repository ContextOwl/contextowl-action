// The note for the reviewer: the commit that the run publishes.
import { readFileSync } from "node:fs";
import { isRec, str } from "./util/json.js";

/** The longest commit subject that the note keeps. */
const MAX_SUBJECT = 200;

/**
 * The note that each write sends to the reviewer when the organization
 * reviews agent changes: the subject of the pushed commit, then its short
 * SHA, its repository and a link to it. Undefined outside GitHub Actions.
 */
export function commitNote(
  env: Record<string, string | undefined>,
  readEvent: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | undefined {
  const sha = env.GITHUB_SHA?.trim();
  const repository = env.GITHUB_REPOSITORY?.trim();
  if (!sha || !repository) return undefined;
  const server = (env.GITHUB_SERVER_URL?.trim() || "https://github.com").replace(/\/+$/, "");
  const commit = `Commit ${sha.slice(0, 7)} in ${repository}: ${server}/${repository}/commit/${sha}`;
  const subject = commitSubject(env.GITHUB_EVENT_PATH, readEvent);
  return subject ? `${sentence(subject)} ${commit}` : commit;
}

/**
 * The first line of the message of the head commit of a push event. Other
 * events have no head commit, so their note names only the commit.
 */
function commitSubject(eventPath: string | undefined, readEvent: (path: string) => string): string {
  if (!eventPath) return "";
  let event: unknown;
  try {
    event = JSON.parse(readEvent(eventPath));
  } catch {
    return "";
  }
  const head = isRec(event) && isRec(event.head_commit) ? event.head_commit : {};
  const subject = str(head.message).split(/\r?\n/)[0].trim();
  return subject.length > MAX_SUBJECT
    ? `${subject.slice(0, MAX_SUBJECT - 3).trimEnd()}...`
    : subject;
}

/** End the text with a full stop unless it ends a sentence already. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
