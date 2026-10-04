import type { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider, { type Config as LocalCredentialProviderConfig } from '@deepseek-ai/dsh-credentials-local'

import { CHEAPAI_API_KEY_CREDENTIAL_REF } from '../dsh/config.ts'
import {
  DESKTOP_CREDENTIAL_SOCKET_ENV,
  DesktopCredentialBridgeClient,
} from './credential-bridge.ts'

/** DSH provider that keeps the ordinary local credential store for every
 * reference except CHEAPAI_API_KEY. That one is resolved through the Runtime
 * session manager for each DSH model operation and never stored in the DSH
 * credentials file or exposed to the renderer.
 */
export class DesktopCredentialProvider extends LocalCredentialProvider {
  static override Config = LocalCredentialProvider.Config

  private readonly bridge: DesktopCredentialBridgeClient

  constructor(ctx: Context, config: LocalCredentialProviderConfig) {
    super(ctx, config)
    this.bridge = new DesktopCredentialBridgeClient({ endpoint: process.env[DESKTOP_CREDENTIAL_SOCKET_ENV] })
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (ref !== CHEAPAI_API_KEY_CREDENTIAL_REF) return super.resolve(ref)
    return this.bridge.resolveKey().then(value => ({ value, source: 'desktop-session' }))
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (ref !== CHEAPAI_API_KEY_CREDENTIAL_REF) return super.describe(ref)
    const status = await this.bridge.getPublicStatus()
    return status.status === 'signedIn'
      ? { configured: true, source: 'desktop-session', writable: false }
      : { configured: false, writable: false }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (ref === CHEAPAI_API_KEY_CREDENTIAL_REF) {
      throw new Error('The desktop-managed credential can only be supplied by the Runtime session manager.')
    }
    await super.set(ref, value)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    // Permit removal of a stale pre-bridge file value. LocalCredentialProvider
    // only deletes that entry here; the managed session Key lives in Runtime.
    await super.unset(ref)
  }
}

export default DesktopCredentialProvider
