import type {
  AuthApi,
  LoginInput,
  PublicSettings,
  PublicUser,
  RegisterInput,
  RegistrationResult,
} from '@cheapai/api-client/auth';
import type { ApiClient, SessionIdentity } from '@cheapai/api-client/types';
import type { QueryClient } from '@tanstack/react-query';

export interface RuntimeSessionSnapshot {
  status: 'unknown' | 'anonymous' | 'authenticated' | 'unavailable';
  user: PublicUser | null;
  epoch: number;
  pending: 'restore' | 'login' | 'logout' | 'register' | null;
  error: Error | null;
  expiry: { userId: string; epoch: number; reason: 'expired' } | null;
  publicSettings: PublicSettings | null;
  settingsError: Error | null;
}

export interface RuntimeSessionController {
  getSnapshot(): RuntimeSessionSnapshot;
  subscribe(listener: () => void): () => void;
  requestIdentity(): SessionIdentity | null;
  expire(identity: SessionIdentity): boolean;
  restore(): Promise<PublicUser | null>;
  bootstrap(): Promise<PublicSettings>;
  login(input: LoginInput): Promise<PublicUser>;
  logout(): Promise<void>;
  register(input: RegisterInput): Promise<RegistrationResult>;
}

export interface AppRuntime {
  session: RuntimeSessionController;
  auth: AuthApi;
  client: ApiClient;
  queryClient: QueryClient;
  dispose(): void;
}
