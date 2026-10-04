/** Renderer-side adapter for the pinned DSH Client Connection service. */

import type { Context } from '@deepseek-ai/cordis'
import {
  installConnection,
  type ClientConnectionRpc,
  type ClientTransportHooks,
  type ConnectionHandle,
  type ConnectionRecoveryConfig,
} from '@deepseek-ai/dsh-client-connection/client'

/**
 * Native/Runtime implementation of DSH's already-decoded logical carrier.
 * The native bridge owns DSH authority and transport details; renderer code
 * supplies this to the official Connection hook without knowing loopback URLs,
 * cookies, Remote envelopes, or Gateway stream frames.
 */
export type DshNativeRpc = Pick<ClientConnectionRpc, 'call'> & {
  readonly open: NonNullable<ClientConnectionRpc['open']>
}

/** Install DSH's Connection service with the app's native Runtime carrier. */
export function installDshConnection(
  context: Context,
  rpc: DshNativeRpc,
  recovery?: ConnectionRecoveryConfig,
): ConnectionHandle {
  const transport: ClientTransportHooks = {
    rpc,
    // The Tauri shell owns the local DSH process and its authenticated carrier.
    ownsHost: true,
  }

  installConnection(context, {
    transport,
    ...(recovery === undefined ? {} : { recovery }),
  })

  const connection = context.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) {
    throw new Error('DSH Connection hook did not provide its service')
  }
  return connection
}
