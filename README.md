# Homebridge Growatt System

Homebridge plugin for Growatt OpenAPI solar plants and inverter metrics.

This project started as a fork/rewrite of `homebridge-growatt-inversor`, with a focus on stable HomeKit accessories, cleaner service names, and safer Growatt API usage.

## Current HomeKit Model

Each Growatt device is exposed as one HomeKit accessory.

Default services:

- `Producing`: switch showing whether the inverter is currently producing.
- `Power Now`: current power in W, exposed through HomeKit's light sensor numeric characteristic.
- `Energy Today`: daily energy in kWh, exposed through HomeKit's light sensor numeric characteristic.
- `Energy Total`: lifetime energy in kWh, exposed through HomeKit's light sensor numeric characteristic.
- `API Online`: contact sensor showing whether the last API update succeeded.

Optional services:

- `Energy Month`
- `Energy Year`

HomeKit does not provide first-class solar energy characteristics for every metric, so numeric energy and power values are exposed with `LightSensor` services for compatibility.

## Configuration

```json
{
  "platform": "GrowattSystem",
  "name": "Growatt Solar",
  "token": "YOUR_GROWATT_OPENAPI_TOKEN",
  "refreshInterval": 10,
  "showMonthlyEnergy": false,
  "showYearlyEnergy": false,
  "debugApi": false
}
```

## Development Notes

- Accessory identity uses `plantId-deviceSN`.
- If a plant has multiple devices, accessory names include device type and a serial suffix to avoid duplicate names in HomeKit.
- Cached accessory keys and active discovery keys use the same format.
- Refresh interval has a 5 minute minimum.
- `error_frequently_access` pauses updates until the next interval.
- Service names avoid parentheses and symbols that HomeKit rejects.

## Install From Local Folder

From the Homebridge environment:

```bash
npm install /path/to/homebridge-growatt-system
```

Then add a `GrowattSystem` platform entry in Homebridge config.
