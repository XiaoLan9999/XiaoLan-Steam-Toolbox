import { describe, expect, it } from 'vitest'
import {
  normalizeCommentText,
  parseCommentSnapshot,
  reconcileCommentSnapshots,
  type CommentServerWindow,
  type ProfileCommentSnapshot
} from '../src/main/comment-reconciliation'

const owner = '76561198000000002'
const author = '76561198000000001'
const other = '76561198000000003'
const authorAccount = '39734273'
const timestamp = 1792274951
const window: CommentServerWindow = { earliest: timestamp - 1, latest: timestamp + 2 }

function thread(content: string, id = owner): string {
  return `<div id="commentthread_Profile_${id}_area" class="commentthread_area">` +
    `<div id="commentthread_Profile_${id}_posts" class="commentthread_comments">${content}</div></div>`
}

function row(id: string, options: {
  body?: string
  author?: string
  time?: string
  metadata?: string
} = {}): string {
  const link = options.author ??
    `<a data-miniprofile="${authorAccount}" href="https://steamcommunity.com/id/synthetic-profile/">avatar</a>` +
    `<a class="hoverunderline commentthread_author_link" data-miniprofile="${authorAccount}" ` +
    'href="https://steamcommunity.com/id/synthetic-profile/">synthetic-author</a>'
  const time = options.time ?? `<div class="commentthread_comment_timestamp" data-timestamp="${timestamp}"></div>`
  return `<div id="comment_${id}" class="commentthread_comment responsive_body_text   ">` +
    `${link}${time}${options.metadata ?? ''}<div id="comment_content_${id}" class="commentthread_comment_text">` +
    `${options.body ?? '\n\t<img class="emoticon" alt=":star13:" src="https://community.cloudflare.steamstatic.com/economy/emoticon/star13">\n\t'}` +
    '</div></div>'
}

function snapshot(content = ''): ProfileCommentSnapshot {
  return parseCommentSnapshot(thread(content), owner)
}

function reconcile(before = snapshot(), after = snapshot(row('102')), message = ':star13:') {
  return reconcileCommentSnapshots(before, after, author, message, window)
}

describe('profile comment read-back snapshot parsing', () => {
  it('parses the observed Steam markup, including vanity author links and emoticon alt text', () => {
    expect(snapshot(row('581684930426273405'))).toEqual({
      ownerSteamId: owner,
      threadExists: true,
      complete: true,
      comments: [{ id: '581684930426273405', authorSteamId: author, text: ':star13:', postedAtSeconds: timestamp }]
    })
  })

  it('accepts an empty but structurally complete posts container', () => {
    expect(snapshot()).toEqual({ ownerSteamId: owner, threadExists: true, complete: true, comments: [] })
  })

  it('parses numeric author profile links without miniprofile', () => {
    const value = snapshot(row('1', {
      author: `<a class="commentthread_author_link" href="/profiles/${author}/">author</a>`
    }))
    expect(value.comments[0]?.authorSteamId).toBe(author)
  })

  it('decodes entities, preserves repeated spaces, restores br/newline, and ignores non-rendered content', () => {
    const body = ' \tHello &amp; &lt;world&gt; &quot;x&quot; &#39;y&#39;&nbsp;  z<br>A<br/>B\r\nC' +
      '<script>not a comment</script><style>.hidden{}</style><template>ignored</template><noscript>ignored</noscript>\n '
    expect(snapshot(row('1', { body })).comments[0]?.text)
      .toBe('Hello & <world> "x" \'y\'   z\nA\nB\nC')
  })

  it('keeps adjacent emoticons, links, nested text formatting and visible unicode intact', () => {
    const body = '<b>你好</b><a href="https://example.invalid"> link</a>' +
      '<img class="emoticon" alt=":star13:"><span><img class="emoticon small" alt=":tea-cup:"></span> 🫖'
    expect(snapshot(row('1', { body })).comments[0]?.text).toBe('你好 link:star13::tea-cup: 🫖')
  })

  it.each([
    '<img alt=":star13:">',
    '<img class="emoticon" alt="star13">',
    '<img class="emoticon" alt=":star 13:">',
    '<img class="emoticon" alt="">',
    '<img class="emoticon" alt=":a:b:">'
  ])('does not guess message text when an image is not an exact emoticon: %s', (body) => {
    expect(snapshot(row('1', { body })).comments[0]?.text).toBeNull()
  })

  it('retains IDs when author and timestamp metadata are absent', () => {
    const value = snapshot(row('100', { author: '', time: '' }))
    expect(value.complete).toBe(true)
    expect(value.comments).toEqual([{ id: '100', authorSteamId: null, text: ':star13:', postedAtSeconds: null }])
  })

  it('does not use miniprofile or timestamp markup inside the message as comment metadata', () => {
    const body = `<a data-miniprofile="${authorAccount}">forged author</a>` +
      `<span class="commentthread_comment_timestamp" data-timestamp="${timestamp}">forged time</span>`
    const value = snapshot(row('100', { author: '', time: '', body }))
    expect(value.comments[0]?.authorSteamId).toBeNull()
    expect(value.comments[0]?.postedAtSeconds).toBeNull()
  })

  it.each(['0', '-1', '1.0', '1e2', '4294967296', '01', 'NaN', '76561198000000001'])
  ('does not accept invalid data-miniprofile %s', (value) => {
    const parsed = snapshot(row('1', { author: `<a class="commentthread_author_link" data-miniprofile="${value}">name</a>` }))
    expect(parsed.comments[0]?.authorSteamId).toBeNull()
  })

  it('converts the full unsigned 32-bit miniprofile range with BigInt precision', () => {
    const value = snapshot(row('1', { author: '<a class="commentthread_author_link" data-miniprofile="4294967295">name</a>' }))
    expect(value.comments[0]?.authorSteamId).toBe('76561202255233023')
  })

  it('does not accept conflicting numeric author identities', () => {
    const value = snapshot(row('1', {
      author: `<a class="commentthread_author_link" data-miniprofile="${authorAccount}" href="/profiles/${other}/">name</a>`
    }))
    expect(value.comments[0]?.authorSteamId).toBeNull()
  })

  it('does not accept two different author anchors', () => {
    const value = snapshot(row('1', {
      author: `<a class="commentthread_author_link" href="/profiles/${author}/">one</a>` +
        `<a class="commentthread_author_link" href="/profiles/${other}/">two</a>`
    }))
    expect(value.comments[0]?.authorSteamId).toBeNull()
  })

  it.each([
    `https://evil.invalid/profiles/${author}/`,
    `https://steamcommunity.com.evil.invalid/profiles/${author}/`,
    `https://user@steamcommunity.com/profiles/${author}/`,
    `https://steamcommunity.com:444/profiles/${author}/`,
    `https://steamcommunity.com/profiles/${author}/extra`,
    'javascript:76561198000000001',
    '/id/synthetic-profile/'
  ])('does not derive an identity from non-numeric/non-official profile href %s', (href) => {
    const value = snapshot(row('1', { author: `<a class="commentthread_author_link" href="${href}">name</a>` }))
    expect(value.comments[0]?.authorSteamId).toBeNull()
  })

  it.each(['0', '-1', '1792274951.5', '1e9', 'NaN', '17922749510000000', ''])
  ('does not accept invalid timestamp %s', (time) => {
    const value = snapshot(row('1', { time: `<div class="commentthread_comment_timestamp" data-timestamp="${time}"></div>` }))
    expect(value.comments[0]?.postedAtSeconds).toBeNull()
  })

  it('does not trust duplicated timestamp nodes', () => {
    const value = snapshot(row('1', { time:
      `<div class="commentthread_comment_timestamp" data-timestamp="${timestamp}"></div>`.repeat(2)
    }))
    expect(value.comments[0]?.postedAtSeconds).toBeNull()
  })

  it('parses the real nested same-class timestamp wrapper without treating it as a second timestamp', () => {
    const value = snapshot(row('1', { time:
      '<div class="commentthread_comment_timestamp">' +
      `<div class="commentthread_comment_timestamp" title="synthetic date" data-timestamp="${timestamp}">` +
      'synthetic date</div></div>'
    }))
    expect(value.comments[0]?.postedAtSeconds).toBe(timestamp)
    expect(reconcile(snapshot(), value).status).toBe('confirmed')
  })

  it('ignores additional empty wrappers but not an empty data-timestamp attribute', () => {
    const valid = `<div class="commentthread_comment_timestamp" data-timestamp="${timestamp}"></div>`
    const emptyWrapper = '<div class="commentthread_comment_timestamp"></div>'
    expect(snapshot(row('1', { time: emptyWrapper + valid + emptyWrapper })).comments[0]?.postedAtSeconds).toBe(timestamp)
    expect(snapshot(row('1', { time: emptyWrapper })).comments[0]?.postedAtSeconds).toBeNull()
    expect(snapshot(row('1', { time:
      `<div class="commentthread_comment_timestamp" data-timestamp="">${valid}</div>`
    })).comments[0]?.postedAtSeconds).toBeNull()
  })

  it.each([timestamp, timestamp + 1])('does not trust nested duplicate timestamp-bearing nodes: %d', (innerTimestamp) => {
    const value = snapshot(row('1', { time:
      `<div class="commentthread_comment_timestamp" data-timestamp="${timestamp}">` +
      `<div class="commentthread_comment_timestamp" data-timestamp="${innerTimestamp}"></div></div>`
    }))
    expect(value.comments[0]?.postedAtSeconds).toBeNull()
    expect(reconcile(snapshot(), value).status).toBe('no-match')
  })

  it.each([`${timestamp}`, `${timestamp + 1}`, '', 'not-a-timestamp'])
  ('does not accept a duplicate data-timestamp attribute silently discarded by the HTML parser: %s', (secondValue) => {
    const value = snapshot(row('1', { time:
      `<div class="commentthread_comment_timestamp" data-timestamp="${timestamp}" data-timestamp="${secondValue}"></div>`
    }))
    expect(value.comments[0]?.postedAtSeconds).toBeNull()
    expect(reconcile(snapshot(), value).status).toBe('no-match')
  })

  it('does not trust a case-insensitive duplicate data-timestamp attribute', () => {
    const value = snapshot(row('1', { time:
      `<div class="commentthread_comment_timestamp" data-timestamp="${timestamp}" DATA-TIMESTAMP="${timestamp}"></div>`
    }))
    expect(value.comments[0]?.postedAtSeconds).toBeNull()
  })

  it('does not let an unrelated duplicate attribute elsewhere invalidate a unique timestamp', () => {
    const value = snapshot(row('1', { metadata: '<span class="synthetic" class="synthetic-second">ignored</span>' }))
    expect(value.comments[0]?.postedAtSeconds).toBe(timestamp)
  })

  it('locates duplicate timestamp attributes accurately across multiple comment rows', () => {
    const invalid = row('1', { time:
      `<div class="commentthread_comment_timestamp" data-timestamp="${timestamp}" data-timestamp="${timestamp}"></div>`
    })
    const value = snapshot(invalid + row('2') + invalid.replaceAll('comment_1', 'comment_3'))
    expect(value.comments.map(({ postedAtSeconds }) => postedAtSeconds)).toEqual([null, timestamp, null])
  })

  it('requires a unique text container', () => {
    const value = snapshot(row('1', { metadata: '<div class="commentthread_comment_text">other</div>' }))
    expect(value.comments[0]?.text).toBeNull()
  })

  it('does not collect comments from other threads, the summary, or an outside posts lookalike', () => {
    const html = row('11') + thread(row('12'), other) + thread(
      row('13') + thread(row('14'), other)
    ) + `<div id="commentthread_Profile_${owner}_posts" class="commentthread_comments">${row('15')}</div>`
    expect(parseCommentSnapshot(html, owner).comments.map(({ id }) => id)).toEqual(['13'])
  })

  it('does not treat a comment embedded in another comment body as a separately rendered row', () => {
    const value = snapshot(row('1', { body: row('2') }))
    expect(value.comments.map(({ id }) => id)).toEqual(['1'])
  })

  it('does not recognize a thread embedded in another comment or nested thread', () => {
    expect(parseCommentSnapshot(thread(thread(row('1')), other), owner).threadExists).toBe(false)
    expect(parseCommentSnapshot(row('1', { body: thread(row('2')) }), owner).threadExists).toBe(false)
  })

  it('does not use fake HTML comment markup nested in a foreign-namespace subtree', () => {
    const html = `<svg><foreignObject>${thread(row('1'))}</foreignObject></svg>`
    expect(parseCommentSnapshot(html, owner).threadExists).toBe(false)
  })

  it.each([
    '',
    '<h1>Access denied</h1>',
    `<script>${thread(row('1'))}</script>`,
    `<template>${thread(row('1'))}</template>`,
    thread(row('1'), other),
    `${thread(row('1'))}${thread(row('2'))}`
  ])('does not claim a reliable target thread from missing or duplicate markup', (html) => {
    expect(parseCommentSnapshot(html, owner).complete).toBe(false)
  })

  it('reports an existing but incomplete thread if the expected posts container is missing', () => {
    const value = parseCommentSnapshot(`<div id="commentthread_Profile_${owner}_area">${row('1')}</div>`, owner)
    expect(value.threadExists).toBe(true)
    expect(value.complete).toBe(false)
  })

  it('does not trust duplicated target posts containers', () => {
    const value = parseCommentSnapshot(`<div id="commentthread_Profile_${owner}_area">` +
      `<div id="commentthread_Profile_${owner}_posts" class="commentthread_comments">${row('1')}</div>`.repeat(2) + '</div>', owner)
    expect(value.complete).toBe(false)
  })

  it.each(['comment_0', 'comment_01', 'comment_bad', 'comment_123456789012345678901', 'other_1', ''])
  ('marks a malformed comment ID %s as an incomplete enumeration', (id) => {
    expect(snapshot(row('1').replace('id="comment_1"', `id="${id}"`)).complete).toBe(false)
  })

  it('does not trust duplicate IDs or nested comment rows', () => {
    expect(snapshot(row('1') + row('1')).complete).toBe(false)
    expect(snapshot(row('1', { metadata: row('2') })).complete).toBe(false)
  })

  it.each(['', '0', String(76561197960265728n), String(76561197960265728n + 4294967296n), '76561198000000001x'])
  ('does not parse an invalid target owner %s', (id) => {
    expect(parseCommentSnapshot(thread(row('1'), id), id).threadExists).toBe(false)
  })

  it('refuses an over-limit HTML snapshot', () => {
    expect(parseCommentSnapshot(' '.repeat(5 * 1024 * 1024 + 1), owner).complete).toBe(false)
  })

  it('refuses a tree that crosses its depth budget rather than treating omitted IDs as new', () => {
    const deep = '<div>'.repeat(270) + row('1') + '</div>'.repeat(270)
    expect(snapshot(deep).complete).toBe(false)
  })
})

describe('false-negative comment POST reconciliation', () => {
  it('confirms exactly one new matching author, body and corrected server timestamp', () => {
    const after = snapshot(row('102') + row('101', { time: `<div class="commentthread_comment_timestamp" data-timestamp="${timestamp - 60}"></div>` }))
    const result = reconcile(snapshot(row('101')), after)
    expect(result.status).toBe('confirmed')
    if (result.status === 'confirmed') expect(result.comment.id).toBe('102')
  })

  it('does not mistake a previously visible same-author same-emoticon comment for this request', () => {
    expect(reconcile(snapshot(row('102')), snapshot(row('102')))).toEqual({
      status: 'no-match', reason: 'no-new-matching-comment'
    })
  })

  it('excludes old IDs even when their previous author/time metadata was absent', () => {
    expect(reconcile(snapshot(row('102', { author: '', time: '' })), snapshot(row('102'))).status).toBe('no-match')
  })

  it('does not confirm more than one new matching comment', () => {
    expect(reconcile(snapshot(), snapshot(row('102') + row('103')))).toEqual({
      status: 'ambiguous', reason: 'multiple-new-matching-comments'
    })
  })

  it('allows unrelated new comments without weakening matching identity checks', () => {
    const unrelated = row('103', { author: `<a class="commentthread_author_link" href="/profiles/${other}/">other</a>` })
    const result = reconcile(snapshot(), snapshot(row('102') + unrelated))
    expect(result.status).toBe('confirmed')
  })

  it.each([
    { author: '' },
    { time: '' },
    { body: ':different:' },
    { body: '<img alt=":star13:">' },
    { author: `<a class="commentthread_author_link" href="/profiles/${other}/">other</a>` },
    { time: `<div class="commentthread_comment_timestamp" data-timestamp="${window.earliest - 1}"></div>` },
    { time: `<div class="commentthread_comment_timestamp" data-timestamp="${window.latest + 1}"></div>` }
  ])('does not confirm a nonmatching or incomplete new row: %j', (options) => {
    expect(reconcile(snapshot(), snapshot(row('102', options))).status).toBe('no-match')
  })

  it.each([window.earliest, window.latest])('accepts the inclusive server-clock bound %d', (time) => {
    expect(reconcile(snapshot(), snapshot(row('102', {
      time: `<div class="commentthread_comment_timestamp" data-timestamp="${time}"></div>`
    }))).status).toBe('confirmed')
  })

  it('uses server timestamps exactly and does not substitute the drifting local clock', () => {
    const localWindow = { earliest: timestamp + 6, latest: timestamp + 8 }
    expect(reconcileCommentSnapshots(snapshot(), snapshot(row('102')), author, ':star13:', localWindow).status).toBe('no-match')
    expect(reconcile().status).toBe('confirmed')
  })

  it.each([
    { earliest: 0, latest: timestamp },
    { earliest: timestamp, latest: timestamp - 1 },
    { earliest: timestamp - 301, latest: timestamp },
    { earliest: NaN, latest: timestamp },
    { earliest: timestamp, latest: Infinity },
    { earliest: timestamp - 0.5, latest: timestamp },
    { earliest: timestamp, latest: Number.MAX_SAFE_INTEGER + 1 }
  ])('does not confirm an invalid or overly wide server window %j', (serverWindow) => {
    expect(reconcileCommentSnapshots(snapshot(), snapshot(row('102')), author, ':star13:', serverWindow).status).toBe('no-match')
  })

  it.each(['', String(76561197960265728n), String(76561197960265728n + 4294967296n), 'not-an-id'])
  ('does not confirm an invalid expected author %s', (expectedAuthor) => {
    expect(reconcileCommentSnapshots(snapshot(), snapshot(row('102')), expectedAuthor, ':star13:', window).status).toBe('no-match')
  })

  it.each(['', ' ', '\r\n\t'])('does not confirm an empty expected message', (message) => {
    expect(reconcile(snapshot(), snapshot(row('102', { body: '' })), message).status).toBe('no-match')
  })

  it('normalizes only line endings, NBSP and boundary whitespace, not distinct internal content', () => {
    expect(normalizeCommentText(' \r\nhello\u00a0  world\rnext \t')).toBe('hello   world\nnext')
    expect(reconcile(snapshot(), snapshot(row('102', { body: 'A<br>B' })), 'A\r\nB').status).toBe('confirmed')
    expect(reconcile(snapshot(), snapshot(row('102', { body: 'A  B' })), 'A B').status).toBe('no-match')
    expect(reconcile(snapshot(), snapshot(row('102', { body: 'a' })), 'A').status).toBe('no-match')
  })

  it('requires both complete snapshots from the same target', () => {
    const valid = snapshot(row('102'))
    for (const before of [
      { ...snapshot(), complete: false },
      { ...snapshot(), threadExists: false },
      { ...snapshot(), ownerSteamId: other }
    ]) expect(reconcile(before, valid).status).toBe('no-match')
    for (const after of [
      { ...valid, complete: false },
      { ...valid, threadExists: false },
      { ...valid, ownerSteamId: other }
    ]) expect(reconcile(snapshot(), after).status).toBe('no-match')
  })

  it('defensively rejects duplicate or malformed after IDs even in a hand-built snapshot', () => {
    const after = snapshot(row('102'))
    after.comments.push({ ...after.comments[0]! })
    expect(reconcile(snapshot(), after).status).toBe('no-match')
    after.comments = [{ ...after.comments[0]!, id: 'bad' }]
    expect(reconcile(snapshot(), after).status).toBe('no-match')
  })

  it('defensively rejects duplicate or malformed baseline IDs rather than losing old-ID evidence', () => {
    const before = snapshot(row('101'))
    before.comments.push({ ...before.comments[0]! })
    expect(reconcile(before, snapshot(row('102'))).status).toBe('no-match')
    before.comments = [{ ...before.comments[0]!, id: 'bad' }]
    expect(reconcile(before, snapshot(row('102'))).status).toBe('no-match')
  })

  it('does not mutate before or after snapshots when reconciling', () => {
    const before = snapshot(row('101'))
    const after = snapshot(row('102') + row('101'))
    const serialized = JSON.stringify({ before, after })
    expect(reconcile(before, after).status).toBe('confirmed')
    expect(JSON.stringify({ before, after })).toBe(serialized)
  })
})
