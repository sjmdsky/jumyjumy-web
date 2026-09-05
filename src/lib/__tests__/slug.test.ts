import { describe, test, expect } from 'vitest'
import { toSlug, buildPath, parseSlugId, encodePath, isIdLookupSegment } from '../slug'

describe('toSlug', () => {
  test('lowercases and hyphenates latin titles', () => {
    expect(toSlug('How to Center a Div in CSS?')).toBe('how-to-center-a-div-in-css')
  })

  test('keeps CJK characters instead of dropping them', () => {
    expect(toSlug('如何给 div 居中？')).toBe('如何给-div-居中')
  })

  test('collapses repeated separators and trims them', () => {
    expect(toSlug('--a  ///  b--')).toBe('a-b')
  })

  test('truncates long titles at a word boundary', () => {
    const slug = toSlug('a'.repeat(20) + ' ' + 'b'.repeat(90))
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith('-')).toBe(false)
  })

  test('never returns an empty slug', () => {
    expect(toSlug('???')).toBe('q')
  })
})

describe('buildPath / parseSlugId', () => {
  test('round-trips a question into a canonical path', () => {
    const path = buildPath('如何给 div 居中？', '7k3f9xq2v8')
    expect(path).toBe('/q/如何给-div-居中-7k3f9xq2v8')
    expect(parseSlugId('如何给-div-居中-7k3f9xq2v8')).toEqual({
      slug: '如何给-div-居中',
      id: '7k3f9xq2v8',
    })
  })

  test('extracts the id even when the slug drifted', () => {
    expect(parseSlugId('a-totally-different-title-7k3f9xq2v8')?.id).toBe('7k3f9xq2v8')
  })

  test('returns null for a malformed path segment', () => {
    expect(parseSlugId('no-id-here')).toBeNull()
    expect(parseSlugId('')).toBeNull()
  })

  test('rejects a legacy six-character id', () => {
    // Arrange —— 后端的 id 已改成 10 位、首位数字，旧形状不再保留兼容分支：
    // 把 `enable-bbr-1xwndu` 当规范 URL 会去阻塞取数，后端却把它当提问。
    // Act / Assert
    expect(parseSlugId('enable-bbr-1xwndu')).toBeNull()
  })

  test('rejects an id that does not start with a digit', () => {
    // Arrange —— 英文单词不以数字开头，这正是 `/q/learn-kubernetes` 不被误判的依据
    // Act / Assert
    expect(parseSlugId('learn-kubernetes')).toBeNull()
  })
})

describe('encodePath', () => {
  test('percent-encodes a CJK slug so it can go in a Location header', () => {
    // Arrange — toSlug 刻意保留 CJK，而 HTTP 头部只接受 ByteString
    const path = buildPath('debian13开启bbr', '1xwndu4p7c')

    // Act
    const encoded = encodePath(path)

    // Assert
    expect(encoded).toBe('/q/debian13%E5%BC%80%E5%90%AFbbr-1xwndu4p7c')
  })

  test('produces a value the Response constructor accepts as a header', () => {
    // Arrange — 未编码时 new Response 会抛 TypeError，整页变成 500
    const encoded = encodePath(buildPath('如何给 div 居中？', '9k3f8p2wqz'))

    // Act / Assert
    expect(
      () => new Response(null, { status: 301, headers: { location: encoded } }),
    ).not.toThrow()
  })

  test('leaves an ascii path untouched', () => {
    // Act / Assert — 纯 ascii 的规范路径不该被改写
    expect(encodePath('/q/how-to-boil-an-egg-9k3f8p2wqz')).toBe('/q/how-to-boil-an-egg-9k3f8p2wqz')
  })

  test('keeps the path separators unencoded', () => {
    // Act / Assert — 编码的是每一段，不是整条路径
    expect(encodePath('/q/a-b-1234567890')).toBe('/q/a-b-1234567890')
  })
})

describe('isIdLookupSegment', () => {
  test('accepts a canonical <slug>-<id> segment', () => {
    // Act / Assert
    expect(isIdLookupSegment('how-to-boil-an-egg-9k3f8p2wqz')).toBe(true)
  })

  test('accepts a CJK slug because the backend only inspects the shape', () => {
    // Act / Assert
    expect(isIdLookupSegment('debian13开启bbr-1xwndu4p7c')).toBe(true)
  })

  test('rejects a segment containing whitespace even when the tail is id-shaped', () => {
    // Arrange — 空白是 isIdLookupSegment 与 parseSlugId 唯一的分歧点，所以样本必须
    // 是「去掉空白就会被判成 id」的那一种；后端把它当提问去调模型，这里若判成
    // id 查询，页面就会阻塞在模型调用上，正是 502 的成因。
    // Act / Assert
    expect(parseSlugId('debian 13-1xwndu4p7c')).not.toBeNull()
    expect(isIdLookupSegment('debian 13-1xwndu4p7c')).toBe(false)
    expect(isIdLookupSegment('how to boil an egg')).toBe(false)
  })

  test('rejects an id whose first character is not a digit', () => {
    // Arrange — 首位数字是后端把英文提问排除在 id 查询之外的唯一依据：
    // `kubernetes` 恰好 10 位小写字母，只有首位规则能让它继续走生成流程。
    // Act / Assert
    expect(isIdLookupSegment('learn-kubernetes')).toBe(false)
    expect(isIdLookupSegment('rust-webassembly')).toBe(false)
  })

  test('rejects a legacy six-character id', () => {
    // Arrange — 旧形状不再保留：后端现在把它当提问，前端必须给出同一个判断
    // Act / Assert
    expect(isIdLookupSegment('enable-bbr-zzzzzz')).toBe(false)
    expect(isIdLookupSegment('debian13开启bbr-1xwndu')).toBe(false)
  })

  test('accepts every id length the backend resolves, and nothing outside it', () => {
    // Arrange — 后端认的是范围 10–12，不是等于 10：将来把生成长度提到 12
    // 时，已发出去的 10 位 id 不必迁移、不必 301、也不必再改这里。
    // Act / Assert
    expect(isIdLookupSegment('abc-1abcdefghi')).toBe(true)
    expect(isIdLookupSegment('abc-1abcdefghij')).toBe(true)
    expect(isIdLookupSegment('abc-1abcdefghijk')).toBe(true)
    expect(isIdLookupSegment('abc-1abcdefgh')).toBe(false)
    expect(isIdLookupSegment('abc-1abcdefghijkl')).toBe(false)
  })

  test('rejects an uppercase id', () => {
    // Act / Assert — id 恒为小写 base36
    expect(isIdLookupSegment('abc-1A2B3C4D5E')).toBe(false)
  })

  test('rejects a bare id with no slug part', () => {
    // Act / Assert
    expect(isIdLookupSegment('9k3f8p2wqz')).toBe(false)
    expect(isIdLookupSegment('-9k3f8p2wqz')).toBe(false)
  })

  test('rejects an empty segment', () => {
    // Act / Assert
    expect(isIdLookupSegment('')).toBe(false)
  })

  test('agrees with parseSlugId on segments without whitespace', () => {
    // Arrange — 两者只在空白这一点上分歧，其余必须一致，否则 301 与骨架页会互相打架
    const segments = [
      'a-b-1234567890',
      'x-9k3f8p2wqz',
      'no-id-here',
      'abc-1A2B3C4D5E',
      'learn-kubernetes',
      'enable-bbr-zzzzzz',
    ]

    // Act / Assert
    for (const segment of segments) {
      expect(isIdLookupSegment(segment)).toBe(parseSlugId(segment) !== null)
    }
  })
})
