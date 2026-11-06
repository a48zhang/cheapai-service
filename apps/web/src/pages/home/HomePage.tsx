import { RouteButton } from '../../shared/ui/RouteButton';
import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Disclosure } from '../../shared/ui/Disclosure';
import { AgentGuides } from './AgentGuides';

const questions = [
  [
    'CheapAI 提供什么？',
    '你可以在网页中对话、生成图片，也可以通过 API 接入自己的应用；这些使用方式共用账户余额。',
  ],
  ['支持哪些模型？', '在「模型目录」查看模型与价格，登录后可查看账户可用的模型。'],
  [
    '如何开始使用？',
    '先登录或创建账户；注册时如需邀请码，请按页面提示填写。账户有可用余额后，即可选择模型开始使用。',
  ],
  [
    '如何查看费用？',
    '你可以在「费用」中查看余额与账单，在「使用记录」中查看请求详情。每次使用的用量、计费单价、倍率和实际扣费均可在详情中核对。',
  ],
];

export default function HomePage() {
  const { hash, search } = useLocation();
  useEffect(() => {
    if (['#possibilities', '#agent-tools', '#questions', '#developers'].includes(hash)) {
      const frame = requestAnimationFrame(() =>
        document
          .getElementById(hash === '#developers' ? 'agent-tools' : hash.slice(1))
          ?.scrollIntoView(),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [hash]);
  if (hash === '#models') return <Navigate replace to={{ pathname: '/models', search }} />;

  return (
    <>
      <section className="home-hero" aria-labelledby="hero-title">
        <div className="home-hero-copy">
          <h1 id="hero-title">对话、生图与 API 接入</h1>
          <p className="home-hero-description">
            选择可用模型开始对话或生成图片，也可以在自己的应用中调用 API。用量与费用统一在控制台查看。
          </p>
          <div className="home-hero-actions">
            <RouteButton variant="outline" to="/chat">
              开始对话 <ArrowRight size={18} aria-hidden="true" />
            </RouteButton>
            <RouteButton variant="outline" to="/images">
              生成图片 <ArrowRight size={18} aria-hidden="true" />
            </RouteButton>
            <RouteButton variant="outline" to="/#agent-tools">
              接入 Agent <ArrowUpRight size={18} aria-hidden="true" />
            </RouteButton>
          </div>
        </div>
      </section>

      <section id="possibilities" className="home-section" aria-labelledby="products-title">
        <div className="home-section-heading">
          <h2 id="products-title">使用方式</h2>
          <p>日常对话与 API 调用，共用一个账户。</p>
        </div>
        <div className="home-products">
          <RouteButton className="home-product" to="/chat">
            <div className="home-product-title">
              <h3>网页对话</h3>
              <ArrowUpRight size={25} aria-hidden="true" />
            </div>
            <p>在浏览器中选择模型，发送消息并管理历史对话。</p>
            <span className="home-product-link">
              开始对话
              <ArrowRight size={16} aria-hidden="true" />
            </span>
          </RouteButton>
          <RouteButton className="home-product" to="/keys">
            <div className="home-product-title">
              <h3>API 接入</h3>
              <ArrowUpRight size={25} aria-hidden="true" />
            </div>
            <p>创建 API Key，将主流模型接入应用、Agent 和开发工具。</p>
            <span className="home-product-link">
              前往 API 接入
              <ArrowRight size={16} aria-hidden="true" />
            </span>
          </RouteButton>
        </div>
      </section>

      <AgentGuides />

      <section id="questions" className="home-section home-faq" aria-labelledby="faq-title">
        <div>
          <h2 id="faq-title">常见问题</h2>
        </div>
        <div className="home-faq-list">
          {questions.map(([question, answer]) => (
            <Disclosure key={question} title={question} className="home-faq-item">
              <p>{answer}</p>
            </Disclosure>
          ))}
        </div>
      </section>
    </>
  );
}
