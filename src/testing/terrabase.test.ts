import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { startTerraBase, verifiedBinary } from "./terrabase";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

beforeAll(async () => {
  await verifiedBinary();
}, 150_000);

it("reports a launch error without an unhandled rejection and removes its temporary directory", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let directory = "";
  vi.mocked(spawn).mockImplementationOnce((_command, args) => {
    const dataDirectory = args!.find((arg) => arg.startsWith("--data-directory="))!;
    directory = dirname(dataDirectory.slice("--data-directory=".length));
    return actual.spawn("/ts497/missing-executable-loader", args);
  });
  try {
    await expect(startTerraBase()).rejects.toMatchObject({ code: "ENOENT" });
    expect(directory).not.toBe("");
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.mocked(spawn).mockReset();
  }
});
