const axios = require('axios');

const PLUGIN_NAME = 'homebridge-growatt-system';
const PLATFORM_NAME = 'GrowattSystem';
const API_BASE_URL = 'https://openapi.growatt.com/v1';
const LIGHT_SENSOR_MIN = 0.0001;
const RATE_LIMIT_MESSAGES = new Set(['error_frequently_access']);

let Service;
let Characteristic;
let PlatformAccessory;
let generateUUID;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  PlatformAccessory = homebridge.platformAccessory;
  generateUUID = homebridge.hap.uuid.generate;

  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GrowattSystemPlatform, false);
};

class GrowattApiClient {
  constructor(token, log, options = {}) {
    this.token = token;
    this.log = log;
    this.timeout = options.timeout || 15000;
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: this.timeout,
      headers: { token: this.token },
    });
  }

  async listPlants(deviceSN) {
    const params = deviceSN ? { device_id: deviceSN } : undefined;
    const data = await this.get('/plant/list', params);
    return data.data?.plants || [];
  }

  async listDevices(plantId) {
    const data = await this.get('/device/list', { plant_id: plantId });
    return data.data?.devices || [];
  }

  async getPlantData(plantId) {
    const data = await this.get('/plant/data', { plant_id: plantId }, { arrayResponse: true });
    const entry = Array.isArray(data) ? data[0] : data;

    if (!entry) {
      return {};
    }

    this.assertSuccess(entry);
    return entry.data || {};
  }

  async get(path, params, options = {}) {
    try {
      const response = await this.client.get(path, { params });
      const data = response.data;

      if (!options.arrayResponse) {
        this.assertSuccess(data);
      }

      return data;
    } catch (error) {
      throw normalizeApiError(error);
    }
  }

  assertSuccess(data) {
    if (!data || data.error_code === undefined || Number(data.error_code) === 0) {
      return;
    }

    const error = new Error(data.error_msg || `Growatt API error ${data.error_code}`);
    error.code = data.error_msg || String(data.error_code);
    error.apiResponse = data;
    throw error;
  }
}

class GrowattSystemPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    this.updateTimer = null;
    this.retryTimer = null;
    this.rateLimitedUntil = 0;
    this.isUpdating = false;

    this.token = this.config.token;
    this.refreshIntervalMinutes = Math.max(Number(this.config.refreshInterval || 15), 5);
    this.refreshInterval = this.refreshIntervalMinutes * 60 * 1000;
    this.showMonthlyEnergy = Boolean(this.config.showMonthlyEnergy);
    this.showYearlyEnergy = Boolean(this.config.showYearlyEnergy);
    this.debugApi = Boolean(this.config.debugApi);

    if (!this.token) {
      this.log.error('Growatt API token is not configured. Platform will not start.');
      return;
    }

    this.client = new GrowattApiClient(this.token, this.log);
    this.log.info('Growatt System platform starting.');

    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.log.info('Homebridge loaded. Starting Growatt discovery.');
        this.discover();
      });
    }
  }

  configureAccessory(accessory) {
    const key = this.accessoryKeyFromContext(accessory.context);

    if (!key) {
      this.log.warn(`Ignoring cached accessory without Growatt identifiers: ${accessory.displayName}`);
      return;
    }

    this.log.info(`Restoring cached Growatt accessory: ${accessory.displayName}`);
    this.accessories.set(key, accessory);
  }

  async discover() {
    this.log.info('Discovering Growatt plants and devices.');

    try {
      const activeKeys = new Set();
      const plants = await this.client.listPlants();

      this.log.info(`Growatt returned ${plants.length} plant(s).`);

      for (const plant of plants) {
        await this.discoverPlant(plant, activeKeys);
        await delay(500);
      }

      this.removeStaleAccessories(activeKeys);
      this.log.info(`Discovery finished. Monitoring ${this.accessories.size} accessory/accessories.`);
      this.startMonitoring();
    } catch (error) {
      this.handleApiError(error, 'discovery');
      this.scheduleDiscoveryRetry();
    }
  }

  async discoverPlant(plant, activeKeys) {
    const plantId = String(plant.plant_id);
    const plantName = cleanHomeKitName(plant.name || `Growatt ${plantId}`);

    try {
      const devices = await this.client.listDevices(plantId);

      if (!devices.length) {
        this.log.warn(`No devices found for plant "${plantName}".`);
        return;
      }

      this.log.info(`Plant "${plantName}" has ${devices.length} device(s).`);

      for (const device of devices) {
        const deviceSN = device.device_sn || device.serial_num || device.sn;

        if (!deviceSN) {
          this.log.warn(`Skipping a device without serial number in plant "${plantName}".`);
          continue;
        }

        const deviceType = device.type || device.device_type || 'Growatt device';
        const accessoryName = makeAccessoryName(plantName, deviceType, String(deviceSN), devices.length);
        const key = makeAccessoryKey(plantId, deviceSN);
        activeKeys.add(key);
        this.log.info(`Discovered Growatt device "${accessoryName}" (${deviceType}, SN ${deviceSN}).`);
        this.createOrUpdateAccessory({
          key,
          plantId,
          plantName,
          accessoryName,
          deviceSN: String(deviceSN),
          deviceType,
          manufacturer: device.manufacturer || 'Growatt',
        });
      }
    } catch (error) {
      this.handleApiError(error, `device discovery for "${plantName}"`);
    }
  }

  createOrUpdateAccessory(device) {
    const uuid = generateUUID(`${PLUGIN_NAME}-${device.key}`);
    let accessory = this.accessories.get(device.key);

    if (!accessory) {
      this.log.info(`Adding Growatt accessory "${device.accessoryName}".`);
      accessory = new PlatformAccessory(device.accessoryName, uuid);
      this.accessories.set(device.key, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.log.info(`Updating Growatt accessory "${device.accessoryName}".`);
      accessory.displayName = device.accessoryName;
    }

    accessory.context.growattKey = device.key;
    accessory.context.plantId = device.plantId;
    accessory.context.plantName = device.plantName;
    accessory.context.accessoryName = device.accessoryName;
    accessory.context.deviceSN = device.deviceSN;
    accessory.context.deviceType = device.deviceType;
    accessory.context.manufacturer = device.manufacturer;
    accessory.context.isProducing = Boolean(accessory.context.isProducing);
    accessory.context.isOnline = accessory.context.isOnline !== false;

    this.setupServices(accessory);
  }

  removeStaleAccessories(activeKeys) {
    for (const [key, accessory] of this.accessories.entries()) {
      if (activeKeys.has(key)) {
        continue;
      }

      this.log.info(`Removing stale Growatt accessory "${accessory.displayName}" (${key}).`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(key);
    }
  }

  startMonitoring() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    this.updateAllAccessories();
    this.updateTimer = setInterval(() => this.updateAllAccessories(), this.refreshInterval);
    this.log.info(`Monitoring started. Refresh interval: ${this.refreshIntervalMinutes} minute(s).`);
  }

  async updateAllAccessories() {
    if (this.isUpdating) {
      this.log.debug('Skipping update because the previous update is still running.');
      return;
    }

    if (Date.now() < this.rateLimitedUntil) {
      const waitSeconds = Math.ceil((this.rateLimitedUntil - Date.now()) / 1000);
      this.log.warn(`Growatt API rate limit is active. Next update in about ${waitSeconds}s.`);
      return;
    }

    this.isUpdating = true;
    this.log.info(`Updating ${this.accessories.size} Growatt accessory/accessories.`);

    const updateCache = {
      plantDataByPlantId: new Map(),
      plantInfoByPlantId: new Map(),
    };

    try {
      for (const [key, accessory] of this.accessories.entries()) {
        await this.updateAccessory(key, accessory, updateCache);

        if (Date.now() < this.rateLimitedUntil) {
          break;
        }

        await delay(750);
      }
    } finally {
      this.isUpdating = false;
    }
  }

  async updateAccessory(key, accessory, updateCache = {}) {
    const plantId = accessory.context.plantId;
    const deviceSN = accessory.context.deviceSN;

    if (!plantId || !deviceSN) {
      this.log.warn(`Accessory "${accessory.displayName}" is missing plantId or deviceSN.`);
      this.setAccessoryOffline(accessory);
      return;
    }

    try {
      const plantInfo = await this.getCachedPlantInfo(plantId, deviceSN, updateCache);
      const plantData = await this.getCachedPlantData(plantId, updateCache);

      const metrics = {
        currentPower: toNumber(plantInfo.current_power),
        todayEnergy: toNumber(plantData.today_energy),
        monthlyEnergy: toNumber(plantData.monthly_energy),
        yearlyEnergy: toNumber(plantData.yearly_energy),
        totalEnergy: toNumber(plantData.total_energy),
      };

      const isProducing = metrics.currentPower > 1;
      accessory.context.isProducing = isProducing;
      accessory.context.isOnline = true;
      accessory.context.lastUpdate = new Date().toISOString();

      this.updateMetric(accessory, 'current_power', metrics.currentPower);
      this.updateMetric(accessory, 'today_energy', metrics.todayEnergy);
      this.updateMetric(accessory, 'total_energy', metrics.totalEnergy);

      if (this.showMonthlyEnergy) {
        this.updateMetric(accessory, 'monthly_energy', metrics.monthlyEnergy);
      }

      if (this.showYearlyEnergy) {
        this.updateMetric(accessory, 'yearly_energy', metrics.yearlyEnergy);
      }

      accessory.getServiceById(Service.Switch, 'production_status')
        ?.updateCharacteristic(Characteristic.On, isProducing);
      accessory.getServiceById(Service.ContactSensor, 'api_status')
        ?.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);

      this.log.info(
        `${accessory.displayName}: ${metrics.currentPower.toFixed(1)} W, ` +
        `today ${metrics.todayEnergy.toFixed(2)} kWh, total ${metrics.totalEnergy.toFixed(2)} kWh, ` +
        `${isProducing ? 'producing' : 'idle'}`
      );
    } catch (error) {
      const rateLimited = this.handleApiError(error, `update for "${accessory.displayName}"`);

      if (rateLimited) {
        return;
      }

      this.setAccessoryOffline(accessory);
    }
  }

  async getCachedPlantInfo(plantId, deviceSN, updateCache) {
    const cache = updateCache.plantInfoByPlantId;

    if (cache?.has(plantId)) {
      return cache.get(plantId);
    }

    const plants = await this.client.listPlants(deviceSN);
    const plantInfo = plants.find((plant) => String(plant.plant_id) === String(plantId)) || plants[0] || {};

    cache?.set(plantId, plantInfo);
    return plantInfo;
  }

  async getCachedPlantData(plantId, updateCache) {
    const cache = updateCache.plantDataByPlantId;

    if (cache?.has(plantId)) {
      return cache.get(plantId);
    }

    const plantData = await this.client.getPlantData(plantId);

    cache?.set(plantId, plantData);
    return plantData;
  }

  setupServices(accessory) {
    const serial = accessory.context.deviceSN || accessory.context.plantId;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, accessory.context.manufacturer || 'Growatt')
      .setCharacteristic(Characteristic.Model, accessory.context.deviceType || 'Solar inverter')
      .setCharacteristic(Characteristic.SerialNumber, serial)
      .setCharacteristic(Characteristic.FirmwareRevision, '0.1.0');

    this.getOrCreateService(accessory, Service.Switch, 'Producing', 'production_status')
      .getCharacteristic(Characteristic.On)
      .onGet(() => Boolean(accessory.context.isProducing));

    this.getOrCreateService(accessory, Service.LightSensor, 'Power Now', 'current_power');
    this.getOrCreateService(accessory, Service.LightSensor, 'Energy Today', 'today_energy');
    this.getOrCreateService(accessory, Service.LightSensor, 'Energy Total', 'total_energy');

    if (this.showMonthlyEnergy) {
      this.getOrCreateService(accessory, Service.LightSensor, 'Energy Month', 'monthly_energy');
    }

    if (this.showYearlyEnergy) {
      this.getOrCreateService(accessory, Service.LightSensor, 'Energy Year', 'yearly_energy');
    }

    this.getOrCreateService(accessory, Service.ContactSensor, 'API Online', 'api_status')
      .getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => accessory.context.isOnline === false
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED);
  }

  getOrCreateService(accessory, serviceType, displayName, subtype) {
    let service = accessory.getServiceById(serviceType, subtype);

    if (!service) {
      service = accessory.addService(serviceType, displayName, subtype);
    }

    service.setCharacteristic(Characteristic.Name, displayName);
    return service;
  }

  updateMetric(accessory, subtype, value) {
    const safeValue = value > 0 ? value : LIGHT_SENSOR_MIN;
    accessory.getServiceById(Service.LightSensor, subtype)
      ?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, safeValue);
  }

  setAccessoryOffline(accessory) {
    accessory.context.isOnline = false;
    accessory.context.isProducing = false;
    accessory.getServiceById(Service.Switch, 'production_status')
      ?.updateCharacteristic(Characteristic.On, false);
    accessory.getServiceById(Service.ContactSensor, 'api_status')
      ?.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    this.updateMetric(accessory, 'current_power', 0);
  }

  handleApiError(error, context) {
    const message = error.code || error.message || 'unknown error';

    if (RATE_LIMIT_MESSAGES.has(message)) {
      this.rateLimitedUntil = Date.now() + Math.max(this.refreshInterval, 5 * 60 * 1000);
      this.log.warn(`Growatt API rate limit during ${context}. Pausing requests until next interval.`);
      return true;
    }

    if (this.debugApi && error.apiResponse) {
      this.log.debug(`Growatt API response during ${context}: ${JSON.stringify(error.apiResponse)}`);
    }

    this.log.warn(`Growatt ${context} failed: ${message}`);
    return false;
  }

  scheduleDiscoveryRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }

    this.retryTimer = setTimeout(() => this.discover(), 5 * 60 * 1000);
    this.log.warn('Discovery retry scheduled in 5 minutes.');
  }

  accessoryKeyFromContext(context = {}) {
    if (context.growattKey) {
      return context.growattKey;
    }

    if (context.plantId && context.deviceSN) {
      return makeAccessoryKey(context.plantId, context.deviceSN);
    }

    return null;
  }
}

function makeAccessoryKey(plantId, deviceSN) {
  return `${plantId}-${deviceSN}`;
}

function makeAccessoryName(plantName, deviceType, deviceSN, deviceCount) {
  if (deviceCount <= 1) {
    return plantName;
  }

  const serialSuffix = String(deviceSN).slice(-4);
  const suffix = cleanHomeKitName(`${cleanDeviceTypeName(deviceType)} ${serialSuffix}`);
  const maxPlantNameLength = Math.max(1, 64 - suffix.length - 3);
  const baseName = plantName.length > maxPlantNameLength
    ? plantName.slice(0, maxPlantNameLength).trim()
    : plantName;

  return cleanHomeKitName(`${baseName} - ${suffix}`);
}

function cleanDeviceTypeName(deviceType) {
  const name = cleanHomeKitName(deviceType);

  if (!name || name.length < 3 || /^\d+$/.test(name)) {
    return 'Device';
  }

  return name;
}

function cleanHomeKitName(name) {
  return String(name)
    .replace(/[^\w '.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64) || 'Growatt';
}

function toNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeApiError(error) {
  if (error.response?.data) {
    const data = error.response.data;
    const normalized = new Error(data.error_msg || error.message);
    normalized.code = data.error_msg || String(data.error_code || error.code || 'api_error');
    normalized.apiResponse = data;
    return normalized;
  }

  return error;
}
