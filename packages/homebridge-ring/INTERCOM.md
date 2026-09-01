# Ring Intercom — audio bidireccional en HomeKit

Fork mantenido por [**@mruwzum**](https://github.com/mruwzum).

Basado en [`homebridge-ring`](https://github.com/dgreif/ring) de **Dusty Greif**, MIT © 2022. Todo el mérito del plugin base es suyo; este fork solo añade lo que faltaba para el **Ring Intercom**.

---

## Qué añade

El plugin original soporta el Ring Intercom de forma **experimental** y limitada: abrir la puerta, el timbre y la batería. No hay forma de **escuchar el portal ni hablar**, porque el Intercom no tiene cámara y el plugin solo monta accesorios de audio sobre cámaras.

Este fork añade:

| | |
|---|---|
| 🔊 **Audio bidireccional** | Escuchar la calle cuando quieras y hablar, desde la app Casa |
| 🔔 **Timbre en el accesorio de audio** | La notificación de llamada lleva directa al stream |
| 📴 **Sensor de conexión** | Avisa si el Intercom se queda sin conexión |
| 🔕 **No molestar real** | Da de baja los avisos **en el servidor de Ring**, no los silencia a medias |
| 📝 **Registro de llamadas** | Cada ding y cada apertura, con hora, en un JSONL |
| 🐛 **`hideDoorbellSwitch`** | Se respeta también en el Intercom (antes se ignoraba) |

## Cómo funciona el audio

El Intercom **no tiene cámara**, así que el plugin nunca le dio accesorio de vídeo y por tanto tampoco audio. Pero el audio **sí está expuesto** en la API de Ring:

- El Intercom es un **doorbot**, igual que las cámaras.
- El ticket de streaming (`clap/ticket/request/signalsocket`) es **genérico**: no lleva el id del aparato.
- Al negociar WebRTC con el `doorbot_id` del Intercom, el servidor responde:

```
m=audio 9 UDP/TLS/RTP/SAVPF 96
a=sendrecv
```

Audio en ambos sentidos, sin pista de vídeo.

**La pieza que faltaba:** el Intercom arranca en **modo sigilo**, con el micrófono cerrado, y solo lo abre al recibir `camera_options { stealth_mode: false }`. La librería manda ese mensaje **únicamente cuando HomeKit empieza a devolver audio** — o sea, cuando pulsas el micrófono para hablar. Hasta entonces transmite silencio, haya llamada o no. Este fork lo envía al abrir el stream.

Medido, cambiando solo eso:

```
sin stealth_mode:false → -28 -74 -80 -85 -92 -92   (silencio digital)
con stealth_mode:false → -42 -51 -53 -58 -64 -69   (señal continua)
```

**El vídeo** se resuelve con una imagen fija incluida (`media/intercom-still.jpg`, 320×240, 1,8 KB): HomeKit no acepta una cámara sin pista de vídeo, así que ffmpeg la codifica en H.264 y la envía por SRTP. **No** se reenvía el vídeo que manda Ring: para un Intercom no es H.264 válido y HomeKit descarta la sesión entera, audio incluido.

## Configuración

```json
{
  "platform": "Ring",
  "ffmpegPath": "/usr/bin/ffmpeg",
  "enableIntercomAudio": true,
  "intercomMicGainDb": 14,
  "intercomSpeakerGainDb": 12,
  "showOfflineSensor": true,
  "showDoNotDisturbSwitch": true,
  "logIntercomDings": true
}
```

⚠️ **`ffmpegPath` es necesario.** `getFfmpegPath()` solo devuelve algo si se configura; sin él, `spawn` falla con *"The file argument must be of type string"* y el accesorio aparece como **"no responde"**.

El accesorio de audio se publica **sin puente** (requisito de HomeKit para cámaras): hay que añadirlo a mano en la app Casa con el código que aparece en el log.

## Rendimiento

Medido en una Raspberry Pi 5 con el stream real abierto:

| Proceso | CPU | RAM |
|---|---|---|
| ffmpeg vídeo | 1,5 % | 59 MB |
| ffmpeg audio entrante | 1,5 % | 49 MB |
| ffmpeg voz saliente | 0,7 % | 49 MB |
| **Total** | **3,7 % de un núcleo (0,9 % del sistema)** | |

Sin subida de temperatura y sin afectar al DNS local.

⚠️ **No bajar los fps por debajo de 10.** Se probó a 5 para ahorrar CPU y HomeKit empezó a cortar la sesión a los pocos segundos, dejando sin audio. La optimización que sí funciona es reducir el **tamaño** del fotograma: a 320×240 el codificador baja de 6,2 % a 1,5 %.

## Tests

```bash
npm run test:intercom
```

13 casos. Cinco son **regresiones** de fallos reales: los fps, el `stealth_mode`, los timestamps, el reenvío de vídeo y la ruta de ffmpeg — todos ellos dejaban al usuario sin audio **sin dar ningún error visible**.

## Licencia

MIT, igual que el original. Copyright (c) 2022 Dusty Greif por el plugin base; las aportaciones de este fork mantienen la misma licencia.
