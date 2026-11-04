// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INVITE_FORMAT_ERROR,
  canonicalInviteCode,
  forgetInvite,
  inviteFormError,
  loadInvite,
  saveInvite,
  takeInviteFragment,
} from "../src/guest-invite.js";
import { FakeStorage } from "./fakes.js";

const LINK = { ownerUid: 1001, hostId: "76805a63a6980c18" };
const CODE = "CNR-7K3Q-HM9P-2XAB-CDEF";

function fakeHistory(location: { pathname: string; search: string; hash: string }): {
  calls: (string | undefined)[];
  replaceState: (data: unknown, unused: string, url?: string) => void;
} {
  const calls: (string | undefined)[] = [];
  return {
    calls,
    replaceState: (_data, _unused, url) => {
      calls.push(url);
      location.hash = "";
    },
  };
}

describe("canonicalInviteCode", () => {
  it("keeps the canonical form", () => {
    expect(canonicalInviteCode(CODE)).toBe(CODE);
  });

  it("accepts the host's hand-typing: case, dashes, spaces, prefix, confusables", () => {
    for (const typed of [
      "cnr-7k3q-hm9p-2xab-cdef",
      "CNR7K3QHM9P2XABCDEF",
      "7K3QHM9P2XABCDEF",
      "7k3q hm9p 2xab cdef",
      "  CNR - 7K3Q - HM9P - 2XAB - CDEF  ",
      "7K3Q-HM9P-2XAB-CDEF",
    ]) {
      expect(canonicalInviteCode(typed), typed).toBe(CODE);
    }
    // I and L read as 1, O as 0, exactly as the host folds them.
    expect(canonicalInviteCode("cnr iiii oooo llll oooo")).toBe("CNR-1111-0000-1111-0000");
  });

  it("rejects what is not a code", () => {
    for (const junk of [
      "",
      "octocat",
      "CNR-123",
      "CNR-7K3Q-HM9P-2XAB-CDE",
      "CNR-7K3Q-HM9P-2XAB-CDEFG",
      "CNR-7K3Q-HM9P-2XAB-CDE!",
      "CNR-7K3Q-HM9P-2XAB-CDEU",
      "XYZ-7K3Q-HM9P-2XAB-CDEF",
      // Only ASCII folds: ß must not upper-case into a valid "SS".
      "CNR-7K3Q-HM9P-2XAB-CDß",
    ]) {
      expect(canonicalInviteCode(junk), junk).toBeNull();
    }
  });

  it("hashes to what the host publishes: SHA-256 of the canonical string", () => {
    // The relay hashes the decoded `invite` value as is; the host stores
    // and publishes sha256(canonical). A lowercase or dashless form would
    // hash to something no published invite carries.
    const published = createHash("sha256").update(CODE).digest("hex");
    const typed = canonicalInviteCode("cnr7k3qhm9p2xabcdef") as string;
    expect(createHash("sha256").update(typed).digest("hex")).toBe(published);
    expect(createHash("sha256").update("cnr7k3qhm9p2xabcdef").digest("hex")).not.toBe(published);
  });
});

describe("inviteFormError", () => {
  it("passes a code in any accepted form and names the format otherwise", () => {
    expect(inviteFormError(CODE)).toBeNull();
    expect(inviteFormError("7k3q hm9p 2xab cdef")).toBeNull();
    expect(inviteFormError("")).toBe(INVITE_FORMAT_ERROR);
    expect(inviteFormError("CNR-7K3Q")).toBe(INVITE_FORMAT_ERROR);
  });
});

describe("takeInviteFragment", () => {
  it("reads #invite=<code> and strips the fragment in place", () => {
    const location = { pathname: "/g/1001/76805a63a6980c18", search: "", hash: `#invite=${CODE}` };
    const history = fakeHistory(location);
    expect(takeInviteFragment(location, history)).toBe(CODE);
    expect(history.calls).toEqual(["/g/1001/76805a63a6980c18"]);
  });

  it("decodes a percent-encoded code and keeps the query", () => {
    const location = {
      pathname: "/g/1001/76805a63a6980c18",
      search: "?x=1",
      hash: `#invite=${encodeURIComponent("cnr 7k3q")}`,
    };
    const history = fakeHistory(location);
    expect(takeInviteFragment(location, history)).toBe("cnr 7k3q");
    expect(history.calls).toEqual(["/g/1001/76805a63a6980c18?x=1"]);
  });

  it("leaves a fragment without an invite alone", () => {
    for (const hash of ["", "#", "#code=1", "#CNR-7K3Q"]) {
      const location = { pathname: "/g/1001/76805a63a6980c18", search: "", hash };
      const history = fakeHistory(location);
      expect(takeInviteFragment(location, history), hash).toBeNull();
      expect(history.calls, hash).toEqual([]);
    }
  });
});

describe("invite storage", () => {
  it("keeps one canonical code per link for this tab", () => {
    const storage = new FakeStorage();
    expect(loadInvite(LINK, storage)).toBeNull();
    saveInvite(LINK, CODE, storage);
    expect(loadInvite(LINK, storage)).toBe(CODE);
    // Another host of the same owner has its own slot.
    expect(loadInvite({ ...LINK, hostId: "0123456789abcdef" }, storage)).toBeNull();
    forgetInvite(LINK, storage);
    expect(loadInvite(LINK, storage)).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("re-checks a stored value and survives a storage that throws", () => {
    const storage = new FakeStorage();
    storage.setItem("canopy.remote.invite:1001/76805a63a6980c18", "not a code");
    expect(loadInvite(LINK, storage)).toBeNull();
    storage.failReads = true;
    storage.failWrites = true;
    expect(loadInvite(LINK, storage)).toBeNull();
    expect(() => saveInvite(LINK, CODE, storage)).not.toThrow();
    expect(() => forgetInvite(LINK, storage)).not.toThrow();
    expect(loadInvite(LINK, null)).toBeNull();
  });
});
