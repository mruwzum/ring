import type { RingIntercom } from 'ring-client-api'
import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import type { PlatformAccessory } from 'homebridge'
import { BaseDataAccessory } from './base-data-accessory.ts'
import { FIRMWARE, MANUFACTURER, mruwzumSerial } from './mruwzum-branding.ts'
import { logError, logInfo } from 'ring-client-api/util'
import { distinctUntilChanged, map, throttleTime } from 'rxjs/operators'
import { appendFile } from 'fs'
import { join } from 'path'

export class Intercom extends BaseDataAccessory<RingIntercom> {
  private unlocking = false
  private doNotDisturb = false
  private unlockTimeout?: ReturnType<typeof setTimeout>
  // HomeKit gets its SET answer before unlock() finishes, so a second tap could send a
  // second PUT while the first is still in flight: only one at a time (29 Oct 2026)
  private unlockInFlight = false

  public readonly device
  public readonly accessory
  public readonly config

  constructor(
    device: RingIntercom,
    accessory: PlatformAccessory,
    config: RingPlatformConfig,
  ) {
    super()

    this.device = device
    this.accessory = accessory
    this.config = config

    const { Characteristic, Service } = hap,
      lockService = this.getService(Service.LockMechanism),
      { LockCurrentState, LockTargetState, ProgrammableSwitchEvent } =
        Characteristic,
      programableSwitchService = this.getService(
        Service.StatelessProgrammableSwitch,
      ),
      onDoorbellPressed = device.onDing.pipe(
        throttleTime(15000),
        map(() => ProgrammableSwitchEvent.SINGLE_PRESS),
      ),
      syncLockState = () => {
        const state = this.getLockState()
        lockService
          .getCharacteristic(Characteristic.LockCurrentState)
          .updateValue(state)
        lockService
          .getCharacteristic(Characteristic.LockTargetState)
          .updateValue(state)
      },
      markAsUnlocked = () => {
        // Mark the lock as unlocked, wait 5 seconds, then mark it as locked again
        clearTimeout(this.unlockTimeout)
        this.unlocking = true

        // Update current state to reflect that the lock is unlocked
        syncLockState()

        // Leave the door in an "unlocked" state for 5 seconds
        // After that, set the lock back to "locked" for both current and target state
        this.unlockTimeout = setTimeout(() => {
          this.unlocking = false
          syncLockState()
        }, 5000)
      }

    // Subscribe to unlock events coming from push notifications, which will catch an unlock from the Ring app
    device.onUnlocked.subscribe(markAsUnlocked)

    // Lock Service
    this.registerCharacteristic({
      characteristicType: LockCurrentState,
      serviceType: lockService,
      getValue: () => this.getLockState(),
      requestUpdate: () => device.requestUpdate(),
    })
    this.registerCharacteristic({
      characteristicType: LockTargetState,
      serviceType: lockService,
      getValue: () => this.getLockState(),
      setValue: async (state: number) => {
        clearTimeout(this.unlockTimeout)

        if (state === LockTargetState.UNSECURED) {
          if (this.unlockInFlight) {
            logInfo(`Unlock of ${device.name} already in progress, ignoring`)
            return
          }
          logInfo(`Unlocking ${device.name}`)
          this.unlocking = true
          this.unlockInFlight = true

          let response: unknown
          try {
            response = await device.unlock()
          } catch (e) {
            // Unknown outcome (no reply) or a refusal: never show the door as open in Home.
            // Put both states back to "locked". (Throwing would not reach HomeKit:
            // base-accessory answers the SET callback before setValue finishes.)
            logError(
              `Unlock of ${device.name} failed, the door may or may not have opened`,
            )
            logError(e)
            this.unlocking = false
            syncLockState()
            return
          } finally {
            this.unlockInFlight = false
          }
          logInfo(`Unlock response: ${JSON.stringify(response)}`)

          markAsUnlocked()
        } else {
          // If the user locks the door from the home app, we can't do anything but set the states back to "locked"
          this.unlocking = false
          lockService
            .getCharacteristic(Characteristic.LockCurrentState)
            .updateValue(this.getLockState())
        }
      },
    })
    lockService.setPrimaryService(true)

    // Doorbell Service
    // Skipped with hideIntercomDoorbell when the audio accessory carries the
    // doorbell instead, so a ding notifies once and opens the stream.
    if (!config.hideIntercomDoorbell) {
      this.registerObservableCharacteristic({
        characteristicType: ProgrammableSwitchEvent,
        serviceType: Service.Doorbell,
        onValue: onDoorbellPressed,
      })
    }

    // Programmable Switch Service
    // `hideDoorbellSwitch` is honored in camera.ts, but here the switch was always
    // created regardless of the option, so anyone who did not want it was stuck with
    // an extra accessory in the Home app and no way to remove it.
    if (!config.hideDoorbellSwitch) {
      this.registerObservableCharacteristic({
        characteristicType: ProgrammableSwitchEvent,
        serviceType: programableSwitchService,
        onValue: onDoorbellPressed,
      })

      // Hide long and double press events by setting max value
      programableSwitchService
        .getCharacteristic(ProgrammableSwitchEvent)
        .setProps({
          maxValue: ProgrammableSwitchEvent.SINGLE_PRESS,
        })
    }

    // ── Ding log ──────────────────────────────────────────────────────────────
    // HomeKit keeps no history, and the Doorbell service above throttles to 15s, so
    // two rings close together look like one. This records EVERY ding, unthrottled,
    // to a JSONL file that survives restarts.
    // The async appendFile is deliberate: a logging failure must never delay or break
    // the doorbell notification, which is the part that actually matters.
    if (config.logIntercomDings) {
      const logPath = join(
          config.intercomDingLogPath || '/var/lib/homebridge',
          'ring-intercom-dings.jsonl',
        ),
        writeEvent = (event: string) => {
          const line =
            JSON.stringify({
              time: new Date().toISOString(),
              device: device.name,
              deviceId: device.id,
              event,
            }) + '\n'
          appendFile(logPath, line, (err) => {
            if (err) {
              logError(
                `Failed to write the intercom ding log at ${logPath}: ${err.message}`,
              )
            }
          })
        }

      device.onDing.subscribe(() => writeEvent('ding'))
      device.onUnlocked.subscribe(() => writeEvent('unlocked'))
      logInfo(`Logging intercom dings to ${logPath}`)
    }

    // ── Connectivity sensor ───────────────────────────────────────────────────
    // The API exposes `alerts.connection` and the plugin never used it: if the
    // intercom dropped off the network there was no way to find out until someone
    // rang and nothing happened. ContactSensor is the only service HomeKit allows
    // as both an automation trigger and a notification source.
    // "Detected" (contact open) = intercom OFFLINE.
    if (config.showOfflineSensor) {
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.ContactSensorState,
        serviceType: Service.ContactSensor,
        name: device.name + ' Offline',
        serviceSubType: 'offline',
        onValue: device.onData.pipe(
          map((data) =>
            data.alerts?.connection === 'offline'
              ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : Characteristic.ContactSensorState.CONTACT_DETECTED,
          ),
          distinctUntilChanged(),
        ),
      })
    }

    // ── Do Not Disturb ────────────────────────────────────────────────────────
    // Uses subscribe/unsubscribeToDingEvents, which the API already offered and the
    // plugin never called. Unlike turning the volume down, this stops the alert at
    // the source: Ring stops sending the push.
    // SAFETY: the state is deliberately NOT persisted. After a restart it goes back
    // to "receiving dings" — a Do Not Disturb that forgets itself is far better than
    // silently losing your doorbell with no idea why.
    if (config.showDoNotDisturbSwitch) {
      this.registerCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Switch,
        name: device.name + ' Do Not Disturb',
        serviceSubType: 'dnd',
        getValue: () => this.doNotDisturb,
        setValue: async (on: boolean) => {
          try {
            if (on) {
              await device.unsubscribeFromDingEvents()
              logInfo(
                `Do Not Disturb ON for ${device.name}: Ring will stop sending ding alerts`,
              )
            } else {
              await device.subscribeToDingEvents()
              logInfo(
                `Do Not Disturb off for ${device.name}: ding alerts restored`,
              )
            }
            this.doNotDisturb = Boolean(on)
          } catch (e) {
            // If the call fails, do not lie to the user about the switch state
            logError(e as Error)
            this.doNotDisturb = !on
          }
        },
      })
    }

    // Battery Service
    if (device.batteryLevel !== null) {
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.BatteryLevel,
        serviceType: Service.Battery,
        onValue: device.onBatteryLevel.pipe(
          map((batteryLevel) => {
            return batteryLevel === null ? 100 : batteryLevel
          }),
        ),
        requestUpdate: () => device.requestUpdate(),
      })
    }

    // Accessory Information Service (branded: this accessory is built by the fork)
    this.registerCharacteristic({
      characteristicType: Characteristic.Manufacturer,
      serviceType: Service.AccessoryInformation,
      getValue: () => MANUFACTURER,
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.Model,
      serviceType: Service.AccessoryInformation,
      getValue: () => 'Portal Intercom',
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.SerialNumber,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => mruwzumSerial('PTL', data.device_id),
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.FirmwareRevision,
      serviceType: Service.AccessoryInformation,
      getValue: () => FIRMWARE,
    })
  }

  private getLockState() {
    const {
      Characteristic: { LockCurrentState: State },
    } = hap
    return this.unlocking ? State.UNSECURED : State.SECURED
  }
}
