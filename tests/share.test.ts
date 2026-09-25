import { describe, expect, it, vi } from "vitest";
import { canShareFiles, shareFiles, shareNotice } from "../src/core/share";
import type { ShareHost, ShareItem } from "../src/core/share";

const ITEM: ShareItem = {
  name: "a1b2c3d4e5f6.jpg",
  mime: "image/jpeg",
  data: new ArrayBuffer(8),
};

/** Stands in for the File constructor, which a node test has no need of. */
const makeFile = (data: ArrayBuffer, name: string, mime: string): File =>
  ({ name, type: mime, size: data.byteLength }) as File;

function host(over: Partial<ShareHost> = {}): ShareHost {
  return {
    canShare: () => true,
    share: () => Promise.resolve(),
    ...over,
  };
}

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("canShareFiles", () => {
  it("accepts a host with both halves of Web Share", () => {
    expect(canShareFiles(host())).toBe(true);
  });

  it("refuses a host with no Web Share at all", () => {
    expect(canShareFiles(undefined)).toBe(false);
    expect(canShareFiles({})).toBe(false);
  });

  it("refuses a level 1 host, which takes a URL and throws on files", () => {
    expect(canShareFiles({ share: () => Promise.resolve() })).toBe(false);
  });
});

describe("shareFiles", () => {
  it("offers every file in one sheet", async () => {
    const share = vi.fn((_data: { files?: File[] }) => Promise.resolve());
    const outcome = await shareFiles({ host: host({ share }), makeFile }, [ITEM, ITEM]);

    expect(outcome).toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].files).toHaveLength(2);
  });

  it("reads nothing and offers nothing when there is nothing archived", async () => {
    const share = vi.fn((_data: { files?: File[] }) => Promise.resolve());
    expect(await shareFiles({ host: host({ share }), makeFile }, [])).toBe("empty");
    expect(share).not.toHaveBeenCalled();
  });

  it("gives up before building anything on a host without Web Share", async () => {
    expect(await shareFiles({ host: {}, makeFile }, [ITEM])).toBe("unsupported");
  });

  it("takes the host's word for it when canShare refuses these files", async () => {
    const share = vi.fn((_data: { files?: File[] }) => Promise.resolve());
    const outcome = await shareFiles(
      { host: host({ canShare: () => false, share }), makeFile },
      [ITEM]
    );

    expect(outcome).toBe("unsupported");
    expect(share).not.toHaveBeenCalled();
  });

  it("reads a dismissed sheet as a cancellation, not a failure", async () => {
    const outcome = await shareFiles(
      { host: host({ share: () => Promise.reject(named("AbortError")) }), makeFile },
      [ITEM]
    );

    expect(outcome).toBe("cancelled");
  });

  it("tells a lost user gesture apart from a share that went wrong", async () => {
    const outcome = await shareFiles(
      { host: host({ share: () => Promise.reject(named("NotAllowedError")) }), makeFile },
      [ITEM]
    );

    expect(outcome).toBe("blocked");
  });

  it("reads anything else thrown as a failure", async () => {
    const outcome = await shareFiles(
      { host: host({ share: () => Promise.reject(new Error("nope")) }), makeFile },
      [ITEM]
    );

    expect(outcome).toBe("failed");
  });

  it("carries the name and type through to the file the sheet gets", async () => {
    const share = vi.fn((_data: { files?: File[] }) => Promise.resolve());
    await shareFiles({ host: host({ share }), makeFile }, [ITEM]);

    const file = share.mock.calls[0][0].files?.[0];
    expect(file?.name).toBe("a1b2c3d4e5f6.jpg");
    expect(file?.type).toBe("image/jpeg");
  });
});

describe("shareNotice", () => {
  it("says nothing when the sheet was its own confirmation", () => {
    expect(shareNotice("shared")).toBeNull();
    expect(shareNotice("cancelled")).toBeNull();
  });

  it("explains the outcomes the user cannot see for themselves", () => {
    expect(shareNotice("empty")).toContain("nothing archived");
    expect(shareNotice("unsupported")).toContain("cannot save");
    expect(shareNotice("blocked")).toContain("again");
    expect(shareNotice("failed")).toContain("could not save");
  });
});
