import { useEffect, useState } from 'react';
import { Toast, type ToastTone } from '@shared/components/Toast';

/**
 * 全局 Toast：单实例、消息队列、纵向堆叠，供任意模块调用。
 * 解决页面级 Toast 多实例同位置重叠的问题。
 */

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<(items: ToastItem[]) => void>();

function emit() {
  for (const listener of listeners) listener([...items]);
}

function push(message: string, tone: ToastTone) {
  const id = nextId++;
  items = [...items, { id, message, tone }];
  emit();
  window.setTimeout(() => dismiss(id), tone === 'error' ? 5000 : 3200);
}

export function dismiss(id: number) {
  items = items.filter((item) => item.id !== id);
  emit();
}

export const toast = {
  success: (message: string) => push(message, 'success'),
  error: (message: string) => push(message, 'error'),
  info: (message: string) => push(message, 'info'),
};

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener = (next: ToastItem[]) => setList(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="toast-host" aria-live="polite">
      {list.map((item) => (
        <Toast
          key={item.id}
          message={item.message}
          tone={item.tone}
          duration={0}
          onClose={() => dismiss(item.id)}
        />
      ))}
    </div>
  );
}
