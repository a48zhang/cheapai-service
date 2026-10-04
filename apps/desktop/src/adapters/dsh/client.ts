/** Typed access to the pinned DSH Remote and Session client helpers. */

import type { Context } from '@deepseek-ai/cordis'
import {
  apply as installGatewayClient,
  type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import workspaceFilesRemote from '@deepseek-ai/dsh-api-workspace-files/remote'
import userQuestionsRemote from '@deepseek-ai/dsh-user-questions/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSessionControlStream,
  createScope,
  scopeOf,
  SessionEventStream,
  type SessionControlStream,
  type SessionControlStreamOptions,
  type SessionEventStreamOptions,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import { apply as installTypertClient } from '@deepseek-ai/dsh-typert-registry/client'
import { typertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'

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
  // Gateway waterfalls target an Agent Context before invoking root listeners.
  // Use upstream tagged scopes without installing a second Session manager.
  context.effect(() => context.typert.contexts.registerClient('agent', {
    identity: scopeOf,
    resolve: sessionId => {
      const scope = createScope(context, sessionId)
      return typertOwnedValue(scope.ctx, () => { void scope.fiber.dispose().catch(() => undefined) })
    },
  }), 'desktop.dsh.agent-context')
  installGatewayClient(context)
  await context.remote.$mount(sessionRemote)
  await context.remote.$mount(workspaceFilesRemote)
  await context.remote.$mount(userQuestionsRemote)
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

/** Read the upstream Agent tag on a Gateway owner without guessing the active UI Session. */
export function sessionIdForDshOwner(owner: unknown): ReturnType<typeof scopeOf> {
  return typeof owner === 'object' && owner !== null ? scopeOf(owner as Context) : undefined
}
export type {
  SessionControlStream,
  SessionControlStreamOptions,
  SessionEventStreamOptions,
  SessionJournalChange,
  SessionRemote,
} from '@deepseek-ai/dsh-api-session-controller/client'
