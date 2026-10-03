import { decodeAccountBalance } from '@cheapai/contracts/account';
import type { AccountBalance } from '@cheapai/contracts/account';
import type { ApiClient } from './types.js';

export type { AccountBalance } from '@cheapai/contracts/account';

export interface AccountApi {
  balance(): Promise<AccountBalance>;
}

export function createAccountApi(client: ApiClient): AccountApi {
  return Object.freeze({
    async balance(): Promise<AccountBalance> {
      return (await client.get('/api/v1/account/balance', { decode: decodeAccountBalance })).data;
    },
  });
}
