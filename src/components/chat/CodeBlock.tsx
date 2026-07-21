'use client';

import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';

export default function CodeBlock({ code, language }: { code: string; language?: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="relative group/code my-2 rounded-lg overflow-hidden border border-lc-border" data-testid="code-block">
      <div className="flex items-center justify-between px-3 py-1.5 bg-lc-black/80 border-b border-lc-border text-xs text-lc-muted">
        <span>{language || 'text'}</span>
        <button
          type="button"
          onClick={() => void copy(code)}
          className="opacity-0 group-hover/code:opacity-100 transition-opacity text-lc-muted hover:text-lc-green"
          data-testid="copy-code-btn"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="bg-lc-black p-3 text-sm text-lc-white overflow-x-auto" data-testid="code-fallback">
        <code>{code}</code>
      </pre>
    </div>
  );
}
