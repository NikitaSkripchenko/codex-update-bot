import { consumeFixedWindow } from "../src/rate-limit";

describe("rate limit", () => {
  it("allows requests up to the fixed-window limit", () => {
    const first = consumeFixedWindow(null, 1000, 2, 60);
    expect(first.result.allowed).toBe(true);
    expect(first.result.remaining).toBe(1);

    const second = consumeFixedWindow(first.record, 2000, 2, 60);
    expect(second.result.allowed).toBe(true);
    expect(second.result.remaining).toBe(0);

    const third = consumeFixedWindow(second.record, 3000, 2, 60);
    expect(third.result.allowed).toBe(false);
    expect(third.result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window expires", () => {
    const first = consumeFixedWindow(null, 1000, 1, 1);
    const second = consumeFixedWindow(first.record, 2500, 1, 1);

    expect(second.result.allowed).toBe(true);
    expect(second.result.remaining).toBe(0);
  });
});
