import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";

type EntryPageProps = {
  onDirect: () => void;
  onWorkspace: () => void;
  onAbout: () => void;
};

/** Lane choice is a privacy decision; keep its promises visible before entry. */
export function EntryPage({ onDirect, onWorkspace, onAbout }: EntryPageProps) {
  return (
    <section className="entry page-enter" aria-labelledby="entry-title">
      <div className="entry-heading">
        <div className="entry-brand" aria-label="DualLane"><span aria-hidden="true" /><span aria-hidden="true" /> DualLane</div>
        <p className="eyebrow">两种连接，一处交流</p>
        <h1 id="entry-title">选择沟通方式</h1>
        <p className="entry-description">临时私密交谈，或与熟悉的人持续协作。</p>
      </div>
      <div className="lane-grid" aria-label="通信通道">
        <button className="lane-choice direct-choice" type="button" onClick={onDirect}>
          <span className="lane-icon" aria-hidden="true"><LockKeyhole size={24} /></span>
          <span className="lane-choice-label">私密通道</span>
          <strong>一对一直连</strong>
          <span>无需登录，用邀请链接开始。<br />对话内容不在服务器保存。</span>
          <span className="lane-choice-action">开始临时会话 <ArrowRight size={17} aria-hidden="true" /></span>
        </button>
        <button className="lane-choice workspace-choice" type="button" onClick={onWorkspace}>
          <span className="lane-icon" aria-hidden="true"><ShieldCheck size={24} /></span>
          <span className="lane-choice-label">共享通道</span>
          <strong>共享空间</strong>
          <span>和熟人或小组持续聊天、共享文件。<br />需要登录和邀请，内容按空间规则保留。</span>
          <span className="lane-choice-action">进入共享空间 <ArrowRight size={17} aria-hidden="true" /></span>
        </button>
      </div>
      <button className="entry-about-link" type="button" onClick={onAbout}>关于 DualLane 与版本更新</button>
    </section>
  );
}
