import { ThemePicker } from '@cheapai/theme';
import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Plus } from 'lucide-react';
import { BrandLink } from '../../shared/ui/BrandLink';
import { Button } from '../../shared/ui/Button';
import { useSession } from '../../features/session/useSession';
import { AgentGuides } from './AgentGuides';
import { ModelCatalog } from './ModelCatalog';
import { Tabs } from '../../shared/ui/Tabs';
import './home.css';

const questions = [
  [
    'CheapAI 提供什么？',
    '你可以直接在网页中对话，也可以通过 API 接入自己的应用；两种方式共用账户余额。',
  ],
  [
    '支持哪些模型？',
    '首页「模型目录」提供已上架模型与基础价格；实际可用模型以账户授权为准，登录后可在 API 接入页查看。',
  ],
  [
    '如何开始使用？',
    '先登录账户；开放注册时，也可以从登录页创建账户。部分部署需要邀请码。获得模型访问权限并由管理员授予余额后，即可开始调用。',
  ],
  [
    '如何查看费用？',
    '你可以在「费用」中查看余额与账单，在「使用记录」中查看请求详情。实际费用取决于所用模型、用量和访问组倍率。',
  ],
];

export default function HomePage() {
  const { isAuthenticated } = useSession();
  const { hash } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (hash === '#agent-tools' || hash === '#questions') {
      const frame = requestAnimationFrame(() =>
        document.getElementById(hash.slice(1))?.scrollIntoView(),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [hash]);
  return (
    <div className="home-page">
      <a
        className="home-skip"
        href="#home-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('home-main')?.focus();
        }}
      >
        跳到主要内容
      </a>
      <header className="home-header">
        <div className="home-header-inner">
          <BrandLink className="home-brand" />
          <div className="home-header-actions">
            <ThemePicker />
            <Link className="home-login" to={isAuthenticated ? '/keys' : '/login?returnTo=%2Fchat'}>
              {isAuthenticated ? '控制台' : '登录'}
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
            <Button asChild variant="outline">
              <Link to="/chat">
                开始对话
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main id="home-main" tabIndex={-1}>
        <Tabs
          value={hash === '#models' ? 'models' : 'start'}
          onValueChange={(value) => void navigate({ hash: value === 'models' ? '#models' : '' })}
          ariaLabel="首页内容"
          listClassName="home-content-tabs"
          items={[
            { value: 'start', label: '开始使用', content: <HomeOverview /> },
            { value: 'models', label: '模型目录', content: <ModelCatalog /> },
          ]}
        />
      </main>
      <footer className="home-footer">
        <BrandLink className="home-brand" />
        <p>对话 · API · 用量与费用</p>
        <nav aria-label="页脚导航">
          <Link to="/chat">对话</Link>
          <Link to="/keys">API 接入</Link>
          <Link to="/#agent-tools">Agent 接入指南</Link>
          <Link to="/#questions">常见问题</Link>
        </nav>
        <span>© {new Date().getFullYear()} CheapAI</span>
      </footer>
    </div>
  );
}

function HomeOverview() {
  return (
    <>
      <section className="home-hero" aria-labelledby="hero-title">
        <div className="home-hero-copy">
          <h1 id="hero-title">对话与 API 接入</h1>
          <p className="home-hero-description">
            选择可用模型开始对话，或在自己的应用中调用 API。用量与费用统一在控制台查看。
          </p>
          <div className="home-hero-actions">
            <Button asChild variant="outline">
              <Link to="/chat">
                开始对话 <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/#agent-tools">
                接入 Agent <ArrowUpRight size={18} aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section id="possibilities" className="home-section" aria-labelledby="products-title">
        <div className="home-section-heading">
          <h2 id="products-title">使用方式</h2>
          <p>日常对话与 API 调用，共用一个账户。</p>
        </div>
        <div className="home-products">
          <Link className="home-product" to="/chat">
            <div className="home-product-title">
              <h3>网页对话</h3>
              <ArrowUpRight size={25} aria-hidden="true" />
            </div>
            <p>在浏览器中选择模型，发送消息并管理历史对话。</p>
            <span className="home-product-link">
              开始对话
              <ArrowRight size={16} aria-hidden="true" />
            </span>
          </Link>
          <Link className="home-product" to="/keys">
            <div className="home-product-title">
              <h3>API 接入</h3>
              <ArrowUpRight size={25} aria-hidden="true" />
            </div>
            <p>创建 API Key，将主流模型接入应用、Agent 和开发工具。</p>
            <span className="home-product-link">
              前往 API 接入
              <ArrowRight size={16} aria-hidden="true" />
            </span>
          </Link>
        </div>
      </section>

      <AgentGuides />

      <section id="questions" className="home-section home-faq" aria-labelledby="faq-title">
        <div>
          <h2 id="faq-title">常见问题</h2>
        </div>
        <div className="home-faq-list">
          {questions.map(([question, answer]) => (
            <details key={question}>
              <summary>
                {question}
                <Plus size={20} aria-hidden="true" />
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
