/**
 * dsh 原生 UI 组件（官方 seed 模块 @deepseek-ai/dsh-client-ui-primitives，
 * 与宿主视觉完全一致）。宿主未注册该模块（老版本 dsh）时静默回退到
 * 本 bundle 的等效实现——degrade-don't-crash，与插件整体降级哲学一致。
 */
import { createElement, type ReactNode } from 'react';
import { hostRequire } from '../env.js';

/* 官方原语模块无类型发布，透传组件的 props 面按调用点宽容处理（any 限定在本文件）。 */

// guarded require：宿主 loader 对未注册模块 throw，这里必须吞掉
let P: any = null;
try {
  P = hostRequire('@deepseek-ai/dsh-client-ui-primitives') as any;
} catch {
  P = null;
}

/** 原语透传 props（原生专属字段 variant/icon 在回退路径被剥离）。 */
export interface NPrimitiveProps {
  [key: string]: any;
  children?: ReactNode;
}

/** 原生 Button（size sm）优先；回退 .dsh-mem-btn 类按钮。 */
export function NButton(props: NPrimitiveProps) {
  if (P && P.Button) return createElement(P.Button, { size: 'sm', ...props });
  const rest = { ...props };
  const variant = rest.variant;
  const icon = rest.icon;
  delete rest.variant;
  delete rest.icon;
  const extra = variant === 'primary' ? ' dsh-mem-btn-primary' : variant === 'outline' ? ' dsh-mem-btn-outline' : '';
  rest.className = 'dsh-mem-btn' + extra + (rest.className ? ' ' + rest.className : '');
  if (icon) {
    rest.style = { display: 'inline-flex', alignItems: 'center', gap: 6, ...(rest.style || {}) };
    rest.children = [icon, rest.children];
  }
  return createElement('button', rest);
}

/** 原生 Input 优先；回退 .dsh-mem-input 类输入框。
 * 原生 Input 是 span>input 结构且 rest 摊给内层 input——布局属性（flex/minWidth
 * 等）必须路由到外层，否则搜索框在 flex 工具栏里不再撑满。 */
export function NInput(props: NPrimitiveProps) {
  if (P && P.Input) {
    const inner = { ...props };
    const layoutStyle = inner.style;
    delete inner.style;
    return createElement('span', { style: layoutStyle }, createElement(P.Input, inner));
  }
  const rest = { ...props };
  rest.className = 'dsh-mem-input' + (rest.className ? ' ' + rest.className : '');
  return createElement('input', rest);
}

/** 原生 Modal 优先；回退 .dsh-mem-rb-overlay/.dsh-mem-rb-modal 模态。 */
export function NModal(props: NPrimitiveProps) {
  if (props.open === false) return null;
  if (P && P.Modal) return createElement(P.Modal, { closeLabel: '关闭', ...props });
  return createElement(
    'div',
    {
      className: 'dsh-mem-rb-overlay',
      onClick: (e: MouseEvent) => {
        if (e.target === e.currentTarget && props.onClose) props.onClose();
      },
    },
    createElement(
      'div',
      { className: 'dsh-mem-rb-modal' },
      props.title
        ? createElement('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 10 } }, props.title)
        : null,
      props.children,
      props.footer
        ? createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
            props.footer,
          )
        : null,
    ),
  );
}

/* ── 原生 chevron 图标（primitives IconChevron*Outline14 优先；回退内联同款 path，
   path 逐字取自 dsh-client-ui-primitives lib/index.js——宿主在则跟随宿主更新） ── */

const CHEVRON_DOWN_14 =
  'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z';
const CHEVRON_RIGHT_14 =
  'M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z';

function iconFallback(d: string, props: NPrimitiveProps) {
  return createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', ...props },
    createElement('path', { d, fill: 'currentColor' }),
  );
}

/** 下向 chevron（原生芯片箭头同款）。 */
export function NIconChevronDown14(props: NPrimitiveProps) {
  if (P && P.IconChevronDownOutline14) return createElement(P.IconChevronDownOutline14, { size: 14, ...props });
  return iconFallback(CHEVRON_DOWN_14, props);
}

/** 右向 chevron（菜单行/披露/活动流行尾指示）。 */
export function NIconChevronRight14(props: NPrimitiveProps) {
  if (P && P.IconChevronRightOutline14) return createElement(P.IconChevronRightOutline14, { size: 14, ...props });
  return iconFallback(CHEVRON_RIGHT_14, props);
}

const COPY_16 =
  'M5.5 2A1.5 1.5 0 0 0 4 3.5V4h1v-.5a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H11v1h.5A1.5 1.5 0 0 0 13 12.5v-8A1.5 1.5 0 0 0 11.5 3h-6ZM3.5 5A1.5 1.5 0 0 0 2 6.5v6A1.5 1.5 0 0 0 3.5 14h6A1.5 1.5 0 0 0 11 12.5v-6A1.5 1.5 0 0 0 9.5 5h-6Z';
const TRASH_16 =
  'M6.5 1.5A1.5 1.5 0 0 1 8 0h0a1.5 1.5 0 0 1 1.5 1.5V2h3a.5.5 0 0 1 0 1h-.54l-.7 9.1A2.5 2.5 0 0 1 8.77 14.5H7.23a2.5 2.5 0 0 1-2.49-2.4L4.04 3H3.5a.5.5 0 0 1 0-1h3V1.5ZM5.05 3l.68 8.94a1.5 1.5 0 0 0 1.5 1.39h1.54a1.5 1.5 0 0 0 1.5-1.39L12 3H5.05ZM7 5.5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5Zm2.5.5a.5.5 0 0 0-1 0v5a.5.5 0 0 0 1 0V6Z';

function icon16(d: string, props: NPrimitiveProps) {
  return createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, ...props },
    createElement('path', { d, fill: 'currentColor' }),
  );
}

/** 复制图标（宿主 IconCopyOutline16 优先）。 */
export function NIconCopy14(props: NPrimitiveProps) {
  if (P && P.IconCopyOutline16) return createElement(P.IconCopyOutline16, { size: 14, ...props });
  return icon16(COPY_16, props);
}

/** 删除图标。 */
export function NIconTrash14(props: NPrimitiveProps) {
  if (P && P.IconTrashOutline16) return createElement(P.IconTrashOutline16, { size: 14, ...props });
  return icon16(TRASH_16, props);
}

const CHECK_16 =
  'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z';
const CLOSE_A = 'M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z';
const CLOSE_B = 'M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z';
const EDIT_16 =
  'M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z';
const REFRESH_16 =
  'M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z';

function icon16d(ds: string[], props: NPrimitiveProps) {
  return createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, ...props },
    ...ds.map((d) => createElement('path', { d, fill: 'currentColor' })),
  );
}

export function NIconCheck14(props: NPrimitiveProps) {
  if (P && P.IconCheckOutline16) return createElement(P.IconCheckOutline16, { size: 14, ...props });
  return icon16(CHECK_16, props);
}

export function NIconClose14(props: NPrimitiveProps) {
  if (P && P.IconCloseOutline16) return createElement(P.IconCloseOutline16, { size: 14, ...props });
  return icon16d([CLOSE_A, CLOSE_B], props);
}

export function NIconEdit14(props: NPrimitiveProps) {
  if (P && P.IconEditOutline16) return createElement(P.IconEditOutline16, { size: 14, ...props });
  return icon16(EDIT_16, props);
}

export function NIconRefresh14(props: NPrimitiveProps) {
  if (P && P.IconRefreshOutline16) return createElement(P.IconRefreshOutline16, { size: 14, ...props });
  return icon16(REFRESH_16, props);
}

const FOLDER_16 =
  'M1.5 4.5A1.5 1.5 0 0 1 3 3h3.086a1.5 1.5 0 0 1 1.06.44L8.5 4.793A.5.5 0 0 0 8.854 4.94L9.207 5.293A1.5 1.5 0 0 0 10.268 5.5H13A1.5 1.5 0 0 1 14.5 7v5A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4.5Z';

export function NIconFolder14(props: NPrimitiveProps) {
  if (P && P.IconFolderOpenOutline16) return createElement(P.IconFolderOpenOutline16, { size: 14, ...props });
  if (P && P.IconFolderClose16) return createElement(P.IconFolderClose16, { size: 14, ...props });
  return icon16(FOLDER_16, props);
}
