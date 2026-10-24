import { ThemePicker } from '@cheapai/theme';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Check, Copy, Menu, Plus, X } from 'lucide-react';
import { BrandLink } from '../../shared/ui/BrandLink';
import { Button } from '../../shared/ui/Button';
import { useSession } from '../../features/session/useSession';
import './home.css';

const example = `from openai import OpenAI

client = OpenAI(
    base_url="https://YOUR_DOMAIN/v1",
    api_key="YOUR_API_KEY",
)

response = client.chat.completions.create(
    model="YOUR_MODEL",
    messages=[
        {"role": "user", "content": "帮我整理这段代码的改进建议。"}
    ],
)

print(response.choices[0].message.content)`;

const questions = [
  [
    'CheapAI 提供什么？',
    '你可以直接在网页中对话，也可以通过 API 接入自己的应用；两种方式共用账户余额。',
  ],
  [
    '支持哪些模型？',
    '可用模型取决于平台配置和你的账户授权。登录后，可以在聊天页查看当前可选模型，在 API 接入页查看接入信息。',
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copyExample() {
    try {
      await navigator.clipboard.writeText(example);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="home-page">
      <a className="home-skip" href="#home-main">
        跳到主要内容
      </a>
      <header className="home-header">
        <div className="home-header-inner">
          <BrandLink className="home-brand" />
          <nav aria-label="首页导航" className="home-desktop-nav">
            <a href="#possibilities">产品</a>
            <a href="#developers">开发者</a>
            <a href="#questions">常见问题</a>
          </nav>
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
            <button
              type="button"
              className="home-menu-toggle"
              aria-label={menuOpen ? '关闭导航' : '打开导航'}
              aria-expanded={menuOpen}
              aria-controls="home-mobile-nav"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="home-mobile-nav"
            aria-label="移动端首页导航"
            className="home-mobile-nav"
            onClick={() => setMenuOpen(false)}
          >
            <a href="#possibilities">
              产品
              <ArrowUpRight size={16} />
            </a>
            <a href="#developers">
              开发者
              <ArrowUpRight size={16} />
            </a>
            <a href="#questions">
              常见问题
              <ArrowUpRight size={16} />
            </a>
            <Link to="/chat">
              开始对话
              <ArrowUpRight size={16} />
            </Link>
          </nav>
        )}
      </header>

      <main id="home-main">
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
                <Link to="/keys">
                  API 接入 <ArrowUpRight size={18} aria-hidden="true" />
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

        <section id="developers" className="home-developers" aria-labelledby="developers-title">
          <div className="home-developer-inner">
            <div className="home-developer-copy">
              <h2 id="developers-title">用熟悉的方式接入模型</h2>
              <p>兼容常用 API 协议。配置接口地址、密钥和模型，即可在现有应用中开始调用。</p>
              <Button asChild variant="outline">
                <Link to="/keys">
                  获取 API Key
                  <ArrowUpRight size={17} aria-hidden="true" />
                </Link>
              </Button>
              <div className="home-protocols">
                <span>Chat Completions</span>
                <span>Responses</span>
                <span>Messages</span>
              </div>
              <p className="home-developer-note">具体能力以所选模型和平台配置为准。</p>
            </div>
            <div className="home-code-panel">
              <div className="home-code-header">
                <span>
                  <span className="home-code-dot" /> quickstart.py
                </span>
                <button
                  type="button"
                  onClick={() => void copyExample()}
                  aria-label="复制 Python 示例"
                >
                  {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
                  <span>{copyState === 'copied' ? '已复制' : '复制'}</span>
                </button>
              </div>
              <pre tabIndex={0} aria-label="Python API 接入示例">
                <code>{example}</code>
              </pre>
              <div className="home-code-footer" role="status">
                {copyState === 'failed'
                  ? '未能复制，请选中上方代码手动复制。'
                  : '将域名、API Key 和模型替换为你的实际配置。'}
              </div>
            </div>
          </div>
        </section>

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
      </main>
      <footer className="home-footer">
        <BrandLink className="home-brand" />
        <p>对话 · API · 用量与费用</p>
        <nav aria-label="页脚导航">
          <Link to="/chat">对话</Link>
          <Link to="/keys">API 接入</Link>
          <a href="#questions">常见问题</a>
        </nav>
        <span>© {new Date().getFullYear()} CheapAI</span>
      </footer>
    </div>
  );
}
