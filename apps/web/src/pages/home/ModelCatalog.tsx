import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createApiClient } from '@cheapai/api-client/client';
import { createCatalogApi } from '@cheapai/api-client/catalog';
import type { CatalogModel } from '@cheapai/contracts/catalog';
import { ImageIcon, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatUsdAmount } from '../../shared/lib/model-price';
import { Button } from '../../shared/ui/Button';
import { CopyButton } from '../../shared/ui/CopyButton';
import { Input } from '../../shared/ui/Input';
import { ModelLogo } from '../../shared/ui/ModelLogo';

const catalogApi = createCatalogApi(createApiClient());

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
        <p className="home-model-unit">{model.kind === 'text' ? 'USD / 百万 Token' : 'USD / 张'}</p>
        <dl className="home-model-rates">
          {model.kind === 'text' ? (
            <>
              <div>
                <dt>输入</dt>
                <dd>{formatUsdAmount(model.prices.input)}</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>{formatUsdAmount(model.prices.output)}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>生成一张</dt>
              <dd>{formatUsdAmount(model.price)}</dd>
            </div>
          )}
        </dl>
        {model.kind === 'text' && model.prices.cacheRead !== undefined && (
          <p className="home-model-cache">
            缓存读取 {formatUsdAmount(model.prices.cacheRead)} / 百万 Token
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

export function ModelCatalog() {
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['public-model-catalog'],
    queryFn: ({ signal }) => catalogApi.list({ signal }),
    retry: false,
    staleTime: 60_000,
  });
  const keyword = search.trim().toLowerCase();
  const models =
    query.data?.items.filter((model) =>
      (model.kind === 'text' ? model.id : model.name).toLowerCase().includes(keyword),
    ) ?? [];

  return (
    <section className="home-section home-catalog" aria-labelledby="catalog-title">
      <div className="home-section-heading">
        <h1 id="catalog-title">模型目录</h1>
        <p>选模型，先看价格。</p>
      </div>
      <p className="home-catalog-note">
        以下为本站基础价，以美元（USD）计费。实际价格按访问组倍率计算，可用模型以账号授权为准。
        <Button asChild variant="ghost" size="sm">
          <Link to="/keys">查看我的可用模型</Link>
        </Button>
      </p>
      {query.isPending ? (
        <div className="home-catalog-state" role="status">
          正在加载模型与价格…
        </div>
      ) : query.isError ? (
        <div className="home-catalog-state">
          <p role="alert">模型与价格暂时加载失败，请重试。</p>
          <Button variant="outline" busy={query.isFetching} onClick={() => void query.refetch()}>
            重新加载
          </Button>
        </div>
      ) : query.data.items.length === 0 ? (
        <div className="home-catalog-state" role="status">
          暂无上架模型，请稍后再来看看。
        </div>
      ) : (
        <>
          <div className="home-catalog-toolbar">
            <label className="home-catalog-search">
              <Search size={17} aria-hidden="true" />
              <span className="sr-only">搜索模型</span>
              <Input
                type="search"
                placeholder="搜索模型名称或 ID"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <span role="status">
              {keyword ? `找到 ${models.length} 个模型` : `${models.length} 个模型`}
            </span>
          </div>
          {models.length === 0 ? (
            <div className="home-catalog-state">
              <p>没有找到匹配的模型。</p>
              <Button variant="outline" onClick={() => setSearch('')}>
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
