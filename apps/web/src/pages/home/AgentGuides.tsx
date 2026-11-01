import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { agentGuides } from '../../features/api-access/agent-guides';
import { Disclosure } from '../../shared/ui/Disclosure';
import { TextLink } from '../../shared/ui/TextLink';
import { Tabs } from '../../shared/ui/Tabs';
import { Button } from '../../shared/ui/Button';
import { CopyButton } from '../../shared/ui/CopyButton';

export function AgentGuides() {
  const [tool, setTool] = useState('codex');
  const guides = agentGuides(window.location.origin);
  return (
    <section id="agent-tools" className="home-agents" aria-labelledby="agents-title">
      <div className="home-agent-inner">
        <div className="home-section-heading home-agent-heading">
          <div>
            <h2 id="agents-title">把常用 Agent 接入 CheapAI</h2>
            <p>选择你正在用的工具，按步骤配置地址、密钥和模型。</p>
          </div>
          <Button asChild variant="outline">
            <Link to="/keys">
              创建 API Key <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <Tabs
          value={tool}
          onValueChange={setTool}
          ariaLabel="Agent 工具"
          listClassName="home-agent-tabs"
          items={guides.map((guide) => ({
            value: guide.id,
            label: guide.name,
            content: (
              <div className="home-agent-content">
                <div className="home-agent-instructions">
                  <h3>{guide.name}</h3>
                  <p>{guide.description}</p>
                  <ol>
                    {guide.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <TextLink
                    className="home-agent-docs"
                    href={guide.documentation}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {guide.name} 官方文档 <ArrowUpRight size={15} aria-hidden="true" />
                  </TextLink>
                </div>
                <div className="home-agent-config">
                  {guide.blocks.map((block) => (
                    <div className="home-code-panel" key={block.title}>
                      <div className="home-code-header">
                        <span>{block.title}</span>
                        <CopyButton value={block.code} label="复制" />
                      </div>
                      <pre tabIndex={0} aria-label={`${guide.name} · ${block.title}`}>
                        <code>{block.code}</code>
                      </pre>
                    </div>
                  ))}
                </div>
                <div className="home-agent-verification">
                  <h4>确认接入成功</h4>
                  <p>
                    {guide.verification}{' '}
                    <Button asChild variant="ghost" size="sm">
                      <Link to="/requests">
                        查看使用记录 <ArrowUpRight size={14} aria-hidden="true" />
                      </Link>
                    </Button>
                  </p>
                </div>
              </div>
            ),
          }))}
        />
        <Disclosure className="home-agent-help" title="连接失败时检查什么？">
          <p>
            401：检查密钥是否完整、有效。403 或模型不存在：核对密钥的访问组和可用模型
            ID。余额不足：到「费用」查看余额。工具无法执行：确认所选模型支持工具调用。
          </p>
          <p>接入地址按所选工具填写，避免多加或漏掉 /v1。请求详情可在「使用记录」查看。</p>
        </Disclosure>
      </div>
    </section>
  );
}
