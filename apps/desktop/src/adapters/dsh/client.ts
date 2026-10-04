/** Typed access to the pinned DSH Remote and Session client helpers. */

import type { Context } from '@deepseek-ai/cordis'
import {
  apply as installGatewayClient,
  type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import {
  createSessionControlStream,
  SessionEventStream,
  type SessionControlStream,
  type SessionControlStreamOptions,
  type SessionEventStreamOptions,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import { apply as installTypertClient } from '@deepseek-ai/dsh-typert-registry/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'

/** Public DSH services consumed by the desktop conversation features. */
export interface DshClient {
  readonly connection: ConnectionHandle
  readonly remote: ClientRemote
  readonly session: ClientRemote['session']
  createControlStream(options: SessionControlStreamOptions): SessionControlStream
  createEventStream(
    address: SessionAddress,
    options: SessionEventStreamOptions,
  ): SessionEventStream
}

/**
 * Install the upstream Typert Gateway and generated Session contribution on a
 * Cordis context whose Connection service was installed by
 * {@link installDshConnection}.
 */
export async function installDshClient(context: Context): Promise<DshClient> {
  const connection = context.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) {
    throw new Error('DSH Connection service is not installed')
  }

  installTypertClient(context)
  installGatewayClient(context)
  await context.remote.$mount(sessionRemote)
  return createDshClient(context)
}

/**
 * Bind the official typed Remote namespace and Session stream helpers from a
 * Cordis Client context already assembled with the DSH Gateway and Session
 * contributions.
 */
export function createDshClient(context: Context): DshClient {
  const connection = context.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) {
    throw new Error('DSH Connection service is not installed')
  }

  const remote = context.remote
  const sessionRemotes = remote as unknown as Parameters<typeof createSessionControlStream>[0]

  return Object.freeze({
    connection,
    remote,
    session: remote.session,
    createControlStream: (options: SessionControlStreamOptions) =>
      createSessionControlStream(sessionRemotes, options),
    createEventStream: (address: SessionAddress, options: SessionEventStreamOptions) =>
      new SessionEventStream(sessionRemotes, address, options),
  })
}

export {
  SessionEventStream,
  createSessionControlStream,
} from '@deepseek-ai/dsh-api-session-controller/client'
export type {
  SessionControlStream,
  SessionControlStreamOptions,
  SessionEventStreamOptions,
  SessionJournalChange,
  SessionRemote,
} from '@deepseek-ai/dsh-api-session-controller/client'
