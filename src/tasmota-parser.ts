/**
 * Tasmota parser — converts Tasmota MQTT messages into DiscoveredDevice / state updates.
 *
 * Tasmota convention:
 *  - STATUS 0 (full device info) → build DiscoveredDevice
 *  - STATE / STATUS 11 / RESULT → incremental data updates (POWERn, Shutter position)
 *  - LWT → online/offline
 */

export interface DiscoveredDevice {
  ieeeAddress?: string;
  friendlyName: string;
  manufacturer?: string;
  model?: string;
  rawExpose?: unknown;
  data: {
    key: string;
    type: string;
    category: string;
    unit?: string;
    enumValues?: string[];
  }[];
  orders: {
    key: string;
    type: string;
    category?: string;
    min?: number;
    max?: number;
    enumValues?: string[];
    unit?: string;
  }[];
}

export interface TasmotaCapabilities {
  /** Relay numbers consumed by shutters (shouldn't be exposed as switches). */
  shutterRelays: Set<number>;
  /** Number of relays reported by the device. */
  relayCount: number;
  /** Shutters declared on the device (1-indexed). */
  shutters: number[];
}

/**
 * Safe JSON parse. Returns null on error.
 */
export function parseJson(raw: string | Buffer): unknown {
  try {
    const str = typeof raw === "string" ? raw : raw.toString("utf-8");
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Extract capabilities from a STATUS 0 response.
 * The response is published on `stat/<topic>/STATUS0` with shape:
 * {
 *   "Status": { "FriendlyName": [...], "Topic": "...", "Module": 23, ... },
 *   "StatusFWR": { ... },
 *   "StatusSHT": { "SHT1": { "Relay1": 3, "Relay2": 4, "Position": 50 }, ... }
 * }
 */
export function extractCapabilities(status0: Record<string, unknown>): TasmotaCapabilities {
  const statusObj = (status0.Status ?? {}) as Record<string, unknown>;
  const friendlyNames = Array.isArray(statusObj.FriendlyName) ? statusObj.FriendlyName : [];
  const relayCount = friendlyNames.length;

  const shutterRelays = new Set<number>();
  const shutters: number[] = [];
  const statusSHT = status0.StatusSHT;
  if (statusSHT && typeof statusSHT === "object") {
    for (const [key, value] of Object.entries(statusSHT)) {
      const match = /^SHT(\d+)$/.exec(key);
      if (!match || !value || typeof value !== "object") continue;
      const shutterNum = parseInt(match[1], 10);
      shutters.push(shutterNum);
      const shtObj = value as Record<string, unknown>;
      if (typeof shtObj.Relay1 === "number" && shtObj.Relay1 > 0) shutterRelays.add(shtObj.Relay1);
      if (typeof shtObj.Relay2 === "number" && shtObj.Relay2 > 0) shutterRelays.add(shtObj.Relay2);
    }
  }

  return { relayCount, shutterRelays, shutters: shutters.sort((a, b) => a - b) };
}

/**
 * Build a DiscoveredDevice from a STATUS 0 response.
 * Returns null if the response is not a valid STATUS 0 payload.
 */
export function buildDiscoveredDevice(status0: unknown): DiscoveredDevice | null {
  if (!status0 || typeof status0 !== "object") return null;
  const s0 = status0 as Record<string, unknown>;
  const statusObj = (s0.Status ?? {}) as Record<string, unknown>;

  const topic = typeof statusObj.Topic === "string" ? statusObj.Topic : null;
  if (!topic) return null;

  // Always use the Tasmota Topic as the DiscoveredDevice friendlyName.
  // Sowel uses friendlyName as sourceDeviceId (stable identifier), which must match
  // the Tasmota MQTT topic so order dispatch publishes to the right cmnd/<topic>/... path.
  // Users can rename the device in Sowel UI afterwards.
  const deviceName: string = topic;

  const caps = extractCapabilities(s0);

  const data: DiscoveredDevice["data"] = [];
  const orders: DiscoveredDevice["orders"] = [];

  // Expose each relay NOT consumed by a shutter
  for (let i = 1; i <= caps.relayCount; i++) {
    if (caps.shutterRelays.has(i)) continue;
    const key = `power${i}`;
    data.push({
      key,
      type: "enum",
      category: "light_state",
      enumValues: ["ON", "OFF"],
    });
    orders.push({
      key,
      type: "enum",
      category: "light_toggle",
      enumValues: ["ON", "OFF"],
    });
  }

  // Expose shutters (position + move)
  for (const n of caps.shutters) {
    const posKey = caps.shutters.length === 1 ? "shutter_position" : `shutter${n}_position`;
    const stateKey = caps.shutters.length === 1 ? "shutter_state" : `shutter${n}_state`;
    data.push({
      key: posKey,
      type: "number",
      category: "shutter_position",
      unit: "%",
    });
    orders.push({
      key: stateKey,
      type: "enum",
      category: "shutter_move",
      enumValues: ["OPEN", "CLOSE", "STOP"],
    });
    orders.push({
      key: posKey,
      type: "number",
      category: "set_shutter_position",
      min: 0,
      max: 100,
      unit: "%",
    });
  }

  return {
    friendlyName: deviceName,
    manufacturer: "Tasmota",
    model: typeof statusObj.Module === "number" ? `Module ${statusObj.Module}` : "Tasmota",
    data,
    orders,
    rawExpose: s0,
  };
}

/**
 * Parse a STATE / STATUS 11 / RESULT message into a flat data payload.
 * Returns a record of { dataKey: value } ready for deviceManager.updateDeviceData.
 *
 * Shapes handled:
 *  - STATE: { POWER1: "ON", POWER2: "OFF", Shutter1: { Position: 50, ... }, ... }
 *  - RESULT after POWER toggle: { POWER1: "ON" } or { POWER: "ON" } (single-relay devices)
 *  - RESULT after shutter command: { Shutter1: { Position: 100 } }
 *  - STATUS11: { StatusSTS: { POWER1: "ON", Shutter1: { ... } } }
 */
export function parseStatePayload(
  payload: unknown,
  caps?: TasmotaCapabilities,
): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};

  // Unwrap STATUS11 (StatusSTS) or STATUS10 (StatusSNS) envelopes
  const root = payload as Record<string, unknown>;
  const obj = (root.StatusSTS as Record<string, unknown> | undefined)
    ?? (root.StatusSNS as Record<string, unknown> | undefined)
    ?? root;

  const result: Record<string, unknown> = {};
  const shutterCount = caps?.shutters.length ?? 0;

  for (const [key, value] of Object.entries(obj)) {
    // POWERn or POWER (single relay)
    const powerMatch = /^POWER(\d*)$/.exec(key);
    if (powerMatch) {
      const n = powerMatch[1] === "" ? 1 : parseInt(powerMatch[1], 10);
      if (caps?.shutterRelays.has(n)) continue; // skip shutter-absorbed relays
      result[`power${n}`] = value;
      continue;
    }

    // Shutter1, Shutter2, ...
    const shutterMatch = /^Shutter(\d+)$/.exec(key);
    if (shutterMatch && value && typeof value === "object") {
      const n = parseInt(shutterMatch[1], 10);
      const sht = value as Record<string, unknown>;
      if (typeof sht.Position === "number") {
        const posKey = shutterCount <= 1 ? "shutter_position" : `shutter${n}_position`;
        result[posKey] = sht.Position;
      }
      continue;
    }
  }

  return result;
}
