/**
 * FixtureRegistry.ts
 *
 * Canonical registry and lazy loader for IO-VNBD benchmark replay datasets.
 *
 * Sourced directly from:
 * - assets/datasets/iovnbd_s1.json (Canonical 180s baseline session)
 * - assets/datasets/test_fixtures/manifest.json (Locked benchmark split sessions)
 *
 * ARCHITECTURAL PRINCIPLE:
 * - Single source of truth for available test-drive sessions.
 * - Statically analyzable requires wrapped in lazy getter functions so Metro
 *   bundles the files but does not deserialize all JSON files into memory at startup.
 * - Normalized session IDs (handles "S1", "iovnbd_s1", "iovnbd_S1").
 * - Does not invent metadata: only surfaces fields physically present in the fixtures/manifest.
 */

import { IovnbdFixture } from "./types";

export interface SessionMetadata {
  id: string;
  label: string;
  description?: string;
  category: "featured" | "baseline";
  durationSec: number;
  sampleCount: number;
  sizeKb?: number;
  vehicle?: string;
  driver?: string;
  isBaseline?: boolean;
  honestEndpointErrorM: number;
  honestOutageDistM: number;
  honestDriftPct: number | null;
  statusLabel: string;
  isCompliant: boolean;
  benchmarkRank: number;
}

declare const require: any;
declare const process: any;

function loadJsonSafe<T>(relPath: string, fallback: () => T): T {
  try {
    const fsMod = "fs";
    const pathMod = "path";
    const fs = typeof require !== "undefined" ? require(fsMod) : null;
    const path = typeof require !== "undefined" ? require(pathMod) : null;
    if (fs && path && typeof process !== "undefined" && process.cwd) {
      const fullPath = path.resolve(process.cwd(), relPath);
      if (fs.existsSync(fullPath)) {
        return JSON.parse(fs.readFileSync(fullPath, "utf8")) as T;
      }
    }
  } catch {
    // Ignore and fallback
  }
  return fallback();
}

// Statically resolvable map for Metro bundler
const FIXTURE_LOADERS: Record<string, () => IovnbdFixture> = {
  S1: () => require("../../../assets/datasets/iovnbd_s1.json"),
  S2: () => require("../../../assets/datasets/test_fixtures/iovnbd_S2.json"),
  M: () => require("../../../assets/datasets/test_fixtures/iovnbd_M.json"),
  Vta10: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vta10.json"),
  Vta15: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vta15.json"),
  Vta21: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vta21.json"),
  Vta8: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vta8.json"),
  Vtb10: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vtb10.json"),
  Vtb12: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vtb12.json"),
  Vtb4: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vtb4.json"),
  Vw14b: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vw14b.json"),
  Vw8: () => require("../../../assets/datasets/test_fixtures/iovnbd_Vw8.json"),
};

// Canonical manifest containing locked test split statistics
const testManifest: Record<
  string,
  { samples: number; duration_sec: number; size_kb: number }
> = loadJsonSafe(
  "assets/datasets/test_fixtures/manifest.json",
  () => {
    try {
      return require("../../../assets/datasets/test_fixtures/manifest.json");
    } catch {
      return {};
    }
  },
);

/**
 * Normalizes input ID into canonical key (e.g. "iovnbd_s2" -> "S2", "s1" -> "S1")
 */
export function normalizeSessionId(id: string): string {
  if (!id) return "S1";
  const trimmed = id.trim();
  const withoutPrefix = trimmed.replace(/^iovnbd_/i, "");

  // Match canonical key case-insensitively
  const canonicalKey = Object.keys(FIXTURE_LOADERS).find(
    (k) => k.toLowerCase() === withoutPrefix.toLowerCase(),
  );
  return canonicalKey ?? withoutPrefix;
}

/**
 * Returns complete list of available benchmark test drive sessions with real metadata.
 */
// Precomputed benchmark error metrics (sorted by least position error)
/**
 * Authoritative demo session registry containing strictly the 5 featured sessions
 * plus the S1 stationary baseline session, parameterized with honest clean benchmark metrics.
 * Note: SIH target is <10%. None of the moving sessions are presented as compliant.
 */
const FEATURED_DEMO_SESSIONS: SessionMetadata[] = [
  {
    id: "S1",
    label: "IO-VNBD S1",
    description: "Stationary zero-velocity hold (~2.9m drift)",
    category: "baseline",
    durationSec: 179.9,
    sampleCount: 1800,
    sizeKb: 1216.7,
    vehicle: "Ford Fiesta 1.25L",
    driver: "Driver A",
    isBaseline: true,
    honestEndpointErrorM: 2.94,
    honestOutageDistM: 2.93,
    honestDriftPct: null,
    statusLabel: "STATIONARY (<5m)",
    isCompliant: true,
    benchmarkRank: 1,
  },
  {
    id: "Vta8",
    label: "IO-VNBD Vta8",
    description: "Lowest absolute endpoint error (~23m)",
    category: "featured",
    durationSec: 119.9,
    sampleCount: 1200,
    sizeKb: 812.5,
    honestEndpointErrorM: 23.07,
    honestOutageDistM: 10.41,
    honestDriftPct: 156.0,
    statusLabel: "ABOVE TARGET (156%)",
    isCompliant: false,
    benchmarkRank: 2,
  },
  {
    id: "S2",
    label: "IO-VNBD S2",
    description: "Strongest route-aided case (81% → 26.9%)",
    category: "featured",
    durationSec: 119.9,
    sampleCount: 1200,
    sizeKb: 815.1,
    honestEndpointErrorM: 15.55,
    honestOutageDistM: 57.83,
    honestDriftPct: 26.9,
    statusLabel: "ABOVE TARGET (26.9%)",
    isCompliant: false,
    benchmarkRank: 3,
  },
  {
    id: "M",
    label: "IO-VNBD M",
    description: "Continuous dead reckoning (~28 km/h)",
    category: "featured",
    durationSec: 119.9,
    sampleCount: 1200,
    sizeKb: 814.2,
    honestEndpointErrorM: 144.29,
    honestOutageDistM: 212.27,
    honestDriftPct: 68.0,
    statusLabel: "ABOVE TARGET (68.0%)",
    isCompliant: false,
    benchmarkRank: 4,
  },
  {
    id: "Vta15",
    label: "IO-VNBD Vta15",
    description: "High-speed motorway stress test (~77 km/h)",
    category: "featured",
    durationSec: 83.2,
    sampleCount: 833,
    sizeKb: 564.8,
    honestEndpointErrorM: 540.23,
    honestOutageDistM: 563.47,
    honestDriftPct: 90.7,
    statusLabel: "FAIL / STRESS CASE (90.7%)",
    isCompliant: false,
    benchmarkRank: 5,
  },
  {
    id: "Vw8",
    label: "IO-VNBD Vw8",
    description: "Realistic moving urban corridor (~36 km/h)",
    category: "featured",
    durationSec: 119.9,
    sampleCount: 1200,
    sizeKb: 813.7,
    honestEndpointErrorM: 106.12,
    honestOutageDistM: 210.73,
    honestDriftPct: 50.4,
    statusLabel: "ABOVE TARGET (50.4%)",
    isCompliant: false,
    benchmarkRank: 6,
  },
];

/**
 * Returns complete list of demo sessions (5 featured + 1 stationary baseline).
 */
export function getAvailableSessions(): SessionMetadata[] {
  return [...FEATURED_DEMO_SESSIONS];
}

/**
 * Retrieves metadata for a specific session ID if registered.
 */
export function getSessionMetadata(id: string): SessionMetadata | null {
  const canonical = normalizeSessionId(id);
  const all = getAvailableSessions();
  return all.find((s) => s.id === canonical) ?? null;
}

/**
 * Dynamically loads and returns the fixture for the requested session ID.
 * Throws an explicit error if the session is not found in the registry.
 */
export function loadFixtureById(id: string): IovnbdFixture {
  const canonical = normalizeSessionId(id);
  const loader = FIXTURE_LOADERS[canonical];
  if (!loader) {
    throw new Error(
      `[FixtureRegistry] Unknown session fixture '${id}' (normalized: '${canonical}'). Available: ${Object.keys(FIXTURE_LOADERS).join(", ")}`,
    );
  }
  const relPath =
    canonical === "S1"
      ? "assets/datasets/iovnbd_s1.json"
      : `assets/datasets/test_fixtures/iovnbd_${canonical}.json`;
  return loadJsonSafe(relPath, loader);
}