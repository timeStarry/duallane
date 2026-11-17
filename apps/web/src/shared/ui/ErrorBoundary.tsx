import React, { type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "./Button";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "界面渲染出现异常",
    };
  }

  componentDidCatch() {
    // Error details intentionally stay local to the UI boundary.
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: "" });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div className="dl-canvas-ambient flex min-h-screen w-screen items-center justify-center p-6">
        <div className="dl-glass-dialog w-full max-w-md rounded-dialog border border-line p-6 space-y-4 text-text">
          <div className="flex items-center gap-2.5 text-danger">
            <AlertTriangle className="size-5 shrink-0" strokeWidth={2} />
            <h2 className="text-base font-semibold text-text">
              {this.props.fallbackTitle || "界面模块已自动隔离恢复"}
            </h2>
          </div>
          <p className="text-xs leading-relaxed text-muted">{this.state.message}</p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={this.handleReset}>
              <RotateCcw className="size-3.5" strokeWidth={2} />
              重试当前视图
            </Button>
            <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
              刷新页面
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
