import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { displayPath } from "../src/core/util";

describe("displayPath (posix)", () => {
  const cwd = "/home/alice/work/app";
  const home = "/home/alice";
  const show = (p: string) => displayPath(p, { cwd, home, pathModule: posix });
  it("is relative inside the cwd", () => {
    expect(show("/home/alice/work/app/package-lock.json")).toBe("package-lock.json");
    expect(show("/home/alice/work/app/apps/web/package-lock.json")).toBe("apps/web/package-lock.json");
  });
  it("is . for the cwd itself", () => expect(show("/home/alice/work/app")).toBe("."));
  it("uses ~ outside the cwd but under home", () => {
    expect(show("/home/alice/other/package-lock.json")).toBe("~/other/package-lock.json");
    expect(show("/home/alice/work/package-lock.json")).toBe("~/work/package-lock.json");
    expect(show("/home/alice")).toBe("~");
  });
  it("leaves paths outside cwd and home absolute (documented: may still hold a user name)", () => {
    expect(show("/srv/project/package-lock.json")).toBe("/srv/project/package-lock.json");
  });
  it("does not treat a sibling prefix as inside", () => {
    expect(show("/home/alicia/x/package-lock.json")).toBe("/home/alicia/x/package-lock.json");
    expect(show("/home/alice/work/app2/package-lock.json")).toBe("~/work/app2/package-lock.json");
  });
  it("never contains the user name when under cwd or home", () => {
    for (const p of ["/home/alice/work/app/a/b", "/home/alice/z/lock"]) expect(show(p)).not.toContain("alice");
  });
});

describe("displayPath (win32)", () => {
  const cwd = "C:\\Users\\alice\\work\\app";
  const home = "C:\\Users\\alice";
  const show = (p: string) => displayPath(p, { cwd, home, pathModule: win32 });
  it("is relative inside the cwd", () => {
    expect(show("C:\\Users\\alice\\work\\app\\package-lock.json")).toBe("package-lock.json");
    expect(show("C:\\Users\\alice\\work\\app\\apps\\web\\package-lock.json")).toBe("apps\\web\\package-lock.json");
    expect(show("C:\\Users\\alice\\work\\app")).toBe(".");
  });
  it("compares case-insensitively", () => {
    expect(show("c:\\users\\ALICE\\work\\app\\package-lock.json")).toBe("package-lock.json");
    expect(show("c:\\users\\ALICE\\x\\package-lock.json")).toBe("~\\x\\package-lock.json");
  });
  it("uses ~ outside the cwd but under home", () => {
    expect(show("C:\\Users\\alice\\proj\\package-lock.json")).toBe("~\\proj\\package-lock.json");
  });
  it("keeps other drives and non-home paths absolute", () => {
    expect(show("D:\\repos\\x\\package-lock.json")).toBe("D:\\repos\\x\\package-lock.json");
    expect(show("C:\\Users\\bob\\x\\package-lock.json")).toBe("C:\\Users\\bob\\x\\package-lock.json");
  });
  it("does not leak the user name when under cwd or home", () => {
    expect(show("C:\\Users\\alice\\proj\\package-lock.json")).not.toContain("alice");
  });
});
