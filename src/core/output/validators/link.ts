/**
 * link validator — brain-internal wikilinks point to pages that exist.
 *
 * Scans compiled_truth + timeline for `[text](path)` markdown links.
 * Classifies each:
 *   - External URL (http://, https://) → skipped; url_reachable resolver
 *     handles reachability on-demand, not pre-write.
 *   - Relative .md wikilink → resolved against brain via engine.getPage.
 *     Dangling links emit an error.
 *   - Anything else (mailto:, internal anchors) → warning.
 *
 * A `./` or `../` link is resolved against the linking page's own directory
 * and slugified the way the importer slugifies paths, so a page in a nested
 * layout (`a/b/c/page` linking `../../x.md` -> `a/x`) finds its target's
 * stored slug and a link with the wrong depth is reported. The older reading
 * (strip the leading dots, treat the rest as a root-relative slug) is kept as
 * a fallback, so a flat brain whose links were written that way still resolves.
 * This matches how engine.addLink is called downstream.
 */

import { posix } from 'path';
import { slugifyPath } from '../../sync.ts';
import type { PageValidator, PageValidationContext, ValidationFinding } from '../writer.ts';

const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

export const linkValidator: PageValidator = {
  id: 'link',

  async validate(ctx: PageValidationContext): Promise<ValidationFinding[]> {
    const findings: ValidationFinding[] = [];
    const body = `${ctx.compiledTruth}\n${ctx.timeline}`;

    const links: { display: string; line: number; candidates: string[] }[] = [];

    for (const { match, line } of iterateLinks(body)) {
      const [, display, href] = match;

      if (isExternalUrl(href)) continue;
      if (isNonBrainRef(href)) {
        findings.push({
          slug: ctx.slug,
          validator: 'link',
          severity: 'warning',
          line,
          message: `Non-brain link (mailto/anchor/scheme): ${truncate(href, 80)}`,
        });
        continue;
      }

      const candidates = linkSlugCandidates(href, ctx.slug);
      if (candidates.length === 0) {
        findings.push({
          slug: ctx.slug,
          validator: 'link',
          severity: 'warning',
          line,
          message: `Unresolvable link path: ${truncate(href, 80)}`,
        });
        continue;
      }

      links.push({ display, line, candidates });
    }

    // One engine lookup per distinct candidate slug, within the validation read scope.
    const sourceOpts = ctx.sourceIds && ctx.sourceIds.length > 0
      ? { sourceIds: ctx.sourceIds }
      : ctx.sourceId
        ? { sourceId: ctx.sourceId }
        : undefined;
    const exists = new Map<string, boolean>();
    for (const slug of new Set(links.flatMap(l => l.candidates))) {
      exists.set(slug, !!(await ctx.engine.getPage(slug, sourceOpts)));
    }
    for (const { line, candidates } of links) {
      if (candidates.some(c => exists.get(c))) continue;
      findings.push({
        slug: ctx.slug,
        validator: 'link',
        severity: 'error',
        line,
        message: `Dangling wikilink to ${candidates[0]} (no such page)`,
      });
    }

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

export function isExternalUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function isNonBrainRef(href: string): boolean {
  return /^(mailto:|tel:|javascript:|data:|#)/i.test(href);
}

/**
 * Normalize a link href to a brain slug. Accepts:
 *   "people/alice-smith.md"
 *   "../people/alice-smith.md"
 *   "../../people/alice-smith.md"
 *   "/people/alice-smith.md"
 *   "people/alice-smith"   (no extension)
 * Returns null if the shape isn't slug-like.
 */
export function normalizeToSlug(href: string): string | null {
  let s = href.trim();
  // Strip repeated leading relative-path components (./, ../, multiple levels).
  while (/^\.\.?\/+/.test(s)) s = s.replace(/^\.\.?\/+/, '');
  // Strip leading slashes
  s = s.replace(/^\/+/g, '');
  // Strip trailing .md
  s = s.replace(/\.md$/i, '');
  // Must look like dir/name (or dir/name/subname)
  if (!/^[a-z0-9][a-z0-9\-]*(\/[a-z0-9][a-z0-9\-]*)+$/i.test(s)) return null;
  return s.toLowerCase();
}

/**
 * Candidate slugs for a link href, best first. A `./` or `../` href resolves
 * against `fromSlug`'s directory; a path that climbs above the brain root has
 * no resolved candidate. The root-relative reading from normalizeToSlug follows.
 */
export function linkSlugCandidates(href: string, fromSlug: string): string[] {
  const out: string[] = [];
  const h = href.trim();
  if (/^\.\.?\//.test(h)) {
    const joined = posix.normalize(posix.join(posix.dirname(fromSlug), h));
    if (joined !== '..' && !joined.startsWith('../')) {
      const resolved = slugifyPath(joined);
      if (resolved) out.push(resolved);
    }
  }
  const legacy = normalizeToSlug(href);
  if (legacy && !out.includes(legacy)) out.push(legacy);
  return out;
}

/**
 * Iterate markdown links with 1-based line numbers. Skips links that appear
 * inside fenced code blocks — those are examples, not wikilinks.
 */
function* iterateLinks(body: string): IterableIterator<{ match: RegExpExecArray; line: number }> {
  const lines = body.split('\n');
  let insideFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (insideFence) {
      if (line.startsWith(fenceMarker)) insideFence = false;
      continue;
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      insideFence = true;
      fenceMarker = line.startsWith('```') ? '```' : '~~~';
      continue;
    }
    // Strip inline code so `[x](y)` inside backticks doesn't get validated
    const cleanedLine = line.replace(/`[^`\n]*`/g, '');
    MD_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_LINK_RE.exec(cleanedLine)) !== null) {
      yield { match: m, line: i + 1 };
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}
