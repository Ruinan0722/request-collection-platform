import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '../logger';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  message?: string;
}

/** React 渲染错误边界：捕获组件树异常并写入日志 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('React ErrorBoundary 捕获异常', error, {
      componentStack: info.componentStack,
    });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, message: undefined });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="error-boundary">
          <h1>页面出错了</h1>
          <p>{this.state.message || '未知错误'}</p>
          <p className="hint">详细堆栈已写入前端日志，并已尝试上报后端。</p>
          <button type="button" onClick={this.handleRetry}>
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
