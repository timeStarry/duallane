import { ArrowLeft, ChevronDown, GitBranch, LockKeyhole, ShieldCheck } from "lucide-react";
import { CURRENT_RELEASE, DUAL_LANE_RELEASES, type DualLaneRelease } from "./releases";

type AboutPageProps = {
  onBack: () => void;
};

export function AboutPage({ onBack }: AboutPageProps) {
  return (
    <section className="about-page page-enter" aria-labelledby="about-title">
      <header className="about-header">
        <button className="icon-button" type="button" title="返回首页" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <a className="about-brand" href="/" onClick={(event) => { event.preventDefault(); onBack(); }}>
          <img src="/icon-512.png" alt="" aria-hidden="true" />
          <span>DualLane</span>
        </a>
      </header>

      <div className="about-intro">
        <p className="eyebrow">关于 DualLane</p>
        <h1 id="about-title">两种边界，一处沟通。</h1>
        <p>临时内容留在浏览器之间，长期协作进入受权限和审计约束的共享空间。</p>
      </div>

      <div className="about-lanes" aria-label="DualLane 通信通道">
        <article>
          <LockKeyhole size={20} aria-hidden="true" />
          <div>
            <h2>私密直连</h2>
            <p>无需账号，通过浏览器间的加密连接传递消息和文件。服务器只转发经校验的安全信封，不保存聊天明文。</p>
          </div>
        </article>
        <article>
          <ShieldCheck size={20} aria-hidden="true" />
          <div>
            <h2>共享空间</h2>
            <p>面向持续协作的成员空间。消息与文件由服务端保存，并执行权限、配额、保留和审计规则。</p>
          </div>
        </article>
      </div>

      <section className="about-releases" aria-labelledby="release-title">
        <div className="about-section-heading">
          <GitBranch size={20} aria-hidden="true" />
          <div>
            <h2 id="release-title">版本更新</h2>
            <p>当前版本与历史变化均在这里维护。</p>
          </div>
        </div>
        <ReleaseDetails release={CURRENT_RELEASE} latest />
        <details className="release-history">
          <summary>
            <span>查看历史版本</span>
            <ChevronDown size={18} aria-hidden="true" />
          </summary>
          <ol className="release-timeline">
            {DUAL_LANE_RELEASES.slice(1).map((release, index) => (
              <li key={release.version} style={{ "--timeline-order": index } as React.CSSProperties}>
                <ReleaseDetails release={release} />
              </li>
            ))}
          </ol>
        </details>
      </section>
    </section>
  );
}

function ReleaseDetails({ release, latest = false }: { release: DualLaneRelease; latest?: boolean }) {
  const content = (
    <div className="release-content">
      <div className="release-heading">
        <div>
          <span className="release-version">v{release.version}</span>
          {latest && <span className="release-current">当前版本</span>}
        </div>
        <time dateTime={release.releasedAt}>{release.releasedAt}</time>
      </div>
      <h3>{release.title}</h3>
      <p>{release.summary}</p>
      <div className="release-categories">
        {release.categories.map((category) => (
          <section key={category.title}>
            <h4>{category.title}</h4>
            <ul>
              {category.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );

  if (latest) return <article className="release-card latest-release">{content}</article>;
  return (
    <details className="release-card historical-release">
      <summary>
        <span><strong>v{release.version}</strong>{release.title}</span>
        <time dateTime={release.releasedAt}>{release.releasedAt}</time>
      </summary>
      {content}
    </details>
  );
}
