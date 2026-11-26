import { describe, expect, it, vi } from "vitest";
import { DemoBackend } from "../backend/demo";
import { setBackendForTests } from "../backend";
import { checkForUpdate, updateFinished, useUpdate } from "../lib/update";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { message: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));

describe("updating from the source folder", () => {
  it("says the browser demo can't update itself", async () => {
    setBackendForTests(new DemoBackend());
    const s = await checkForUpdate();
    expect(s?.canInstall).toBe(false);
    expect(s?.problem).toMatch(/reload the page/);
    expect(useUpdate.getState().checking).toBe(false);
  });

  it("offers the restart once the new app is in place, not after a failure", () => {
    useUpdate.setState({ ready: false });
    updateFinished({ kind: "update", done: 0, total: 0, message: "", finished: true, error: "Update stopped" });
    expect(useUpdate.getState().ready).toBe(false);
    updateFinished({ kind: "update", done: 2, total: 4, message: "Building", finished: false, error: null });
    expect(useUpdate.getState().ready).toBe(false);
    updateFinished({ kind: "update", done: 0, total: 0, message: "MixIt is updated to abc1234.", finished: true, error: null });
    expect(useUpdate.getState().ready).toBe(true);
  });
});
