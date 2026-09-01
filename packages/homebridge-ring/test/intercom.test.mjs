// Tests del fork para el Ring Intercom.
//
// Se ejecutan EN LA RASPI (`node --test`) porque los modulos importan ring-client-api
// y hap, que solo existen dentro de la instalacion de Homebridge.
//
// No son tests de relleno: cada uno cubre algo que YA se rompio el 1 Sep 2026 o que,
// si se rompe, deja al usuario sin audio sin dar ningun error visible.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

const PLUGIN = '/var/lib/homebridge/node_modules/homebridge-ring'
const { IntercomCamera } = await import(`${PLUGIN}/lib/intercom-camera.js`)

const fakeIntercom = { id: 999, name: 'Portal de prueba', isOffline: false, data: {} }
const fakeRest = { request: async () => ({ ticket: 'x' }) }

test('la imagen fija viaja con el plugin y no hay que generarla', async () => {
  const still = join(PLUGIN, 'media', 'intercom-still.jpg')
  assert.ok(existsSync(still), 'falta media/intercom-still.jpg: el accesorio se quedaria sin video')
  const buf = await readFile(still)
  assert.ok(buf.length > 500, 'la imagen esta vacia o corrupta')
  assert.ok(buf.length < 20000, `la imagen pesa ${buf.length} b; se mueve en cada preview, deberia ser pequeña`)
  assert.equal(buf[0], 0xff, 'no es un JPEG valido')
  assert.equal(buf[1], 0xd8, 'no es un JPEG valido')
})

test('getSnapshot devuelve la imagen del plugin, no una generada', async () => {
  const cam = new IntercomCamera(fakeIntercom, fakeRest, '/tmp', '/usr/bin/ffmpeg')
  const snap = await cam.getSnapshot()
  const bundled = await readFile(join(PLUGIN, 'media', 'intercom-still.jpg'))
  assert.deepEqual(snap, bundled, 'deberia servir el fichero incluido tal cual')
})

test('getSnapshot cachea: la segunda llamada no vuelve a leer disco', async () => {
  const cam = new IntercomCamera(fakeIntercom, fakeRest, '/tmp', '/usr/bin/ffmpeg')
  const a = await cam.getSnapshot()
  const b = await cam.getSnapshot()
  assert.equal(a, b, 'deberia devolver la MISMA instancia en memoria')
})

test('getSnapshotPath apunta al fichero del plugin', async () => {
  const cam = new IntercomCamera(fakeIntercom, fakeRest, '/tmp', '/usr/bin/ffmpeg')
  const p = await cam.getSnapshotPath()
  assert.ok(p.endsWith('media/intercom-still.jpg'), `ffmpeg necesita el fichero incluido, recibio ${p}`)
})

test('las ganancias tienen valor por defecto sensato', () => {
  const cam = new IntercomCamera(fakeIntercom, fakeRest, '/tmp', '/usr/bin/ffmpeg')
  assert.equal(cam.micGainDb, 12)
  assert.equal(cam.speakerGainDb, 10)
})

test('las ganancias se pueden configurar, incluido el 0', () => {
  const cam = new IntercomCamera(fakeIntercom, fakeRest, '/tmp', '/usr/bin/ffmpeg', 18, 20)
  assert.equal(cam.speakerGainDb, 18)
  assert.equal(cam.micGainDb, 20)
  // 0 es un valor legitimo (dejar el volumen original) y no debe caer al por defecto
  const sinGanancia = new IntercomCamera(fakeIntercom, fakeRest, '/tmp', '/usr/bin/ffmpeg', 0, 0)
  assert.equal(sinGanancia.speakerGainDb, 0, 'un 0 explicito no puede convertirse en el valor por defecto')
  assert.equal(sinGanancia.micGainDb, 0)
})

test('una ganancia invalida no rompe: cae al valor por defecto', () => {
  const cam = new IntercomCamera(fakeIntercom, fakeRest, '/tmp', '/usr/bin/ffmpeg', 'mucho', null)
  assert.equal(cam.speakerGainDb, 10)
  assert.equal(cam.micGainDb, 12)
})

test('ffmpegPath nunca queda undefined', () => {
  // getFfmpegPath() de ring-client-api devuelve undefined si no se configura, y spawn
  // revienta con «The file argument must be of type string». Paso el 1 Sep 2026 y dejo
  // el accesorio como "no responde".
  const cam = new IntercomCamera(fakeIntercom, fakeRest, '/tmp', undefined)
  assert.equal(typeof cam.ffmpegPath, 'string')
  assert.ok(cam.ffmpegPath.length > 0)
})

test('REGRESION: el video va a 10 fps, no menos', async () => {
  // Se probo bajar a 5 fps para ahorrar CPU y HomeKit empezo a cortar la sesion a los
  // pocos segundos, dejando al usuario sin audio. El ahorro eran 1,3 puntos de CPU.
  const src = await readFile(`${PLUGIN}/lib/intercom-camera-source.js`, 'utf8')
  const fps = src.match(/'-r',\s*'(\d+)'/)
  assert.ok(fps, 'no se encuentra el parametro de fps')
  assert.ok(Number(fps[1]) >= 10, `fps en ${fps[1]}: por debajo de 10 HomeKit corta la sesion y se pierde el audio`)
})

test('REGRESION: se abre el microfono del portal al iniciar el stream', async () => {
  // Sin activateCameraSpeaker() al abrir, el intercom se queda en modo sigilo y
  // transmite SILENCIO, con llamada o sin ella. Fue la causa de que no se oyera nada.
  const src = await readFile(`${PLUGIN}/lib/intercom-camera-source.js`, 'utf8')
  const activate = src.slice(src.indexOf('async activate('))
  assert.ok(activate.includes('activateCameraSpeaker'),
    'falta activateCameraSpeaker() en activate(): el portal transmitiria silencio')
})

test('REGRESION: el audio de entrada regenera timestamps', async () => {
  // Sin genpts/aresample, ffmpeg avisa «Queue input is backward in time» y HomeKit
  // descarta el audio aunque los paquetes lleguen bien.
  const src = await readFile(`${PLUGIN}/lib/intercom-camera-source.js`, 'utf8')
  assert.ok(src.includes('genpts'), 'falta -fflags +genpts en la entrada de audio')
  assert.ok(src.includes('aresample'), 'falta el resample asincrono')
})

test('las ganancias pasan al pipeline con limitador', async () => {
  // Subir volumen sin limitador satura los picos, que es justo donde estan las
  // consonantes que hacen entender la palabra.
  const src = await readFile(`${PLUGIN}/lib/intercom-camera-source.js`, 'utf8')
  const filtros = src.match(/aresample=[^`']*/)
  assert.ok(filtros, 'no se encuentra la cadena de filtros de audio')
  assert.ok(filtros[0].includes('volume='), 'la ganancia no llega al filtro')
  assert.ok(filtros[0].includes('alimiter'), 'falta el limitador: la ganancia saturaria')
})

test('no se reenvia a HomeKit el video que manda Ring', async () => {
  // Para un intercom ese canal no trae H.264 valido; reenviarlo hacia que HomeKit
  // tirase la sesion entera, audio incluido.
  const src = await readFile(`${PLUGIN}/lib/intercom-camera-source.js`, 'utf8')
  const activate = src.slice(src.indexOf('async activate('), src.indexOf('    stop()'))
  assert.ok(!/onVideoRtp\.subscribe/.test(activate),
    'se esta reenviando onVideoRtp de Ring: HomeKit descartara la sesion')
})
