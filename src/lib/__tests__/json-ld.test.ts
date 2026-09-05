import { describe, test, expect } from 'vitest'
import { toInlineJsonLd } from '../json-ld'

describe('toInlineJsonLd', () => {
  test('escapes < so an embedded </script> cannot close the tag', () => {
    // Arrange — 后端可控字段里塞 </script> 是最常见的 JSON-LD 逃逸手法
    const payload = { text: 'before</script><img src=x onerror=alert(1)>after' }

    // Act
    const serialized = toInlineJsonLd(payload)

    // Assert
    expect(serialized).not.toContain('</script>')
    expect(serialized).not.toContain('<img')
    expect(serialized).toContain('\\u003c/script>')
  })

  test('round-trips back to the original value through JSON.parse', () => {
    // Arrange
    const payload = {
      '@context': 'https://schema.org',
      nested: { text: 'a</script>b', list: [1, 'two<br>'] },
    }

    // Act
    const parsed = JSON.parse(toInlineJsonLd(payload))

    // Assert
    expect(parsed).toEqual(payload)
  })

  test('leaves payloads without angle brackets untouched', () => {
    // Arrange
    const payload = { '@type': 'QAPage', name: 'How to boil an egg' }

    // Act
    const serialized = toInlineJsonLd(payload)

    // Assert
    expect(serialized).toBe('{"@type":"QAPage","name":"How to boil an egg"}')
  })

  test('serializes null answer text without producing the string "undefined"', () => {
    // Arrange
    const payload = { text: null }

    // Act
    const serialized = toInlineJsonLd(payload)

    // Assert
    expect(serialized).toBe('{"text":null}')
  })
})
