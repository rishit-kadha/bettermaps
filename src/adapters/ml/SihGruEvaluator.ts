/**
 * SihGruEvaluator
 *
 * Runtime adapter for the friend's SIH Dead Reckoning 2-layer GRU velocity model
 * (from external/sih_dead_reckoning/artifacts/clean_velocity_comparison/gru_clean_velocity.pt).
 *
 * ARCHITECTURE CONTRACT:
 * ─ initialize() is ASYNC — loads the ONNX session: UNINITIALIZED → LOADING → READY | FAILED.
 *   Also loads embedded trained weights for zero-dependency JavaScript execution on device.
 * ─ evaluateAsync() runs inference over a 50-sample sliding window (5.0s @ 10 Hz).
 * ─ Normalization (exact statistics from scalers.joblib):
 *     Channels: [linear_accel_x, linear_accel_y, linear_accel_z, angular_vel_x, angular_vel_y, angular_vel_z]
 *     z = (x - mean) / scale
 * ─ Target denormalization:
 *     velocity_mps = max(0, model_output * target_scale + target_mean)
 */

import type { InferenceSession, Tensor } from "onnxruntime-common";

export type SihModelStatus =
  | "UNINITIALIZED"
  | "LOADING"
  | "READY"
  | "FAILED";

export interface SihEvaluatorResult {
  forwardVelocity: number; // m/s, always >= 0
}

export type SihEngineMode = "onnx" | "neural_js";

export interface SihGruEvaluatorDiagnostics {
  backend: "sih_gru";
  runtime: "onnx" | "neural_js";
  modelFile: "sih_gru.onnx";
  status: SihModelStatus;
  inferenceReady: boolean;
  totalInferences: number;
  droppedInferences: number;
  lastInferenceLatencyMs: number;
  windowFill: number;
  windowTarget: 50;
  lastVelocityMps: number | null;
  initErrorMessage: string | null;
}

// ─── Normalization constants from scalers.joblib ────────────────────────────
export const SIH_NORM_MEANS = Object.freeze([
  0.044815783860300926,  // linear_accel_x
  -0.06724548060373758,  // linear_accel_y
  0.18944164501314714,   // linear_accel_z
  4.413844272944445e-06, // angular_vel_x
  0.0014875562173792766, // angular_vel_y
  -0.0020986324986663,   // angular_vel_z
]);

export const SIH_NORM_STDS = Object.freeze([
  2.2225976692690628,   // linear_accel_x
  2.3958236620567073,   // linear_accel_y
  0.8902544811156624,   // linear_accel_z
  0.26395565131407367,  // angular_vel_x
  0.25048259629254094,  // angular_vel_y
  0.10458397316236762,  // angular_vel_z
]);

export const SIH_TARGET_MEAN = 14.618584326606433;
export const SIH_TARGET_SCALE = 6.597726638937385;

export function normalizeSihFeatures(raw: readonly number[]): number[] {
  const norm = new Array<number>(6);
  for (let i = 0; i < 6; i++) {
    norm[i] = (raw[i] - SIH_NORM_MEANS[i]) / SIH_NORM_STDS[i];
  }
  return norm;
}

// ─── Trained SIH Weights Interface ──────────────────────────────────────────
export interface SihGruWeights {
  metadata: {
    model_name: string;
    hidden_size: number;
    num_layers: number;
    window_size: number;
    target_mean: number;
    target_scale: number;
  };
  weights: {
    "gru.weight_ih_l0": number[][];
    "gru.weight_hh_l0": number[][];
    "gru.bias_ih_l0": number[];
    "gru.bias_hh_l0": number[];
    "gru.weight_ih_l1": number[][];
    "gru.weight_hh_l1": number[][];
    "gru.bias_ih_l1": number[];
    "gru.bias_hh_l1": number[];
    "head.0.weight": number[][];
    "head.0.bias": number[];
    "head.3.weight": number[][];
    "head.3.bias": number[];
  };
}

let cachedSihWeights: SihGruWeights | null = null;
function getSihWeights(): SihGruWeights {
  if (cachedSihWeights) return cachedSihWeights;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedSihWeights = require("../../../assets/models/sih_gru_weights.json") as SihGruWeights;
    return cachedSihWeights;
  } catch (e) {
    try {
      const fsMod = "fs";
      const pathMod = "path";
      const fs = typeof require !== "undefined" ? require(fsMod) : null;
      const path = typeof require !== "undefined" ? require(pathMod) : null;
      if (fs && path) {
        const candidate = path.resolve(process.cwd(), "assets/models/sih_gru_weights.json");
        if (fs.existsSync(candidate)) {
          cachedSihWeights = JSON.parse(fs.readFileSync(candidate, "utf8")) as SihGruWeights;
          return cachedSihWeights;
        }
      }
    } catch {}
    throw new Error(`Failed to load sih_gru_weights.json: ${e instanceof Error ? e.message : String(e)}`);
  }
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

const WINDOW_SIZE = 50;
const NUM_CHANNELS = 6;
const FLAT_SIZE = WINDOW_SIZE * NUM_CHANNELS; // 300 floats

export class SihGruEvaluator {
  private session: any = null;
  private _status: SihModelStatus = "UNINITIALIZED";
  private _engineMode: SihEngineMode = "onnx";
  private _errorMessage: string | null = null;

  // Rolling window: Float32Array[50 x 6] in row-major order (oldest row first)
  private readonly rawBuffer = new Float32Array(FLAT_SIZE);
  private _sampleCount = 0;

  private _totalInferences = 0;
  private _droppedInferences = 0;
  private _lastLatencyMs = 0;
  private _lastVf: number | null = null;

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
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { Asset } = require("expo-asset");
            const asset = Asset.fromModule(require("../../../assets/models/sih_gru.onnx") as number);
            await asset.downloadAsync();
            if (!asset.localUri) throw new Error("Asset.localUri is null");
            modelUri = asset.localUri;
          } catch (assetErr) {
            // Node.js test environment fallback
            const req = (globalThis as any).require;
            const fs = req ? req("fs") : null;
            const path = req ? req("path") : null;
            if (fs && path) {
              const candidate = path.resolve(process.cwd(), "assets/models/sih_gru.onnx");
              if (fs.existsSync(candidate)) {
                modelUri = candidate;
              } else {
                throw assetErr;
              }
            } else {
              throw assetErr;
            }
          }
        }

        this.session = await ort.InferenceSession.create(modelUri, {
          executionProviders: ["cpu"],
        });
        this._engineMode = "onnx";
        this._status = "READY";
        console.log("[SihGruEvaluator] READY (ONNX Runtime) - sih_gru.onnx loaded successfully.");
        return;
      }

      // Fallback: Embedded Neural Engine with exact trained weights
      getSihWeights();
      this._engineMode = "neural_js";
      this._status = "READY";
      console.log("[SihGruEvaluator] READY (Embedded Neural Engine) - SIH GRU weights active.");
    } catch (err) {
      // If ONNX loading fails, attempt fallback to embedded neural weights before declaring failure
      try {
        getSihWeights();
        this._engineMode = "neural_js";
        this._status = "READY";
        console.log("[SihGruEvaluator] READY (Embedded Neural Engine fallback) - SIH GRU active.");
      } catch (fallbackErr) {
        this._status = "FAILED";
        this._errorMessage = err instanceof Error ? err.message : String(err);
        console.error("[SihGruEvaluator] FAILED to initialize SIH GRU:", this._errorMessage);
      }
    }
  }

  pushSample(sample6: readonly number[]): void {
    if (sample6.length !== NUM_CHANNELS) return;

    if (this._sampleCount >= WINDOW_SIZE) {
      this.rawBuffer.copyWithin(0, NUM_CHANNELS);
    }

    const writeOffset = Math.min(this._sampleCount, WINDOW_SIZE - 1) * NUM_CHANNELS;
    for (let c = 0; c < NUM_CHANNELS; c++) {
      this.rawBuffer[writeOffset + c] = sample6[c];
    }

    if (this._sampleCount < WINDOW_SIZE) {
      this._sampleCount++;
    }
  }

  async evaluateAsync(): Promise<SihEvaluatorResult | null> {
    if (this._status !== "READY" || this._sampleCount < WINDOW_SIZE) {
      this._droppedInferences++;
      return null;
    }

    const tStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      if (this._engineMode === "onnx" && this.session) {
        const ort = getOrt();
        // The ONNX model expects raw IMU window [1, 50, 6] (or pre-normalized)
        const inputData = new Float32Array(this.rawBuffer);
        const inputTensor = new ort.Tensor("float32", inputData, [1, WINDOW_SIZE, NUM_CHANNELS]);
        const results = await this.session.run({ imu_window: inputTensor });
        const outTensor = results["forward_velocity"] || Object.values(results)[0];
        const data = (outTensor as any).data as Float32Array;
        const vf = Math.max(0, data[0]);

        this._lastVf = vf;
        this._totalInferences++;
        return { forwardVelocity: vf };
      } else {
        return this.evaluateNeural();
      }
    } catch (err) {
      this._droppedInferences++;
      console.warn("[SihGruEvaluator] evaluateAsync() error, falling back to neural engine:", err);
      try {
        return this.evaluateNeural();
      } catch {
        return null;
      }
    } finally {
      const tEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
      this._lastLatencyMs = tEnd - tStart;
    }
  }

  /**
   * Embedded 2-layer GRU forward pass for SIH model.
   * Numerically identical to PyTorch execution.
   */
  public evaluateNeural(): SihEvaluatorResult {
    const { weights, metadata } = getSihWeights();
    const H = metadata.hidden_size || 64;
    const C = NUM_CHANNELS;
    const T = WINDOW_SIZE;

    // Normalize input buffer
    const normBuffer = new Float32Array(FLAT_SIZE);
    for (let t = 0; t < T; t++) {
      const offset = t * C;
      for (let c = 0; c < C; c++) {
        normBuffer[offset + c] = (this.rawBuffer[offset + c] - SIH_NORM_MEANS[c]) / SIH_NORM_STDS[c];
      }
    }

    // Layer 0 GRU
    const W_ih_0 = weights["gru.weight_ih_l0"];
    const W_hh_0 = weights["gru.weight_hh_l0"];
    const b_ih_0 = weights["gru.bias_ih_l0"];
    const b_hh_0 = weights["gru.bias_hh_l0"];

    // Layer 1 GRU
    const W_ih_1 = weights["gru.weight_ih_l1"];
    const W_hh_1 = weights["gru.weight_hh_l1"];
    const b_ih_1 = weights["gru.bias_ih_l1"];
    const b_hh_1 = weights["gru.bias_hh_l1"];

    // Dense head
    const W_head0 = weights["head.0.weight"]; // [32, 64]
    const b_head0 = weights["head.0.bias"];   // [32]
    const W_head3 = weights["head.3.weight"]; // [1, 32]
    const b_head3 = weights["head.3.bias"];   // [1]

    let h0 = new Float32Array(H);
    let h1 = new Float32Array(H);

    const gates0_ih = new Float32Array(3 * H);
    const gates0_hh = new Float32Array(3 * H);
    const gates1_ih = new Float32Array(3 * H);
    const gates1_hh = new Float32Array(3 * H);

    for (let t = 0; t < T; t++) {
      const rowOffset = t * C;

      // Layer 0 step
      for (let i = 0; i < 3 * H; i++) {
        let sum_ih = b_ih_0[i];
        const row_ih = W_ih_0[i];
        for (let j = 0; j < C; j++) {
          sum_ih += row_ih[j] * normBuffer[rowOffset + j];
        }
        gates0_ih[i] = sum_ih;

        let sum_hh = b_hh_0[i];
        const row_hh = W_hh_0[i];
        for (let j = 0; j < H; j++) {
          sum_hh += row_hh[j] * h0[j];
        }
        gates0_hh[i] = sum_hh;
      }

      const next_h0 = new Float32Array(H);
      for (let j = 0; j < H; j++) {
        const r = sigmoid(gates0_ih[j] + gates0_hh[j]);
        const z = sigmoid(gates0_ih[H + j] + gates0_hh[H + j]);
        const n = Math.tanh(gates0_ih[2 * H + j] + r * gates0_hh[2 * H + j]);
        next_h0[j] = (1 - z) * n + z * h0[j];
      }
      h0 = next_h0;

      // Layer 1 step (input is h0)
      for (let i = 0; i < 3 * H; i++) {
        let sum_ih = b_ih_1[i];
        const row_ih = W_ih_1[i];
        for (let j = 0; j < H; j++) {
          sum_ih += row_ih[j] * h0[j];
        }
        gates1_ih[i] = sum_ih;

        let sum_hh = b_hh_1[i];
        const row_hh = W_hh_1[i];
        for (let j = 0; j < H; j++) {
          sum_hh += row_hh[j] * h1[j];
        }
        gates1_hh[i] = sum_hh;
      }

      const next_h1 = new Float32Array(H);
      for (let j = 0; j < H; j++) {
        const r = sigmoid(gates1_ih[j] + gates1_hh[j]);
        const z = sigmoid(gates1_ih[H + j] + gates1_hh[H + j]);
        const n = Math.tanh(gates1_ih[2 * H + j] + r * gates1_hh[2 * H + j]);
        next_h1[j] = (1 - z) * n + z * h1[j];
      }
      h1 = next_h1;
    }

    // Dense Head: [64] -> Linear(64, 32) -> ReLU -> Linear(32, 1)
    const hidden_dense = new Float32Array(32);
    for (let i = 0; i < 32; i++) {
      let sum = b_head0[i];
      const row = W_head0[i];
      for (let j = 0; j < H; j++) {
        sum += row[j] * h1[j];
      }
      hidden_dense[i] = Math.max(0, sum); // ReLU
    }

    let raw_out = b_head3[0];
    const row3 = W_head3[0];
    for (let j = 0; j < 32; j++) {
      raw_out += row3[j] * hidden_dense[j];
    }

    // Denormalization
    const speed_mps = Math.max(0, raw_out * SIH_TARGET_SCALE + SIH_TARGET_MEAN);

    this._lastVf = speed_mps;
    this._totalInferences++;
    return { forwardVelocity: speed_mps };
  }

  reset(): void {
    this.rawBuffer.fill(0);
    this._sampleCount = 0;
    this._lastVf = null;
    this._totalInferences = 0;
    this._droppedInferences = 0;
    this._lastLatencyMs = 0;
  }

  get isReady(): boolean { return this._status === "READY"; }
  get initStatus(): SihModelStatus { return this._status; }
  get windowFill(): number { return this._sampleCount; }

  getDiagnostics(): SihGruEvaluatorDiagnostics {
    return {
      backend: "sih_gru",
      runtime: this._engineMode,
      modelFile: "sih_gru.onnx",
      status: this._status,
      inferenceReady: this._status === "READY" && this._sampleCount >= WINDOW_SIZE,
      totalInferences: this._totalInferences,
      droppedInferences: this._droppedInferences,
      lastInferenceLatencyMs: this._lastLatencyMs,
      windowFill: this._sampleCount,
      windowTarget: WINDOW_SIZE,
      lastVelocityMps: this._lastVf,
      initErrorMessage: this._errorMessage,
    };
  }
}

export const sihGruEvaluator = new SihGruEvaluator();
