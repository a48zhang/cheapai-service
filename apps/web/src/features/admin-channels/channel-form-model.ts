import { channelInputSchema, channelPatchSchema } from '@cheapai/contracts/channels';
import type {
  ChannelInput,
  ChannelPatch,
  ChannelStatus,
  ChannelView,
} from '@cheapai/api-client/channels';
import { credentialInputError, credentialReplacement } from './credential-input';

export type LimitMode = 'unlimited' | 'finite';

export interface ChannelDraft {
  name: string;
  baseUrl: string;
  status: ChannelStatus;
  priority: string;
  concurrencyMode: LimitMode;
  concurrencyValue: string;
  rpmMode: LimitMode;
  rpmValue: string;
  upstreamKey: string;
}

export interface ChannelFormErrors {
  name?: string;
  baseUrl?: string;
  status?: string;
  priority?: string;
  concurrency?: string;
  rpm?: string;
  upstreamKey?: string;
}

interface ReadValue<T> {
  readonly value?: T;
  readonly error?: string;
}

function limitDraft(value: number | undefined): { mode: LimitMode; value: string } {
  if (value === undefined || value === Number.MAX_SAFE_INTEGER)
    return { mode: 'unlimited', value: '' };
  return { mode: 'finite', value: String(value) };
}

export function createChannelDraft(channel: ChannelView | null): ChannelDraft {
  const concurrency = limitDraft(channel?.concurrencyLimit);
  const rpm = limitDraft(channel?.rpmLimit);
  return {
    name: channel?.name ?? '',
    baseUrl: channel?.baseUrl ?? '',
    status: channel?.status ?? 'active',
    priority: String(channel?.priority ?? 0),
    concurrencyMode: concurrency.mode,
    concurrencyValue: concurrency.value,
    rpmMode: rpm.mode,
    rpmValue: rpm.value,
    // Channel credentials are write-only; never initialize this from a response.
    upstreamKey: '',
  };
}

function readLimit(mode: LimitMode, value: string, maximum?: number): ReadValue<number | null> {
  if (mode === 'unlimited') return { value: null };
  if (!/^[0-9]+$/u.test(value)) return { error: '请输入正整数，或选择不限。' };
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number === Number.MAX_SAFE_INTEGER ||
    (maximum !== undefined && number > maximum)
  ) {
    return {
      error: maximum === undefined ? '请输入有效的并发上限。' : `上限需为 1 到 ${maximum} 的整数。`,
    };
  }
  return { value: number };
}

function readPriority(value: string): ReadValue<number> {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return { error: '优先级必须是非负整数。' };
  const number = Number(value);
  return Number.isSafeInteger(number) ? { value: number } : { error: '优先级超出可用范围。' };
}

function cleanNameError(value: string): string | undefined {
  if (!value.trim()) return '请输入渠道名称。';
  if (!channelInputSchema.shape.name.safeParse(value).success) {
    return '渠道名称最多 200 个字符，且不能包含首尾空格或控制字符。';
  }
  return undefined;
}

function cleanUrlError(value: string): string | undefined {
  if (!value.trim()) return '请输入上游 Base URL。';
  if (!channelInputSchema.shape.baseUrl.safeParse(value).success) return 'Base URL 格式无效。';
  return undefined;
}

export function validateChannelDraft(draft: ChannelDraft, creating: boolean): ChannelFormErrors {
  const errors: ChannelFormErrors = {};
  const nameError = cleanNameError(draft.name);
  if (nameError !== undefined) errors.name = nameError;
  const baseUrlError = cleanUrlError(draft.baseUrl);
  if (baseUrlError !== undefined) errors.baseUrl = baseUrlError;
  const concurrency = readLimit(draft.concurrencyMode, draft.concurrencyValue);
  const rpm = readLimit(draft.rpmMode, draft.rpmValue, 4096);
  const priority = readPriority(draft.priority);
  if (concurrency.error !== undefined) errors.concurrency = concurrency.error;
  if (rpm.error !== undefined) errors.rpm = rpm.error;
  if (priority.error !== undefined) errors.priority = priority.error;
  const upstreamKeyError = credentialInputError(draft.upstreamKey, creating);
  if (upstreamKeyError !== null) errors.upstreamKey = upstreamKeyError;
  return errors;
}

function channelFields(draft: ChannelDraft) {
  const concurrency = readLimit(draft.concurrencyMode, draft.concurrencyValue);
  const rpm = readLimit(draft.rpmMode, draft.rpmValue, 4096);
  const priority = readPriority(draft.priority);
  if (concurrency.value === undefined || rpm.value === undefined || priority.value === undefined) {
    throw new TypeError('Invalid channel form values.');
  }
  return {
    name: draft.name,
    baseUrl: draft.baseUrl,
    status: draft.status,
    priority: priority.value,
    concurrencyLimit: concurrency.value,
    rpmLimit: rpm.value,
  };
}

export function buildChannelInput(draft: ChannelDraft): ChannelInput {
  return channelInputSchema.parse({ ...channelFields(draft), upstreamKey: draft.upstreamKey });
}

export function buildChannelPatch(draft: ChannelDraft): ChannelPatch {
  return channelPatchSchema.parse({
    ...channelFields(draft),
    ...credentialReplacement(draft.upstreamKey),
  });
}
