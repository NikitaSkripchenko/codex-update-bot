import { readFileSync } from "node:fs";
import { vi } from "vitest";

vi.mock("../src/reset-image.png", () => ({
  default: readFileSync("src/reset-image.png"),
}));
