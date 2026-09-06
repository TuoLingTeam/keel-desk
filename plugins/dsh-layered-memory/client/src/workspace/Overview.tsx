/**
 * 工作台·总览：健康摘要 + 最近活动 + 关键数字。
 * 区块靠 inset 表面与留白分层，不加描边。
 */
import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceOverviewResponse } from '../../../src/contract.js';
import { fmtAgoLocal, fmtAgoParts, t, tpl } from '../i18n.js';
import type { RpcFn } from '../rpc.js';
import { S } from '../styles.js';
import { NButton, NIconEdit14, NIconFolder14, NIconRefresh14 } from '../ui/primitives.js';
import { ErrorBlock, KindTag, QuietEmpty, VerbTag, fmtTokensCompact } from './common.js';

const POLL_MS = 15_000;

export function Overview(props: { rpc: RpcFn; onNavigate?(tab: string): void }) {
  const rpc = props.rpc;
  const [data, setData] = useState<WorkspaceOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    rpc('dsh-memory/workspace-overview', {})
      .then((r) => {
        if (r && r.ok) setData(r.value);
        else setError(r && r.error ? r.error.message : 'RPC error');
      })
      .catch((e: unknown) => {
        setError(String((e && (e as Error).message) || e));
      });
  }, [rpc]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  if (!data) {
    return error ? <ErrorBlock msg={error} onRetry={load} /> : <p style={S.intro}>{t('ws.loading')}</p>;
  }

  if (data.empty) {
    return <QuietEmpty title={t('ov.empty.title')} body={t('ov.empty.body')} />;
  }

  const vectorDegraded = data.retrieval === 'keyword';
  const warn = data.degraded || vectorDegraded;
  const title = data.degraded ? t('ov.runningDown') : warn ? t('ov.runningWarn') : t('ov.runningOk');
  const store = data.degraded ? t('mt.store.down') : t('ov.sys.ok');
  const retrieval =
    data.retrieval === 'hybrid'
      ? t('mt.retrieval.hybrid')
      : data.retrieval === 'keyword'
        ? t('ov.sys.keyword')
        : data.retrieval === 'vector'
          ? t('ov.sys.vectorOnly')
          : t('ov.sys.none');
  const queue =
    data.pendingExtract > 0 ? tpl('ov.sys.pending', { n: data.pendingExtract }) : t('ov.sys.idle');
  const pills = [
    { label: t('ov.subsys.store'), value: store },
    { label: t('ov.subsys.vec'), value: retrieval },
    { label: t('ov.subsys.queue'), value: queue },
  ];
  const weekOut = data.week ? data.week.outputTokens + data.week.reasoningTokens : 0;
  const go = (tab: string) => {
    props.onNavigate?.(tab);
  };
  const metrics = [
    {
      key: 'mem',
      tone: 'mem',
      icon: <NIconEdit14 />,
      label: t('ov.kg.l1'),
      hint: t('ov.kg.l1Hint'),
      value: String(data.l1Count),
      sub: data.pendingExtract > 0 ? tpl('ov.kg.pending', { n: data.pendingExtract }) : undefined,
      tab: 'library',
      muted: false,
    },
    {
      key: 'scene',
      tone: 'scene',
      icon: <NIconFolder14 />,
      label: t('ov.kg.scenes'),
      hint: t('ov.kg.scenesHint'),
      value: data.sceneCount > 0 ? String(data.sceneCount) : t('ov.kg.scenesEmpty'),
      tab: 'library',
      muted: data.sceneCount === 0,
    },
    {
      key: 'week',
      tone: 'week',
      icon: <NIconRefresh14 />,
      label: t('ov.kg.week'),
      hint: t('ov.kg.weekHint'),
      value: data.week ? fmtTokensCompact(weekOut) : '0',
      sub: data.week ? tpl('ov.kg.weekSub', { n: data.week.calls }) : t('ov.kg.weekIdle'),
      tab: 'insights',
      muted: !data.week,
    },
    {
      key: 'time',
      tone: 'time',
      icon: <NIconRefresh14 />,
      label: t('ov.kg.lastDistill'),
      hint: t('ov.kg.lastHint'),
      value: fmtAgoLocal(data.lastExtractAt) ?? t('ov.kg.never'),
      valueParts: fmtAgoParts(data.lastExtractAt),
      tab: 'maintenance',
      muted: !data.lastExtractAt,
    },
  ];
  const dot = data.degraded ? 'err' : warn ? 'warn' : 'ok';

  return (
    <div className="dsh-mem-panel">
      <section className="dsh-mem-block">
        <div className="dsh-mem-block-head">
          <div className="dsh-mem-health">
            <div className="dsh-mem-health-title">
              <span className={'dsh-mem-health-dot ' + dot} aria-hidden="true" />
              <h3>{title}</h3>
            </div>
            <div className="dsh-mem-health-pills">
              {pills.map((pill) => (
                <span key={pill.label} className="dsh-mem-health-pill">
                  <b>{pill.label}</b>
                  {pill.value}
                </span>
              ))}
            </div>
          </div>
          <NButton icon={<NIconRefresh14 />} onClick={load}>{t('ws.refresh')}</NButton>
        </div>
      </section>

      <section className="dsh-mem-block">
        <div className="dsh-mem-block-head">
          <h3 className="dsh-mem-block-title">{t('ov.recent')}</h3>
        </div>
        {data.recent.length > 0 ? (
          <div className="dsh-mem-activity">
            {data.recent.map((item) => (
              <div key={item.id} className="dsh-mem-activity-row">
                <VerbTag verb={item.verb} />
                <KindTag kind={item.kind} />
                <span className="dsh-mem-activity-title">{item.title}</span>
                <span className="dsh-mem-activity-time">{fmtAgoLocal(item.updatedAt) ?? '—'}</span>
              </div>
            ))}
          </div>
        ) : (
          <p style={S.muted}>—</p>
        )}
      </section>

      <section className="dsh-mem-metrics">
        {metrics.map((item) => {
          const clickable = !!props.onNavigate;
          const cls = 'dsh-mem-metric' + (clickable ? ' dsh-mem-metric-click' : '') + (item.muted ? ' dsh-mem-metric-muted' : '');
          const inner = (
            <>
              <div className="dsh-mem-metric-top">
                <span className="dsh-mem-metric-ico" aria-hidden="true">{item.icon}</span>
                <span className="dsh-mem-metric-copy">
                  <div className="dsh-mem-metric-label">{item.label}</div>
                  <div className="dsh-mem-metric-hint">{item.hint}</div>
                </span>
              </div>
              <div className="dsh-mem-metric-value">
                {item.valueParts && item.valueParts.unit ? (
                  <>
                    {item.valueParts.n}
                    <span className="dsh-mem-metric-unit">{item.valueParts.unit.trim()}</span>
                  </>
                ) : (
                  item.value
                )}
              </div>
              {item.sub ? <div className="dsh-mem-metric-sub">{item.sub}</div> : null}
            </>
          );
          return clickable ? (
            <button
              key={item.key}
              type="button"
              className={cls}
              data-tone={item.tone}
              onClick={() => { go(item.tab); }}
            >
              {inner}
            </button>
          ) : (
            <div key={item.key} className={cls} data-tone={item.tone}>
              {inner}
            </div>
          );
        })}
      </section>
    </div>
  );
}
