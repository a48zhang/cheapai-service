import { z } from 'zod';

const nonEmptyTextSchema = z.string().min(1);
const safeTimestampSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);

export const publicUserSchema = z.object({
  id: nonEmptyTextSchema,
  email_normalized: nonEmptyTextSchema,
  role: z.enum(['user', 'admin']),
  status: z.enum(['active', 'disabled']),
  group_id: nonEmptyTextSchema,
  group_status: z.enum(['active', 'disabled']),
  balance_units: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u),
  email_verified_at: safeTimestampSchema.nullable(),
});

export type PublicUser = Readonly<z.infer<typeof publicUserSchema>>;

export const publicSettingsSchema = z.object({
  registrationMode: z.enum(['closed', 'open', 'invite']),
  emailVerificationEnabled: z.boolean(),
  // A 32-byte base64url token has 43 characters and a constrained final sextet.
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
});

export type PublicSettings = Readonly<z.infer<typeof publicSettingsSchema>>;

export const loginInputSchema = z.object({
  email: z.string(),
  password: z.string(),
});

export type LoginInput = Readonly<z.infer<typeof loginInputSchema>>;

export const registerInputSchema = loginInputSchema.extend({
  registrationCode: z.string().optional(),
  emailCode: z.string().optional(),
});

export type RegisterInput = Readonly<z.infer<typeof registerInputSchema>>;

const registrationUserSchema = z.object({
  id: nonEmptyTextSchema,
  email_normalized: nonEmptyTextSchema,
});

const registrationCreatedSchema = z.object({
  status: z.literal('created'),
  user: registrationUserSchema,
  session: z.literal('created'),
});

const registrationLoginRequiredSchema = z.object({
  status: z.literal('created'),
  user: registrationUserSchema,
  session: z.literal('login_required'),
  next_action: z.literal('login'),
});

export const registrationResultSchema = z.union([
  registrationCreatedSchema,
  registrationLoginRequiredSchema,
]);

export type RegistrationResult = Readonly<z.infer<typeof registrationResultSchema>> & {
  readonly user: Readonly<z.infer<typeof registrationUserSchema>>;
};

export const verificationCodeResultSchema = z.object({
  status: z.literal('accepted'),
  retry_after_ms: z.number().int().nonnegative().refine(Number.isSafeInteger),
});

export type VerificationCodeResult = Readonly<z.infer<typeof verificationCodeResultSchema>>;

export const logoutResultSchema = z.object({ loggedOut: z.literal(true) });

export function decodePublicUser(value: unknown): PublicUser {
  return publicUserSchema.parse(value);
}

export function decodePublicSettings(value: unknown): PublicSettings {
  return publicSettingsSchema.parse(value);
}

export function decodeRegistrationResult(value: unknown): RegistrationResult {
  return registrationResultSchema.parse(value) as RegistrationResult;
}

export function decodeVerificationCodeResult(value: unknown): VerificationCodeResult {
  return verificationCodeResultSchema.parse(value);
}

export function decodeLogoutResult(value: unknown): true {
  return logoutResultSchema.parse(value).loggedOut;
}
