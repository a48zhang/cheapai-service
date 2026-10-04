export const DSH_PROFILE_NAME = 'cheapai' as const
export const DSH_PROFILE_TEMPLATE = 'web' as const
export const DSH_PROFILE_PATCH = 'cheapai.yml' as const
export const DSH_LOOPBACK_HOST = '127.0.0.1' as const
export const DSH_DYNAMIC_PORT = 0 as const
export const CHEAPAI_API_KEY_CREDENTIAL_REF = 'CHEAPAI_API_KEY' as const

export interface DshProfileLaunchOptions {
  /** Absolute private DSH home for this desktop account. */
  home: string
  /** Absolute path to the profile patch copied or resolved by the launcher. */
  patchFile: string
  /** Optional launcher-generated overlay that installs the Runtime credential bridge provider. */
  credentialProviderPatchFile?: string
  /** Zero asks the DSH web Host to bind an OS-assigned loopback port. */
  port: number
  /** True only before the `cheapai` profile directory has been initialized. */
  initializeProfile: boolean
}

export interface DshProfileLaunchConfig {
  args: string[]
  env: Record<string, string>
}

/**
 * Build the DSH CLI invocation from resolved startup parameters. The profile
 * patch itself contains no model endpoint or key; the model provider is
 * configured by Runtime after it receives private configuration.
 */
export function createDshProfileLaunchConfig(
  options: DshProfileLaunchOptions,
): DshProfileLaunchConfig {
  if (!options.home || !options.patchFile) {
    throw new Error('DSH home and profile patch path are required')
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('DSH Host port must be an integer from 0 through 65535')
  }

  const args = [
    '--profile', DSH_PROFILE_NAME,
    ...(options.initializeProfile ? ['--from-default-profile', DSH_PROFILE_TEMPLATE] : []),
    '--patch', options.patchFile,
    ...(options.credentialProviderPatchFile === undefined
      ? []
      : ['--patch', options.credentialProviderPatchFile]),
    '--no-open',
    '--host', DSH_LOOPBACK_HOST,
    '--port', String(options.port),
  ]

  return {
    args,
    env: {
      DSH_HOME: options.home,
    },
  }
}
