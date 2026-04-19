import { describe, it, expect } from "vitest";
import {
  buildDiscoveredDevice,
  extractCapabilities,
  parseJson,
  parseStatePayload,
} from "./tasmota-parser.js";

// ============================================================
// Sample STATUS 0 responses
// ============================================================

const STATUS0_MINI = {
  Status: {
    Module: 1,
    DeviceName: "SONOFF_MINI_RADIATEUR_SDB",
    FriendlyName: ["Radiateur SDB"],
    Topic: "SONOFF_MINI_RADIATEUR_SDB",
    Power: 0,
  },
};

const STATUS0_4CH_NO_SHUTTER = {
  Status: {
    Module: 23,
    DeviceName: "SONOFF_4CH",
    FriendlyName: ["R1", "R2", "R3", "R4"],
    Topic: "SONOFF_4CH",
    Power: 0,
  },
};

const STATUS0_4CH_WITH_SHUTTER = {
  Status: {
    Module: 23,
    DeviceName: "SONOFF_4CH_PRO_PISCINE",
    FriendlyName: ["Volet_R1", "Volet_R2", "Pompe", "Spot"],
    Topic: "SONOFF_4CH_PRO_PISCINE",
    Power: 0,
  },
  StatusSHT: {
    SHT1: { Relay1: 1, Relay2: 2, Position: 50, Direction: 0 },
  },
};

// ============================================================
// extractCapabilities
// ============================================================

describe("extractCapabilities", () => {
  it("detects single relay, no shutter", () => {
    const caps = extractCapabilities(STATUS0_MINI);
    expect(caps.relayCount).toBe(1);
    expect(caps.shutterRelays.size).toBe(0);
    expect(caps.shutters).toEqual([]);
  });

  it("detects 4 relays, no shutter", () => {
    const caps = extractCapabilities(STATUS0_4CH_NO_SHUTTER);
    expect(caps.relayCount).toBe(4);
    expect(caps.shutterRelays.size).toBe(0);
    expect(caps.shutters).toEqual([]);
  });

  it("detects shutter absorbing relays 1+2", () => {
    const caps = extractCapabilities(STATUS0_4CH_WITH_SHUTTER);
    expect(caps.relayCount).toBe(4);
    expect([...caps.shutterRelays].sort()).toEqual([1, 2]);
    expect(caps.shutters).toEqual([1]);
  });
});

// ============================================================
// buildDiscoveredDevice
// ============================================================

describe("buildDiscoveredDevice", () => {
  it("builds device for Sonoff Mini (1 relay, no shutter)", () => {
    const dd = buildDiscoveredDevice(STATUS0_MINI);
    expect(dd).not.toBeNull();
    expect(dd!.friendlyName).toBe("Radiateur SDB");
    expect(dd!.data).toHaveLength(1);
    expect(dd!.data[0].key).toBe("power1");
    expect(dd!.orders).toHaveLength(1);
    expect(dd!.orders[0].key).toBe("power1");
    expect(dd!.orders[0].enumValues).toEqual(["ON", "OFF"]);
  });

  it("builds device for 4CH Pro (4 relays, no shutter)", () => {
    const dd = buildDiscoveredDevice(STATUS0_4CH_NO_SHUTTER);
    expect(dd).not.toBeNull();
    expect(dd!.data).toHaveLength(4);
    expect(dd!.data.map((d) => d.key)).toEqual(["power1", "power2", "power3", "power4"]);
    expect(dd!.orders).toHaveLength(4);
  });

  it("builds device for 4CH Pro with shutter (absorbs relays 1+2)", () => {
    const dd = buildDiscoveredDevice(STATUS0_4CH_WITH_SHUTTER);
    expect(dd).not.toBeNull();
    // data: only power3, power4, shutter_position (3 entries)
    expect(dd!.data).toHaveLength(3);
    const dataKeys = dd!.data.map((d) => d.key).sort();
    expect(dataKeys).toEqual(["power3", "power4", "shutter_position"]);
    // orders: power3, power4, shutter_state, shutter_position (4 entries)
    expect(dd!.orders).toHaveLength(4);
    const orderKeys = dd!.orders.map((o) => o.key).sort();
    expect(orderKeys).toEqual(["power3", "power4", "shutter_position", "shutter_state"]);

    // Shutter position has min/max + unit
    const posOrder = dd!.orders.find((o) => o.key === "shutter_position" && o.type === "number");
    expect(posOrder?.min).toBe(0);
    expect(posOrder?.max).toBe(100);
    expect(posOrder?.category).toBe("set_shutter_position");

    // Shutter state is enum
    const stateOrder = dd!.orders.find((o) => o.key === "shutter_state");
    expect(stateOrder?.enumValues).toEqual(["OPEN", "CLOSE", "STOP"]);
    expect(stateOrder?.category).toBe("shutter_move");
  });

  it("falls back to Topic when FriendlyName is missing", () => {
    const dd = buildDiscoveredDevice({
      Status: { Topic: "FALLBACK_TOPIC", Module: 1, Power: 0 },
    });
    expect(dd).not.toBeNull();
    expect(dd!.friendlyName).toBe("FALLBACK_TOPIC");
    expect(dd!.data).toHaveLength(0);
  });

  it("returns null when Topic is missing", () => {
    const dd = buildDiscoveredDevice({ Status: {} });
    expect(dd).toBeNull();
  });

  it("returns null for malformed payload", () => {
    expect(buildDiscoveredDevice(null)).toBeNull();
    expect(buildDiscoveredDevice(undefined)).toBeNull();
    expect(buildDiscoveredDevice("not an object")).toBeNull();
  });
});

// ============================================================
// parseStatePayload
// ============================================================

describe("parseStatePayload", () => {
  it("parses STATE with POWER1 and POWER2", () => {
    const result = parseStatePayload({ POWER1: "ON", POWER2: "OFF" });
    expect(result).toEqual({ power1: "ON", power2: "OFF" });
  });

  it("parses single-relay device using bare POWER key", () => {
    const result = parseStatePayload({ POWER: "ON" });
    expect(result).toEqual({ power1: "ON" });
  });

  it("parses Shutter1 position for single-shutter device", () => {
    const result = parseStatePayload(
      { Shutter1: { Position: 50, Direction: 0, Target: 50 } },
      { relayCount: 4, shutterRelays: new Set([1, 2]), shutters: [1] },
    );
    expect(result).toEqual({ shutter_position: 50 });
  });

  it("parses multi-shutter devices with indexed keys", () => {
    const result = parseStatePayload(
      {
        Shutter1: { Position: 20 },
        Shutter2: { Position: 80 },
      },
      { relayCount: 4, shutterRelays: new Set([1, 2, 3, 4]), shutters: [1, 2] },
    );
    expect(result).toEqual({ shutter1_position: 20, shutter2_position: 80 });
  });

  it("skips shutter-absorbed relays in POWER updates", () => {
    const result = parseStatePayload(
      { POWER1: "ON", POWER2: "OFF", POWER3: "ON", POWER4: "OFF" },
      { relayCount: 4, shutterRelays: new Set([1, 2]), shutters: [1] },
    );
    expect(result).toEqual({ power3: "ON", power4: "OFF" });
  });

  it("parses RESULT with single POWER toggle", () => {
    const result = parseStatePayload({ POWER3: "ON" });
    expect(result).toEqual({ power3: "ON" });
  });

  it("unwraps STATUS11 envelope", () => {
    const result = parseStatePayload({
      StatusSTS: { POWER1: "ON", Shutter1: { Position: 75 } },
    });
    expect(result).toEqual({ power1: "ON", shutter_position: 75 });
  });

  it("returns empty object for null/invalid input", () => {
    expect(parseStatePayload(null)).toEqual({});
    expect(parseStatePayload(undefined)).toEqual({});
    expect(parseStatePayload("string")).toEqual({});
  });
});

// ============================================================
// parseJson
// ============================================================

describe("parseJson", () => {
  it("parses valid JSON string", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses Buffer", () => {
    expect(parseJson(Buffer.from('{"x":true}'))).toEqual({ x: true });
  });

  it("returns null for invalid JSON", () => {
    expect(parseJson("not json")).toBeNull();
    expect(parseJson("{incomplete")).toBeNull();
  });
});
