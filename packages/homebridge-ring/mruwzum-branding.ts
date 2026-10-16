import type { PlatformAccessory } from 'homebridge'
import { hap } from './hap.ts'

// Accessory Information for the accessories this fork adds (the Intercom audio
// handset and its two-way-audio camera). The Ring hardware is Ring's, but these
// HomeKit accessories are built by this fork, so they carry its maker's name.
export const MANUFACTURER = 'mruwzum'

// HomeKit only accepts "x.y.z" in FirmwareRevision, so the package's pre-release
// suffix ("14.3.0-intercom.2") is dropped.
export const FIRMWARE = '14.3.0'

// Short, stable serial: MRZ-<kind>-<last 6 hex of the Ring device id>, upper case.
export function mruwzumSerial(
  kind: string,
  deviceId: string | number | undefined,
) {
  const tail = String(deviceId ?? '')
    .replace(/[^0-9a-z]/gi, '')
    .slice(-6)
    .toUpperCase()
  return `MRZ-${kind}-${tail || '000000'}`
}

export function brandAccessory(
  accessory: PlatformAccessory,
  model: string,
  serial: string,
) {
  const { Characteristic, Service } = hap,
    info =
      accessory.getService(Service.AccessoryInformation) ||
      accessory.addService(Service.AccessoryInformation)
  info
    .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
    .setCharacteristic(Characteristic.Model, model)
    .setCharacteristic(Characteristic.SerialNumber, serial)
    .setCharacteristic(Characteristic.FirmwareRevision, FIRMWARE)
}
