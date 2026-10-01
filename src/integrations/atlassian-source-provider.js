'use strict';

const MAX_COMMENTS = 100;
const MAX_COMMENT_PAGES = 3;
const MAX_LINKS = 20;
const MAX_ADF_NODES = 5000;
const MAX_ADF_DEPTH = 40;

function plainText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join('\n');
  if (typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
}

function adfText(root, warnings) {
  const supportedContainers = new Set(['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'blockquote', 'panel', 'table', 'tableRow', 'tableCell', 'tableHeader', 'expand', 'extension', 'inlineExtension', 'nestedExpand', 'inlineCard', 'blockCard', 'embedCard']);
  let visited = 0;
  let limitWarned = false;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object') return '';
    visited += 1;
    if (visited > MAX_ADF_NODES || depth > MAX_ADF_DEPTH) {
      if (!limitWarned) warnings.push('ADF content exceeded the extraction node/depth limit.');
      limitWarned = true;
      return '';
    }
    if (Array.isArray(node)) return node.map((child) => walk(child, depth + 1)).filter(Boolean).join('');
    if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention') return String(node.attrs?.text || node.attrs?.id || '');
    if (node.type === 'emoji') return String(node.attrs?.text || node.attrs?.shortName || '');
    if (node.type && !supportedContainers.has(node.type)) warnings.push(`Unsupported ADF node type: ${String(node.type).slice(0, 80)}`);
    const content = walk(node.content || [], depth + 1);
    return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'panel', 'tableRow', 'tableCell', 'tableHeader'].includes(node.type)
      ? content.trim() ? `${content.trim()}\n` : '' : content;
  };
  return walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function typedRef(sourceKind, originId, externalId) {
  const id = String(externalId || '').trim();
  return id ? { sourceKind, originId, externalId: id } : null;
}

function linkToConfluenceRef(rawUrl, sites, baseSite) {
  if (typeof rawUrl !== 'string') return null;
  try {
    const url = new URL(rawUrl, baseSite.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== new URL(baseSite.baseUrl).origin) return null;
    const target = sites.find((site) => site.sourceKind === 'confluence' && new URL(site.baseUrl).origin === url.origin);
    if (!target) return null;
    const basePath = new URL(target.baseUrl).pathname.replace(/\/+$/, '');
    if (basePath && basePath !== '/' && !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) return null;
    let id = null;
    const match = url.pathname.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/|$)/)
      || url.pathname.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)-/);
    if (match) id = match[1];
    if (!id && /\/wiki\/pages\/viewpage\.action$/.test(url.pathname)) id = url.searchParams.get('pageId');
    return id && /^\d+$/.test(id) ? typedRef('confluence', target.originId, id) : null;
  } catch { return null; }
}

function collectAdfLinks(root, sites, site, warnings) {
  const out = [];
  const visited = new Set();
  let nodes = 0;
  let limitWarned = false;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object') return;
    nodes += 1;
    if (nodes > MAX_ADF_NODES || depth > MAX_ADF_DEPTH) { if (!limitWarned) warnings.push('ADF links exceeded the extraction node/depth limit.'); limitWarned = true; return; }
    if (Array.isArray(node)) { node.forEach((child) => walk(child, depth + 1)); return; }
    const href = node.type === 'text' && node.marks?.find((mark) => mark.type === 'link')?.attrs?.href;
    const cardHref = ['inlineCard', 'blockCard', 'embedCard'].includes(node.type) ? node.attrs?.url : null;
    if (href || cardHref) {
      const ref = linkToConfluenceRef(href || cardHref, sites, site);
      if (ref) {
        const k = `${ref.originId}\0${ref.externalId}`;
        if (!visited.has(k) && out.length < MAX_LINKS) { visited.add(k); out.push(ref); }
        else if (!visited.has(k)) warnings.push(`ADF links were limited to ${MAX_LINKS}.`);
      } else warnings.push('Ignored an ADF link that was not a same-site Confluence page.');
    }
    walk(node.content, depth + 1);
  };
  walk(root);
  return out;
}

function extractAdf(root, sites, site, warnings) {
  return { text: adfText(root, warnings), links: collectAdfLinks(root, sites, site, warnings) };
}

function createAtlassianSourceProvider({ client, sites = [] } = {}) {
  if (!client || typeof client.getIssue !== 'function' || typeof client.getComments !== 'function'
    || typeof client.getRemoteLinks !== 'function' || typeof client.getPage !== 'function') {
    throw new TypeError('A typed Atlassian read client is required');
  }
  const configuredSites = sites.map((site) => ({ ...site }));
  const siteFor = (ref) => configuredSites.find((site) => site.originId === ref.originId && site.sourceKind === ref.sourceKind);
  return Object.freeze({
    async read(ref) {
      const site = siteFor(ref);
      if (!site || !/^https:\/\//i.test(site.baseUrl || '')) return { ...ref, availability: 'unavailable', title: 'Source site is not configured', text: '', links: [] };
      const warnings = [];
      if (ref.sourceKind === 'jira') {
        const issue = await client.getIssue({ originId: ref.originId, issueIdOrKey: ref.externalId });
        if (!issue || !issue.id) return { ...ref, availability: 'missing', title: 'Jira issue missing', text: '', links: [] };
        const comments = [];
        const commentLinks = [];
        let startAt = 0;
        try {
          for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
            const result = await client.getComments({ originId: ref.originId, issueIdOrKey: issue.id, startAt, maxResults: MAX_COMMENTS });
            const values = Array.isArray(result) ? result : (result?.comments || result?.values || []);
            for (const comment of values.slice(0, MAX_COMMENTS)) {
              const c = comment?.body;
              const extracted = c && typeof c === 'object' ? extractAdf(c, configuredSites, site, warnings) : { text: plainText(c), links: [] };
              const body = extracted.text;
              commentLinks.push(...extracted.links);
              const commentId = typeof comment?.id === 'string' || typeof comment?.id === 'number' ? String(comment.id).slice(0, 80) : null;
              const updated = typeof comment?.updated === 'string' ? comment.updated.slice(0, 80) : null;
              if (body) comments.push(`${commentId || updated ? `[comment${commentId ? ` id=${commentId}` : ''}${updated ? ` updated=${updated}` : ''}]\n` : ''}${body}`);
            }
            startAt += values.length;
            const total = Number.isFinite(result?.total) ? result.total : startAt;
            if (values.length < MAX_COMMENTS || startAt >= total) break;
            if (page === MAX_COMMENT_PAGES - 1) warnings.push('Jira comments were truncated at the pagination limit.');
          }
        } catch (error) { if (error?.code === 'reconnect_required') throw error; warnings.push('Jira comments could not be retrieved; comment context is unavailable.'); }
        let remotes = [];
        try { remotes = await client.getRemoteLinks({ originId: ref.originId, issueIdOrKey: issue.id }); }
        catch (error) { if (error?.code === 'reconnect_required') throw error; warnings.push('Jira remote links could not be retrieved; linked context is unavailable.'); }
        const links = [];
        const remoteList = Array.isArray(remotes) ? remotes : [];
        for (const remote of remoteList.slice(0, MAX_LINKS)) {
          const target = linkToConfluenceRef(remote?.object?.url || remote?.url, configuredSites, site);
          if (target) links.push(target);
          else if (remote?.object?.url || remote?.url) warnings.push('Ignored a remote link that was not a same-site Confluence page.');
        }
        if (remoteList.length > MAX_LINKS) warnings.push(`Jira remote links were limited to ${MAX_LINKS}.`);
        const fields = issue.fields || {};
        const desc = fields.description && typeof fields.description === 'object'
          ? extractAdf(fields.description, configuredSites, site, warnings) : { text: plainText(fields.description), links: [] };
        const parent = fields.parent?.id ? typedRef('jira', ref.originId, fields.parent.id) : null;
        if (parent) links.unshift(parent);
        links.push(...commentLinks.slice(0, MAX_LINKS));
        const issueType = typeof fields.issuetype?.name === 'string' ? `Issue type: ${fields.issuetype.name.slice(0, 100)}` : '';
        const text = [issueType, desc.text, ...comments.map((item) => `Comment:\n${item}`)].filter(Boolean).join('\n\n');
        links.push(...desc.links);
        const key = String(issue.key || ref.externalId);
        const base = site.baseUrl.replace(/\/+$/, '');
        return {
          sourceKind: 'jira', originId: ref.originId, externalId: String(issue.id), displayKey: key,
          url: `${base}/browse/${encodeURIComponent(key)}`, sourceRevision: issue.fields?.updated || null,
          title: String(fields.summary || key), text, links, availability: 'available', warnings,
        };
      }
      if (ref.sourceKind === 'confluence') {
        const page = await client.getPage({ originId: ref.originId, pageId: ref.externalId });
        if (!page || !page.id) return { ...ref, availability: 'missing', title: 'Confluence page missing', text: '', links: [] };
        const body = page.body?.atlas_doc_format?.value;
        let adf = body;
        if (typeof body === 'string') {
          try { adf = JSON.parse(body); } catch { warnings.push('Confluence atlas_doc_format body was not valid JSON.'); adf = null; }
        }
        const extracted = extractAdf(adf, configuredSites, site, warnings);
        const base = site.baseUrl.replace(/\/+$/, '');
        const wikiBase = /\/wiki$/i.test(new URL(site.baseUrl).pathname.replace(/\/+$/, '')) ? base : `${base}/wiki`;
        const url = `${wikiBase}/pages/viewpage.action?pageId=${encodeURIComponent(String(page.id))}`;
        return {
          sourceKind: 'confluence', originId: ref.originId, externalId: String(page.id), displayKey: String(page.title || page.id),
          url, sourceRevision: page.version?.number == null ? null : String(page.version.number),
          title: String(page.title || page.id), text: extracted.text, links: extracted.links,
          availability: 'available', warnings,
        };
      }
      return { ...ref, availability: 'unavailable', title: 'Unsupported source kind', text: '', links: [] };
    },
  });
}

module.exports = { createAtlassianSourceProvider, extractAdf, linkToConfluenceRef, MAX_COMMENTS, MAX_COMMENT_PAGES };
