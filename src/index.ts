/**
 * Sowel Plugin: Tasmota
 *
 * Auto-discovers Tasmota-flashed devices (Sonoff, ESP-based) via MQTT.
 * Exposes relays (POWERn) and shutters (Shuttern position + move).
 */

import { MqttConnector } from "./mqtt-connector.js";
import { TasmotaEngine } from "./tasmota-plugin.js";
import type { DeviceManager, EventBus, Logger } from "./tasmota-plugin.js";

interface SettingsManager {
  get(key: string): string | undefined;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(
    device: Device,
    orderKeyOrDispatchConfig: string | Record<string, unknown>,
    value: unknown,
  ): Promise<void>;
  refresh?(): Promise<void>;
  getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

const INTEGRATION_ID = "tasmota";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;

class TasmotaPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Tasmota";
  readonly description = "Tasmota-flashed devices (Sonoff, etc.) via MQTT";
  readonly icon = "Power";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private mqtt: MqttConnector | null = null;
  private engine: TasmotaEngine | null = null;
  private status: IntegrationStatus = "disconnected";

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.mqtt && !this.mqtt.isConnected()) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return this.getSetting("mqtt_url") !== undefined;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      {
        key: "mqtt_url",
        label: "MQTT Broker URL",
        type: "text",
        required: true,
        placeholder: "mqtt://localhost:1883",
      },
      { key: "mqtt_username", label: "MQTT Username", type: "text", required: false },
      { key: "mqtt_password", label: "MQTT Password", type: "password", required: false },
      {
        key: "mqtt_client_id",
        label: "MQTT Client ID",
        type: "text",
        required: false,
        defaultValue: "sowel-tasmota",
      },
      {
        key: "base_topic",
        label: "Tasmota Base Topic",
        type: "text",
        required: false,
        defaultValue: "tasmota",
      },
    ];
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) {
      this.status = "not_configured";
      return;
    }

    const mqttUrl = this.getSetting("mqtt_url")!;
    const mqttUsername = this.getSetting("mqtt_username") || undefined;
    const mqttPassword = this.getSetting("mqtt_password") || undefined;
    const mqttClientId = this.getSetting("mqtt_client_id") ?? "sowel-tasmota";
    const baseTopic = this.getSetting("base_topic") ?? "tasmota";

    try {
      this.mqtt = new MqttConnector(
        mqttUrl,
        { username: mqttUsername, password: mqttPassword, clientId: mqttClientId },
        this.eventBus,
        this.logger,
        INTEGRATION_ID,
      );
      await this.mqtt.connect();

      this.engine = new TasmotaEngine(
        INTEGRATION_ID,
        baseTopic,
        this.mqtt,
        this.deviceManager,
        this.logger,
      );
      this.engine.start();

      this.status = this.mqtt.isConnected() ? "connected" : "disconnected";
      if (this.status === "connected") {
        this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
      }
      this.logger.info("Tasmota plugin started");
    } catch (err) {
      this.status = "error";
      this.logger.error({ err } as Record<string, unknown>, "Failed to start Tasmota plugin");
    }
  }

  async stop(): Promise<void> {
    if (this.mqtt) {
      await this.mqtt.disconnect();
      this.mqtt = null;
      this.engine = null;
      this.status = "disconnected";
      this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
      this.logger.info("Tasmota plugin stopped");
    }
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    if (!this.engine || !this.mqtt?.isConnected()) {
      throw new Error("Tasmota plugin not connected");
    }
    this.engine.executeOrder(device, orderKey, value);
  }

  private getSetting(key: string): string | undefined {
    return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`);
  }
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new TasmotaPlugin(deps);
}
