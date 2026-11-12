import { useEffect, useRef } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastProps {
  message: string | null;
  tone?: ToastTone;
  onClose: () => void;
  duration?: number;
}

export function Toast({ message, tone = 'success', onClose, duration = 3200 }: ToastProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!message || duration <= 0) return;
    const timer = window.setTimeout(() => onCloseRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration, message]);

  if (!message) return null;

  return (
    <div
      className={`toast toast-${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <span className="toast-icon" aria-hidden="true">
        {tone === 'success' ? '✓' : tone === 'error' ? '!' : 'i'}
      </span>
      <span className="toast-message">{message}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label="关闭提示">
        ×
      </button>
    </div>
  );
}
