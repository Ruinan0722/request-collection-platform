/** 优先级越高 rank 越小：P0 → P1 → P2 → P3 → 未评定 */
const PRIORITY_RANK: Record<string, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
  unset: 4,
};

export function priorityRank(priority?: string | null): number {
  return PRIORITY_RANK[(priority || 'unset').toLowerCase()] ?? 99;
}

export function sortByPriority<T extends { priority?: string | null; dueDate?: string | null; createdAt?: string | null }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const dueA = a.dueDate || '9999';
    const dueB = b.dueDate || '9999';
    if (dueA !== dueB) return dueA < dueB ? -1 : 1;
    const ca = a.createdAt || '';
    const cb = b.createdAt || '';
    if (ca !== cb) return ca > cb ? -1 : 1;
    return 0;
  });
}
