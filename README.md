# Sowel Plugin — Tasmota

Auto-discovers [Tasmota](https://tasmota.github.io/)-flashed devices (Sonoff, ESP-based) via MQTT and exposes their relays and shutters to [Sowel](https://github.com/mchacher/sowel).

## Features

- **Auto-discovery** via MQTT LWT (`tele/<device>/LWT = Online`)
- **Relays** (`POWERn`) — exposed as generic on/off switches
- **Shutters** (`Shuttern`) — position 0-100% + open/close/stop
- **Offline detection** via LWT (`Offline`)
- Shutter-absorbed relays are NOT double-exposed

## Tasmota device requirements

1. Tasmota firmware installed (any recent version)
2. MQTT configured against the same broker Sowel uses
3. Default `FullTopic` pattern: `%prefix%/%topic%/` (`tasmota/cmnd/DEVICE/...`, `tasmota/tele/DEVICE/...`, `tasmota/stat/DEVICE/...`)
4. Unique `Topic` per device (e.g. `SONOFF_4CH_PRO_PISCINE`, `SONOFF_MINI_RADIATEUR_SDB`)

No additional Tasmota configuration is required (no `SetOption19`, no HA discovery).

## Settings

| Key              | Required | Default            | Description                   |
| ---------------- | :------: | ------------------ | ----------------------------- |
| `mqtt_url`       |    ✓     | —                  | Broker URL (`mqtt://host:port`) |
| `mqtt_username`  |          | —                  | Broker auth username          |
| `mqtt_password`  |          | —                  | Broker auth password          |
| `mqtt_client_id` |          | `sowel-tasmota`    | MQTT client ID                |
| `base_topic`     |          | `tasmota`          | Tasmota MQTT prefix           |

## How it works

On startup:

1. Subscribes to `<base>/tele/+/LWT`, `<base>/tele/+/STATE`, `<base>/stat/+/RESULT`, `<base>/stat/+/STATUS0/11`
2. When a device publishes `Online` (LWT), plugin sends `STATUS 0` + `STATUS 11` to learn its capabilities
3. Parses the response to detect relays (from `FriendlyName`) and shutters (from `StatusSHT`)
4. Calls `deviceManager.upsertFromDiscovery` with the device definition
5. Updates device data on every `STATE` / `RESULT` message

When Sowel sends an order (e.g. turn on POWER3):

1. Plugin publishes `<base>/cmnd/<device>/POWER3` with payload `ON`
2. Tasmota acts and publishes the new state on `<base>/stat/<device>/RESULT`
3. Plugin receives that and calls `deviceManager.updateDeviceData`

## Order keys

| Order key            | Type   | Values               | Effect                              |
| -------------------- | ------ | -------------------- | ----------------------------------- |
| `powerN`             | enum   | `ON`, `OFF`          | Toggle relay N                      |
| `shutter_state`      | enum   | `OPEN`, `CLOSE`, `STOP` | Shutter action (1-shutter devices) |
| `shutter_position`   | number | 0–100                | Shutter target position in %        |
| `shutterN_state`     | enum   | `OPEN`, `CLOSE`, `STOP` | Shutter N action (multi-shutter)   |
| `shutterN_position`  | number | 0–100                | Shutter N target position in %      |

## Development

```bash
npm install
npm run build
npm test
```

## License

AGPL-3.0
