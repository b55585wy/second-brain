import { useCallback, useEffect, useState } from 'react';

export function useApi<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loader().then((result) => {
      if (active) setData(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error('加载失败'));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
    // The caller controls reload semantics through explicit dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, version]);

  return { data, error, loading, reload, setData };
}

export function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
