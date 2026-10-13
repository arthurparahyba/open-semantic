import { describe, expect, it } from "vitest";

import { activeProject } from "../src/projects.js";

const doc = (activeProjectId: string | undefined) =>
  ({
    workspace: { activeProjectId },
    projects: [{ id: "a" }, { id: "b" }],
  }) as unknown as Parameters<typeof activeProject>[0];

describe("activeProject", () => {
  it("é o marcado como ativo ou, sem marca, o último aberto", () => {
    expect(activeProject(doc("a"))?.id).toBe("a");
    expect(activeProject(doc(undefined))?.id).toBe("b");
    expect(activeProject(doc("sumiu"))?.id).toBe("b");
  });
});
