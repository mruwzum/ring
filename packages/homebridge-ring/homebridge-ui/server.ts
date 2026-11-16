/* eslint-disable no-console */
import {
  HomebridgePluginUiServer,
  RequestError,
} from '@homebridge/plugin-ui-utils'

import { RingRestClient } from 'ring-client-api/rest-client'
import { controlCenterDisplayName, getSystemId } from '../config.ts'

interface LoginRequest {
  email: string
  password: string
}

interface TokenRequest {
  email: string
  password: string
  code: string
}

class PluginUiServer extends HomebridgePluginUiServer {
  // One client per account being linked: a single shared client let two overlapping
  // logins swap it between "send code" and "token", checking the code on the wrong one.
  private clients = new Map<string, RingRestClient>()

  constructor() {
    super()

    this.onRequest('/send-code', this.generateCode)
    this.onRequest('/token', this.generateToken)

    this.ready()
  }

  generateCode = async ({ email, password }: LoginRequest) => {
    console.log(`Logging in with email '${email}'`)
    const storagePath = this.homebridgeStoragePath,
      restClient = new RingRestClient({
        email,
        password,
        controlCenterDisplayName,
        systemId: storagePath ? getSystemId(storagePath) : undefined,
      })
    this.clients.set(email, restClient)

    try {
      const { refresh_token } = await restClient.getCurrentAuth()
      this.clients.delete(email)

      // If we get here, 2fa was not required.  I'm not sure this is possible anymore, but it's here just in case
      return { refreshToken: refresh_token }
    } catch (e: any) {
      if (restClient.promptFor2fa) {
        console.log(restClient.promptFor2fa)
        return { codePrompt: restClient.promptFor2fa }
      }
      this.clients.delete(email)

      console.error(e)
      throw new RequestError(e.message, e)
    }
  }

  generateToken = async ({ email, password, code }: TokenRequest) => {
    // use the existing restClient to avoid sending a token again
    const restClient =
      this.clients.get(email) || new RingRestClient({ email, password })
    console.log(`Getting token for ${email}`)

    try {
      const authResponse = await restClient.getAuth(code)
      this.clients.delete(email)

      return { refreshToken: authResponse.refresh_token }
    } catch (e: any) {
      console.error('Incorrect 2fa Code')
      throw new RequestError('Please check the code and try again', e)
    }
  }
}

function startPluginUiServer() {
  return new PluginUiServer()
}

startPluginUiServer()
