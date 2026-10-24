import {
  isEnabled,
  setFlag,
  getAllFlags,
  clearRuntimeOverrides,
  KNOWN_FLAGS,
} from "./featureFlags";

// Minimal env stubbing helpers (jest has no built-in process.env stubs).
const originalEnv = new Map<string, string | undefined>();

function stubEnv(name: string, value: string): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function restoreEnvs(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
}

beforeEach(() => {
  clearRuntimeOverrides();
});

afterEach(() => {
  clearRuntimeOverrides();
  restoreEnvs();
});

describe("isEnabled", () => {
  it("returns the compiled default when no override or env var is set", () => {
    // streaming_responses defaults to true
    expect(isEnabled("streaming_responses")).toBe(true);
    // dag_preview defaults to false
    expect(isEnabled("dag_preview")).toBe(false);
  });

  it("runtime override takes precedence over default", () => {
    setFlag("dag_preview", true);
    expect(isEnabled("dag_preview")).toBe(true);
  });

  it("env var overrides default but not runtime", () => {
    stubEnv("FEATURE_DAG_PREVIEW", "true");
    expect(isEnabled("dag_preview")).toBe(true);

    setFlag("dag_preview", false);
    expect(isEnabled("dag_preview")).toBe(false);
  });

  it("accepts '1' as truthy env value", () => {
    stubEnv("FEATURE_EXPERIMENTAL_AGENTS", "1");
    expect(isEnabled("experimental_agents")).toBe(true);
  });
});

describe("setFlag", () => {
  it("sets a runtime override", () => {
    setFlag("quality_scorer", false);
    expect(isEnabled("quality_scorer")).toBe(false);
  });

  it("clears a runtime override when passed null", () => {
    setFlag("streaming_responses", false);
    expect(isEnabled("streaming_responses")).toBe(false);

    setFlag("streaming_responses", null);
    expect(isEnabled("streaming_responses")).toBe(true);
  });
});

describe("getAllFlags", () => {
  it("returns an entry for every known flag", () => {
    const flags = getAllFlags();
    for (const flag of KNOWN_FLAGS) {
      expect(flags[flag]).toBeDefined();
      expect(typeof flags[flag].enabled).toBe("boolean");
      expect(["runtime", "env", "default"]).toContain(flags[flag].source);
    }
  });

  it("marks runtime-overridden flags with source=runtime", () => {
    setFlag("dag_preview", true);
    const flags = getAllFlags();
    expect(flags.dag_preview.source).toBe("runtime");
    expect(flags.dag_preview.enabled).toBe(true);
  });

  it("marks env-driven flags with source=env", () => {
    stubEnv("FEATURE_EXPERIMENTAL_AGENTS", "true");
    const flags = getAllFlags();
    expect(flags.experimental_agents.source).toBe("env");
  });
});
