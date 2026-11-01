import { useQuery } from '@tanstack/react-query';
import type { CatalogModel } from '@cheapai/contracts/catalog';
import { ImageIcon, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../../features/session/useSession';
import { catalogGroupsQuery, catalogModelsQuery } from '../../features/model-catalog/api';
import { formatPriceAmount } from '../../shared/lib/model-price';
import { Button } from '../../shared/ui/Button';
import { CopyButton } from '../../shared/ui/CopyButton';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { ModelLogo } from '../../shared/ui/ModelLogo';
import '../../shared/styles/public-site.css';

function ModelCard({ model }: { model: CatalogModel }) {
  const name = model.kind === 'text' ? model.id : model.name;
  return (
    <article className="home-model-card" aria-label={name}>
      <div className="home-model-heading">
        {model.kind === 'text' ? (
          <ModelLogo modelId={model.id} />
        ) : (
          <span className="model-logo" aria-hidden="true">
            <ImageIcon size={18} />
          </span>
        )}
        <div>
          <h2>{name}</h2>
          <p>{model.kind === 'text' ? '对话 · API' : '图片生成'}</p>
        </div>
      </div>
      <div className="home-model-pricing">
        <p className="home-model-unit">
          {model.kind === 'text' ? '积分 / 百万 Token' : '积分 / 张'}
        </p>
        <dl className="home-model-rates">
          {model.kind === 'text' ? (
            <>
              <div>
                <dt>输入</dt>
                <dd>{formatPriceAmount(model.prices.input)}</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>{formatPriceAmount(model.prices.output)}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>生成一张</dt>
              <dd>{formatPriceAmount(model.price)}</dd>
            </div>
          )}
        </dl>
        {model.kind === 'text' && model.prices.cacheRead !== undefined && (
          <p className="home-model-cache">
            缓存读取 {formatPriceAmount(model.prices.cacheRead)} 积分 / 百万 Token
          </p>
        )}
      </div>
      <div className="home-model-actions">
        {model.kind === 'text' ? (
          <CopyButton value={model.id} label="复制模型 ID" />
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link to="/images">去生图</Link>
          </Button>
        )}
      </div>
    </article>
  );
}

export default function ModelCatalogPage() {
  const { client } = useSession();
  const [params, setParams] = useSearchParams();
  const groups = useQuery(catalogGroupsQuery(client));
  const requestedGroup = params.get('group');
  const group =
    requestedGroup === null
      ? groups.data?.items[0]
      : groups.data?.items.find((item) => item.id === requestedGroup);
  const query = useQuery(catalogModelsQuery(client, group?.id ?? ''));
  const search = params.get('q') ?? '';
  const keyword = search.trim().toLowerCase();
  const models =
    query.data?.items.filter((model) =>
      (model.kind === 'text' ? model.id : model.name).toLowerCase().includes(keyword),
    ) ?? [];
  function updateParam(key: string, value: string, replace = false) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace },
    );
  }
  return (
    <section className="home-section home-catalog" aria-labelledby="catalog-title">
      <div className="home-section-heading">
        <h1 id="catalog-title">模型目录</h1>
      </div>
      {groups.isPending ? (
        <div className="home-catalog-state" role="status">
          正在加载公开分组…
        </div>
      ) : groups.isError ? (
        <div className="home-catalog-state">
          <p role="alert">公开分组暂时加载失败，请重试。</p>
          <Button variant="outline" busy={groups.isFetching} onClick={() => void groups.refetch()}>
            重新加载
          </Button>
        </div>
      ) : groups.data.items.length === 0 ? (
        <div className="home-catalog-state" role="status">
          暂无公开分组。
        </div>
      ) : (
        <>
          <div className="home-catalog-toolbar">
            <label className="home-catalog-group">
              <span className="sr-only">公开分组</span>
              <Select
                aria-label="公开分组"
                value={group?.id ?? ''}
                placeholder="选择公开分组"
                items={groups.data.items.map((item) => ({ value: item.id, label: item.name }))}
                onValueChange={(value) => updateParam('group', value)}
              />
            </label>
            <label className="home-catalog-search">
              <Search size={17} aria-hidden="true" />
              <span className="sr-only">搜索模型</span>
              <Input
                type="search"
                placeholder="搜索模型名称或 ID"
                value={search}
                onChange={(event) => updateParam('q', event.target.value, true)}
              />
            </label>
            {group && query.isSuccess && (
              <span role="status">
                {keyword ? `找到 ${models.length} 个模型` : `${models.length} 个模型`}
              </span>
            )}
          </div>
          {!group ? (
            <div className="home-catalog-state" role="status">
              该公开分组暂不可用，请重新选择。
            </div>
          ) : query.isPending ? (
            <div className="home-catalog-state" role="status">
              正在加载模型与价格…
            </div>
          ) : query.isError ? (
            <div className="home-catalog-state">
              <p role="alert">模型与价格暂时加载失败，请重试。</p>
              <Button
                variant="outline"
                busy={query.isFetching}
                onClick={() => void query.refetch()}
              >
                重新加载
              </Button>
            </div>
          ) : query.data.items.length === 0 ? (
            <div className="home-catalog-state" role="status">
              此分组暂无上架模型。
            </div>
          ) : models.length === 0 ? (
            <div className="home-catalog-state">
              <p>没有找到匹配的模型。</p>
              <Button variant="outline" onClick={() => updateParam('q', '', true)}>
                清除搜索
              </Button>
            </div>
          ) : (
            <div className="home-model-grid">
              {models.map((model) => (
                <ModelCard key={`${model.kind}:${model.id}`} model={model} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
