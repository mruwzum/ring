import type { RingIntercom, RingRestClient } from 'ring-client-api'
import { StreamingSession } from 'ring-client-api/streaming/streaming-session'
// WebrtcConnection no está en el campo `exports` de ring-client-api, así que se
// importa por ruta de fichero: las rutas de fichero no pasan por `exports`.
import { WebrtcConnection } from '../../node_modules/ring-client-api/lib/streaming/webrtc-connection.js'
import { logInfo } from 'ring-client-api/util'
import { readFile } from 'fs/promises'

/**
 * Envuelve un RingIntercom para que pueda usarse como cámara en HomeKit.
 *
 * POR QUÉ EXISTE
 * El Ring Intercom no tiene cámara, así que el plugin nunca le dio un accesorio de
 * vídeo y por tanto tampoco audio: en HomeKit solo se podía abrir la puerta, no
 * escuchar ni hablar. Pero el audio SÍ está disponible. Comprobado el 1 Sep 2026
 * contra los servidores de Ring: el intercom es un "doorbot" igual que las cámaras,
 * el ticket de streaming es genérico (no lleva el id del aparato) y al negociar con
 * el `doorbot_id` del intercom el servidor responde
 *
 *     m=audio 9 UDP/TLS/RTP/SAVPF 96
 *     a=sendrecv
 *
 * es decir: audio en ambos sentidos y sin pista de vídeo. Escuchar y hablar.
 *
 * CÓMO SE RESUELVE LA FALTA DE VÍDEO
 * HomeKit no acepta una "cámara" sin vídeo, así que se sirve una imagen fija que
 * viene incluida con el plugin (`media/intercom-still.jpg`). No se dibuja ni se
 * calcula: es un fichero, siempre el mismo, y no depende de las fuentes del sistema.
 *
 * La interfaz que expone es la mínima que consumen CameraSource (name, isOffline,
 * getSnapshot, hasSnapshotWithinLifetime, snapshotsAreBlocked, snapshotLifeTime,
 * startLiveCall), StreamingSession (name) y WebrtcConnection (id, name,
 * isRingEdgeEnabled) — sacada de leer su código, no supuesta.
 */
export class IntercomCamera {
  public readonly snapshotsAreBlocked = false
  public readonly snapshotLifeTime = 0
  public readonly isRingEdgeEnabled = false
  public readonly ffmpegPath: string
  public readonly speakerGainDb: number
  public readonly micGainDb: number

  private snapshot: Buffer | null = null
  private readonly stillPath = new URL(
    '../media/intercom-still.jpg',
    import.meta.url,
  ).pathname

  constructor(
    private readonly intercom: RingIntercom,
    public readonly restClient: RingRestClient,
    ffmpegPath?: string,
    speakerGainDb?: number,
    micGainDb?: number,
  ) {
    this.ffmpegPath = ffmpegPath || 'ffmpeg'
    // OJO con Number(): Number(null) es 0 y Number('') también, así que un valor
    // vacío en la config se colaba como «ganancia 0 dB» en vez de caer al valor por
    // defecto — el usuario se quedaba sin ganancia sin saber por qué. Lo cazó un
    // test. Un 0 EXPLÍCITO sí es válido y debe respetarse.
    this.speakerGainDb = IntercomCamera.gain(speakerGainDb, 10)
    this.micGainDb = IntercomCamera.gain(micGainDb, 12)
  }

  private static gain(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === '') {
      return fallback
    }
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  get id() {
    return this.intercom.id
  }
  get name() {
    return this.intercom.name
  }
  get isOffline() {
    return this.intercom.isOffline
  }

  hasSnapshotWithinLifetime() {
    return Boolean(this.snapshot)
  }

  /** Imagen fija incluida con el plugin. Se lee una vez y se queda en memoria. */
  async getSnapshot() {
    if (!this.snapshot) {
      this.snapshot = await readFile(this.stillPath)
    }
    return this.snapshot
  }

  /** ffmpeg necesita el fichero en disco, no el buffer. */
  getSnapshotPath() {
    return this.stillPath
  }

  /**
   * Abre la llamada de audio. Mismo camino que una cámara: ticket genérico y luego
   * negociación WebRTC identificando el aparato por su doorbot_id.
   */
  async startLiveCall() {
    const ticket = await this.restClient.request<{ ticket: string }>({
      method: 'POST',
      url: 'https://app.ring.com/api/v1/clap/ticket/request/signalsocket',
    })
    logInfo(`Abriendo audio con ${this.name}`)
    const connection = new WebrtcConnection(ticket.ticket, this as any, {})
    return new StreamingSession(this as any, connection)
  }
}
