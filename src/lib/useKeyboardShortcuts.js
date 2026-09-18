import { useEffect, useRef } from 'react';

/**
 * useKeyboardShortcuts — bind a map of key → handler at the window level
 * for the lifetime of the calling component.
 *
 * The handlers map can change across renders (React reference identity
 * churns freely). Rather than re-register the listener each render, we
 * mirror the latest handlers into a ref and read from the ref inside a
 * single, stable listener. Registration happens once on mount.
 *
 * By default a key fires only when no text input, textarea, or
 * contenteditable element is focused — so shortcuts don't hijack typing.
 * Escape is the exception: it always fires (used to close modal-style
 * UI even while an input is focused).
 */
export function useKeyboardShortcuts(handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function onKeyDown(e) {
      const map = handlersRef.current || {};
      const handler = map[e.key];
      if (!handler) return;
      // Bail if typing in an input, unless the key is Escape (which
      // should always be able to dismiss an active inspector/modal).
      if (e.key !== 'Escape') {
        const t = e.target;
        const inField = t && (
          t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable
        );
        if (inField) return;
      }
      handler(e);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
