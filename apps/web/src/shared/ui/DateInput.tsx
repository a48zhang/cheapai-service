import * as Popover from '@radix-ui/react-popover';
import { CalendarDays } from 'lucide-react';
import { useState, type Ref } from 'react';
import { DayPicker } from 'react-day-picker';
import { zhCN } from 'react-day-picker/locale';
import { formatLocalDateTime, parseLocalDateTime } from '../lib/datetime';
import { Button } from './Button';
import { Input, type InputProps } from './Input';
import { Select } from './Select';
import './date-input.css';

interface DateInputProps extends Omit<InputProps, 'type' | 'value' | 'defaultValue' | 'onChange'> {
  ref?: Ref<HTMLInputElement>;
  mode?: 'date' | 'datetime';
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: (value: string) => void;
}

const hours = Array.from({ length: 24 }, (_, n) => ({
  value: String(n).padStart(2, '0'),
  label: String(n).padStart(2, '0'),
}));
const minutes = Array.from({ length: 60 }, (_, n) => ({
  value: String(n).padStart(2, '0'),
  label: String(n).padStart(2, '0'),
}));

/** Editable local date/time with a shared calendar; never invokes a browser picker. */
export function DateInput({
  mode = 'datetime',
  value,
  defaultValue = '',
  onValueChange,
  disabled,
  readOnly,
  className,
  ...props
}: DateInputProps) {
  const [draft, setDraft] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const current = value ?? draft;
  const datePart = current.split('T')[0] ?? '';
  const timeParts = current.split('T')[1]?.split(':') ?? [];
  const timestamp = parseLocalDateTime(`${datePart}T00:00`);
  const selected = timestamp === undefined ? undefined : new Date(timestamp);

  function update(next: string) {
    if (value === undefined) setDraft(next);
    onValueChange?.(next);
  }
  function selectDay(day: Date) {
    const date = formatLocalDateTime(day.getTime()).split('T')[0];
    update(mode === 'date' ? date! : `${date}T${current.split('T')[1] || '00:00'}`);
    if (mode === 'date') setOpen(false);
  }
  function selectTime(index: number, part: string) {
    const next = [timeParts[0] || '00', timeParts[1] || '00', ...timeParts.slice(2)];
    next[index] = part;
    const date = selected ? datePart : formatLocalDateTime(Date.now()).split('T')[0];
    update(`${date}T${next.join(':')}`);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="relative min-w-0">
          <Input
            {...props}
            type="text"
            placeholder={mode === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm'}
            autoComplete="off"
            disabled={disabled}
            readOnly={readOnly}
            value={current}
            onChange={(event) => update(event.currentTarget.value)}
            className={`pr-11 tabular-nums ${className ?? ''}`}
          />
          <Popover.Trigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled || readOnly}
              aria-label="打开日历"
              className="absolute right-0 top-1/2 -translate-y-1/2"
            >
              <CalendarDays size={16} aria-hidden="true" />
            </Button>
          </Popover.Trigger>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label="选择日期"
          className="date-popover z-[80] max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1.5rem)] overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[var(--color-foreground)] shadow-lg outline-none"
        >
          <DayPicker
            mode="single"
            locale={zhCN}
            selected={selected}
            defaultMonth={selected ?? new Date()}
            onSelect={(day) => {
              if (day) selectDay(day);
            }}
            autoFocus
            showOutsideDays
            labels={{ labelPrevious: () => '上个月', labelNext: () => '下个月' }}
          />
          {mode === 'datetime' && (
            <div className="mt-3 flex items-center gap-2 border-t border-[var(--color-border)] pt-3">
              <span className="shrink-0 text-sm">时间</span>
              <Select
                aria-label="小时"
                value={timeParts[0] || '00'}
                items={hours}
                onValueChange={(part) => selectTime(0, part)}
                contentClassName="z-[90]"
              />
              <span aria-hidden="true">:</span>
              <Select
                aria-label="分钟"
                value={timeParts[1] || '00'}
                items={minutes}
                onValueChange={(part) => selectTime(1, part)}
                contentClassName="z-[90]"
              />
            </div>
          )}
          <div className="mt-3 flex justify-between gap-2 border-t border-[var(--color-border)] pt-3">
            <Button variant="ghost" size="sm" onClick={() => selectDay(new Date())}>
              今天
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                update('');
                setOpen(false);
              }}
            >
              清除
            </Button>
            {mode === 'datetime' && (
              <Button size="sm" onClick={() => setOpen(false)}>
                完成
              </Button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
