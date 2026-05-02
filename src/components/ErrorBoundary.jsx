import { Component } from 'react';
import { hrefFor, useLinkHandler } from '../lib/router.js';

// Error boundary for routed tool views. Without this, an uncaught
// exception inside loadPlayerIndex (or any rendering downstream) flips
// the entire React tree to a white screen with no recovery path —
// which is exactly what the crashes friends were reporting on mobile.
//
// Wraps each tool view in App.jsx with a `key={route.name}` so a crash
// in Players doesn't poison the boundary when the user navigates to
// Teams; React unmounts the old boundary and mounts a fresh one.

function FallbackUI({ error, onRetry }) {
  const onClick = useLinkHandler();
  return (
    <main className="tool-main">
      <div className="page-title-row">
        <h1 className="page-title">Couldn't load this view</h1>
        <div className="page-sub">
          Something went wrong while building the player index. This is
          most often a memory hiccup on mobile — try again, or head back
          to the home page.
        </div>
      </div>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: '3px solid var(--red)',
        borderRadius: '8px',
        padding: '1rem 1.2rem',
        maxWidth: '720px',
        marginBottom: '1.2rem',
      }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.7rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
          marginBottom: '0.5rem',
        }}>
          Error
        </div>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.78rem',
          color: 'var(--text)',
          lineHeight: 1.55,
          wordBreak: 'break-word',
        }}>
          {error?.message || String(error) || 'Unknown error'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="search-btn"
          onClick={onRetry}
        >
          Try again
        </button>
        <a
          href={hrefFor('about')}
          onClick={onClick}
          className="gl-mode-btn"
          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
        >
          ← Back to home
        </a>
      </div>
    </main>
  );
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface to console for any in-the-wild diagnostics.
    console.error('[ErrorBoundary] caught', error, info);
  }

  retry() {
    this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return <FallbackUI error={this.state.error} onRetry={this.retry} />;
    }
    return this.props.children;
  }
}
