/**
 * 破坏性操作的共享确认框：记忆库删除、维护区重建等都走这里，
 * 不再在行内把按钮换成「取消 / 确认删除」。
 */
import type { ReactNode } from 'react';
import { t } from '../i18n.js';
import { NButton, NIconCheck14, NIconClose14, NModal } from './primitives.js';

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  busy?: boolean;
  busyLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelLabel = props.cancelLabel ?? t('ws.cancel');
  const busy = !!props.busy;
  return (
    <NModal
      open={props.open}
      onClose={() => {
        if (!busy) props.onCancel();
      }}
      title={props.title}
      footer={[
        <NButton
          key="cancel"
          icon={<NIconClose14 />}
          disabled={busy}
          onClick={() => {
            if (!busy) props.onCancel();
          }}
        >
          {cancelLabel}
        </NButton>,
        <NButton
          key="confirm"
          variant="primary"
          icon={<NIconCheck14 />}
          disabled={busy}
          onClick={props.onConfirm}
          style={props.confirmVariant === 'primary' ? undefined : { background: 'var(--dsh-mem-danger)', borderColor: 'var(--dsh-mem-danger)' }}
        >
          {busy ? (props.busyLabel ?? t('ws.deleting')) : props.confirmLabel}
        </NButton>,
      ]}
    >
      {props.body ?? null}
    </NModal>
  );
}
