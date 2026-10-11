import type { ColumnDef } from '@tanstack/react-table';
import type { ModelMappingView } from '@cheapai/api-client/mappings';
import { CursorTable } from '../../shared/patterns/CursorTable';
import { Button } from '../../shared/ui/Button';

export interface MappingTableProps {
  readonly rows: readonly ModelMappingView[];
  readonly channelName?: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onCreate?: () => void;
  readonly onEdit?: (mapping: ModelMappingView) => void;
}

function columnsFor(
  onEdit?: (mapping: ModelMappingView) => void,
  channelName?: string,
): ColumnDef<ModelMappingView, unknown>[] {
  return [
    {
      accessorKey: 'channelId',
      header: '渠道',
      cell: ({ row }) => (
        <span title={row.original.channelId} className="font-medium">
          {channelName ?? row.original.channelId}
        </span>
      ),
    },
    {
      accessorKey: 'protocol',
      header: '协议',
      cell: ({ row }) => <span className="capitalize">{row.original.protocol}</span>,
    },
    {
      accessorKey: 'upstreamModel',
      header: '上游模型',
      cell: ({ row }) => <code className="font-mono text-sm">{row.original.upstreamModel}</code>,
    },
    {
      accessorKey: 'capabilities',
      header: '能力声明',
      cell: ({ row }) => (
        <span className="console-muted" title={row.original.capabilities.features.join(', ')}>
          {row.original.capabilities.features.length > 0
            ? `${row.original.capabilities.features.length} 项能力`
            : '未声明'}
        </span>
      ),
    },
    {
      accessorKey: 'configVersion',
      header: '映射版本',
      cell: ({ row }) => <span className="font-mono text-sm">v{row.original.configVersion}</span>,
    },
    {
      id: 'actions',
      header: '操作',
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={!onEdit}
          aria-label={`编辑 ${row.original.channelId} 的 ${row.original.protocol} 映射`}
          onClick={() => onEdit?.(row.original)}
        >
          编辑映射
        </Button>
      ),
    },
  ];
}

/** Shows configured upstream declarations without implying channel health or test success. */
export function MappingTable({
  rows,
  channelName,
  loading = false,
  error,
  onRetry,
  onCreate,
  onEdit,
}: MappingTableProps) {
  return (
    <section className="space-y-3" aria-label="渠道模型映射">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">渠道映射</h2>
        </div>
        {onCreate && (
          <Button size="sm" onClick={onCreate}>
            添加映射
          </Button>
        )}
      </div>
      <CursorTable
        rows={rows}
        columns={columnsFor(onEdit, channelName)}
        loading={loading}
        error={error}
        onRetry={onRetry}
        getRowId={(mapping) => `${mapping.channelId}/${mapping.protocol}`}
        emptyMessage="此模型尚未配置渠道映射。"
        caption="渠道模型映射"
      />
    </section>
  );
}
