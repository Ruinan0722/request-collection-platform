import type { ProgressNode } from '@shared/types/domain';

interface Props {
  nodes?: ProgressNode[];
}

function formatDateTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  // 转换时间只到分，不展示秒
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nodeHint(node: ProgressNode) {
  if (node.state === 'pending') return '未到达';
  if (node.state === 'current') return '当前节点';
  return '已完成';
}

export function ProgressTimeline({ nodes = [] }: Props) {
  if (!nodes.length) return null;

  const onlyWont = nodes.length === 1 && nodes[0]?.code === 'wont_impl';

  return (
    <section
      className={`progress-timeline${onlyWont ? ' is-wont-only' : ''}`}
      aria-label="需求进度节点"
    >
      <h2>进度节点</h2>
      <ol>
        {nodes.map((node, index) => {
          const entered = formatDateTime(node.enteredAt);
          const next = nodes[index + 1];
          const showRail = Boolean(next);
          const duration = node.state !== 'pending' ? node.durationLabel : null;
          // 连线上展示本节点耗时；末节点 / 窄屏无连线时回退到节点下方
          const railDuration = showRail && duration ? duration : null;
          const fallbackDuration = (!showRail || onlyWont) && duration ? duration : null;

          return (
            <li
              key={node.code}
              className={`progress-node is-${node.state}${node.code === 'wont_impl' ? ' is-wont' : ''}`}
            >
              <span className="dot" aria-hidden />
              <div>
                <strong>{node.label}</strong>
                <em>{nodeHint(node)}</em>
                {entered && <span className="progress-node-meta">进入 {entered}</span>}
                {fallbackDuration && (
                  <span className="progress-node-meta">
                    {node.state === 'current' ? '已耗时' : '耗时'} {fallbackDuration}
                  </span>
                )}
                {duration && showRail && (
                  <span className="progress-node-meta progress-node-duration-fallback">
                    {node.state === 'current' ? '已耗时' : '耗时'} {duration}
                  </span>
                )}
              </div>
              {showRail && (
                <span className={`rail${railDuration ? ' has-duration' : ''}`}>
                  {railDuration && <span className="rail-duration">{railDuration}</span>}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
