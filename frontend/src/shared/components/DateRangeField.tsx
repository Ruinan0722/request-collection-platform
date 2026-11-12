import { useEffect, useId, useMemo, useRef, useState } from 'react';

export type DateRangeValue = {
  from: string;
  to: string;
};

type Precision = 'day' | 'minute';

type Props = {
  label: string;
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  placeholder?: string;
  /** day=按自然日；minute=可精确到时分（创建时间） */
  precision?: Precision;
};

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function toYmd(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 取出日期部分 YYYY-MM-DD */
function ymdPart(value: string) {
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** 取出时分 HH:mm；缺省用 fallback */
function hmPart(value: string, fallback: string) {
  const m = value.trim().match(/[T\s](\d{2}:\d{2})(?::\d{2})?/);
  return m ? m[1] : fallback;
}

function joinDateTime(ymd: string, hm: string) {
  if (!ymd) return '';
  return `${ymd}T${hm}`;
}

function parseYmd(value: string) {
  const ymd = ymdPart(value);
  if (!ymd) return null;
  const date = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function formatBoundDisplay(value: string, precision: Precision) {
  const ymd = ymdPart(value);
  if (!ymd) return '';
  if (precision === 'day') return ymd;
  const hm = hmPart(value, '');
  return hm ? `${ymd} ${hm}` : ymd;
}

function formatRange(value: DateRangeValue, precision: Precision) {
  const from = formatBoundDisplay(value.from, precision);
  const to = formatBoundDisplay(value.to, precision);
  if (from && to) {
    if (from === to) return from;
    return `${from} 至 ${to}`;
  }
  if (from) return `${from} 起`;
  if (to) return `至 ${to}`;
  return '';
}

function buildMonthCells(month: Date) {
  const first = startOfMonth(month);
  // Monday-first grid
  const weekday = (first.getDay() + 6) % 7;
  const cells: Array<Date | null> = [];
  for (let i = 0; i < weekday; i += 1) cells.push(null);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), day));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function DateRangeField({
  label,
  value,
  onChange,
  placeholder = '选择时间段',
  precision = 'day',
}: Props) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const base = parseYmd(value.from) || parseYmd(value.to) || new Date();
    return startOfMonth(base);
  });
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [draftFromYmd, setDraftFromYmd] = useState('');
  const [draftToYmd, setDraftToYmd] = useState('');
  const [draftFromHm, setDraftFromHm] = useState('00:00');
  const [draftToHm, setDraftToHm] = useState('23:59');

  const display = formatRange(value, precision) || placeholder;
  const cells = useMemo(() => buildMonthCells(month), [month]);
  const withTime = precision === 'minute';

  useEffect(() => {
    if (!open) return;
    const base = parseYmd(value.from) || parseYmd(value.to) || new Date();
    setMonth(startOfMonth(base));
    setDraftStart(null);
    setHoverDay(null);
    setDraftFromYmd(ymdPart(value.from));
    setDraftToYmd(ymdPart(value.to));
    setDraftFromHm(hmPart(value.from, '00:00'));
    setDraftToHm(hmPart(value.to, '23:59'));
  }, [open, value.from, value.to]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setDraftStart(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setDraftStart(null);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const previewYmd = useMemo(() => {
    if (draftStart && hoverDay) {
      return draftStart <= hoverDay
        ? { from: draftStart, to: hoverDay }
        : { from: hoverDay, to: draftStart };
    }
    if (draftStart) return { from: draftStart, to: draftStart };
    if (draftFromYmd || draftToYmd) {
      return { from: draftFromYmd, to: draftToYmd || draftFromYmd };
    }
    return { from: ymdPart(value.from), to: ymdPart(value.to) };
  }, [draftStart, hoverDay, draftFromYmd, draftToYmd, value.from, value.to]);

  const applyDayRange = (fromYmd: string, toYmd: string) => {
    if (withTime) {
      setDraftFromYmd(fromYmd);
      setDraftToYmd(toYmd);
      setDraftStart(null);
      setHoverDay(null);
      return;
    }
    onChange({ from: fromYmd, to: toYmd });
    setDraftStart(null);
    setHoverDay(null);
    setOpen(false);
  };

  const pickDay = (day: Date) => {
    const ymd = toYmd(day);
    if (!draftStart) {
      setDraftStart(ymd);
      setHoverDay(ymd);
      return;
    }
    const from = draftStart <= ymd ? draftStart : ymd;
    const to = draftStart <= ymd ? ymd : draftStart;
    applyDayRange(from, to);
  };

  const commitMinuteRange = () => {
    let fromYmd = draftFromYmd;
    let toYmd = draftToYmd;
    if (!fromYmd && !toYmd) return;
    if (fromYmd && !toYmd) toYmd = fromYmd;
    if (!fromYmd && toYmd) fromYmd = toYmd;
    if (fromYmd > toYmd) {
      const tmp = fromYmd;
      fromYmd = toYmd;
      toYmd = tmp;
    }
    let fromHm = draftFromHm || '00:00';
    let toHm = draftToHm || '23:59';
    // 同一天且开始晚于结束时，自动对调时分
    if (fromYmd === toYmd && fromHm > toHm) {
      const tmp = fromHm;
      fromHm = toHm;
      toHm = tmp;
    }
    onChange({
      from: joinDateTime(fromYmd, fromHm),
      to: joinDateTime(toYmd, toHm),
    });
    setOpen(false);
  };

  const clearRange = () => {
    onChange({ from: '', to: '' });
    setDraftFromYmd('');
    setDraftToYmd('');
    setDraftFromHm('00:00');
    setDraftToHm('23:59');
    setDraftStart(null);
    setHoverDay(null);
    setOpen(false);
  };

  const monthLabel = `${month.getFullYear()}年${month.getMonth() + 1}月`;
  const hasValue = Boolean(value.from || value.to);

  return (
    <div className={`date-range-field${withTime ? ' is-minute' : ''}`} ref={rootRef}>
      <span className="filter-date-title" id={id}>
        {label}
      </span>
      <button
        type="button"
        className={`date-range-trigger${hasValue ? ' has-value' : ''}${open ? ' is-open' : ''}`}
        aria-labelledby={id}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{display}</span>
      </button>

      {open && (
        <div className="date-range-popover" role="dialog" aria-label={`${label}时间段`}>
          <div className="date-range-popover-head">
            <button
              type="button"
              className="date-range-nav"
              aria-label="上个月"
              onClick={() => setMonth((prev) => addMonths(prev, -1))}
            >
              ‹
            </button>
            <strong>{monthLabel}</strong>
            <button
              type="button"
              className="date-range-nav"
              aria-label="下个月"
              onClick={() => setMonth((prev) => addMonths(prev, 1))}
            >
              ›
            </button>
          </div>
          <p className="date-range-hint">
            {withTime
              ? draftStart
                ? '再点一次选择结束日期，然后调整时分'
                : '先选日期范围，再精确到时分'
              : draftStart
                ? '再点一次选择结束日期'
                : '先点开始日期，再点结束日期'}
          </p>
          <div className="date-range-weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="date-range-grid">
            {cells.map((day, index) => {
              if (!day) {
                return <span key={`empty-${index}`} className="date-range-day is-empty" />;
              }
              const ymd = toYmd(day);
              const inRange =
                previewYmd.from &&
                previewYmd.to &&
                ymd >= previewYmd.from &&
                ymd <= previewYmd.to;
              const isStart = previewYmd.from === ymd;
              const isEnd = previewYmd.to === ymd;
              const isToday = ymd === toYmd(new Date());
              return (
                <button
                  key={ymd}
                  type="button"
                  className={[
                    'date-range-day',
                    inRange ? 'is-in-range' : '',
                    isStart ? 'is-start' : '',
                    isEnd ? 'is-end' : '',
                    isToday ? 'is-today' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => pickDay(day)}
                  onMouseEnter={() => {
                    if (draftStart) setHoverDay(ymd);
                  }}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          {withTime && (
            <div className="date-range-time-fields">
              <label>
                开始
                <div className="date-range-time-row">
                  <input
                    type="date"
                    value={draftFromYmd}
                    onChange={(e) => setDraftFromYmd(e.target.value)}
                    aria-label="开始日期"
                  />
                  <input
                    type="time"
                    value={draftFromHm}
                    onChange={(e) => setDraftFromHm(e.target.value)}
                    aria-label="开始时间"
                  />
                </div>
              </label>
              <label>
                结束
                <div className="date-range-time-row">
                  <input
                    type="date"
                    value={draftToYmd}
                    onChange={(e) => setDraftToYmd(e.target.value)}
                    aria-label="结束日期"
                  />
                  <input
                    type="time"
                    value={draftToHm}
                    onChange={(e) => setDraftToHm(e.target.value)}
                    aria-label="结束时间"
                  />
                </div>
              </label>
            </div>
          )}

          <div className="date-range-popover-actions">
            <button type="button" className="btn-secondary" onClick={clearRange}>
              清空
            </button>
            {withTime ? (
              <button
                type="button"
                className="btn-primary"
                disabled={!draftFromYmd && !draftToYmd}
                onClick={commitMinuteRange}
              >
                确定
              </button>
            ) : (
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                关闭
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
