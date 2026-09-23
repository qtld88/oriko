import { describe, expect, it } from "vitest";
import {
  NO_SNIFF_PROGRESS,
  SNIFF_QUIET_POLLS,
  advanceSniff,
  sniffGivesUp,
} from "../src/core/resolve";
import type { SniffProbe } from "../src/core/resolve";

function probe(overrides: Partial<SniffProbe> = {}): SniffProbe {
  return { src: "", res: [], hasVideo: false, ready: true, ...overrides };
}

function run(probes: SniffProbe[]): boolean {
  let progress = NO_SNIFF_PROGRESS;
  for (const one of probes) {
    progress = advanceSniff(progress, one);
    if (sniffGivesUp(progress)) return true;
  }
  return false;
}

describe("sniffGivesUp", () => {
  it("waits on a fresh page, which has read nothing yet", () => {
    expect(sniffGivesUp(NO_SNIFF_PROGRESS)).toBe(false);
  });

  it("gives up on a loaded page that never shows a player", () => {
    expect(run(Array.from({ length: SNIFF_QUIET_POLLS }, () => probe()))).toBe(true);
  });

  it("does not give up one probe early", () => {
    expect(run(Array.from({ length: SNIFF_QUIET_POLLS - 1 }, () => probe()))).toBe(false);
  });

  it("keeps waiting while the page is still loading, however long that takes", () => {
    const loading = Array.from({ length: SNIFF_QUIET_POLLS * 4 }, () => probe({ ready: false }));
    expect(run(loading)).toBe(false);
  });

  it("keeps the full timeout once a player has mounted", () => {
    const probes = [probe({ hasVideo: true }), ...Array.from({ length: 20 }, () => probe())];
    expect(run(probes)).toBe(false);
  });

  it("remembers a player that mounted and then went away during navigation", () => {
    let p = advanceSniff(NO_SNIFF_PROGRESS, probe({ hasVideo: true }));
    p = advanceSniff(p, probe({ hasVideo: false }));
    expect(p.sawVideo).toBe(true);
    expect(p.quiet).toBe(0);
  });

  it("restarts the count when a client-rendered player finally appears", () => {
    let p = NO_SNIFF_PROGRESS;
    for (let i = 0; i < SNIFF_QUIET_POLLS - 1; i++) p = advanceSniff(p, probe());
    expect(p.quiet).toBe(SNIFF_QUIET_POLLS - 1);
    p = advanceSniff(p, probe({ hasVideo: true }));
    expect(p.quiet).toBe(0);
    expect(sniffGivesUp(p)).toBe(false);
  });

  it("gives up inside four seconds at the 600 ms poll, not twenty", () => {
    expect(SNIFF_QUIET_POLLS * 600).toBeLessThan(4000);
  });
});
