const MAX_CREDENTIAL_LENGTH = 16_384;

/** Empty edit drafts mean "keep the stored credential"; secrets are never prefilled. */
export function credentialInputError(value: string, required: boolean): string | null {
  if (value.length === 0) return required ? '新建渠道时必须填写上游凭证。' : null;
  if (value.length > MAX_CREDENTIAL_LENGTH) return '上游凭证长度不能超过 16384 个字符。';
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value))
    return '上游凭证不能包含首尾空格或控制字符。';
  return null;
}

/** Omits an empty edit value so a blank field can never clear the stored secret. */
export function credentialReplacement(value: string): { readonly upstreamKey?: string } {
  return value.length === 0 ? {} : { upstreamKey: value };
}
