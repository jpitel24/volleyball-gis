/**
 * router.js
 *
 * Tiny URL router on top of the History API. No dependencies, ~50 lines.
 *
 * Routes:
 *   /                     → about
 *   /games                → games (no game selected)
 *   /games/:year/:key     → games (specific game open; key URL-encoded)
 *   /players              → players
 *   /seasons              → seasons
 *   /teams                → teams
 *   /compare              → compare (player-season comparison tool)
 *
 * vercel.json already rewrites all non-asset URLs back to / so the SPA
 * boots regardless of which path the user lands on.
 *
 * Usage:
 *   import { useRoute, navigate, hrefFor } from './router.js';
 *   const route = useRoute();             // { name, year?, gameKey? }
 *   navigate('/players');                 // pushState + re-render
 *   <a href={hrefFor('games', 2024, k)} onClick={onClickLink}>...
 */

import { useEffect, useState, useCallback } from 'react';

function readPath() {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname || '/';
}

export function matchRoute(path) {
  if (!path || path === '/') return { name: 'about', path };
  // /games/:year/:gameKey — gameKey is URL-encoded
  const gm = path.match(/^\/games\/(\d{4})\/(.+?)\/?$/);
  if (gm) {
    return {
      name:    'games',
      year:    parseInt(gm[1], 10),
      gameKey: decodeURIComponent(gm[2]),
      path,
    };
  }
  if (path === '/games' || path.startsWith('/games/')) return { name: 'games', path };
  if (path === '/players' || path.startsWith('/players/')) return { name: 'players', path };
  if (path === '/seasons' || path.startsWith('/seasons/')) return { name: 'seasons', path };
  if (path === '/teams' || path.startsWith('/teams/')) return { name: 'teams', path };
  if (path === '/compare' || path.startsWith('/compare/')) return { name: 'compare', path };
  if (path === '/about' || path.startsWith('/about/')) return { name: 'about', path };
  // Unknown → fall back to about so the app still renders.
  return { name: 'about', path };
}

export function hrefFor(name, ...args) {
  if (name === 'about')   return '/';
  if (name === 'games') {
    if (args.length >= 2) return `/games/${args[0]}/${encodeURIComponent(args[1])}`;
    return '/games';
  }
  if (name === 'players') return '/players';
  if (name === 'seasons') return '/seasons';
  if (name === 'teams')   return '/teams';
  if (name === 'compare') return '/compare';
  return '/';
}

export function navigate(path, { replace = false } = {}) {
  if (typeof window === 'undefined') return;
  if (path === window.location.pathname) return;
  if (replace) window.history.replaceState(null, '', path);
  else         window.history.pushState (null, '', path);
  // History API doesn't fire popstate on push/replace; synthesize one so
  // every useRoute consumer re-reads the path.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute() {
  const [path, setPath] = useState(readPath);
  useEffect(() => {
    const onPop = () => setPath(readPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return matchRoute(path);
}

// Click handler for <a> tags so middle-click / cmd-click / right-click
// still work. Only intercepts plain left-clicks on same-origin paths.
export function useLinkHandler() {
  return useCallback((e) => {
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.currentTarget;
    if (!a || a.target === '_blank') return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('//')) return;
    e.preventDefault();
    navigate(href);
  }, []);
}
