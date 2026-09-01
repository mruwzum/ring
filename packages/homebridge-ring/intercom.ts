import type { RingIntercom } from 'ring-client-api'
import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import type { PlatformAccessory } from 'homebridge'
import { BaseDataAccessory } from './base-data-accessory.ts'
import { logError, logInfo } from 'ring-client-api/util'
import { distinctUntilChanged, map, throttleTime } from 'rxjs/operators'
import { appendFile } from 'fs'
import { join } from 'path'

export class Intercom extends BaseDataAccessory<RingIntercom> {
  private unlocking = false
  private doNotDisturb = false
  private unlockTimeout?: ReturnType<typeof setTimeout>

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
          logInfo(`Unlocking ${device.name}`)
          this.unlocking = true

          const response = await device.unlock().catch((e) => {
            logError(e)
            this.unlocking = false
          })
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
    this.registerObservableCharacteristic({
      characteristicType: ProgrammableSwitchEvent,
      serviceType: Service.Doorbell,
      onValue: onDoorbellPressed,
    })

    // Programmable Switch Service
    // `hideDoorbellSwitch` se respeta en camera.ts pero aquí se creaba el botón
    // siempre, sin mirar la opción: quien no lo usara se comía un accesorio extra
    // en la app Casa sin forma de quitarlo.
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

    // ── Registro de llamadas ──────────────────────────────────────────────────
    // HomeKit no guarda historial, y el servicio Doorbell de arriba aplica un
    // throttle de 15 s: dos llamadas seguidas se ven como una sola. Aquí se
    // registra CADA ding, sin throttle, en un JSONL que sobrevive a los reinicios.
    // Se escribe con appendFile asíncrono a propósito: un fallo al registrar no
    // puede retrasar ni romper el aviso del timbre, que es lo que importa.
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
                `No se pudo escribir el registro del intercom en ${logPath}: ${err.message}`,
              )
            }
          })
        }

      device.onDing.subscribe(() => writeEvent('ding'))
      device.onUnlocked.subscribe(() => writeEvent('unlocked'))
      logInfo(`Registro de llamadas del intercom activo en ${logPath}`)
    }

    // ── Sensor de conexión ────────────────────────────────────────────────────
    // La API expone `alerts.connection` y el plugin no lo usaba: si el interfono
    // se quedaba sin conexión no había forma de enterarse hasta que alguien
    // llamaba y no sonaba. ContactSensor es el único servicio que HomeKit deja
    // usar como disparador de automatización y notificación.
    // "Detectado" (contacto abierto) = portal SIN conexión.
    if (config.showOfflineSensor) {
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.ContactSensorState,
        serviceType: Service.ContactSensor,
        name: device.name + ' sin conexión',
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

    // ── No molestar ───────────────────────────────────────────────────────────
    // Usa subscribe/unsubscribeToDingEvents, que la API ya ofrecía y el plugin
    // nunca llamaba. Al contrario que bajar el volumen, esto corta el aviso de
    // raíz: Ring deja de enviar el push.
    // SEGURIDAD: el estado NO se persiste a propósito. Tras un reinicio vuelve a
    // "recibiendo llamadas": es preferible un no-molestar que se olvida solo a
    // quedarse sin oír el portal sin saber por qué.
    if (config.showDoNotDisturbSwitch) {
      this.registerCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Switch,
        name: device.name + ' no molestar',
        serviceSubType: 'dnd',
        getValue: () => this.doNotDisturb,
        setValue: async (on: boolean) => {
          try {
            if (on) {
              await device.unsubscribeFromDingEvents()
              logInfo(
                `No molestar ACTIVADO para ${device.name}: Ring deja de enviar avisos de llamada`,
              )
            } else {
              await device.subscribeToDingEvents()
              logInfo(
                `No molestar desactivado para ${device.name}: avisos de llamada restaurados`,
              )
            }
            this.doNotDisturb = Boolean(on)
          } catch (e) {
            // Si la llamada falla, no mentimos al usuario diciendo que está activo
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

    // Accessory Information Service
    this.registerCharacteristic({
      characteristicType: Characteristic.Manufacturer,
      serviceType: Service.AccessoryInformation,
      getValue: () => 'Ring',
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.Model,
      serviceType: Service.AccessoryInformation,
      getValue: () => 'Intercom Handset Audio',
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.SerialNumber,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => data.device_id || 'Unknown',
    })
  }

  private getLockState() {
    const {
      Characteristic: { LockCurrentState: State },
    } = hap
    return this.unlocking ? State.UNSECURED : State.SECURED
  }
}
