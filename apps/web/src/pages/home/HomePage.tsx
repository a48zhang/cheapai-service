import { ThemePicker } from '@cheapai/theme';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowRight, ArrowUpRight, Check, Copy, Menu, Plus, X } from 'lucide-react';
import { BrandLink } from '../../shared/ui/BrandLink';
import { BrandMark } from '../../shared/ui/BrandMark';
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
        {"role": "user", "content": "让想法，向前一步。"}
    ],
)

print(response.choices[0].message.content)`;

const questions = [
  [
    'CheapAI 有什么不同？',
    'CheapAI 以极低价格提供多种主流旗舰模型，让你以更低成本使用强大的 AI 能力。你可以直接在网页中对话，也可以通过 API 接入自己的应用；两种方式共用账户余额。',
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
            <Link className="home-button home-button-dark home-header-cta" to="/chat">
              开始使用
              <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
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
              开始使用
              <ArrowUpRight size={16} />
            </Link>
          </nav>
        )}
      </header>

      <main id="home-main">
        <section className="home-hero" aria-labelledby="hero-title">
          <p className="home-eyebrow">
            <span className="home-dot" /> FLAGSHIP AI. SMALLER BILLS.
          </p>
          <h1 id="hero-title">
            旗舰模型，
            <br />
            <span>极低价格。</span>
          </h1>
          <p className="home-hero-description">
            CheapAI 以极低价格，提供多种主流旗舰模型。
            <br />
            无论日常对话，还是 API 开发，让强大 AI 触手可及。
          </p>
          <div className="home-hero-actions">
            <Link className="home-button home-button-dark" to="/chat">
              开始对话
              <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
            <a className="home-text-link" href="#developers">
              探索 API
              <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <div className="home-art" aria-hidden="true">
            <div className="home-art-grid" />
            <div className="home-orbit home-orbit-one" />
            <div className="home-orbit home-orbit-two" />
            <div className="home-orbit home-orbit-three" />
            <div className="home-art-glow" />
            <div className="home-art-caption">
              <span>MORE INTELLIGENCE. LESS COST.</span>
              <span>旗舰级能力，更轻的成本。</span>
            </div>
            <span className="home-art-index">01 — EXPLORE</span>
          </div>
          <a className="home-explore" href="#possibilities">
            向下探索
            <ArrowDown size={15} aria-hidden="true" />
          </a>
        </section>

        <section id="possibilities" className="home-section" aria-labelledby="products-title">
          <div className="home-section-heading">
            <p className="home-eyebrow">01 / POSSIBILITIES</p>
            <h2 id="products-title">
              多种旗舰模型，
              <br />
              两种使用方式。
            </h2>
            <p>
              用自然语言探索，用代码构建。
              <br />
              让低成本的 AI 能力，融入你的日常。
            </p>
          </div>
          <div className="home-products">
            <Link className="home-product" to="/chat">
              <div className="home-product-art home-chat-art" aria-hidden="true">
                <span className="home-demo-label">对话示意</span>
                <div className="home-chat-question">有一个想法，想和你聊聊。</div>
                <div className="home-chat-answer">
                  <BrandMark className="home-mini-brand" />
                  <div>
                    当然。我们从哪里开始？
                    <span className="home-answer-line" />
                    <span className="home-answer-line short" />
                  </div>
                </div>
                <div className="home-chat-input">
                  <span>让灵感继续…</span>
                  <span className="home-send">
                    <ArrowUpRight size={18} />
                  </span>
                </div>
              </div>
              <div className="home-product-title">
                <h3>把问题，聊成思路。</h3>
                <ArrowUpRight size={25} aria-hidden="true" />
              </div>
              <p>
                写作、编程、梳理灵感。在持续的对话中，
                <br className="home-desktop-break" />
                找到值得继续的方向。
              </p>
              <span className="home-product-link">
                探索网页对话
                <ArrowRight size={16} aria-hidden="true" />
              </span>
            </Link>
            <Link className="home-product" to="/keys">
              <div className="home-product-art home-api-art" aria-hidden="true">
                <span className="home-demo-label">连接你的应用</span>
                <div className="home-api-line" />
                <div className="home-api-node home-api-source">你的应用</div>
                <div className="home-api-hub">
                  <BrandMark className="home-hub-mark" />
                  <span>CheapAI</span>
                </div>
                <div className="home-api-node home-api-target">旗舰模型</div>
                <span className="home-api-tag">ONE API. MORE POSSIBILITIES.</span>
              </div>
              <div className="home-product-title">
                <h3>把能力，写进产品。</h3>
                <ArrowUpRight size={25} aria-hidden="true" />
              </div>
              <p>
                创建 API Key，将可用模型连接到你的应用。
                <br className="home-desktop-break" />
                让下一次构建，从这里开始。
              </p>
              <span className="home-product-link">
                探索 API 接入
                <ArrowRight size={16} aria-hidden="true" />
              </span>
            </Link>
          </div>
        </section>

        <section id="developers" className="home-developers" aria-labelledby="developers-title">
          <div className="home-developer-inner">
            <div className="home-developer-copy">
              <p className="home-eyebrow">02 / BUILT FOR BUILDERS</p>
              <h2 id="developers-title">
                更低的成本。
                <br />
                新的可能。
              </h2>
              <p>
                通过兼容的 API 接入多种主流旗舰模型。
                <br />
                少一些成本顾虑，多一些构建可能。
              </p>
              <Link className="home-button home-button-light" to="/keys">
                获取 API Key
                <ArrowUpRight size={17} aria-hidden="true" />
              </Link>
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
            <p className="home-eyebrow">03 / GOOD TO KNOW</p>
            <h2 id="faq-title">
              开始之前，
              <br />
              你可能想了解。
            </h2>
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
        <section className="home-closing" aria-labelledby="closing-title">
          <p className="home-eyebrow">YOUR NEXT CHAPTER</p>
          <h2 id="closing-title">让旗舰 AI，不再昂贵。</h2>
          <Link className="home-button home-button-dark" to="/chat">
            开始使用 CheapAI
            <ArrowUpRight size={17} aria-hidden="true" />
          </Link>
        </section>
      </main>
      <footer className="home-footer">
        <BrandLink className="home-brand" />
        <p>旗舰 AI，轻量成本。</p>
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
