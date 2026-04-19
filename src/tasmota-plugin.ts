/**
 * Tasmota plugin — auto-discovers Tasmota devices via MQTT LWT
 * and exposes relays + shutters to Sowel.
 */

import { MqttConnector } from "./mqtt-connector.js";
import {
  buildDiscoveredDevice,
  extractCapabilities,
  parseJson,
  parseStatePayload,
  type DiscoveredDevice,
  type TasmotaCapabilities,
} from "./tasmota-parser.js";

// ============================================================
// Local type definitions (no imports from Sowel source)
// ============================================================

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface EventBus {
  emit(event: unknown): void;
}

export interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: unknown): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
  ): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

export class TasmotaEngine {
  private readonly integrationId: string;
  private readonly baseTopic: string;
  private readonly mqtt: MqttConnector;
  private readonly deviceManager: DeviceManager;
  private readonly logger: Logger;
  private readonly capabilities = new Map<string, TasmotaCapabilities>();
  /** Timestamp (ms) of the last STATUS 0 request per device (backoff). */
  private readonly lastDiscoveryRequest = new Map<string, number>();
  private static readonly DISCOVERY_BACKOFF_MS = 30_000;
  /**
   * Buffer for STATUS 0 responses which Tasmota splits across multiple topics:
   *   stat/<device>/STATUS    → { Status: {...} }       (core info)
   *   stat/<device>/STATUS13  → { StatusSHT: {...} }    (shutter config, if any)
   * We merge them and emit a single DiscoveredDevice after a short idle period.
   */
  private readonly pendingDiscovery = new Map<
    string,
    { payload: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }
  >();
  private static readonly DISCOVERY_BUFFER_MS = 800;

  constructor(
    integrationId: string,
    baseTopic: string,
    mqtt: MqttConnector,
    deviceManager: DeviceManager,
    logger: Logger,
  ) {
    this.integrationId = integrationId;
    this.baseTopic = baseTopic;
    this.mqtt = mqtt;
    this.deviceManager = deviceManager;
    this.logger = logger;
  }

  start(): void {
    this.mqtt.subscribe(`${this.baseTopic}/tele/+/LWT`, (topic, payload) =>
      this.onLwt(topic, payload),
    );
    this.mqtt.subscribe(`${this.baseTopic}/tele/+/STATE`, (topic, payload) =>
      this.onState(topic, payload),
    );
    this.mqtt.subscribe(`${this.baseTopic}/stat/+/RESULT`, (topic, payload) =>
      this.onState(topic, payload),
    );
    // Tasmota response to `Status 0` comes as multiple messages:
    //  stat/<device>/STATUS    → { Status: {...} }     — core info (Topic, FriendlyName, Module)
    //  stat/<device>/STATUS10  → { StatusSNS: {...} }  — sensors + shutter position
    //  stat/<device>/STATUS11  → { StatusSTS: {...} }  — current state (POWER)
    //  stat/<device>/STATUS13  → { StatusSHT: {...} }  — shutter config (if shutters exist)
    // We buffer STATUS + STATUS13 for full device discovery (need both).
    this.mqtt.subscribe(`${this.baseTopic}/stat/+/STATUS`, (topic, payload) =>
      this.onDiscoveryMessage(topic, payload),
    );
    this.mqtt.subscribe(`${this.baseTopic}/stat/+/STATUS13`, (topic, payload) =>
      this.onDiscoveryMessage(topic, payload),
    );
    this.mqtt.subscribe(`${this.baseTopic}/stat/+/STATUS10`, (topic, payload) =>
      this.onStatus11(topic, payload),
    );
    this.mqtt.subscribe(`${this.baseTopic}/stat/+/STATUS11`, (topic, payload) =>
      this.onStatus11(topic, payload),
    );
    this.logger.info({ baseTopic: this.baseTopic }, "Tasmota subscriptions installed");
  }

  executeOrder(device: Device, orderKey: string, value: unknown): void {
    const deviceTopic = device.sourceDeviceId;
    const powerMatch = /^power(\d+)$/.exec(orderKey);
    if (powerMatch) {
      const n = parseInt(powerMatch[1], 10);
      const payload = String(value).toUpperCase();
      this.mqtt.publish(`${this.baseTopic}/cmnd/${deviceTopic}/POWER${n}`, payload);
      return;
    }

    const shutterStateMatch = /^shutter(\d*)_state$/.exec(orderKey);
    if (shutterStateMatch) {
      const n = shutterStateMatch[1] === "" ? 1 : parseInt(shutterStateMatch[1], 10);
      const str = String(value).toUpperCase();
      const cmd = str === "OPEN" ? "ShutterOpen" : str === "CLOSE" ? "ShutterClose" : "ShutterStop";
      this.mqtt.publish(`${this.baseTopic}/cmnd/${deviceTopic}/${cmd}${n}`, "");
      return;
    }

    const shutterPosMatch = /^shutter(\d*)_position$/.exec(orderKey);
    if (shutterPosMatch) {
      const n = shutterPosMatch[1] === "" ? 1 : parseInt(shutterPosMatch[1], 10);
      this.mqtt.publish(`${this.baseTopic}/cmnd/${deviceTopic}/ShutterPosition${n}`, String(value));
      return;
    }

    this.logger.warn({ orderKey, deviceId: device.id }, "Unknown Tasmota order key");
  }

  // ── Handlers ──────────────────────────────────────────────

  private deviceFromTopic(topic: string, expectedSegments: string[]): string | null {
    const parts = topic.split("/");
    if (parts.length !== 4) return null;
    if (parts[0] !== this.baseTopic) return null;
    if (parts[1] !== expectedSegments[0]) return null;
    if (parts[3] !== expectedSegments[1] && !parts[3].startsWith(expectedSegments[1])) {
      return null;
    }
    return parts[2];
  }

  private onLwt(topic: string, payload: Buffer): void {
    try {
      const deviceTopic = this.deviceFromTopic(topic, ["tele", "LWT"]);
      if (!deviceTopic) return;
      const value = payload.toString("utf-8").trim();

      if (value === "Online") {
        // Skip STATUS request if we already know the device (capabilities cached).
        // Otherwise Tasmota devices that disconnect/reconnect frequently (flaky ones)
        // would trigger a STATUS request every time, spamming the broker.
        if (this.capabilities.has(deviceTopic)) {
          this.logger.debug({ device: deviceTopic }, "Tasmota device back online (already known)");
          this.deviceManager.updateDeviceStatus(this.integrationId, deviceTopic, "online");
          return;
        }
        this.logger.info({ device: deviceTopic }, "Tasmota device online — requesting STATUS");
        this.mqtt.publish(`${this.baseTopic}/cmnd/${deviceTopic}/STATUS`, "0");
        this.mqtt.publish(`${this.baseTopic}/cmnd/${deviceTopic}/STATUS`, "11");
      } else if (value === "Offline") {
        this.deviceManager.updateDeviceStatus(this.integrationId, deviceTopic, "offline");
      }
    } catch (err) {
      this.logger.error({ err, topic } as Record<string, unknown>, "LWT handler error");
    }
  }

  /**
   * Accumulate STATUS + STATUS13 messages (and any future STATUS<N> used for discovery)
   * and emit a single processStatus0 call once messages settle.
   */
  private onDiscoveryMessage(topic: string, payload: Buffer): void {
    try {
      const parts = topic.split("/");
      if (parts.length !== 4 || parts[0] !== this.baseTopic || parts[1] !== "stat") return;
      const deviceTopic = parts[2];
      const data = parseJson(payload);
      if (!data || typeof data !== "object") return;

      let pending = this.pendingDiscovery.get(deviceTopic);
      if (pending) {
        clearTimeout(pending.timer);
      } else {
        pending = { payload: {}, timer: null as never };
      }
      Object.assign(pending.payload, data as Record<string, unknown>);
      pending.timer = setTimeout(() => {
        const finalPayload = this.pendingDiscovery.get(deviceTopic)?.payload;
        this.pendingDiscovery.delete(deviceTopic);
        if (finalPayload) this.processStatus0(deviceTopic, finalPayload);
      }, TasmotaEngine.DISCOVERY_BUFFER_MS);
      this.pendingDiscovery.set(deviceTopic, pending);
    } catch (err) {
      this.logger.error({ err, topic } as Record<string, unknown>, "Discovery handler error");
    }
  }

  private onStatus11(topic: string, payload: Buffer): void {
    try {
      const parts = topic.split("/");
      if (parts.length !== 4 || parts[0] !== this.baseTopic || parts[1] !== "stat") return;
      const deviceTopic = parts[2];
      this.applyStateUpdate(deviceTopic, payload);
    } catch (err) {
      this.logger.error({ err, topic } as Record<string, unknown>, "STATUS11 handler error");
    }
  }

  private onState(topic: string, payload: Buffer): void {
    try {
      const parts = topic.split("/");
      if (parts.length !== 4 || parts[0] !== this.baseTopic) return;
      const deviceTopic = parts[2];
      this.applyStateUpdate(deviceTopic, payload);
    } catch (err) {
      this.logger.error({ err, topic } as Record<string, unknown>, "STATE handler error");
    }
  }

  private applyStateUpdate(deviceTopic: string, payload: Buffer): void {
    const data = parseJson(payload);
    if (!data || typeof data !== "object") return;

    // Some Tasmota configurations publish the STATUS 0 response on stat/<device>/RESULT
    // (when SetOption4=1) instead of stat/<device>/STATUS0. Detect the envelope by shape
    // and treat it as a discovery response.
    const dataObj = data as Record<string, unknown>;
    const statusEnvelope = dataObj.Status;
    if (
      statusEnvelope &&
      typeof statusEnvelope === "object" &&
      (statusEnvelope as Record<string, unknown>).Topic
    ) {
      this.processStatus0(deviceTopic, dataObj);
      return;
    }

    // If we don't know this device yet, request STATUS 0 to discover it.
    if (!this.capabilities.has(deviceTopic)) {
      const now = Date.now();
      const lastReq = this.lastDiscoveryRequest.get(deviceTopic) ?? 0;
      if (now - lastReq < TasmotaEngine.DISCOVERY_BACKOFF_MS) {
        return;
      }
      this.lastDiscoveryRequest.set(deviceTopic, now);
      this.logger.debug(
        { device: deviceTopic },
        "State received for unknown device — requesting STATUS 0",
      );
      this.mqtt.publish(`${this.baseTopic}/cmnd/${deviceTopic}/STATUS`, "0");
      return;
    }

    const caps = this.capabilities.get(deviceTopic);
    const parsed = parseStatePayload(data, caps);
    if (Object.keys(parsed).length === 0) return;

    this.deviceManager.updateDeviceData(this.integrationId, deviceTopic, parsed);
  }

  private processStatus0(deviceTopic: string, data: Record<string, unknown>): void {
    if (this.capabilities.has(deviceTopic)) return; // already discovered
    const discovered = buildDiscoveredDevice(data);
    if (!discovered) {
      this.logger.warn({ device: deviceTopic }, "Could not build DiscoveredDevice from STATUS 0");
      return;
    }
    const withSourceId = { ...discovered, ieeeAddress: deviceTopic };
    this.capabilities.set(deviceTopic, extractCapabilities(data));
    this.deviceManager.upsertFromDiscovery(this.integrationId, this.integrationId, withSourceId);
    this.deviceManager.updateDeviceStatus(this.integrationId, deviceTopic, "online");
    this.logger.info(
      {
        device: deviceTopic,
        relays: discovered.data.filter((d) => d.key.startsWith("power")).length,
        shutters: discovered.data.filter((d) => d.key.includes("shutter")).length,
      },
      "Tasmota device discovered",
    );
  }
}

// Re-export for the tests / external use
export type { DiscoveredDevice };
