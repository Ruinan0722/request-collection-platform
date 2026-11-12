import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@shared/api/client';
import type { Project } from '@shared/types/domain';
import { logger } from '@shared/logger/index';
import { toast } from '@shared/toast';

const log = logger.child({ module: 'projects' });

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get<Project[]>('/projects');
      setProjects(data);
      setError(null);
    } catch (err) {
      log.error('加载项目失败', err);
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post<Project>('/projects', { name, description });
      const createdName = name;
      setName('');
      setDescription('');
      await load();
      toast.success(`项目「${createdName}」已创建`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="page">
      <header className="section-head">
        <div>
          <h1>项目看板</h1>
          <p className="lead">以项目为单元管理需求流转，点击进入对应看板。</p>
        </div>
      </header>

      <form className="panel-form" onSubmit={onCreate}>
        <h2>新建项目</h2>
        <label>
          项目名称
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={128} />
        </label>
        <label>
          描述
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        <button type="submit" disabled={creating}>{creating ? '创建中...' : '创建项目'}</button>
      </form>

      {loading && <p>加载中...</p>}
      {error && <p className="error-text">{error}</p>}

      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id}>
            <Link to={`/projects/${p.id}`} className="project-link">
              <strong>{p.name}</strong>
              <span>{p.requirementCount} 个需求</span>
            </Link>
            {p.description && <p>{p.description}</p>}
          </li>
        ))}
      </ul>
      {!loading && projects.length === 0 && <p className="hint">暂无项目，先创建一个吧。</p>}
    </main>
  );
}
