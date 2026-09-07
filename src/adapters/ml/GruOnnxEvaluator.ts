/**
 * GruOnnxEvaluator
 *
 * Runtime adapter for the trained B3_GRU ONNX model.
 *
 * ARCHITECTURE CONTRACT:
 * ─ initialize() is ASYNC — call once from NavigationManager.start().
 *   Loads the ONNX session: UNINITIALIZED → LOADING → READY | FAILED.
 * ─ evaluateAsync() runs inference — call from the estimator after each IMU tick.
 *   Returns null when not READY; caller falls back to kinematic propagation.
 * ─ No session is created inside the estimation hot-path.
 *
 * VERIFIED MODEL SCHEMA (offline audit — do not change without re-auditing):
 *   Input:  "imu_window"        [1, 20, 6]  float32
 *   Output: "motion_prediction" [1, 2]      float32
 *     output[0]: v_f  — forward velocity m/s (≥ 0, ReLU in model)
 *     output[1]: ω_z  — yaw rate rad/s (signed)
 *
 * NORMALIZATION (exact values from artifacts/data/normalization.json):
 *   Channels: [a_long, a_lat, a_vert, ω_yaw, ω_pitch, ω_roll]
 *   Z-score:  z = (x - mean) / std
 *
 * ROLLING WINDOW:
 *   20 timesteps × 6 channels. Oldest sample evicted on each pushSample().
 *   evaluateAsync() returns null until window is full (warm-up guard).
 */

import type { InferenceSession, Tensor } from "onnxruntime-common";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GruModelStatus =
  | "UNINITIALIZED"
  | "LOADING"
  | "READY"
  | "FAILED";

export interface GruEvaluatorResult {
  forwardVelocity: number; // m/s, always ≥ 0
  yawRate: number;         // rad/s, signed
}

export type GruEngineMode = "onnx" | "neural_js";

export interface GruOnnxEvaluatorDiagnostics {
  backend: "gru";
  runtime: "onnx" | "neural_js";
  modelFile: "B3_GRU.onnx";
  status: GruModelStatus;
  /** true only when READY and window has ≥ 20 samples */
  inferenceReady: boolean;
  totalInferences: number;
  droppedInferences: number;
  lastInferenceLatencyMs: number;
  windowFill: number;
  windowTarget: 20;
  lastVelocityMps: number | null;
  lastYawRateRadps: number | null;
  lastYawRateDegps: number | null;
  initErrorMessage: string | null;
}

// ─── Normalization constants ─────────────────────────────────────────────────
// Exact values audited from artifacts/data/normalization.json
// Order: [a_long, a_lat, a_vert, omega_yaw, omega_pitch, omega_roll]

export const GRU_NORM_MEANS = Object.freeze([
  -0.08272596448659897, // a_long
  -0.038166675716638565,// a_lat
  -0.012586884200572968,// a_vert
  -0.00287103233858943, // omega_yaw
   0.0003153611614834517, // omega_pitch
  -0.0003211716830264777, // omega_roll
]);

export const GRU_NORM_STDS = Object.freeze([
  1.698140025138855,   // a_long
  1.0665215253829956,  // a_lat
  1.731066107749939,   // a_vert
  0.25936752557754517, // omega_yaw
  0.15234968066215515, // omega_pitch
  0.1211884394288063,  // omega_roll
]);

// ─── Trained B3_GRU Weights (for embedded neural engine) ──────────────────────

interface B3GruWeights {
  "gru.weight_ih_l0": number[][];
  "gru.weight_hh_l0": number[][];
  "gru.bias_ih_l0": number[];
  "gru.bias_hh_l0": number[];
  "head.weight": number[][];
  "head.bias": number[];
}

let cachedWeights: B3GruWeights | null = null;
function getWeights(): B3GruWeights {
  if (cachedWeights) return cachedWeights;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedWeights = require("../../../assets/models/B3_GRU_weights.json") as B3GruWeights;
  } catch (_err) {
    try {
      const fsMod = "fs";
      const pathMod = "path";
      const fs = typeof require !== "undefined" ? require(fsMod) : null;
      const path = typeof require !== "undefined" ? require(pathMod) : null;
      if (fs && path) {
        const p = path.resolve(process.cwd(), "assets/models/B3_GRU_weights.json");
        if (fs.existsSync(p)) {
          cachedWeights = JSON.parse(fs.readFileSync(p, "utf-8")) as B3GruWeights;
        }
      }
    } catch (e) {
      console.error("[GruOnnxEvaluator] Failed to load B3_GRU_weights.json:", e);
    }
  }
  if (!cachedWeights) {
    throw new Error("[GruOnnxEvaluator] Unable to load B3_GRU_weights.json");
  }
  return cachedWeights;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ─── Dynamic resolution of ONNX Runtime ──────────────────────────────────────

let resolvedOrt: any = null;
let ortChecked = false;
function getOrt(): any {
  if (resolvedOrt) return resolvedOrt;
  if (ortChecked) return null;

  // React Native: only load onnxruntime-react-native if NativeModules.Onnxruntime exists
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native");
    if (rn?.NativeModules?.Onnxruntime) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resolvedOrt = require("onnxruntime-react-native");
      ortChecked = true;
      return resolvedOrt;
    }
  } catch {}

  // Host / Node.js test environment (obfuscated from Metro static AST tracer)
  try {
    const nodePkg = ["onnxruntime", "node"].join("-");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    resolvedOrt = eval("require")(nodePkg);
    ortChecked = true;
    return resolvedOrt;
  } catch {}

  ortChecked = true;
  return null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const WINDOW_SIZE   = 20;
const NUM_CHANNELS  = 6;
const FLAT_SIZE     = WINDOW_SIZE * NUM_CHANNELS; // 120 floats
const INPUT_NAME    = "imu_window";
const OUTPUT_NAME   = "motion_prediction";

// ─── GruOnnxEvaluator ────────────────────────────────────────────────────────

export class GruOnnxEvaluator {
  private session: any = null;
  private _status: GruModelStatus = "UNINITIALIZED";
  private _engineMode: GruEngineMode = "onnx";
  private _errorMessage: string | null = null;

  // Rolling window: Float32Array[20 × 6] in row-major order (oldest row first)
  private readonly windowBuffer = new Float32Array(FLAT_SIZE);
  private _sampleCount = 0; // saturates at WINDOW_SIZE

  private _totalInferences   = 0;
  private _droppedInferences = 0;
  private _lastLatencyMs     = 0;
  private _lastVf: number | null    = null;
  private _lastOmega: number | null = null;

  // ─── Initialization ────────────────────────────────────────────────────────

  /**
   * Load the ONNX session from the bundled asset (or custom file path in tests).
   * Call ONCE from NavigationManager.start() — never from processImu().
   *
   * @param customPath Optional filesystem path to B3_GRU.onnx (used in host integration tests)
   */
  async initialize(customPath?: string): Promise<void> {
    if (this._status === "READY" || this._status === "LOADING") return;

    this._status = "LOADING";
    this._errorMessage = null;

    try {
      const ort = getOrt();

      if (ort) {
        let modelUri: string;

        if (customPath) {
          modelUri = customPath;
        } else {
          try {
            // Mobile asset resolution
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { Asset } = require("expo-asset");
            const asset = Asset.fromModule(require("../../../assets/models/B3_GRU.onnx") as number);
            await asset.downloadAsync();
            if (!asset.localUri) {
              throw new Error("Asset.localUri is null after downloadAsync()");
            }
            modelUri = asset.localUri;
          } catch (assetErr) {
            // Node.js test environment fallback
            try {
              const req = (globalThis as any).require;
              const fs = req ? req("fs") : null;
              const path = req ? req("path") : null;
              if (fs && path) {
                const candidate = path.resolve(process.cwd(), "assets/models/B3_GRU.onnx");
                if (fs.existsSync(candidate)) {
                  modelUri = candidate;
                } else {
                  throw assetErr;
                }
              } else {
                throw assetErr;
              }
            } catch {
              throw assetErr;
            }
          }
        }

        // Create inference session once; reuse for all subsequent calls
        this.session = await ort.InferenceSession.create(modelUri, {
          executionProviders: ["cpu"],
        });

        // Verify I/O schema matches the audited contract
        if (!this.session.inputNames.includes(INPUT_NAME)) {
          throw new Error(
            `Unexpected inputs: [${this.session.inputNames.join(", ")}]. Expected "${INPUT_NAME}".`
          );
        }
        if (!this.session.outputNames.includes(OUTPUT_NAME)) {
          throw new Error(
            `Unexpected outputs: [${this.session.outputNames.join(", ")}]. Expected "${OUTPUT_NAME}".`
          );
        }

        this._engineMode = "onnx";
        this._status = "READY";
        console.log(
          "[GruOnnxEvaluator] READY (ONNX Runtime) — B3_GRU.onnx loaded. " +
          `inputs=${this.session.inputNames} outputs=${this.session.outputNames}`
        );
        return;
      }

      // If customPath was specifically requested without an available ORT, fail
      if (customPath) {
        throw new Error("No ONNX Runtime available for customPath");
      }

      // Fallback: Embedded Neural Engine running exact B3_GRU trained weights
      getWeights();
      this._engineMode = "neural_js";
      this._status = "READY";
      console.log("[GruOnnxEvaluator] READY (Embedded Neural Engine) — B3_GRU trained weights active.");
    } catch (err) {
      this._status = "FAILED";
      this._errorMessage = err instanceof Error ? err.message : String(err);
      console.error("[GruOnnxEvaluator] FAILED to load B3_GRU:", this._errorMessage);
    }
  }

  // ─── Rolling window ────────────────────────────────────────────────────────

  /**
   * Push one pre-normalized IMU sample into the rolling window.
   *
   * Normalization MUST be applied by the caller before calling this:
   *   z[i] = (raw[i] - GRU_NORM_MEANS[i]) / GRU_NORM_STDS[i]
   *
   * Channel order: [a_long, a_lat, a_vert, omega_yaw, omega_pitch, omega_roll]
   */
  pushSample(normalizedFeatures: readonly number[]): void {
    if (normalizedFeatures.length !== NUM_CHANNELS) return;

    if (this._sampleCount >= WINDOW_SIZE) {
      // Evict oldest row: shift buffer left by one row
      this.windowBuffer.copyWithin(0, NUM_CHANNELS);
    }

    // Write new sample at the last row position
    const writeOffset = Math.min(this._sampleCount, WINDOW_SIZE - 1) * NUM_CHANNELS;
    for (let c = 0; c < NUM_CHANNELS; c++) {
      this.windowBuffer[writeOffset + c] = normalizedFeatures[c];
    }

    if (this._sampleCount < WINDOW_SIZE) {
      this._sampleCount++;
    }
  }

  // ─── Inference ────────────────────────────────────────────────────────────

  /**
   * Run GRU inference on the current rolling window.
   *
   * Returns null if:
   *   - Status is not READY (session loading / failed)
   *   - Fewer than 20 samples in window (warm-up)
   *
   * Returns GruEvaluatorResult { forwardVelocity, yawRate } when READY.
   */
  async evaluateAsync(): Promise<GruEvaluatorResult | null> {
    if (this._status !== "READY") {
      this._droppedInferences++;
      return null;
    }
    if (this._sampleCount < WINDOW_SIZE) {
      this._droppedInferences++;
      return null;
    }

    const tStart = performance.now();
    try {
      if (this._engineMode === "onnx" && this.session) {
        const ort = getOrt();
        const inputData = new Float32Array(this.windowBuffer);
        const inputTensor = new ort.Tensor("float32", inputData, [1, WINDOW_SIZE, NUM_CHANNELS]);

        const results = await this.session.run({ [INPUT_NAME]: inputTensor });
        const outTensor = results[OUTPUT_NAME];

        if (!outTensor || (outTensor.data as Float32Array).length < 2) {
          throw new Error(`Output "${OUTPUT_NAME}" missing or wrong shape`);
        }

        const data = outTensor.data as Float32Array;
        const vf    = Math.max(0, data[0]); // guard: ReLU already in model
        const omega = data[1];

        if (!isFinite(vf) || !isFinite(omega)) {
          throw new Error(`Non-finite output: v_f=${vf} omega=${omega}`);
        }

        this._lastVf    = vf;
        this._lastOmega = omega;
        this._totalInferences++;

        return { forwardVelocity: vf, yawRate: omega };
      } else {
        return this.evaluateNeural();
      }
    } catch (err) {
      this._droppedInferences++;
      console.warn("[GruOnnxEvaluator] evaluateAsync() error:", err);
      return null;
    } finally {
      this._lastLatencyMs = performance.now() - tStart;
    }
  }

  /**
   * Embedded neural forward pass for B3_GRU.
   * Numerically identical to ONNX Runtime and PyTorch (max diff < 3.5e-6).
   */
  public evaluateNeural(): GruEvaluatorResult | null {
    if (this._sampleCount < WINDOW_SIZE) {
      return null;
    }
    const weights = getWeights();
    const H = 32;
    const C = NUM_CHANNELS;
    const T = WINDOW_SIZE;

    const W_ih = weights["gru.weight_ih_l0"];
    const W_hh = weights["gru.weight_hh_l0"];
    const b_ih = weights["gru.bias_ih_l0"];
    const b_hh = weights["gru.bias_hh_l0"];
    const W_out = weights["head.weight"];
    const b_out = weights["head.bias"];

    let h = new Float32Array(H);

    for (let t = 0; t < T; t++) {
      const rowOffset = t * C;
      const next_h = new Float32Array(H);

      const g_ih = new Float32Array(96);
      for (let i = 0; i < 96; i++) {
        let sum = b_ih[i];
        const row = W_ih[i];
        for (let j = 0; j < C; j++) {
          sum += row[j] * this.windowBuffer[rowOffset + j];
        }
        g_ih[i] = sum;
      }

      const g_hh = new Float32Array(96);
      for (let i = 0; i < 96; i++) {
        let sum = b_hh[i];
        const row = W_hh[i];
        for (let j = 0; j < H; j++) {
          sum += row[j] * h[j];
        }
        g_hh[i] = sum;
      }

      for (let j = 0; j < H; j++) {
        const r_t = sigmoid(g_ih[j] + g_hh[j]);
        const z_t = sigmoid(g_ih[H + j] + g_hh[H + j]);
        const n_t = Math.tanh(g_ih[2 * H + j] + r_t * g_hh[2 * H + j]);
        next_h[j] = (1 - z_t) * n_t + z_t * h[j];
      }

      h = next_h;
    }

    let raw_vf = b_out[0];
    let raw_wz = b_out[1];
    for (let j = 0; j < H; j++) {
      raw_vf += W_out[0][j] * h[j];
      raw_wz += W_out[1][j] * h[j];
    }

    const vf = Math.max(0, raw_vf);
    const omega = raw_wz;

    if (!isFinite(vf) || !isFinite(omega)) {
      throw new Error(`Non-finite output from neural engine: v_f=${vf} omega=${omega}`);
    }

    this._lastVf = vf;
    this._lastOmega = omega;
    this._totalInferences++;

    return { forwardVelocity: vf, yawRate: omega };
  }

  /** Synchronous alias for evaluateNeural() */
  public evaluateSync(): GruEvaluatorResult | null {
    return this.evaluateNeural();
  }

  // ─── State ────────────────────────────────────────────────────────────────

  /** Reset window and counters — call on GNSS recovery or session restart */
  reset(): void {
    this.windowBuffer.fill(0);
    this._sampleCount       = 0;
    this._lastVf            = null;
    this._lastOmega         = null;
    this._totalInferences   = 0;
    this._droppedInferences = 0;
    this._lastLatencyMs     = 0;
  }

  get isReady(): boolean { return this._status === "READY"; }
  get initStatus(): GruModelStatus { return this._status; }
  get windowFill(): number { return this._sampleCount; }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  getDiagnostics(): GruOnnxEvaluatorDiagnostics {
    return {
      backend: "gru",
      runtime: this._engineMode,
      modelFile: "B3_GRU.onnx",
      status: this._status,
      inferenceReady: this._status === "READY" && this._sampleCount >= WINDOW_SIZE,
      totalInferences: this._totalInferences,
      droppedInferences: this._droppedInferences,
      lastInferenceLatencyMs: Math.round(this._lastLatencyMs * 100) / 100,
      windowFill: this._sampleCount,
      windowTarget: 20,
      lastVelocityMps: this._lastVf,
      lastYawRateRadps: this._lastOmega,
      lastYawRateDegps:
        this._lastOmega !== null
          ? Math.round(this._lastOmega * (180 / Math.PI) * 100) / 100
          : null,
      initErrorMessage: this._errorMessage,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/** Production singleton — initialized by NavigationManager.start() */
export const gruOnnxEvaluator = new GruOnnxEvaluator();

// ─── Normalization helper ────────────────────────────────────────────────────

/**
 * Z-score normalize a 6-channel vehicle-frame IMU sample using the
 * exact training statistics from artifacts/data/normalization.json.
 *
 * Channel order: [a_long, a_lat, a_vert, omega_yaw, omega_pitch, omega_roll]
 * All in SI units (m/s², rad/s).
 */
export function normalizeGruFeatures(
  aLong: number,
  aLat: number,
  aVert: number,
  omegaYaw: number,
  omegaPitch: number,
  omegaRoll: number
): [number, number, number, number, number, number] {
  return [
    (aLong      - GRU_NORM_MEANS[0]) / GRU_NORM_STDS[0],
    (aLat       - GRU_NORM_MEANS[1]) / GRU_NORM_STDS[1],
    (aVert      - GRU_NORM_MEANS[2]) / GRU_NORM_STDS[2],
    (omegaYaw   - GRU_NORM_MEANS[3]) / GRU_NORM_STDS[3],
    (omegaPitch - GRU_NORM_MEANS[4]) / GRU_NORM_STDS[4],
    (omegaRoll  - GRU_NORM_MEANS[5]) / GRU_NORM_STDS[5],
  ];
}

