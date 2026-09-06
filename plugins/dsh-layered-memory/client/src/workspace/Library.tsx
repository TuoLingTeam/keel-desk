/**
 * 工作台·记忆库：资产活动流（L1 记忆 / L2 场景 / L3 画像按更新时间混排）。
 * 数据源：dsh-memory/asset-activity（每页 15 条，游标换页 + 类型/族/时间/关键词筛选）。
 * 展开后可直接改写正文（asset-update）或删除（asset-delete）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetActivityItem } from '../../../src/contract.js';
import { fmtAgoLocal, t, tpl, typeLabel } from '../i18n.js';
import type { RpcFn } from '../rpc.js';
import { S } from '../styles.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { NButton, NIconCheck14, NIconClose14, NIconCopy14, NIconEdit14, NIconRefresh14, NIconTrash14, NInput } from '../ui/primitives.js';
import { Segmented } from '../ui/controls.js';
import { Chevron, FamilyTag, KindTag, QuietEmpty, VerbTag } from './common.js';

const PAGE_LIMIT = 15;
const DEBOUNCE_MS = 300;

type KindFilter = '' | 'l1' | 'l2' | 'l3';
type FamilyFilter = '' | 'chat' | 'work';
type TimeFilter = '' | 'today' | 'd7' | 'd30';

function sinceFor(time: TimeFilter): number {
  if (time === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (time === 'd7') return Date.now() - 7 * 24 * 3600_000;
  if (time === 'd30') return Date.now() - 30 * 24 * 3600_000;
  return 0;
}

export function Library(props: { rpc: RpcFn }) {
  const rpc = props.rpc;
  const [items, setItems] = useState<AssetActivityItem[]>([]);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [hasNext, setHasNext] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AssetActivityItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('');
  const [family, setFamily] = useState<FamilyFilter>('');
  const [time, setTime] = useState<TimeFilter>('');

  // 请求序列号：快速连续筛选时丢弃过期响应
  const seqRef = useRef(0);

  const fetchPage = useCallback(
    (pageNo: number, cur: string | null) => {
      const token = ++seqRef.current;
      setLoading(true);
      setError(null);
      const payload: Record<string, unknown> = { limit: PAGE_LIMIT, cursor: cur ?? undefined };
      if (query.trim()) payload.query = query.trim();
      if (kind) payload.kind = kind;
      if (family) payload.family = family;
      const since = sinceFor(time);
      if (since > 0) payload.since = since;
      rpc('dsh-memory/asset-activity', payload)
        .then((r) => {
          if (token !== seqRef.current) return;
          setLoading(false);
          if (!r || !r.ok) {
            setError(r && r.error ? r.error.message : 'RPC error');
            return;
          }
          setItems(r.value.items);
          setPage(pageNo);
          setHasNext(!!r.value.nextCursor);
          setTruncated(!!r.value.truncated);
          setCursors((prev) => {
            const next = prev.slice(0, pageNo);
            next[0] = null;
            next[pageNo] = r.value.nextCursor;
            return next;
          });
          setExpandedId(null);
          setPendingDelete(null);
          setEditingId(null);
        })
        .catch((e: unknown) => {
          if (token !== seqRef.current) return;
          setLoading(false);
          setError(String((e && (e as Error).message) || e));
        });
    },
    [rpc, query, kind, family, time],
  );

  // 筛选变化重拉第一页；关键词输入经 300ms 防抖（FTS 检索不逐键打）
  useEffect(() => {
    const h = setTimeout(() => {
      fetchPage(1, null);
    }, query ? DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  const filtered = !!(query.trim() || kind || family || time);

  const copy = (item: AssetActivityItem) => {
    const text = item.title + '\n' + item.content;
    const done = () => {
      setCopiedId(item.id);
      setTimeout(() => {
        setCopiedId((cur) => (cur === item.id ? null : cur));
      }, 2000);
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) done();
        else setError(t('ws.copyFail'));
      } catch {
        setError(t('ws.copyFail'));
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  };

  const startEdit = (item: AssetActivityItem) => {
    setEditingId(item.id);
    setDraft(item.content);
    setPendingDelete(null);
    setError(null);
  };

  const saveItem = (item: AssetActivityItem) => {
    if (savingId) return;
    const next = draft.trim();
    if (!next) {
      setError(t('ws.editEmpty'));
      return;
    }
    if (next === item.content) {
      setEditingId(null);
      return;
    }
    setSavingId(item.id);
    setError(null);
    rpc('dsh-memory/asset-update', { id: item.id, content: next })
      .then((r) => {
        setSavingId(null);
        if (!r || !r.ok) {
          setError(r && r.error ? r.error.message : 'update failed');
          return;
        }
        setItems((prev) => prev.map((it) => (it.id === item.id ? r.value.item : it)));
        setEditingId(null);
      })
      .catch((e: unknown) => {
        setSavingId(null);
        setError(String((e && (e as Error).message) || e));
      });
  };

  const deleteItem = (item: AssetActivityItem) => {
    if (deletingId) return;
    setDeletingId(item.id);
    setError(null);
    rpc('dsh-memory/asset-delete', { id: item.id })
      .then((r) => {
        setDeletingId(null);
        setPendingDelete(null);
        if (!r || !r.ok) {
          setError(r && r.error ? r.error.message : 'delete failed');
          return;
        }
        setExpandedId(null);
        const lastOnPage = items.length <= 1;
        if (lastOnPage && page > 1) fetchPage(page - 1, cursors[page - 2] ?? null);
        else fetchPage(page, cursors[page - 1] ?? null);
      })
      .catch((e: unknown) => {
        setDeletingId(null);
        setError(String((e && (e as Error).message) || e));
      });
  };

  const metaRow = (label: string, value: string) => (
    <div key={label} style={{ display: 'contents' }}>
      <dt style={{ color: 'var(--dsh-mem-text-3)', fontSize: 12 }}>{label}</dt>
      <dd style={{ color: 'var(--dsh-mem-text-2)', fontSize: 12, margin: 0, wordBreak: 'break-all' }}>{value}</dd>
    </div>
  );

  const row = (item: AssetActivityItem) => {
    const open = expandedId === item.id;
    return (
      <div key={item.id} className={'dsh-mem-feed-row' + (open ? ' open' : '')}>
        <button
          className="dsh-mem-feed-head"
          aria-expanded={open}
          onClick={() => {
            setExpandedId(open ? null : item.id);
            if (open) {
              setEditingId(null);
              setPendingDelete(null);
            }
          }}
        >
          <VerbTag verb={item.verb} />
          <KindTag kind={item.kind} />
          <span className="dsh-mem-feed-title">{item.title}</span>
          <span className="dsh-mem-feed-time">{fmtAgoLocal(item.updatedAt) ?? '-'}</span>
          <Chevron />
        </button>
        {open ? (
          <div style={{ padding: '2px 2px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {editingId === item.id ? (
              <textarea
                className="dsh-mem-input"
                value={draft}
                onChange={(e) => { setDraft(e.target.value); }}
                rows={8}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  minHeight: 120,
                  maxHeight: 320,
                  padding: '10px 12px',
                  fontSize: 12.5,
                  lineHeight: '20px',
                  borderRadius: 10,
                  background: 'var(--dsh-mem-bg-inset)',
                  color: 'var(--dsh-mem-text-1)',
                  border: '1px solid var(--dsh-mem-border)',
                }}
              />
            ) : (
              <div
                style={{
                  background: 'var(--dsh-mem-bg-inset)',
                  border: '1px solid var(--dsh-mem-border)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  fontSize: 12.5,
                  lineHeight: '20px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--dsh-mem-text-1)',
                  maxHeight: 320,
                  overflowY: 'auto',
                }}
              >
                {item.content}
              </div>
            )}
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 14px', margin: 0 }}>
              {item.kind === 'l1' && item.scene ? metaRow(t('lib.meta.scene'), item.scene) : null}
              {item.kind === 'l1' && item.l1Type ? metaRow(t('lib.meta.type'), typeLabel(item.l1Type)) : null}
              {metaRow(t('lib.meta.created'), fmtAgoLocal(item.createdAt) ?? '-')}
              {metaRow(t('lib.meta.updated'), fmtAgoLocal(item.updatedAt) ?? '-')}
              {item.version !== null ? metaRow(t('lib.meta.version'), 'v' + item.version) : null}
              {item.sourceSession ? metaRow(t('lib.meta.source'), item.sourceSession) : null}
            </dl>
            <div style={{ ...S.flexRow }}>
              <FamilyTag family={item.family} />
              <div style={S.grow} />
              {editingId === item.id ? (
                <>
                  <NButton
                    icon={<NIconClose14 />}
                    onClick={() => { setEditingId(null); setDraft(item.content); }}
                    disabled={savingId === item.id}
                    title={t('ws.cancel')}
                  >
                    {t('ws.cancel')}
                  </NButton>
                  <NButton
                    variant="primary"
                    icon={<NIconCheck14 />}
                    disabled={savingId === item.id}
                    onClick={() => { saveItem(item); }}
                    title={t('ws.save')}
                  >
                    {savingId === item.id ? t('ws.saving') : t('ws.save')}
                  </NButton>
                </>
              ) : (
              <>
              <NButton
                icon={<NIconEdit14 />}
                onClick={() => { startEdit(item); }}
                title={t('ws.edit')}
              >
                {t('ws.edit')}
              </NButton>
              <NButton
                icon={<NIconCopy14 />}
                onClick={() => { copy(item); }}
                title={t('ws.copy')}
              >
                {copiedId === item.id ? t('ws.copied') : t('ws.copy')}
              </NButton>
              <NButton
                icon={<NIconTrash14 />}
                onClick={() => { setPendingDelete(item); }}
                title={t('ws.delete')}
              >
                {t('ws.delete')}
              </NButton>
              </>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="dsh-mem-panel">
      <section className="dsh-mem-block">
      <div style={S.toolbar}>
        <NInput
          style={{ flex: 1, minWidth: 160 }}
          placeholder={t('lib.search')}
          value={query}
          onChange={(e: { target: { value: string } }) => {
            setQuery(e.target.value);
          }}
        />
        <NButton
          icon={<NIconRefresh14 />}
          onClick={() => {
            fetchPage(page, cursors[page - 1] ?? null);
          }}
        >
          {t('ws.refresh')}
        </NButton>
      </div>
      <div style={{ ...S.toolbar, marginBottom: 8 }}>
        <Segmented
          value={kind}
          options={[
            { key: '', label: t('ws.all') },
            { key: 'l1', label: t('kind.l1') },
            { key: 'l2', label: t('kind.l2') },
            { key: 'l3', label: t('kind.l3') },
          ]}
          onChange={(k) => { setKind(k as KindFilter); }}
        />
        <Segmented
          value={family}
          options={[
            { key: '', label: t('ws.all') },
            { key: 'chat', label: t('scope.chat') },
            { key: 'work', label: t('scope.work') },
          ]}
          onChange={(k) => { setFamily(k as FamilyFilter); }}
        />
        <Segmented
          value={time}
          options={[
            { key: '', label: t('ws.all') },
            { key: 'today', label: t('lib.time.today') },
            { key: 'd7', label: t('lib.time.d7') },
            { key: 'd30', label: t('lib.time.d30') },
          ]}
          onChange={(k) => { setTime(k as TimeFilter); }}
        />
      </div>
      <div style={{ ...S.flexRow, marginBottom: 8 }}>
        <span style={S.muted}>
          {loading ? t('ws.loading') : tpl(filtered ? 'lib.countFiltered' : 'lib.count', { n: items.length, page })}
        </span>
      </div>
      {error ? (
        <div style={{ ...S.flexRow, justifyContent: 'space-between', marginTop: 0, marginBottom: 8 }}>
          <span style={{ color: 'var(--dsh-mem-danger)', fontSize: 13 }}>{error}</span>
          {items.length > 0 ? (
            <NButton
              icon={<NIconRefresh14 />}
              onClick={() => {
                fetchPage(page, cursors[page - 1] ?? null);
              }}
            >
              {t('ws.retry')}
            </NButton>
          ) : null}
        </div>
      ) : null}
      {truncated ? <div style={{ ...S.hint, marginTop: 0 }}>{t('lib.truncated')}</div> : null}
      {items.length === 0 && !loading && !error ? (
        <QuietEmpty title={t('lib.empty')} body={t('lib.emptyHint')} />
      ) : (
        <div>{items.map(row)}</div>
      )}
      {page > 1 || hasNext ? (
        <div style={{ ...S.flexRow, marginTop: 12, justifyContent: 'flex-end' }}>
          <NButton
            disabled={loading || page <= 1}
            onClick={() => {
              fetchPage(page - 1, cursors[page - 2] ?? null);
            }}
          >
            {t('lib.prev')}
          </NButton>
          <span style={S.muted}>{tpl('lib.page', { n: page })}</span>
          <NButton
            disabled={loading || !hasNext}
            onClick={() => {
              fetchPage(page + 1, cursors[page] ?? null);
            }}
          >
            {t('lib.next')}
          </NButton>
        </div>
      ) : null}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('ws.deleteConfirm')}
        body={pendingDelete ? tpl('ws.deleteBody', { s: pendingDelete.title }) : null}
        confirmLabel={t('ws.deleteNow')}
        busy={!!deletingId}
        onCancel={() => { setPendingDelete(null); }}
        onConfirm={() => {
          if (pendingDelete) deleteItem(pendingDelete);
        }}
      />
      </section>
    </div>
  );
}
