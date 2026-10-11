import { describe, expect, it } from 'vitest';
import { initialModelFormValues, modelFormSchema } from './model-form-model';

describe('model minimum balance in USD', () => {
  it('converts display input to exact integer units without losing a small amount', () => {
    const values = {
      ...initialModelFormValues(),
      publicModelId: 'test-model',
      sellPrices: { ...initialModelFormValues().sellPrices, input: '0.1', output: '0.2' },
      maxOutputTokens: '4096',
      admissionMinBalanceUnits: '0.00000001',
    };
    expect(modelFormSchema.parse(values).admissionMinBalanceUnits).toBe('1');
    expect(
      modelFormSchema.parse({ ...values, admissionMinBalanceUnits: '1.2300' })
        .admissionMinBalanceUnits,
    ).toBe('123000000');
    expect(modelFormSchema.safeParse({ ...values, admissionMinBalanceUnits: '-1' }).success).toBe(
      false,
    );
    expect(
      modelFormSchema.safeParse({ ...values, admissionMinBalanceUnits: '0.000000001' }).success,
    ).toBe(false);
  });
});
