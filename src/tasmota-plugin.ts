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
    this.mqtt.subscribe(`${this.baseTopic}/stat/+/STATUS0`, (topic, payload) =>
      this.onStatus0(topic, payload),
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

  private onStatus0(topic: string, payload: Buffer): void {
    try {
      const deviceTopic = this.deviceFromTopic(topic, ["stat", "STATUS0"]);
      if (!deviceTopic) return;
      const data = parseJson(payload);
      if (!data || typeof data !== "object") return;

      const discovered = buildDiscoveredDevice(data);
      if (!discovered) {
        this.logger.warn({ device: deviceTopic }, "Could not build DiscoveredDevice from STATUS 0");
        return;
      }

      // Patch sourceDeviceId on discovery: use the Tasmota topic as stable ID.
      const withSourceId = { ...discovered, ieeeAddress: deviceTopic };

      this.capabilities.set(deviceTopic, extractCapabilities(data as Record<string, unknown>));
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
    } catch (err) {
      this.logger.error({ err, topic } as Record<string, unknown>, "STATUS0 handler error");
    }
  }

  private onStatus11(topic: string, payload: Buffer): void {
    try {
      const deviceTopic = this.deviceFromTopic(topic, ["stat", "STATUS11"]);
      if (!deviceTopic) return;
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
    if (!data) return;

    // If we don't know this device yet, request STATUS 0 to discover it.
    if (!this.capabilities.has(deviceTopic)) {
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
}

// Re-export for the tests / external use
export type { DiscoveredDevice };
