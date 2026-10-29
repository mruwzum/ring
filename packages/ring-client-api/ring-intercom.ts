import type { IntercomHandsetData, PushNotification } from './ring-types.ts'
import { PushNotificationAction } from './ring-types.ts'
import type { RingRestClient } from './rest-client.ts'
import { clientApi, commandsApi } from './rest-client.ts'
import { BehaviorSubject, Subject } from 'rxjs'
import { distinctUntilChanged, map } from 'rxjs/operators'
import { getBatteryLevel } from './ring-camera.ts'
import { logError } from './util.ts'

export class RingIntercom {
  id
  deviceType
  onData
  onRequestUpdate = new Subject()
  onBatteryLevel
  onDing = new Subject<void>()
  onUnlocked = new Subject<void>()
  private initialData
  private restClient

  constructor(initialData: IntercomHandsetData, restClient: RingRestClient) {
    this.initialData = initialData
    this.restClient = restClient
    this.id = initialData.id
    this.deviceType = initialData.kind
    this.onData = new BehaviorSubject<IntercomHandsetData>(this.initialData)

    this.onBatteryLevel = this.onData.pipe(
      map((data) => getBatteryLevel(data)),
      distinctUntilChanged(),
    )

    if (!initialData.subscribed) {
      this.subscribeToDingEvents().catch((e) => {
        logError(
          'Failed to subscribe ' + initialData.description + ' to ding events',
        )
        logError(e)
      })
    }
  }

  updateData(update: IntercomHandsetData) {
    this.onData.next(update)
  }

  requestUpdate() {
    this.onRequestUpdate.next(null)
  }

  get data() {
    return this.onData.getValue()
  }

  get name() {
    return this.data.description
  }

  get isOffline() {
    return this.data.alerts.connection === 'offline'
  }

  get batteryLevel() {
    return getBatteryLevel(this.data)
  }

  unlock() {
    return this.restClient.request<unknown>({
      method: 'PUT',
      // Opening the door is not idempotent: if Ring ran the command and the reply was lost,
      // the generic retry-on-no-response would send it again and open the door twice.
      // Fail instead and let the caller decide (mruwzum fork, 29 Oct 2026).
      noRetry: true,
      url: commandsApi(`devices/${this.id}/device_rpc`),
      json: {
        command_name: 'device_rpc',
        request: {
          jsonrpc: '2.0',
          method: 'unlock_door',
          params: {
            door_id: 0,
            user_id: 0,
          },
        },
      },
    })
  }

  private doorbotUrl(path = '') {
    return clientApi(`doorbots/${this.id}/${path}`)
  }

  subscribeToDingEvents() {
    return this.restClient.request({
      method: 'POST',
      url: this.doorbotUrl('subscribe'),
    })
  }

  unsubscribeFromDingEvents() {
    return this.restClient.request({
      method: 'POST',
      url: this.doorbotUrl('unsubscribe'),
    })
  }

  processPushNotification(notification: PushNotification) {
    if (
      'android_config' in notification &&
      notification.android_config.category ===
        PushNotificationAction.IntercomDing
    ) {
      this.onDing.next()
    } else if (
      'gcmData' in notification.data &&
      notification.data.gcmData.action === PushNotificationAction.IntercomUnlock
    ) {
      this.onUnlocked.next()
    }
  }
}
