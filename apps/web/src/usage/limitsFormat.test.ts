import { describe, expect, it } from "@effect/vitest";

import { formatPlan } from "./limitsFormat";

describe("formatPlan", () => {
  it("cases the terse slugs providers report", () => {
    expect(formatPlan("max")).toBe("Max");
    expect(formatPlan("prolite")).toBe("Pro Lite");
  });

  it("passes display-cased tiers through untouched", () => {
    expect(formatPlan("SuperGrok Heavy")).toBe("SuperGrok Heavy");
  });

  it("capitalizes unknown slugs instead of guessing marketing names", () => {
    expect(formatPlan("mega")).toBe("Mega");
  });

  it("treats null and empty as no plan", () => {
    expect(formatPlan(null)).toBeNull();
    expect(formatPlan("  ")).toBeNull();
  });
});
