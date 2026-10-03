import type { ColumnDef } from '@tanstack/react-table';
import type { ModelMappingView } from '@cheapai/api-client/mappings';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';

export interface MappingTableProps {
  readonly rows: readonly ModelMappingView[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onCreate?: () => void;
  readonly onEdit?: (mapping: ModelMappingView) => void;
}

function columnsFor(onEdit?: (mapping: ModelMappingView) => void): ColumnDef<ModelMappingView, unknown>[] {
  return [
    {
      accessorKey: 'channelId',
      header: '渠道 ID',
      cell: ({ row }) => <code className="font-mono text-xs">{row.original.channelId}</code>,
    },
    {
      accessorKey: 'protocol',
      header: '协议',
      cell: ({ row }) => <span className="capitalize">{row.original.protocol}</span>,
    },
    {
      accessorKey: 'upstreamModel',
      header: '上游模型',
      cell: ({ row }) => <code className="font-mono text-xs">{row.original.upstreamModel}</code>,
    },
    {
      accessorKey: 'capabilities',
      header: '能力声明',
      cell: ({ row }) => <div className="max-w-xs space-y-1">
        <StatusBadge tone="info">已配置</StatusBadge>
        <p className="line-clamp-2 break-words text-xs text-[var(--muted)]" title={row.original.capabilities.features.join(', ')}>
          {row.original.capabilities.features.length ? row.original.capabilities.features.join(', ') : '未声明功能'}
        </p>
      </div>,
    },
    {
      accessorKey: 'configVersion',
      header: '映射版本',
      cell: ({ row }) => <span className="font-mono text-xs">v{row.original.configVersion}</span>,
    },
    {
      id: 'actions',
      header: '操作',
      cell: ({ row }) => <Button variant="ghost" size="sm" disabled={!onEdit}
        aria-label={`编辑 ${row.original.channelId} 的 ${row.original.protocol} 映射`}
        onClick={() => onEdit?.(row.original)}>编辑映射</Button>,
    },
  ];
}

/** Shows configured upstream declarations without implying channel health or test success. */
export function MappingTable({ rows, loading = false, error, onRetry, onCreate, onEdit }: MappingTableProps) {
  return <section className="space-y-3" aria-label="渠道模型映射">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold">渠道映射</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">映射只记录上游配置和能力声明，不代表渠道已连通或探测成功。</p>
      </div>
      {onCreate && <Button size="sm" onClick={onCreate}>添加映射</Button>}
    </div>
    <CursorTable
      rows={rows}
      columns={columnsFor(onEdit)}
      loading={loading}
      error={error}
      onRetry={onRetry}
      getRowId={mapping => `${mapping.channelId}/${mapping.protocol}`}
      emptyMessage="此模型尚未配置渠道映射。"
      caption="渠道模型映射"
    />
  </section>;
}
