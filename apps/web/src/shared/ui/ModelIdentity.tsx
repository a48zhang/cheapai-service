import type { ReactNode } from 'react';
import { ModelLogo } from './ModelLogo';

export function ModelIdentity({
  modelId,
  secondary,
  className = '',
}: {
  modelId: string;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <span className={`model-identity ${className}`} title={modelId}>
      <ModelLogo modelId={modelId} />
      <span className="model-identity-copy">
        <span className="model-identity-name">{modelId}</span>
        {secondary && <span className="model-identity-secondary">{secondary}</span>}
      </span>
    </span>
  );
}
