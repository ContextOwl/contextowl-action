import { describe, expect, it } from "vitest";
import { changelogTitleKey, pendingProposals } from "../src/sync/review.js";
import type { RemoteProposal } from "../src/types.js";

const row = (over: Partial<RemoteProposal>): RemoteProposal => ({
  id: 1,
  objectType: "article",
  status: "pending",
  target: "article:7",
  slug: "intro",
  title: "Intro",
  ...over,
});

describe("pendingProposals", () => {
  it("indexes the pending proposals of writes under review by item", () => {
    const pending = pendingProposals([
      row({ id: 1 }),
      row({ id: 2, objectType: "placement", target: "placement:7" }),
      row({ id: 3, objectType: "changelog", target: "changelog:4", slug: "", title: "1.0.0" }),
      row({
        id: 4,
        objectType: "changelog",
        target: "changelog-new:ab12",
        slug: "",
        title: "1.1.0",
      }),
      // A propose call files no working copy, so its row has no target.
      row({ id: 5, target: "" }),
      row({ id: 6, status: "approved", slug: "old" }),
      row({ id: 7, objectType: "openapi", target: "openapi", slug: "", title: "Petstore" }),
      row({ id: 8, objectType: "landing", target: "landing", slug: "" }),
    ]);

    expect(pending.articles).toEqual(new Map([["intro", 1]]));
    expect(pending.placements).toEqual(new Map([["intro", 2]]));
    expect(pending.entries).toEqual(new Map([[4, 3]]));
    expect(pending.creates).toEqual([{ id: 4, title: "1.1.0" }]);
  });

  it("reads a row without a status as pending", () => {
    expect(pendingProposals([row({ status: "" })]).articles).toEqual(new Map([["intro", 1]]));
  });
});

describe("changelogTitleKey", () => {
  it("compares changelog titles as the server does", () => {
    expect(changelogTitleKey("  Release   1.0 ")).toBe("release 1.0");
  });
});
