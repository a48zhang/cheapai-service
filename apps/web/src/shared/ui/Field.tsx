import { useId, cloneElement } from 'react'
import type { AriaAttributes, ReactElement, ReactNode } from 'react'
import * as Label from '@radix-ui/react-label'

export interface FieldControlProps {
  id?: string
  required?: boolean | undefined
  'aria-describedby'?: string | undefined
  'aria-invalid'?: AriaAttributes['aria-invalid']
}

export interface FieldProps {
  /** Explicit IDs are useful when a caller also targets this control elsewhere. */
  id?: string
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
  required?: boolean
  className?: string
  /** One input control; Field adds its ID and label/error description relationships. */
  children: ReactElement<FieldControlProps>
}

function mergeIds(...ids: Array<string | undefined>) {
  return [...new Set(ids.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []))].join(' ') || undefined
}

/** Form field that keeps the visible label, helper text, and error tied to one control. */
export function Field({
  id,
  label,
  description,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  const generatedId = useId()
  const controlId = id ?? children.props.id ?? `field-${generatedId}`
  const descriptionId = description ? `${controlId}-description` : undefined
  const hasError = Boolean(error)
  const errorId = hasError ? `${controlId}-error` : undefined
  const child = cloneElement(children, {
    id: controlId,
    required: required || children.props.required,
    'aria-describedby': mergeIds(children.props['aria-describedby'], descriptionId, errorId),
    'aria-invalid': hasError || children.props['aria-invalid'] || undefined,
  })

  return (
    <div className={`grid gap-1.5 ${className ?? ''}`}>
      <Label.Root
        htmlFor={controlId}
        className="text-sm font-medium text-[var(--color-foreground)]"
      >
        {label}
        {required && <span aria-hidden="true" className="ml-1 text-[var(--color-destructive)] after:content-['*']" />}
      </Label.Root>
      {child}
      {description && (
        <p id={descriptionId} className="text-xs text-[var(--color-muted-foreground)]">
          {description}
        </p>
      )}
      {hasError && (
        <p id={errorId} role="alert" className="text-xs text-[var(--color-destructive)]">
          {error}
        </p>
      )}
    </div>
  )
}
