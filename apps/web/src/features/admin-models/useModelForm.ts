import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { ApiClientError } from '@cheapai/api-client/errors';
import { createAdminModelsApi } from '@cheapai/api-client/models';
import type { ModelView } from '@cheapai/api-client/models';
import type { ApiClient } from '@cheapai/api-client/types';
import { withErrorContext } from '../../shared/lib/api-error';
import { createModelPatch, initialModelFormValues, modelFormSchema } from './model-form-model';
import type { ModelFormOutput, ModelFormValues } from './model-form-model';

export interface UseModelFormProps {
  readonly client: ApiClient;
  readonly model?: ModelView | undefined;
  readonly onSaved: (model: ModelView) => void;
}

/** Model write lock, priceVersion conflict handling, and create/update lifecycle. */
export function useModelForm({ client, model, onSaved }: UseModelFormProps) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const api = useMemo(() => createAdminModelsApi(client), [client]);
  const form = useForm<ModelFormValues, unknown, ModelFormOutput>({
    resolver: zodResolver<ModelFormValues, unknown, ModelFormOutput>(modelFormSchema),
    defaultValues: initialModelFormValues(model),
  });

  async function submit(value: ModelFormOutput) {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (model) {
        const patch = createModelPatch(model, value);
        if (Object.keys(patch).length === 0) {
          setSaveError(new Error('没有需要保存的更改。'));
          return;
        }
        onSaved(await api.update(model.publicModelId, model.priceVersion, patch));
      } else {
        onSaved(await api.create(value));
      }
    } catch (error) {
      const conflict = error instanceof ApiClientError && error.status === 409;
      const context = conflict
        ? '模型价格版本已变化。请重新读取并核对后再保存；当前输入已保留。'
        : error instanceof Error
          ? `${error.message} 当前输入已保留。`
          : '保存结果未确认。请重新读取模型；当前输入已保留。';
      setSaveError(withErrorContext(error, context));
    } finally {
      setSaving(false);
    }
  }

  return { form, saving, saveError, submit };
}
