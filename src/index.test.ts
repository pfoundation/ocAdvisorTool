import { describe, expect, test } from "bun:test";
import plugin from "./index";
import advisorDefault from "./ocAdvisor";

describe("package entrypoint", () => {
  test("re-exports the advisor plugin as the default export", () => {
    expect(plugin).toBe(advisorDefault);
  });

  test("exposes the documented V2 shape only", () => {
    expect(plugin.id).toBe("oc-advisor");
    expect(typeof plugin.setup).toBe("function");
    expect("server" in plugin).toBe(false);
  });
});
